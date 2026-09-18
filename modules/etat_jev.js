/* ============================================================================
   L'etat que Jev voit, et les questions qu'on lui pose — FIGES.

   Jev ne lit pas une serie : il juge un etat. Ce module fabrique cet etat a
   partir des bougies 1 minute closes et de ce que le moteur sait deja
   (prix, funding, range 24 h, regime), sous une forme compacte, relative
   et lisible — des rendements en points de base plutot que des prix, des
   volumes relatifs plutot qu'absolus. Un prix absolu ne dit rien a un
   modele qui n'a pas vu cet instrument ; « +32 bps en 5 minutes sur un
   volume double » dit quelque chose a n'importe qui.

   Les questions sont ecrites UNE fois, ici, et une signature les
   accompagne partout : chaque decision journalisee porte la signature des
   questions qui l'ont produite. Changer un mot change la signature, donc
   invalide les mesures precedentes — c'est voulu. Reformuler une question
   apres avoir vu un chiffre est un essai non compte, et c'est exactement
   le mecanisme qui trouvait des perles sur des journees melangees
   (avantage.md).

   Elles sont en anglais : c'est la langue de l'entrainement du modele, et
   le libelle n'a pas vocation a etre lu par le proprietaire — il est
   explique en francais dans docs/jev.md.

   Rien ici ne touche le reseau. Tout est pur : un etat entre, un objet
   sort. Le banc et le vivant appellent EXACTEMENT ces fonctions — une
   seule formule, deux consommateurs, comme signaux.js.
   ============================================================================ */
"use strict";

const crypto = require("crypto");

const VERSION = 1;
const HORIZON_MIN_DEFAUT = Number(process.env.HERMES_JEV_HORIZON_MIN || 15);
const N_HEURE = 60;
const N_COURT = 5;
const N_SERIE = 20;        // bougies recentes montrees une par une

/* Les seuils de decision. Ils sont des reglages, pas des questions : les
   changer ne change pas la signature, et le banc les choisit sur la
   premiere moitie de la fenetre pour les mesurer sur la seconde. */
const SEUILS_DEFAUT = {
  sens: Number(process.env.HERMES_JEV_SEUIL_SENS || 0.65),   // proba du sens retenu
  cout: Number(process.env.HERMES_JEV_SEUIL_COUT || 0.60),   // proba que le mouvement depasse le cout
};

/* ----- les questions ----- */

const QUESTIONS = {
  direction: {
    type: "choice",
    instructions: {
      question: "Over the next `horizonMin` minutes, in which direction will the mid price of `instrument` move by MORE than `coutAllerRetourBps` basis points (the round-trip cost)?",
      context: "This is a USDT-margined perpetual swap on OKX. Blocks of one minute. The decision is made now, at the close of the last one-minute candle, and held until the horizon or until a stop/take-profit. The trade only pays if the net move beats the round-trip cost.",
      inputs: "`rendementsBps` are past returns over 1, 5, 15 and 60 minutes. `serie` lists the last minutes, newest last, each as `return_bps/volume_relative`. `volatilite` gives realized volatility (bps per hour) and the ratio of the last 5 minutes to the last hour. `volume` compares the last 5 minutes to the hourly average. `rangePos24h` is where the price sits in its 24-hour range (0 = low, 1 = high). `funding` is the current funding rate in bps per 8 hours. `regime` is the broad market state. `spreadBps` is the current bid-ask spread. If `autorise.long` is false, a long cannot be taken, and likewise for short.",
    },
    criteria: {
      long: "The price is more likely to be higher than now by more than the round-trip cost at the horizon.",
      short: "The price is more likely to be lower than now by more than the round-trip cost at the horizon.",
      aucun: "No net move beyond the round-trip cost is expected in either direction, or the evidence does not favour one side.",
    },
  },
  depasse_cout: {
    type: "noul",
    instructions: "Will the ABSOLUTE move of `instrument` over the next `horizonMin` minutes exceed `coutAllerRetourBps` basis points, in either direction? Judge the likely size of the move, not its direction.",
  },
  conviction: {
    type: "score",
    instructions: "How strong and coherent is the evidence in this state for a directional move over the horizon? Judge the agreement between flow, volatility, position in range and recent path.",
    criteria: [
      "1 — Contradictory or absent evidence; the state looks like noise.",
      "2 — Weak evidence; one indicator leans one way, the others are flat.",
      "3 — Moderate evidence; two or more indicators agree but volatility or volume is unremarkable.",
      "4 — Strong evidence; several indicators agree and volume or volatility confirms activity.",
      "5 — Very strong, coherent evidence across flow, volatility, range position and recent path. Use rarely.",
    ],
  },
};

