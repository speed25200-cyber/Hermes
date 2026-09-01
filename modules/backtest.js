/* ============================================================================
   Le simulateur — fidèle aux sorties VIVANTES, pas à un idéal de backtest.

   Ce que le moteur fait vraiment (GATE V2), et que ce fichier reproduit :

     entrée   au signal sur bougie close -> position prise à l'OPEN de la
              bougie suivante (le vivant entre au marché dans la seconde qui
              suit la clôture ; l'open suivant est l'approximation honnête)
     TP / SL  en % de la MARGE, convertis en prix via le levier
              (tp 0,80 à x15 = +5,33 % de prix)
     trail    move_order_stop OKX : s'arme quand le prix touche
              entrée × (1 + act/levier), puis suit le plus haut avec un
              rappel de cb/levier
     durée    fermeture au marché passé holdMs (le vivant vérifie chaque
              minute ; ici, au close de la bougie où l'échéance tombe)
     frais    taker 0,05 % du notionnel par jambe, les deux jambes — le
              vivant tente maker d'abord, compter taker partout est le
              choix conservateur

   À l'intérieur d'une bougie, l'ordre des extrêmes est inconnaissable.
   Chaque ambiguïté est tranchée CONTRE la stratégie : si le stop et le
   take-profit tiennent dans la même bougie, c'est le stop qui compte ;
   une ouverture en gap au-delà du stop sort au prix d'ouverture, pas au
   stop. Un backtest qui tranche pour soi fabrique des perles en verre.

   Et la règle de fidélité qui ne se voit pas : le vivant évalue chaque
   signal sur EXACTEMENT 299 bougies closes (limite REST 300, moins la
   bougie en cours). Le chercheur doit donc évaluer sur des fenêtres
   glissantes de 299 — évaluer sur tout l'historique testerait un autre
   programme que celui qui trade. C'est ce que fait serieSignaux().
   ============================================================================ */
"use strict";

const { evalSignal } = require("./signaux.js");

const FENETRE_VIVANTE = 299;   // ce que voit le moteur : 300 REST - la bougie en cours

/* La série des signaux d'un nom donné, bougie par bougie, chaque point
   évalué sur la même fenêtre que le vivant. Retour : tableau aligné sur
   c5, valeur 1/-1/0 (0 aussi pour les index trop tôt). */
function serieSignaux(sig, c5) {
  const out = new Array(c5.length).fill(0);
  const etat = {};
  for (let i = FENETRE_VIVANTE - 1; i < c5.length; i++) {
    out[i] = evalSignal(sig, c5.slice(i - FENETRE_VIVANTE + 1, i + 1), etat);
  }
  return out;
}

/* Simule les sorties du vivant sur une liste d'entrées.
     c5      bougies 5 m closes ascendantes [[ts,o,h,l,c,v],...]
     signaux série de serieSignaux (ou équivalente)
     sortie  { tpPctMargin, slPctMargin, trailActPctMargin, trailCbPctMargin, holdMs }
     lev     levier (le vivant : HERMES_DEFAULT_LEVERAGE, 15)
     frais   taux taker par jambe sur le notionnel (défaut 0,0005)
   Une seule position à la fois — le vivant refuse la ré-entrée sur un
   symbole déjà ouvert. */
