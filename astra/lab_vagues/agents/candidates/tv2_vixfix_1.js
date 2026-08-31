// RE : Mass Index [Donald Dorsey, 1992] "reversal bulge" — le range haut-bas se DILATE
// (le rapport EMA9(range)/EMA9(EMA9(range)) monte) jusqu'à faire franchir 26 à la somme
// glissante sur 25 bougies, PUIS se re-comprime sous 25,5 : la respiration du range est
// finie, la tendance qui l'a produite s'essouffle. Formule Pine EXACTE (mass index classique
// singleEMA=EMA9(high-low), doubleEMA=EMA9(singleEMA), ratio=singleEMA/doubleEMA, massIndex=
// somme(ratio,25)) ; Dorsey ne donne PAS de sens — on le lit sur le déplacement du prix PENDANT
// le renflement (armé au franchissement de 26, tiré au repli sous 25,5) : prix monté dans
// l'intervalle -> l'expansion/compression étouffe la hausse -> SHORT ; prix descendu -> LONG.
// Aucun repaint : EMA/somme/état tout causal, signal tiré à la bougie de repli sous 25,5.
// Robustesse (banc 30 j) : seule la paire hi/lo classique 26/25,5 vit (E1 worst 8.83, E2 5.79,
// même emaLen=9 cohérent sur les 2 exits) ; emaLen=12 et la paire stricte 27/26,5 sont négatifs
// (pic net mais confirmé par 2 exits, pas par le voisinage des seuils — à surveiller en live).
const EMA_LEN = 9, SUM_LEN = 25, HI = 26, LO = 25.5, MIN_MOVE = 0.003, WARM = 200;

function emaSeries(src, len) {
  const n = src.length, out = new Float64Array(n), a = 2 / (len + 1);
  out[0] = src[0];
  for (let i = 1; i < n; i++) out[i] = a * src[i] + (1 - a) * out[i - 1];
  return out;
}

module.exports = {
  instId: "RE-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 12 },
  detect(c5) {
    const n = c5.length;
    const high = c5.map(x => x[2]), low = c5.map(x => x[3]), close = c5.map(x => x[4]);
    const diff = new Float64Array(n);
    for (let i = 0; i < n; i++) diff[i] = high[i] - low[i];
    const s1 = emaSeries(diff, EMA_LEN), s2 = emaSeries(s1, EMA_LEN);
    const ratio = new Float64Array(n);
    for (let i = 0; i < n; i++) ratio[i] = s2[i] > 1e-12 ? s1[i] / s2[i] : 1;
    const mi = new Float64Array(n).fill(NaN);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += ratio[i];
      if (i >= SUM_LEN) sum -= ratio[i - SUM_LEN];
      if (i >= SUM_LEN - 1) mi[i] = sum;
    }
    const out = [];
    let armed = false, startIdx = -1;
    for (let i = WARM; i < n; i++) {
      if (Number.isNaN(mi[i]) || Number.isNaN(mi[i - 1])) continue;
      if (!armed && mi[i - 1] <= HI && mi[i] > HI) { armed = true; startIdx = i; }
      else if (armed && mi[i - 1] > LO && mi[i] <= LO) {
        const net = (close[i] - close[startIdx]) / close[startIdx];
        if (Math.abs(net) >= MIN_MOVE) out.push({ i5: i, dir: net > 0 ? -1 : 1 });
        armed = false;
      }
    }
    return out;
  }
};
