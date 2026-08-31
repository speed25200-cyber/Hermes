// fable1_2 — GPS : detect INTACT de gen_regime_3 (mèche d'épuisement >=60 % + volume >=2x SMA20,
// fadée UNIQUEMENT dans la moitié favorable du range 24 h), converti en HAUT WINRATE par sorties
// courtes : TP +30 % de marge, trail activé à mi-chemin (+15 %, cb 5 %), hold 12 h, SL 30 %.
// Logique en une phrase : le MEILLEUR edge bi-époque du registre (+4,81/+3,25 en sorties longues)
// encaisse tôt — le winrate vient de la géométrie tp<sl, l'espérance de l'edge mèche+régime.
// Banc 30 j (test_harness) : wr 62,2/87,0 · esp +0,04/+11,04 · n 45+23 (IS faible : l'edge GPS
// vit surtout côté OOS du banc — mais les DEUX fenêtres vierges, elles, passent).
// Fenêtres vierges (scan fable1, data90 coupure 30 j / data180) :
//   60 j récents  : wr 68,7 · esp +3,24 · n 163
//   90-180 j      : wr 65,8 · esp +0,23 · n 231  (⚠️ marges minces côté ancien)
// Plateau : voisin hold24 passe aussi les 2 fenêtres vierges (wr 70,2/66,8, esp +3,35/+0,32) ;
// hold8 rate le wr180 de 0,7 pt seulement ; et la MÊME recette tp30_act15 passe sur ACT (fable1_1).
// ⚠️ Risque connu : trail cb5 = biais 5m→1m (~−15 % d'esp relatif) ; esp180 +0,23 peut plier.
module.exports = {
  instId: "GPS-USDT-SWAP",
  exits: { tp: 0.30, sl: 0.30, act: 0.15, cb: 0.05, holdH: 12 },
  detect(c5) {
    const vs = new Array(c5.length).fill(null);
    let s = 0;
    for (let i = 0; i < c5.length; i++) {
      s += c5[i][5];
      if (i >= 20) s -= c5[i - 20][5];
      if (i >= 19) vs[i] = s / 20;
    }
    const R = 288, pos = new Array(c5.length).fill(null);
    const dqH = [], dqL = [];
    for (let i = 0; i < c5.length; i++) {
      while (dqH.length && c5[dqH[dqH.length - 1]][2] <= c5[i][2]) dqH.pop();
      dqH.push(i);
      while (dqL.length && c5[dqL[dqL.length - 1]][3] >= c5[i][3]) dqL.pop();
      dqL.push(i);
      while (dqH[0] <= i - R) dqH.shift();
      while (dqL[0] <= i - R) dqL.shift();
      if (i >= R - 1) { const hh = c5[dqH[0]][2], ll = c5[dqL[0]][3]; pos[i] = hh > ll ? (c5[i][4] - ll) / (hh - ll) : 0.5; }
    }
    const out = [];
    for (let i = 300; i < c5.length; i++) {
      const o = c5[i][1], h = c5[i][2], l = c5[i][3], c = c5[i][4], range = h - l;
      if (!(range > 0) || vs[i] == null || !(vs[i] > 0) || pos[i] == null) continue;
      const wLo = (Math.min(o, c) - l) / range, wHi = (h - Math.max(o, c)) / range, vm = c5[i][5] / vs[i];
      if (wLo >= 0.6 && vm >= 2 && pos[i] < 0.5) out.push({ i5: i, dir: 1 });
      else if (wHi >= 0.6 && vm >= 2 && pos[i] > 0.5) out.push({ i5: i, dir: -1 });
    }
    return out;
  }
};