function simuler({ c5, signaux, sortie, lev = 15, frais = 0.0005 }) {
  const trades = [];
  const tp = sortie.tpPctMargin / lev;
  const sl = sortie.slPctMargin / lev;
  const act = sortie.trailActPctMargin / lev;
  const cb = (sortie.trailCbPctMargin ?? 0.05) / lev;
  const fraisMarge = 2 * frais * lev;          // deux jambes, en fraction de la marge

  let pos = null;
  for (let i = 0; i < c5.length; i++) {
    const [ts, o, h, l] = c5[i];

    /* L'entrée AVANT les sorties, et c'est une question de fidélité, pas
       de style : le vivant attache TP/SL à l'instant même de l'entrée,
       et la bougie d'entrée peut toucher le stop juste après l'open.
       Traiter l'entrée après aurait fait rater les stops de la première
       bougie — rater un TP est conservateur, rater un SL ne l'est pas. */
    if (!pos && i > 0 && signaux[i - 1]) {
      pos = { i, ts, px: o, dir: signaux[i - 1], pic: null };
    }

    if (pos) {
      const long = pos.dir > 0;
      const pxTp = pos.px * (1 + (long ? tp : -tp));
      const pxSl = pos.px * (1 - (long ? sl : -sl));
      const pxAct = pos.px * (1 + (long ? act : -act));

      let sortiePx = null, raison = null;

      // 1. Le stop le plus proche du prix (initial ou trail déjà armé).
      let stop = pxSl;
      if (pos.pic != null) {
        const pxTrail = pos.pic * (1 - (long ? cb : -cb));
        stop = long ? Math.max(stop, pxTrail) : Math.min(stop, pxTrail);
      }
      if (long ? o <= stop : o >= stop) { sortiePx = o; raison = "gap-stop"; }
      else if (long ? l <= stop : h >= stop) { sortiePx = stop; raison = pos.pic != null && stop !== pxSl ? "trail" : "sl"; }
      // 2. Puis seulement le take-profit : l'ambiguïté intra-bougie se
      //    tranche contre la stratégie.
      else if (long ? h >= pxTp : l <= pxTp) { sortiePx = pxTp; raison = "tp"; }

      // 3. Le trail s'arme et avance sur les extrêmes de la bougie —
      //    APRÈS les sorties : il ne peut pas sortir sur la bougie même
      //    qui vient de le faire avancer.
      if (!sortiePx) {
        const extreme = long ? h : l;
        if (long ? extreme >= pxAct : extreme <= pxAct) {
          pos.pic = pos.pic == null ? extreme : (long ? Math.max(pos.pic, extreme) : Math.min(pos.pic, extreme));
        }
        // 4. L'échéance : au close de la bougie où elle tombe. Le vivant
        //    ferme dès que now >= holdUntil — l'égalité déclenche.
        if (ts + 300000 >= pos.ts + sortie.holdMs) { sortiePx = c5[i][4]; raison = "hold"; }
      }

      if (sortiePx) {
        const brut = pos.dir * (sortiePx - pos.px) / pos.px * lev;
        trades.push({ iIn: pos.i, tsIn: pos.ts, dir: pos.dir, pxIn: pos.px,
                      iOut: i, tsOut: ts, pxOut: sortiePx, raison,
                      pnlMarge: brut - fraisMarge });
        pos = null;
        // La place libérée ne se remplit qu'à la bougie suivante : sortir
        // au milieu d'une bougie et rentrer à son open serait remonter le
        // temps — c'est l'ordre entrée-puis-sorties qui le garantit.
      }
    }
  }
  // Une position encore ouverte à la fin de la série n'est PAS comptée :
  // son sort est inconnu, et l'inconnu ne se met pas dans un winrate.
  return trades;
}

function resumer(trades) {
  const n = trades.length;
  const gagnes = trades.filter((t) => t.pnlMarge > 0).length;
  const net = trades.reduce((a, t) => a + t.pnlMarge, 0);
  // Le partage par SENS : chaque signal est symetrique (long et short),
  // et « ai-je des strategies short ? » merite une reponse en nombres,
  // pas en principe.
  const sens = (d) => {
    const l = trades.filter((t) => t.dir === d);
    const g = l.filter((t) => t.pnlMarge > 0).length;
    return { trades: l.length, winrate: l.length ? (100 * g) / l.length : 0 };
  };
  return {
    trades: n,
    gagnes,
    winrate: n ? (100 * gagnes) / n : 0,
    netMarge: net,                         // en fraction de marge cumulée
    moyenneMarge: n ? net / n : 0,
    longs: sens(1),
    shorts: sens(-1),
  };
}

module.exports = { serieSignaux, simuler, resumer, FENETRE_VIVANTE };
