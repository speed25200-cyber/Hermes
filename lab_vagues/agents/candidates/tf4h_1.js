// CHANTIER TF 4H/DAILY — GRASS : z-score 5m extrême (SMA48 ±2,5σ, le signal live de GRASS)
// fadé UNIQUEMENT quand l'HEURE est elle-même étirée du même côté (z-score 1h SMA20 <= -0,5
// pour un long / >= +0,5 pour un short). Logique : ne ramasser l'excès 5m que si le marché
// est aussi sous sa moyenne horaire — l'étirement multi-échelle aligné augmente le snap-back.
// Plateau vérifié (scan 90 j, tools/rapports/tf4h_scan2.json) : z1h 0,5/1/1,5 ET z4h 0,5/1/1,5
// tous positifs sur les 3 fenêtres (60 j antérieurs + IS + OOS) ; version contra négative.
// Bougie 1h utilisée = dernière bougie 1h CLOSE (bucket UTC strictement antérieur) — zéro futur.
module.exports = {
  instId: "GRASS-USDT-SWAP",
  exits: { tp: 0.80, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 },
  detect(c5) {
    const N5 = 48, TH5 = 2.5, N1 = 20, TH1 = 0.5, MS = 3600 * 1000;
    const closes = c5.map(x => x[4]);
    // z-score 5m rolling (aucun futur)
    const z5 = new Array(c5.length).fill(null);
    let s = 0, s2 = 0;
    for (let i = 0; i < closes.length; i++) {
      s += closes[i]; s2 += closes[i] * closes[i];
      if (i >= N5) { const o = closes[i - N5]; s -= o; s2 -= o * o; }
      if (i >= N5 - 1) { const m = s / N5, v = Math.max(s2 / N5 - m * m, 1e-18); z5[i] = (closes[i] - m) / Math.sqrt(v); }
    }
    // bougies 1h agrégées (une bougie n'existe qu'une fois son bucket terminé)
    const A = []; let cur = null;
    for (let i = 0; i < c5.length; i++) {
      const b = Math.floor(c5[i][0] / MS);
      if (!cur || b !== cur.b) { if (cur) A.push(cur); cur = { b, c: c5[i][4] }; }
      else cur.c = c5[i][4];
    }
    // z-score 1h rolling sur les clôtures 1h
    const z1 = new Array(A.length).fill(null);
    let t = 0, t2 = 0;
    for (let k = 0; k < A.length; k++) {
      t += A[k].c; t2 += A[k].c * A[k].c;
      if (k >= N1) { const o = A[k - N1].c; t -= o; t2 -= o * o; }
      if (k >= N1 - 1) { const m = t / N1, v = Math.max(t2 / N1 - m * m, 1e-18); z1[k] = (A[k].c - m) / Math.sqrt(v); }
    }
    // pour chaque 5m : dernière bougie 1h STRICTEMENT close
    const out = []; let k = 0;
    for (let i = 300; i < c5.length; i++) {
      const b = Math.floor(c5[i][0] / MS);
      while (k < A.length && A[k].b < b) k++;
      const kc = k - 1;
      if (kc < N1 + 1 || z5[i] == null || z1[kc] == null) continue;
      if (z5[i] <= -TH5 && z1[kc] <= -TH1) out.push({ i5: i, dir: 1 });
      else if (z5[i] >= TH5 && z1[kc] >= TH1) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
