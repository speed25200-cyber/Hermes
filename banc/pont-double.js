// Le double du pont : memes canaux que le moteur, scene fixe.
// Aucune cle, aucun reseau, aucun ordre.
"use strict";
(function () {
  const POSITIONS = [
    { symbol: "MEGA-USDT-SWAP", side: "LONG", leverage: 15,
      entryPrice: 0.03841, markPrice: 0.03827, size: 1940, notional: 74.21, margin: 4.96,
      entryTime: Date.now() - 137 * 60000, liqPrice: 0.03661,
      unrealizedPnl: -0.26, pnlPctOfMargin: -5.40,
      takeProfit: 0.03941, stopLoss: 0.03762, stopActuel: 0.03762, stopMode: "INIT",
      trailArme: true, protection: null },
    { symbol: "AXS-USDT-SWAP", side: "LONG", leverage: 15,
      entryPrice: 0.9134, markPrice: 0.9071, size: 84.6, notional: 76.70, margin: 5.14,
      entryTime: Date.now() - 154 * 60000, liqPrice: 0.8704,
      unrealizedPnl: -0.53, pnlPctOfMargin: -10.34,
      takeProfit: 0.9624, stopLoss: 0.8954, stopActuel: 0.9210, stopMode: "TRAIL",
      trailArme: true, protection: null },
  ];
  const PF = {
    futures: { total: 10.86, available: 1.29, unrealizedPnL: -0.79 },
    positions: { count: 2, totalValue: 150.9, totalMargin: 10.1 },
    performance: { winrate: 100, winrate24: 100, gagnees: 3, gagnees24: 2, dailyPnL: 1.13, totalTrades: 3, dailyTrades: 2, dailyVolume: 150 },
    positionsFermees: [
      { symbol: "SOON-USDT-SWAP", side: "SHORT", leverage: 15, openTime: Date.now() - 9 * 3600e3, closeTime: Date.now() - 2 * 3600e3,
        entryPrice: 0.4181, closePrice: 0.4013, pnl: 0.62, pnlRatio: 12.4 },
      { symbol: "AXS-USDT-SWAP", side: "LONG", leverage: 15, openTime: Date.now() - 26 * 3600e3, closeTime: Date.now() - 14 * 3600e3,
        entryPrice: 0.8712, closePrice: 0.8931, pnl: 0.51, pnlRatio: 9.8 },
      { symbol: "MEGA-USDT-SWAP", side: "LONG", leverage: 15, openTime: Date.now() - 31 * 3600e3, closeTime: Date.now() - 27 * 3600e3,
        entryPrice: 0.0361, closePrice: 0.0369, pnl: 0.21, pnlRatio: 4.1 },
    ],
    openPositionsDetails: POSITIONS,
    dealsRecent: [],
    history: { spot: Array.from({ length: 80 }, (_, i) => ({ t: Date.now() - (80 - i) * 60000, v: 11.4 - i * 0.007 })) },
    clesOkx: true,
  };
  const PAS = { "1m": 60e3, "5m": 300e3, "15m": 900e3, "1H": 3600e3, "4H": 14400e3, "1D": 86400e3 };
  function chandelles(graine, dernier, n, pas) {
    let x = graine;
    const alea = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
    const rows = [];
    let prix = dernier * (1 + 0.04 * (alea() - 0.5));
    const t0 = Date.now() - n * pas;
    for (let i = 0; i < n; i++) {
      const derive = (dernier - prix) / (n - i);
      const o = prix, c = prix + derive + prix * 0.004 * (alea() - 0.5);
      rows.push([t0 + i * pas, o, Math.max(o, c) * (1 + 0.0018 * alea()), Math.min(o, c) * (1 - 0.0018 * alea()), c, 4000 + 12000 * alea()]);
      prix = c;
    }
    return rows;
  }
  const il_y_a = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  const mes = (t, w, n) => ({ trades: t, winrate: w, netMarge: n });
  const LABO = {
    ok: true,
    moteur: true,
    capital: { equite: 13.87, places: 3, parTrade: 4.16, ouvertes: 2, engage: 10.1, budget: 12.48 },
    guet: {
      "AXS-USDT-SWAP":  { ts: Date.now(), bougie: Date.now() - 3 * 60e3, sig: "run5_5m", dir: 0, prix: 0.9071, dernierSignal: Date.now() - 154 * 60e3, garde: "enPosition" },
      "MEGA-USDT-SWAP": { ts: Date.now(), bougie: Date.now() - 4 * 60e3, sig: "run5_5m", dir: 0, prix: 0.03827, dernierSignal: Date.now() - 137 * 60e3, garde: "enPosition" },
      "DOGE-USDT-SWAP": { ts: Date.now(), bougie: Date.now() - 2 * 60e3, sig: "z48_5m", dir: 0, prix: 0.2131, dernierSignal: null, garde: null },
      "ZEC-USDT-SWAP":  { ts: Date.now(), bougie: Date.now() - 6 * 60e3, sig: "keltner3", dir: 0, prix: 141.2, dernierSignal: null, garde: "budget" },
      "PEPE-USDT-SWAP": { ts: Date.now(), bougie: Date.now() - 1 * 60e3, sig: "meche_regime", dir: 0, prix: 0.0000094, dernierSignal: Date.now() - 41 * 60e3, garde: null },
      "SOL-USDT-SWAP":  { ts: Date.now(), bougie: Date.now() - 3 * 60e3, sig: "donchian_fade", dir: 0, prix: 199.4, dernierSignal: null, garde: null },
    },
    joue: { source: "chercheur", strats: {} },
    historique: [
      { ts: il_y_a(36), dureeS: 512, perles: 4 },
      { ts: il_y_a(24), dureeS: 498, perles: 5 },
      { ts: il_y_a(12), dureeS: 505, perles: 6 },
    ],
    roster: {
      genere: il_y_a(3), dureeS: 505,
      fenetres: { jours: 30, validationJours: 7 },
      hasard: { tirages: 12, percentile: 0.90 },
      candidats: new Array(20).fill("x"),
      perles: {
        "AXS-USDT-SWAP":  { sig: "run5_5m",       ov: { tpPctMargin: .4, trailActPctMargin: .3, holdMs: 12*3600e3 },
          mesures: { a: mes(18, 72, 1.90), b: mes(16, 69, 1.52), sel: { ...mes(34, 71, 3.42), longs: { trades: 21, winrate: 76 }, shorts: { trades: 13, winrate: 62 } }, val: mes(9, 67, .88) },
          nul: { tirages: 12, taux: 0.25, percentile: 1, median: 0.0181 },
          finalistes: [
            { sig: "run5_5m", ov: { tpPctMargin: .4, trailActPctMargin: .3, holdMs: 12*3600e3 }, wr: 71, net: 3.42 },
            { sig: "keltner3", ov: { tpPctMargin: .6, trailActPctMargin: .2, holdMs: 8*3600e3 }, wr: 66, net: 2.10 },
            { sig: "z48_5m", ov: { tpPctMargin: .3, trailActPctMargin: .15, holdMs: 24*3600e3 }, wr: 61, net: 1.40 },
          ] },
        "MEGA-USDT-SWAP": { sig: "run5_5m",       ov: { tpPctMargin: .4, trailActPctMargin: .3, holdMs: 24*3600e3 },
          mesures: { a: mes(15, 66, 1.10), b: mes(13, 62, 1.00), sel: mes(28, 64, 2.10), val: mes(7, 71, 1.05) },
          nul: { tirages: 12, taux: 0.42, percentile: 0.92, median: 0.0244 } },
        "DOGE-USDT-SWAP": { sig: "z48_5m",        ov: { tpPctMargin: .6, trailActPctMargin: .2, holdMs: 8*3600e3 },
          mesures: { a: mes(10, 80, 2.20), b: mes(9, 78, 1.85), sel: mes(19, 79, 4.05), val: mes(6, 50, .31) } },
        "ZEC-USDT-SWAP":  { sig: "keltner3",      ov: { tpPctMargin: .8, trailActPctMargin: .3, holdMs: 12*3600e3 },
          mesures: { a: mes(8, 62, .95), b: mes(7, 58, .80), sel: mes(15, 60, 1.75), val: mes(5, 80, 1.60) } },
        "PEPE-USDT-SWAP": { sig: "meche_regime",  ov: { tpPctMargin: .3, trailActPctMargin: .15, holdMs: 8*3600e3 },
          mesures: { a: mes(21, 67, 1.55), b: mes(20, 65, 1.35), sel: mes(41, 66, 2.90), val: mes(11, 64, .95) } },
        "SOL-USDT-SWAP":  { sig: "donchian_fade", ov: { tpPctMargin: .6, trailActPctMargin: .2, holdMs: 12*3600e3 },
          mesures: { a: mes(9, 84, 1.95), b: mes(8, 80, 1.65), sel: mes(17, 82, 3.60), val: mes(5, 60, .55) } },
      },
      refus: {
        "BTC-USDT-SWAP":   { raison: "le vainqueur (rsi5m, wr 58 %) echoue en validation", concourantes: 4,
          vainqueur: { sig: "rsi5m", ov: { tpPctMargin: .6, trailActPctMargin: .2, holdMs: 12*3600e3 }, porte: "negatif",
            mesures: { a: mes(11, 60, .90), b: mes(12, 56, .60), sel: mes(23, 58, 1.50), val: mes(7, 43, -.42) } },
          finalistes: [
            { sig: "rsi5m", ov: { tpPctMargin: .6, trailActPctMargin: .2, holdMs: 12*3600e3 }, wr: 58, net: 1.50 },
            { sig: "donchian_fade", ov: { tpPctMargin: .4, trailActPctMargin: .3, holdMs: 8*3600e3 }, wr: 56, net: 1.20 },
          ] },
        "ETH-USDT-SWAP":   { raison: "aucune concourante positive dans A et B", concourantes: 0,
          presque: { sig: "vwap_reclaim", ov: { tpPctMargin: .3, trailActPctMargin: .15, holdMs: 8*3600e3 }, wr: 52, porte: "negB",
            mesures: { a: mes(14, 57, .80), b: mes(13, 46, -.31), sel: mes(27, 52, .49) } } },
        "XRP-USDT-SWAP":   { raison: "aucune concourante positive dans A et B", concourantes: 2 },
        "TRUMP-USDT-SWAP": { raison: "le vainqueur (bb_range, wr 63 %) echoue en validation", concourantes: 3,
          vainqueur: { sig: "bb_range", ov: { tpPctMargin: .6, trailActPctMargin: .2, holdMs: 8*3600e3 }, porte: "wr",
            mesures: { a: mes(9, 66, .70), b: mes(9, 60, .55), sel: mes(18, 63, 1.25), val: mes(6, 33, -.20) } } },
        "HYPE-USDT-SWAP":  { raison: "aucune concourante positive dans A et B", concourantes: 1 },
        "SUI-USDT-SWAP":   { raison: "histoire trop courte", concourantes: 0 },
        "INJ-USDT-SWAP":   { raison: "battue par le hasard (58e percentile, il en faut 90)", concourantes: 6,
          vainqueur: { sig: "meche15m", ov: { tpPctMargin: .3, trailActPctMargin: .15, holdMs: 8*3600e3 }, porte: "hasard",
            mesures: { a: mes(12, 74, 1.20), b: mes(11, 70, .95), sel: mes(23, 72, 2.15), val: mes(8, 75, .72) } },
          nul: { tirages: 12, taux: 0.58, percentile: 0.58, median: 0.0904 },
          finalistes: [
            { sig: "meche15m", ov: { tpPctMargin: .3, trailActPctMargin: .15, holdMs: 8*3600e3 }, wr: 72, net: 2.15 },
          ] },
      },
    },
  };

  window.api = {
    invoke: async (canal, arg) => {
      if (canal === "fetch-portfolio") return { ok: true, data: PF };
      if (canal === "get-ai-state")   return { ok: true, logs: [
        { ts: Date.now() - 60e3, event: "H15_ENTER", symbol: "AXS-USDT-SWAP", side: "LONG", margin: 5.14, lev: 15 },
        { ts: Date.now(), event: "GUARD_OK", stops: 2, orphans: 0 },
      ] };
      if (canal === "ai:live-status") return { ok: true, liveEnabled: true };
      if (canal === "ui-mode")        return { ok: true, mode: "full" };
      if (canal === "laboratoire") {
        if (window.__passeEnCours) return { ...LABO, progression: { debut: new Date(Date.now() - 83e3).toISOString(), rang: 7, total: 20, instId: "SOL" } };
        return LABO;
      }
      if (canal === "chercher-perles") { window.__passeEnCours = true; return { ok: true, lance: true }; }
      if (canal === "chandelles") {
        const p = POSITIONS.find((q) => q.symbol === arg.instId);
        const dernier = p ? p.markPrice : 1;
        return { ok: true, instId: arg.instId, bar: arg.bar,
                 rows: chandelles(42 + arg.instId.length, dernier, 300, PAS[arg.bar] || 300e3),
                 last: dernier };
      }
      return { ok: true };
    },
    on: () => () => {},
    subscribe: () => () => {},
    surSante: (fn) => { fn({}); },
    surLien: (fn) => { fn({ relie: true }); },
  };
})();