const SIGNATURE = crypto.createHash("sha1").update(JSON.stringify({ VERSION, QUESTIONS })).digest("hex").slice(0, 12);

/* ----- l'etat ----- */

function arrondi(x, d) { const f = Math.pow(10, d); return Math.round(x * f) / f; }

function rendementBps(closes, k) {
  const n = closes.length;
  if (n <= k) return null;
  return arrondi((closes[n - 1] / closes[n - 1 - k] - 1) * 1e4, 1);
}

function volatiliteBpsHeure(closes, n) {
  const m = closes.length;
  if (m < n + 1) return null;
  const r = [];
  for (let i = m - n; i < m; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  const mu = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - mu) * (b - mu), 0) / Math.max(1, r.length - 1);
  return Math.sqrt(v) * Math.sqrt(60) * 1e4;   // par minute -> par heure, en bps
}

/* Construit l'etat. Tout ce qui manque est omis, jamais invente : un
   champ absent est une information (« pas de funding connu »), un zero
   invente est un mensonge.

     p.instId        "BTC-USDT-SWAP"
     p.bougies       bougies 1 m CLOSES ascendantes [ts,o,h,l,c,vol,volQuote], >= 61
     p.tick          { lastPrice, bidPx, askPx, fundingRate, high24Price, low24Price }
     p.regime        { etat, force } ou null
     p.autorise      { long, short }
     p.fraisTaker    fraction par jambe (0.0005)
     p.horizonMin    minutes */
function construireEtat(p) {
  const b = p.bougies;
  if (!Array.isArray(b) || b.length < N_HEURE + 1) return null;
  const closes = b.map((k) => k[4]);
  const vols = b.map((k) => k[5]);
  const n = b.length;
  const prix = closes[n - 1];
  const tick = p.tick || {};
  const horizon = p.horizonMin || HORIZON_MIN_DEFAUT;

  const spreadBps = (tick.bidPx > 0 && tick.askPx > 0) ? arrondi((tick.askPx - tick.bidPx) / prix * 1e4, 1) : null;
  const frais = Number.isFinite(p.fraisTaker) ? p.fraisTaker : 0.0005;
  // Le cout aller-retour en bps de PRIX : deux jambes de frais, plus le
  // spread qu'une entree au marche paie. C'est ce que le mouvement doit
  // battre, et c'est ce qu'on demande au modele de juger.
  const coutBps = arrondi(2 * frais * 1e4 + (spreadBps || 0), 1);

  const volH = volatiliteBpsHeure(closes, N_HEURE);
  const volC = volatiliteBpsHeure(closes, N_COURT);
  const volMoyH = vols.slice(n - N_HEURE).reduce((a, x) => a + x, 0) / N_HEURE;
  const volC5 = vols.slice(n - N_COURT).reduce((a, x) => a + x, 0) / N_COURT;

  const serie = [];
  for (let i = n - N_SERIE; i < n; i++) {
    const r = (closes[i] / closes[i - 1] - 1) * 1e4;
    const vr = volMoyH > 0 ? vols[i] / volMoyH : 0;
    serie.push(`${r >= 0 ? "+" : ""}${r.toFixed(0)}/${vr.toFixed(1)}`);
  }

  let rangePos = null;
  const h24 = Number(tick.high24Price), l24 = Number(tick.low24Price);
  if (h24 > l24 && l24 > 0) rangePos = arrondi((prix - l24) / (h24 - l24), 2);
  else {
    const fen = b.slice(-Math.min(n, 1440));
    const hh = Math.max(...fen.map((k) => k[2])), ll = Math.min(...fen.map((k) => k[3]));
    if (hh > ll) rangePos = arrondi((prix - ll) / (hh - ll), 2);
  }

  const etat = {
    instrument: p.instId,
    ts: b[n - 1][0],
    horizonMin: horizon,
    coutAllerRetourBps: coutBps,
    spreadBps,
    rendementsBps: { m1: rendementBps(closes, 1), m5: rendementBps(closes, 5), m15: rendementBps(closes, 15), m60: rendementBps(closes, 60) },
    volatilite: { bpsParHeure: volH == null ? null : arrondi(volH, 0), ratioCourtLong: (volH > 0 && volC != null) ? arrondi(volC / volH, 2) : null },
    volume: { ratio5minSurHeure: volMoyH > 0 ? arrondi(volC5 / volMoyH, 2) : null },
    rangePos24h: rangePos,
    serie: serie.join(" "),
    autorise: { long: p.autorise ? !!p.autorise.long : true, short: p.autorise ? !!p.autorise.short : true },
  };
  if (typeof tick.fundingRate === "number") etat.funding = { bpsPar8h: arrondi(tick.fundingRate * 1e4, 2) };
  if (p.regime && p.regime.etat) etat.regime = { etat: p.regime.etat, force: p.regime.force == null ? null : arrondi(p.regime.force, 2) };
  return etat;
}

