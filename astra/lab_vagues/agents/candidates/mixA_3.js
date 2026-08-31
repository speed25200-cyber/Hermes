// mixA_3 — ONT : MFI14 extrême (argent qui a fui/afflué en excès) confirmé par TRIX18 étiré (le momentum
// lissé pointe dans le même sens extrême). Logique en une phrase : quand le flux d'argent pondéré par le
// volume ET le momentum lissé sont TOUS LES DEUX à un extrême simultané, c'est une double confirmation
// d'épuisement — on fade.
// Réglages retenus par le scanner mix_scan_mixA.js : MFI14 setting0 (20/80) × TRIX18 setting0 (±0,03 %).
// Autonome : tout le calcul est ici, aucune dépendance au labo (seulement "technicalindicators", npm).
const { MFI, TRIX } = require("technicalindicators");

const MFI_LO = 20, MFI_HI = 80;
const TRIX_LO = -0.03, TRIX_HI = 0.03; // %

function alignEnd(n, arr) {
  const pad = n - arr.length;
  const out = new Array(Math.max(0, pad)).fill(null);
  for (let k = 0; k < arr.length; k++) out.push(arr[k]);
  return out;
}

module.exports = {
  instId: "ONT-USDT-SWAP",
  exits: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 8 },
  detect(c5) {
    const n = c5.length;
    const close = c5.map(b => b[4]);
    const high = c5.map(b => b[2]);
    const low = c5.map(b => b[3]);
    const vol = c5.map(b => b[5]);

    const mfi = alignEnd(n, MFI.calculate({ period: 14, high, low, close, volume: vol }));
    const trix = alignEnd(n, TRIX.calculate({ period: 18, values: close }));

    const out = [];
    for (let i = 100; i < n; i++) {
      const m = mfi[i], t = trix[i];
      if (m == null || t == null) continue;
      const mfiLong = m < MFI_LO, mfiShort = m > MFI_HI;
      const trixLong = t < TRIX_LO, trixShort = t > TRIX_HI;
      if (mfiLong && trixLong) out.push({ i5: i, dir: 1 });
      else if (mfiShort && trixShort) out.push({ i5: i, dir: -1 });
    }
    return out;
  },
};
