// SCAN 2 "EFFICACITÉ DU DÉPLACEMENT" (agent inv_efficacite_, 30/08) — ajustement après passe 1 :
// la CHARGE en volume (vr >= 1,3) détruit (delta worst moyen -2,88) → on teste l'inverse : le ressort
// se comprime À SEC (vr <= 0,8 : le volume se tarit pendant la compression). + fenêtre W144 ajoutée.
// volmode : off = pas de condition · sec = vr <= 0,8.
const fs = require("fs");
const path = require("path");
const { chargerCandles, evaluer } = require("../harness_lib.js");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const EXITS = {
  E1: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  E2: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 }
};
const WS = [24, 48, 96, 144];
const ENS = [0.30, 0.45];
const BS = [0.10, 0.20];
const VOLMODES = ["off", "sec"];
const SEC = 0.8;
const START_PAD = 288;
const BLOCK = new Set(("AAOI AAPL AMD AMZN AVGO AXTI BARD BEAT BILL BZ CBRS CC CHIP CL COIN CRCL CXMT DRAM EWY GOOGL " +
  "INTC LITE META MINIMAX MRVL MSFT MSTR MU NBIS NVDA OPG QQQ ROBO SAMSUNG SKDD SKHY SKHYNIX SLX SNDK SNXX SOXL SOXS " +
  "SPACE SPCX SPX SPY TQQQ TRUMP TSLA TSM UNITREE XAG XAU XAUT XCU XIAOMI ZHIPU GLD HOOD").split(" "));

function precalc(c5) {
  const n = c5.length;
  const pAbs = new Float64Array(n), pLow = new Float64Array(n), pUp = new Float64Array(n), pVol = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = c5[i][1], h = c5[i][2], l = c5[i][3], c = c5[i][4], v = c5[i][5];
    pAbs[i] = (i ? pAbs[i - 1] : 0) + (i ? Math.abs(c - c5[i - 1][4]) : 0);
    pLow[i] = (i ? pLow[i - 1] : 0) + Math.max(0, Math.min(o, c) - l);
    pUp[i] = (i ? pUp[i - 1] : 0) + Math.max(0, h - Math.max(o, c));
    pVol[i] = (i ? pVol[i - 1] : 0) + (v > 0 ? v : 0);
  }
  const par = {};
  for (const W of WS) {
    const start = W + START_PAD;
    const edn = new Float64Array(n).fill(NaN);
    const biais = new Float64Array(n).fill(NaN);
    const vr = new Float64Array(n).fill(NaN);
    const sq = Math.sqrt(W);
    for (let i = start; i < n; i++) {
      const chemin = pAbs[i] - pAbs[i - W];
      if (chemin <= 0) continue;
      const net = Math.abs(c5[i][4] - c5[i - W][4]);
      edn[i] = (net / chemin) * sq;
      const mLow = pLow[i] - pLow[i - W], mUp = pUp[i] - pUp[i - W];
      if (mLow + mUp > 0) biais[i] = (mLow - mUp) / (mLow + mUp);
      const volW = (pVol[i] - pVol[i - W]) / W;
      const volBase = (pVol[i - W] - pVol[i - W - START_PAD]) / START_PAD;
      if (volBase > 0) vr[i] = volW / volBase;
    }
    par[W] = { edn, biais, vr };
  }
  return par;
}

const fichiers = fs.readdirSync(DATA_DIR).filter(f => f.endsWith(".json"));
const lignes = [];
let scanned = 0;
for (const f of fichiers) {
  const instId = f.replace(".json", "");
  const base = instId.split("-")[0];
  if (BLOCK.has(base)) continue;
  let c5; try { c5 = chargerCandles("data", instId); } catch (e) { continue; }
  if (!Array.isArray(c5) || c5.length < 5000) continue;
  scanned++;
  const par = precalc(c5);
  for (const W of WS) {
    const { edn, biais, vr } = par[W];
    for (const EN of ENS) for (const B of BS) for (const vm of VOLMODES) for (const mode of ["brut", "conf"]) for (const sens of ["M", "A"]) {
      if (vm === "off" && W !== 144) continue; // off × 24/48/96 déjà couvert par la passe 1
      const sigs = [];
      for (let i = W + START_PAD; i < c5.length; i++) {
        if (!(edn[i] <= EN)) continue;
        if (Number.isNaN(biais[i])) continue;
        if (vm === "sec" && !(vr[i] <= SEC)) continue;
        let dir = 0;
        if (biais[i] >= B) dir = 1;
        else if (biais[i] <= -B) dir = -1;
        if (!dir) continue;
        if (sens === "A") dir = -dir;
        if (mode === "conf") {
          const o = c5[i][1], c = c5[i][4];
          if (dir > 0 && c < o) continue;
          if (dir < 0 && c > o) continue;
        }
        sigs.push({ i5: i, dir });
      }
      if (sigs.length < 30) continue;
      for (const ex of Object.keys(EXITS)) {
        const r = evaluer({ instId, exits: EXITS[ex], detect: () => sigs }, c5);
        if (!r.A || !r.B) continue;
        const valide = r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15;
        lignes.push({
          instId, W, EN, B, vm, mode, sens, ex,
          espIS: r.A.esp, espOOS: r.B.esp, nIS: r.A.n, nOOS: r.B.n,
          wrOOS: r.B.wr, pfOOS: r.B.pf,
          worst: Math.min(r.A.esp, r.B.esp), valide
        });
      }
    }
  }
}
lignes.sort((a, b) => b.worst - a.worst);
fs.writeFileSync(path.join(__dirname, "rapports", "inv_efficacite_scan2_resultats.json"), JSON.stringify(lignes, null, 1));
const valides = lignes.filter(l => l.valide);
console.log("cryptos:", scanned, "lignes:", lignes.length, "valides:", valides.length);
for (const l of valides.slice(0, 40))
  console.log(`${l.instId} W${l.W} EN${l.EN} B${l.B} ${l.vm} ${l.mode} ${l.sens} ${l.ex} worst ${l.worst} (IS ${l.espIS}/${l.nIS} OOS ${l.espOOS}/${l.nOOS} pf ${l.pfOOS} wr ${l.wrOOS})`);