/* ----- la lecture de la reponse ----- */

/* La regle de decision. Elle est ECRITE, pas apprise : long si le sens
   « long » porte au moins `seuils.sens` de probabilite ET que le
   mouvement a au moins `seuils.cout` de chances de depasser le cout.
   Symetrique pour short. Sinon rien.

   Le seuil n'est jamais 0,5 : un noul a 0,5 dit « autant oui que non »,
   et une position a x15 n'est pas ce qu'on ouvre sur un pile ou face. */
function decider(reponse, seuils, autorise) {
  const s = { ...SEUILS_DEFAUT, ...(seuils || {}) };
  const a = reponse && reponse.answers;
  if (!a || !a.direction) return { sens: null, motif: "reponse vide" };
  const pr = a.direction.probabilities || {};
  const pLong = Number(pr.long ?? (a.direction.choice === "long" ? 1 : 0)) || 0;
  const pShort = Number(pr.short ?? (a.direction.choice === "short" ? 1 : 0)) || 0;
  const pAucun = Number(pr.aucun ?? (a.direction.choice === "aucun" ? 1 : 0)) || 0;
  const dc = a.depasse_cout || {};
  const pDepasse = typeof dc.probability === "number" ? dc.probability
    : (dc.probabilities && typeof dc.probabilities.true === "number") ? dc.probabilities.true
    : (typeof dc.choice === "boolean" ? (dc.choice ? 1 : 0) : null);
  const conv = a.conviction ? (a.conviction.score ?? a.conviction.choice ?? null) : null;

  const base = { pLong: arrondi(pLong, 3), pShort: arrondi(pShort, 3), pAucun: arrondi(pAucun, 3), pDepasse: pDepasse == null ? null : arrondi(pDepasse, 3), conviction: conv, seuils: s };
  if (pDepasse == null || pDepasse < s.cout) return { ...base, sens: null, motif: `mouvement sous le cout (${base.pDepasse})` };
  const ok = autorise || { long: true, short: true };
  if (pLong >= s.sens && pLong > pShort && ok.long) return { ...base, sens: "long", motif: `long ${base.pLong} · depasse ${base.pDepasse}` };
  if (pShort >= s.sens && pShort > pLong && ok.short) return { ...base, sens: "short", motif: `short ${base.pShort} · depasse ${base.pDepasse}` };
  return { ...base, sens: null, motif: `aucun sens au-dessus de ${s.sens}` };
}

/* Estimation grossiere des tokens d'entree : quatre caracteres par
   token est l'ordre de grandeur habituel. Sert au budget, pas a la
   facture — la facture, c'est l'API qui la fait. */
function estimerTokens(etat) {
  return Math.ceil((JSON.stringify(etat).length + JSON.stringify(QUESTIONS).length) / 4);
}

module.exports = { VERSION, SIGNATURE, QUESTIONS, SEUILS_DEFAUT, HORIZON_MIN_DEFAUT, construireEtat, decider, estimerTokens, N_HEURE };
