const { toInstId,toUi }=require('./symbols');
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const Market = require("./market");
const Indicators = require("./indicators");
const Scorer = require("./scorer");
const Risk = require("./risk");
const Exec = require("./exec");
const Logger = require("./logger");
const Bandit = require("./learn_bandit");
const Optim2h = require("./learn_optimize");

const Engine = {
  active: true,
  cfg: null,
  okx: null,
  getTopSymbols: null,
  logToUi: (m)=>{},
  state: {
    open: new Map(),
    cooldown: new Map(),
    perfDay: { pnl:0, startEq:0 },
    stopDay: false
  },

  async init({ okxApi, getTopSymbols, dataDir, configDir, logToUi }) {
    this.okx = okxApi;
    this.getTopSymbols = getTopSymbols;
    this.logToUi = logToUi || this.logToUi;

    this.paths = {
      dataDir,
      configDir,
      stratCur: path.join(configDir, "strategy.current.json"),
      risk: path.join(configDir, "risk.json"),
      whitelist: path.join(configDir, "symbols.whitelist.json")
    };

    this.cfg = {
      strategy: JSON.parse(fs.readFileSync(this.paths.stratCur, "utf8")),
      risk: JSON.parse(fs.readFileSync(this.paths.risk, "utf8")),
      whitelist: JSON.parse(fs.readFileSync(this.paths.whitelist, "utf8"))
    };

    await Market.init({ okx: this.okx, bar: this.cfg.strategy.bar, cacheDir: dataDir });
    Logger.init({ baseDir: path.join(dataDir, "trades-logs") });
    Bandit.init({ modelDir: path.join("models","bandits") });
    Optim2h.init({ configPath: this.paths.stratCur, log: this.logToUi });

    this.log("Engine ready (24/7, 2h optimize)");
    setInterval(()=>this.signalLoop().catch(()=>{}), 7000);
    setInterval(()=>this.manageLoop().catch(()=>{}), 1000);

    cron.schedule("0 */2 * * *", async ()=> {
      try { await Optim2h.run2h(); this.reloadConfig(); this.log("Optim 2h applied."); }
      catch(e){ this.log("Optim 2h error: "+(e.message||e)); }
    });
  },

  setActive(v){
    this.active = !!v;
    try{ this.log("AI " + (this.active ? "ON" : "OFF")); }catch{}
    return this.active;
  },

  reloadConfig(){
    try { this.cfg.strategy = JSON.parse(fs.readFileSync(this.paths.stratCur,"utf8")); } catch {}
  },

  async signalLoop(){
    if (!this.active) return;
    if (this.state.stopDay) return;

    let syms = [];
    try { syms = await this.getTopSymbols(50).map(s=>toInstId(s)); } catch {}
    if (Array.isArray(this.cfg.whitelist) && this.cfg.whitelist.length) {
      syms = syms.filter(s => this.cfg.whitelist.includes(s));
    }
    if (!syms.length) syms = ["BTC_USDT","ETH_USDT","SOL_USDT"];

    const candidates = [];
    for (const sym of syms.slice(0, 20)) {
      const instId = Market.toInstId(sym);
      if (Risk.isCooldown(this.state, sym)) continue;
      if (this.state.open.has(instId)) continue;

      const candles = await Market.getCandles(instId, 200);
      if (!candles || candles.length < 50) continue;

      const feat = Indicators.computeAll(candles, this.cfg.strategy);
      if (!feat) continue;
      if ((feat.atrPct || 0) < (this.cfg.strategy.atrVolMinPct || 0.0025)) continue;

      const scored = Scorer.score(feat, this.cfg.strategy);
      if (scored.total < 2) continue;

      candidates.push({ sym, instId, feat, scored });
    }

    const slotsFree = Risk.slotsFree(this.state, this.cfg.strategy.maxOpen || 10);
    if (!candidates.length || slotsFree <= 0) return;

    candidates.sort((a,b)=> b.scored.total - a.scored.total || (b.feat.atrPct - a.feat.atrPct));

    for (const c of candidates) {
      if (Risk.slotsFree(this.state, this.cfg.strategy.maxOpen || 10) <= 0) break;
      if (!Risk.correlationOk(this.state, c.sym, c.scored.side, this.cfg.risk.maxCorrelatedSameSide||3)) continue;

      const side = c.scored.side;
      const params = Risk.pickParamsFor(c.scored.mode==="MR"?"MR":"TF", this.cfg.strategy, c.scored.total);
      try {
        const orderInfo = await Exec.openMarket({
  okx: this.okx,
  instId: c.instId,
  side,
  marginUSDT: 20,
  leverage: 20
});

        const now = Date.now();
        const timeoutAt = now + 5*60*1000;
        this.state.open.set(c.instId, {
  sym: c.sym, side,
  entryPx: orderInfo.entryPx,
  tsOpen: now, timeoutAt,
  beArmed: false, trailActive: false,
  regime: c.scored.mode==="MR"?"MR":"TF",
  params, scored: c.scored, feat: c.feat,
  tdMode: (orderInfo.tdMode || "isolated")
});

        Logger.logDecision({
          ts_open: now, instId: toInstId(c).sym, regime: (c.scored.mode==="MR"?"MR":"TF"),
          scores: c.scored, params,
          features: Indicators.pickFeaturesForLog(c.feat),
          entry: { side, px: orderInfo.entryPx, sz: orderInfo.sz }
        });
        this.log(`OPEN ${c.sym} ${side} @${orderInfo.entryPx} (score=${c.scored.total})`);
      } catch(e){
        this.log(`OPEN ERR ${c.sym}: ${e.message||e}`);
      }
    }
  },

  async manageLoop(){
    const now = Date.now();

    for (const [instId, pos] of [...this.state.open.entries()]) {
      try {
        const lastPx = await Market.getLast(instId);
        if (!lastPx) continue;
        const dir = pos.side === "LONG" ? 1 : -1;
        const changePct = (lastPx - pos.entryPx) / pos.entryPx * dir;

        if (!pos.beArmed && changePct >= (pos.params.be || 0.005)) {
          await Exec.moveToBE({ okx: this.okx, instId, entryPx: pos.entryPx, side: pos.side });
          pos.beArmed = true;
        }

        if (pos.beArmed && !pos.trailActive && changePct >= (pos.params.be || 0.005)) {
          await Exec.enableTrailing({ okx: this.okx, instId, distancePct: pos.params.trail || 0.0028, side: pos.side });
          pos.trailActive = true;
        }

        if (now >= pos.timeoutAt) {
          const res = await Exec.closeMarket({ okx: this.okx, instId, reason: "TIMEOUT" });
          this.state.open.delete(instId);
          Logger.finishTrade(instId, { reason: "TIMEOUT", exitPx: res.exitPx, fees: res.fees, pnl: res.pnl, ts_open: pos.tsOpen, ts_close: Date.now(), instId: toInstId(pos).sym });
          this.log(`CLOSE TIMEOUT ${pos.sym} pnl=${res.pnl?.toFixed?res.pnl.toFixed(2):res.pnl} USDT`);
          Risk.onTradeResult(this.state, pos, res.pnl||0, this.cfg.risk);
          continue;
        }

        const maybeClosed = await Exec.checkClosed({ okx: this.okx, instId });
        if (maybeClosed) {
          this.state.open.delete(instId);
          Logger.finishTrade(instId, { ...maybeClosed.log, ts_open: pos.tsOpen, ts_close: Date.now(), instId: toInstId(pos).sym });
          this.log(`CLOSE ${pos.sym} ${maybeClosed.log.reason} pnl=${maybeClosed.log.pnl?.toFixed?maybeClosed.log.pnl.toFixed(2):maybeClosed.log.pnl} USDT`);
          Risk.onTradeResult(this.state, pos, maybeClosed.log.pnl||0, this.cfg.risk);
        }
      } catch(e){
        this.log("manageLoop error: " + (e.message||e));
      }
    }

    if (!this.state.stopDay && Risk.shouldStopDay(this.state, this.cfg.risk)) {
      this.state.stopDay = true;
      this.log("STOP-DAY déclenché (−25%).");
    }
  },

  log(m){ try{ this.logToUi(m); }catch{} }
};

module.exports = Engine;


