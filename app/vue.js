"use strict";
/*
 * Le rendu.
 *
 * DEUX REGLES tiennent ce fichier.
 *
 * La premiere : la couleur ne porte jamais seule une information. Ce
 * nest pas un principe, cest une mesure — le validateur donne entre le
 * vert #0ca30c et le rouge #d03b3b un ecart de 4,1 en deuteranopie,
 * deux tons indiscernables pour une partie des gens, et ce sont
 * exactement ceux quune interface de trading pose sur le take-profit
 * et le stop. Ils sont gardes parce quils parlent au lecteur habitue,
 * mais chaque repere porte AUSSI son mot, sa forme et sa position.
 *
 * La seconde : on met a jour EN PLACE, jamais en reconstruisant. La
 * page se rafraichit toutes les quatre secondes ; en remplacant le
 * HTML, chaque carte serait detruite puis recreee, et son animation
 * dentree rejouerait indefiniment — une page qui palpite en boucle.
 * Les cartes sont donc reconciliees par symbole : celles qui restent
 * sont modifiees, celles qui arrivent entrent, celles qui partent
 * sortent. Cest ce qui permet au stop de GLISSER vers son nouveau
 * prix, et donc de voir un trail monter au lieu de constater quil a
 * change.
 */

/* ===== mise en forme ===== */

const nf = (n, d = 2) => (Number.isFinite(n) ? n : 0)
  .toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });

// Un prix na pas un nombre fixe de decimales : BTC a 110 000 et PUMP a
// 0,0043 ne se lisent pas avec la meme regle.
function prix(p) {
  const v = Number(p);
  if (!Number.isFinite(v) || v === 0) return "—";
  const a = Math.abs(v);
  const d = a >= 1000 ? 1 : a >= 10 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 5 : 7;
  return v.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
}
// « 820 000,0000 » ne dit rien de plus que « 820 000 » : il occupe la
// place ou devrait tenir un chiffre utile.
function taille(q) {
  const v = Number(q);
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const d = a >= 1000 ? 0 : a >= 10 ? 2 : a >= 1 ? 3 : 4;
  return v.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
}
const usd = (n) => (n >= 0 ? "+" : "−") + nf(Math.abs(n)) + " $";
const pct = (n) => (n >= 0 ? "+" : "−") + nf(Math.abs(n)) + " %";
const signe = (n) => (n > 0 ? "gain" : n < 0 ? "perte" : "");

function duree(ms) {
  if (!ms) return "—";
  let s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  const j = Math.floor(s / 86400); s -= j * 86400;
  const h = Math.floor(s / 3600);  s -= h * 3600;
  const m = Math.floor(s / 60);
  if (j) return `${j} j ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}
const court = (s) => String(s || "").replace(/-USDT-SWAP$/, "").replace(/-SWAP$/, "");
const ech = (s) => String(s == null ? "" : s)
  .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (id) => document.getElementById(id);

const SOBRE = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ============================================================
   Le comptage anime dun nombre.

   Un chiffre qui saute de 9 800 a 10 200 ne dit pas dans quel sens il
   a bouge ; le meme chiffre qui y monte le dit sans un mot. La courbe
   est un easeOutExpo : tres rapide au debut, puis elle se pose — cest
   la forme qui donne limpression darriver quelque part plutot que de
   sarreter.

   Elle ne se declenche QUE sur changement reel. Une animation qui
   rejoue a chaque rafraichissement devient un bruit de fond quon
   cesse de voir, et pire, quon finit par ne plus distinguer dun vrai
   mouvement.
   ============================================================ */
const _valeurs = new WeakMap();
function poserNombre(el, valeur, formate, teinte) {
  if (!el) return;
  const avant = _valeurs.get(el);
  if (avant === valeur) return;
  _valeurs.set(el, valeur);

  if (SOBRE || avant === undefined || !Number.isFinite(avant) || !Number.isFinite(valeur)) {
    el.textContent = formate(valeur);
  } else {
    const t0 = performance.now(), duree = 620;
    const pas = (t) => {
      const k = Math.min(1, (t - t0) / duree);
      const e = 1 - Math.pow(2, -9 * k);          // easeOutExpo
      el.textContent = formate(avant + (valeur - avant) * e);
      if (k < 1) requestAnimationFrame(pas);
      else el.textContent = formate(valeur);
    };
    requestAnimationFrame(pas);
  }

  if (teinte && !SOBRE && avant !== undefined) {
    el.style.color = valeur >= avant ? "var(--gain)" : "var(--perte)";
    el.classList.remove("bat"); void el.offsetWidth; el.classList.add("bat");
    setTimeout(() => { el.style.color = ""; }, 620);
  }
}

/* ===== etat ===== */

const E = {
  pf: null, sante: {}, mode: "viewer",
  moteur: false, relie: false, journal: [], tableau: false,
  premier: true,
};

/* ============================================================
   LA REGLETTE

   Quatre reperes — stop, entree, prix, take-profit — sur UNE echelle
   de prix. La distance entre deux se lit alors directement, ce quune
   liste de nombres ne permet jamais.

   Elle est construite une fois par position, puis MISE A JOUR : les
   reperes glissent vers leur nouveau prix au lieu detre redessines.
   Cest ce qui rend un trail visible pendant quil monte.
   ============================================================ */
const L = 320, H = 122, MG = 12, LARGE = L - MG * 2;
const YAXE = 56;
const LIGNE = { tp: 16, prix: 36, sl: 94, entree: 114 };

function formeRepere(forme, couleur, y) {
  // rotate(45) SANS centre pivote autour de lorigine du repere local,
  // ce qui DEPLACE le carre au lieu de le tourner sur lui-meme : le
  // losange de lentree se retrouvait au-dessus de laxe pendant que son
  // etiquette restait en dessous. Le centre est donc donne.
  if (forme === "losange") return `<rect x="-4" y="${y - 4}" width="8" height="8" fill="${couleur}" transform="rotate(45 0 ${y})"/>`;
  if (forme === "bas")     return `<path d="M-5 ${y - 4} L5 ${y - 4} L0 ${y + 4.5} Z" fill="${couleur}"/>`;
  if (forme === "haut")    return `<path d="M-5 ${y + 4} L5 ${y + 4} L0 ${y - 4.5} Z" fill="${couleur}"/>`;
  return `<circle cx="0" cy="${y}" r="4.6" fill="${couleur}" stroke="var(--surface)" stroke-width="2"/>`;
}

function squeletteReglette() {
  const g = (cle, forme, couleur, yTexte) => {
    const dessous = yTexte > YAXE;
    const yM = dessous ? YAXE + 7 : YAXE - 7;
    const yFin = dessous ? yTexte - 9 : yTexte + 3;
    return `<g class="rep" data-rep="${cle}">
      <line x1="0" y1="${YAXE}" x2="0" y2="${yFin}" stroke="${couleur}" stroke-width="1" opacity=".5"/>
      ${formeRepere(forme, couleur, yM)}
      <text y="${yTexte}" text-anchor="middle" font-size="11.5" fill="${couleur}"
            font-family="var(--mono)" letter-spacing="-.4"
            paint-order="stroke" stroke="var(--surface)" stroke-width="3.5"
            stroke-linejoin="round"></text>
    </g>`;
  };
  return `<svg viewBox="0 0 ${L} ${H}" style="width:100%;height:auto;display:block" role="img" data-regle>
    <rect class="bande" x="0" y="${YAXE - 3}" width="1" height="6" rx="1" opacity=".32"/>
    <line x1="${MG}" y1="${YAXE}" x2="${L - MG}" y2="${YAXE}" stroke="var(--bord-vif)" stroke-width="1.4"/>
    <g class="rep" data-rep="fantome" opacity="0">
      <line x1="0" y1="${YAXE + 7}" x2="0" y2="${YAXE + 7}" stroke="var(--texte-3)" stroke-width="1.2" stroke-dasharray="3 3" opacity=".75"/>
      <path d="M-4 ${YAXE + 3.5} L4 ${YAXE + 3.5} L0 ${YAXE + 10} Z" fill="none" stroke="var(--texte-3)" stroke-width="1.2" opacity=".75"/>
      <text y="${YAXE + 19}" text-anchor="middle" font-size="9" fill="var(--texte-3)" font-family="var(--mono)"
            paint-order="stroke" stroke="var(--surface)" stroke-width="3" stroke-linejoin="round"></text>
    </g>
    ${g("tp", "haut", "var(--bon)", LIGNE.tp)}
    ${g("prix", "rond", "var(--serie)", LIGNE.prix)}
    ${g("sl", "bas", "var(--critique)", LIGNE.sl)}
    ${g("entree", "losange", "var(--texte-2)", LIGNE.entree)}
  </svg>`;
}

function majReglette(svg, p) {
  const entree = Number(p.entryPrice) || 0;
  const marque = Number(p.markPrice) || entree;
  const tp = Number(p.takeProfit) || null;
  const sl = Number(p.stopActuel || p.stopLoss) || null;
  const slInit = Number(p.stopLoss) || null;

  const pts = [entree, marque, tp, sl, slInit].filter((v) => Number.isFinite(v) && v > 0);
  if (pts.length < 2) { svg.style.opacity = ".25"; return; }
  svg.style.opacity = "1";

  let min = Math.min(...pts), max = Math.max(...pts);
  const pad = (max - min) * 0.14 || Math.abs(entree) * 0.004 || 1;
  min -= pad; max += pad;
  const x = (v) => MG + ((v - min) / (max - min)) * LARGE;

  const long = p.side === "LONG";
  const gagne = long ? marque > entree : marque < entree;
  const verrou = Number.isFinite(sl) && entree > 0 && (long ? sl >= entree : sl <= entree);
  const couleurStop = verrou ? "var(--bon)" : "var(--critique)";
  const modeStop = p.stopMode || null;
  const etiqStop = modeStop === "TRAIL" ? "TRAIL " : modeStop === "BE" ? "SEUIL " : "SL ";

  // La bande entre lentree et le prix : elle dit le sens ET lampleur
  // du mouvement sans quon ait a comparer deux nombres.
  const b = svg.querySelector(".bande");
  const bx1 = Math.min(x(entree), x(marque)), bx2 = Math.max(x(entree), x(marque));
  b.setAttribute("width", Math.max(0.5, bx2 - bx1).toFixed(1));
  b.style.transform = `translateX(${bx1.toFixed(1)}px)`;
  b.setAttribute("fill", gagne ? "var(--gain)" : "var(--perte)");

  const poser = (cle, v, etiquette, couleur) => {
    const g = svg.querySelector(`[data-rep="${cle}"]`);
    if (!g) return;
    if (!Number.isFinite(v) || v <= 0) { g.style.opacity = "0"; return; }
    g.style.opacity = "1";
    const px = x(v);
    g.style.transform = `translateX(${px.toFixed(1)}px)`;
    const t = g.querySelector("text");
    if (t) {
      t.textContent = etiquette;
      // Recalage aux bords : sinon les etiquettes extremes sortent du
      // cadre sur telephone. Lancrage suit la place disponible.
      const demi = etiquette.length * 3.1;
      const ancre = px - demi < MG ? "start" : px + demi > L - MG ? "end" : "middle";
      t.setAttribute("text-anchor", ancre);
      t.setAttribute("x", ancre === "start" ? (MG - px).toFixed(1) : ancre === "end" ? (L - MG - px).toFixed(1) : 0);
    }
    for (const el of g.querySelectorAll("line, path, circle, rect")) {
      if (el.hasAttribute("stroke")) el.setAttribute("stroke", couleur);
      if (el.hasAttribute("fill") && el.getAttribute("fill") !== "none") el.setAttribute("fill", couleur);
    }
    if (t) t.setAttribute("fill", couleur);
  };

  poser("tp", tp, "TP " + prix(tp), "var(--bon)");
  poser("prix", marque, prix(marque), long ? "var(--long)" : "var(--short)");
  poser("sl", sl, etiqStop + prix(sl), couleurStop);
  poser("entree", entree, "ENTRÉE " + prix(entree), "var(--texte-2)");

  // Le stop dorigine, quand le trail la deplace. Sans lui on ne mesure
  // pas le chemin parcouru, qui est tout lapport dun trail.
  const f = svg.querySelector('[data-rep="fantome"]');
  if (f) {
    if (Number.isFinite(slInit) && Number.isFinite(sl) && Math.abs(slInit - sl) > (max - min) * 0.01) {
      f.style.opacity = "1";
      const xa = x(slInit), xb = x(sl);
      f.style.transform = `translateX(${xa.toFixed(1)}px)`;
      f.querySelector("line").setAttribute("x2", (xb - xa).toFixed(1));
      f.querySelector("text").textContent = "départ " + prix(slInit);
    } else f.style.opacity = "0";
  }
  return { verrou, long };
}

/* ===== la carte dune position ===== */

function coquePosition(p) {
  const el = document.createElement("article");
  el.className = "pos " + (p.side === "LONG" ? "long" : "short");
  el.dataset.sym = p.symbol;
  el.innerHTML = `
    <div class="pos-tete">
      <span class="sym"></span>
      <span class="sens"></span>
      <span class="lev"></span>
      <span data-marques></span>
      <div class="pos-pnl"><div class="u"></div><div class="p"></div></div>
    </div>
    <div class="faits">
      <div class="fait"><div class="e">Taille</div><div class="v" data-f="size"></div></div>
      <div class="fait"><div class="e">Marge</div><div class="v" data-f="marge"></div></div>
      <div class="fait"><div class="e">Notionnel</div><div class="v" data-f="notio"></div></div>
      <div class="fait"><div class="e">Tenue</div><div class="v" data-f="tenue"></div></div>
    </div>
    <div class="regle">
      ${squeletteReglette()}
      <div class="legende" data-legende></div>
    </div>`;
  return el;
}

function majPosition(el, p) {
  const long = p.side === "LONG";
  el.className = "pos " + (long ? "long" : "short");
  el.querySelector(".sym").textContent = court(p.symbol);
  const s = el.querySelector(".sens");
  s.className = "sens " + (long ? "long" : "short");
  s.textContent = long ? "↑ LONG" : "↓ SHORT";
  el.querySelector(".lev").textContent = "×" + (p.leverage || "?");

  let marques = "";
  if (p.stopMode === "TRAIL") {
    marques += `<span class="marque trail" title="Le stop suit le prix et ne redescend jamais">
      <svg width="9" height="9" viewBox="0 0 10 10" fill="none"><path d="M2 8L8 2M8 2H4M8 2v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>TRAIL</span>`;
  } else if (p.stopMode === "BE") {
    marques += `<span class="marque seuil" title="Stop remonté au point mort : la position ne peut plus perdre">= SEUIL</span>`;
  }
  if (p.trailArme) marques += `<span class="marque trail" title="Un ordre de suivi est posé côté exchange">⛓ posé</span>`;
  const zm = el.querySelector("[data-marques]");
  if (zm.innerHTML !== marques) zm.innerHTML = marques;

  const pnl = Number(p.unrealizedPnl) || 0;
  const u = el.querySelector(".pos-pnl .u");
  u.className = "u " + signe(pnl);
  poserNombre(u, pnl, usd);
  el.querySelector(".pos-pnl .p").textContent = pct(Number(p.pnlPctOfMargin) || 0) + " de la marge";

  // La taille arrive en monnaie de base, comme sur lexchange ; nommer
  // la monnaie evite de relire le titre de la carte pour savoir de quoi
  // 1 940 est le compte.
  el.querySelector('[data-f="size"]').textContent  = taille(p.size) + " " + court(p.symbol);
  el.querySelector('[data-f="marge"]').textContent = nf(Number(p.margin) || 0) + " $";
  el.querySelector('[data-f="notio"]').textContent = nf(Number(p.notional) || 0) + " $";
  el.querySelector('[data-f="tenue"]').textContent = duree(p.entryTime);

  const r = majReglette(el.querySelector("[data-regle]"), p) || {};
  // La legende doit dire la meme chose que le dessin : un stop remonte
  // au-dela de lentree y est vert, lannoncer rouge ferait mentir lun
  // des deux.
  el.querySelector("[data-legende]").innerHTML =
    `<span><i style="background:${r.verrou ? "var(--bon)" : "var(--critique)"}"></i>${r.verrou ? "stop (gain verrouillé)" : "stop"}</span>
     <span><i style="background:var(--texte-2)"></i>entrée</span>
     <span><i style="background:${long ? "var(--long)" : "var(--short)"}"></i>prix</span>
     <span><i style="background:var(--bon)"></i>take-profit</span>`;
}

/* ============================================================
   La reconciliation par cle.

   Cest la piece qui rend toutes les animations possibles. Sans elle,
   chaque rafraichissement detruirait et recreerait les cartes : les
   entrees rejoueraient sans fin, et un stop ne pourrait jamais
   glisser puisquil naitrait deja a sa nouvelle place.
   ============================================================ */
function rendrePositions() {
  const liste = (E.pf && E.pf.openPositionsDetails) || [];
  $("n-pos").textContent = liste.length ? `${liste.length} ouverte${liste.length > 1 ? "s" : ""}` : "aucune";

  const zc = $("z-pos"), zt = $("z-tab");
  zc.hidden = E.tableau; zt.hidden = !E.tableau;

  if (E.tableau) { zt.innerHTML = tableau(liste); return; }

  let grille = zc.querySelector(".positions");
  if (!liste.length) {
    zc.innerHTML = `<div class="vide">
      <svg width="34" height="34" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="4" stroke="currentColor" stroke-width="1.6"/><path d="M8 12h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      <strong>Aucune position ouverte</strong>
      Les positions apparaissent ici dès qu'une stratégie en ouvre une, avec leur stop et leur take-profit.</div>`;
    return;
  }
  if (!grille) { zc.innerHTML = `<div class="positions"></div>`; grille = zc.querySelector(".positions"); }

  const vues = new Set();
  liste.forEach((p, i) => {
    vues.add(p.symbol);
    let el = grille.querySelector(`[data-sym="${CSS.escape(p.symbol)}"]`);
    if (!el) {
      el = coquePosition(p);
      el.classList.add("entre");
      el.style.animationDelay = (i * 55) + "ms";
      grille.appendChild(el);
    }
    majPosition(el, p);
  });
  for (const el of [...grille.children]) {
    if (!vues.has(el.dataset.sym)) {
      // Une position qui se ferme sen va, elle ne disparait pas : le
      // depart est linformation.
      el.style.transition = "opacity .3s, transform .3s";
      el.style.opacity = "0"; el.style.transform = "scale(.97)";
      setTimeout(() => el.remove(), SOBRE ? 0 : 300);
    }
  }
}

function tableau(l) {
  if (!l.length) return `<div class="vide">Aucune position ouverte.</div>`;
  return `<div class="roule"><table>
    <thead><tr><th>Instrument</th><th>Sens</th><th>Levier</th><th>Taille</th><th>Marge</th>
    <th>Entrée</th><th>Prix</th><th>Stop</th><th>Mode</th><th>TP</th><th>PnL</th><th>Tenue</th></tr></thead>
    <tbody>${l.map((p) => `<tr>
      <td>${ech(court(p.symbol))}</td>
      <td>${p.side === "LONG" ? "↑ LONG" : "↓ SHORT"}</td>
      <td>×${ech(p.leverage || "?")}</td>
      <td>${taille(p.size)}</td>
      <td>${nf(Number(p.margin) || 0)} $</td>
      <td>${prix(p.entryPrice)}</td>
      <td>${prix(p.markPrice)}</td>
      <td>${prix(p.stopActuel || p.stopLoss)}</td>
      <td>${p.stopMode ? ech(p.stopMode) : "—"}</td>
      <td>${prix(p.takeProfit)}</td>
      <td class="${signe(Number(p.unrealizedPnl) || 0)}">${usd(Number(p.unrealizedPnl) || 0)}</td>
      <td>${duree(p.entryTime)}</td></tr>`).join("")}</tbody></table></div>`;
}

/* ===== courbes ===== */

function cheminCourbe(points, w, h, m) {
  const vs = points.map((p) => Number(p.v) || 0);
  let min = Math.min(...vs), max = Math.max(...vs);
  if (max === min) return null;
  const pad = (max - min) * 0.12; min -= pad; max += pad;
  const x = (i) => m.g + (i / (points.length - 1)) * (w - m.g - m.d);
  const y = (v) => m.h + (1 - (v - min) / (max - min)) * (h - m.h - m.b);
  return { d: points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" "), x, y, min, max };
}

// La petite courbe du hero : pas daxe, pas de graduation. Elle donne
// la FORME du dernier moment, pas des valeurs — celles-ci sont juste
// au-dessus, en grand.
function etincelle(points, sens) {
  const z = $("h-spark");
  if (!points || points.length < 3) { z.innerHTML = ""; return; }
  const pts = points.slice(-90);
  // Marge a droite : sans elle le point terminal, qui a un rayon, est
  // coupe par le bord du cadre.
  const w = 520, h = 128, m = { g: 3, d: 7, h: 10, b: 8 };
  const c = cheminCourbe(pts, w, h, m);
  if (!c) { z.innerHTML = ""; return; }
  const dernier = pts.length - 1;
  // La teinte suit le DELTA AFFICHE juste a cote, et non la pente des
  // quatre-vingt-dix derniers points. Les deux repondent a des
  // questions differentes — « depuis ce matin » et « sur la fenetre
  // dessinee » — et cote a cote, un delta vert pres dune courbe rouge
  // ne se lit pas comme deux mesures : il se lit comme une erreur, et
  // fait douter de tout le reste de la page.
  const teinte = sens > 0 ? "var(--gain)" : sens < 0 ? "var(--perte)" : "var(--serie)";
  z.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:100%;display:block;overflow:visible">
      <defs>
        <linearGradient id="gspark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${teinte}" stop-opacity=".30"/>
          <stop offset="100%" stop-color="${teinte}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path class="aire-courbe" d="${c.d} L${c.x(dernier).toFixed(1)} ${h - m.b} L${c.x(0).toFixed(1)} ${h - m.b} Z" fill="url(#gspark)"/>
      <path class="trace-courbe" style="--long-trace:2400" d="${c.d}" fill="none" stroke="${teinte}"
            stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      <circle class="bout" cx="${c.x(dernier).toFixed(1)}" cy="${c.y(pts[dernier].v).toFixed(1)}" r="3.5" fill="${teinte}"/>
    </svg>`;
}

function courbe(points) {
  const z = $("z-courbe");
  if (!points || points.length < 2) {
    z.innerHTML = `<div class="vide"><strong>Pas encore d'historique</strong>La courbe apparaît dès que le moteur a relevé quelques points.</div>`;
    return;
  }
  const vs = points.map((p) => Number(p.v) || 0);
  const mn = Math.min(...vs), mx = Math.max(...vs);
  // Une serie plate na pas de courbe, et lui en fabriquer une est pire
  // que de nen montrer aucune : lecart affiche viendrait du
  // remplissage, et le lecteur croirait voir une variation.
  if (mn === mx) {
    z.innerHTML = `<div class="vide"><strong>Équité constante à ${nf(mn)} $</strong>
      ${points.length} points relevés, tous identiques. La courbe apparaîtra dès que l'équité bougera.</div>`;
    $("n-eq").textContent = `${points.length} points, plats`;
    return;
  }

  const w = 900, h = 250, m = { g: 66, d: 16, h: 16, b: 28 };
  const c = cheminCourbe(points, w, h, m);
  const dernier = points.length - 1;

  // Le nombre de decimales suit LETENDUE : arrondir a lentier une
  // plage de trois dollars imprimait « 1, 1, 0 », deux graduations
  // identiques a des hauteurs differentes.
  const etendue = c.max - c.min;
  const dec = etendue >= 400 ? 0 : etendue >= 40 ? 1 : etendue >= 4 ? 2 : 3;
  let grille = "";
  for (let i = 0; i <= 4; i++) {
    const v = c.min + (i / 4) * etendue, yy = c.y(v);
    grille += `<line x1="${m.g}" y1="${yy.toFixed(1)}" x2="${w - m.d}" y2="${yy.toFixed(1)}" stroke="var(--bord)" stroke-width="1"/>
      <text x="${m.g - 10}" y="${(yy + 3.5).toFixed(1)}" text-anchor="end" font-size="10.5"
            fill="var(--texte-3)" font-family="var(--mono)">${nf(v, dec)}</text>`;
  }

  z.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;display:block;overflow:visible" id="svg-courbe">
      <defs>
        <linearGradient id="gcourbe" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--serie)" stop-opacity=".26"/>
          <stop offset="100%" stop-color="var(--serie)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${grille}
      <path class="aire-courbe" d="${c.d} L${c.x(dernier).toFixed(1)} ${c.y(c.min).toFixed(1)} L${c.x(0).toFixed(1)} ${c.y(c.min).toFixed(1)} Z" fill="url(#gcourbe)"/>
      <path class="trace-courbe" style="--long-trace:4200" d="${c.d}" fill="none" stroke="var(--serie)"
            stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle class="bout" cx="${c.x(dernier).toFixed(1)}" cy="${c.y(points[dernier].v).toFixed(1)}" r="4" fill="var(--serie)"/>
      <line id="viseur" y1="${m.h}" y2="${h - m.b}" stroke="var(--texte-3)" stroke-width="1" stroke-dasharray="3 4" opacity="0"/>
      <circle id="vpt" r="5" fill="var(--serie)" stroke="var(--surface)" stroke-width="2.5" opacity="0"/>
      <rect id="capteur" x="${m.g}" y="${m.h}" width="${w - m.g - m.d}" height="${h - m.h - m.b}" fill="transparent"/>
    </svg>
    <div class="bulle" id="bulle"></div>`;

  const svg = $("svg-courbe"), bulle = $("bulle"), vis = $("viseur"), pt = $("vpt");
  const survol = (ev) => {
    const r = svg.getBoundingClientRect();
    const cx = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left) / r.width * w;
    let i = Math.round(((cx - m.g) / (w - m.g - m.d)) * (points.length - 1));
    i = Math.max(0, Math.min(points.length - 1, i));
    const px = c.x(i), py = c.y(points[i].v);
    vis.setAttribute("x1", px); vis.setAttribute("x2", px); vis.setAttribute("opacity", ".5");
    pt.setAttribute("cx", px); pt.setAttribute("cy", py); pt.setAttribute("opacity", "1");
    bulle.style.opacity = "1";
    bulle.style.left = (px / w * r.width) + "px";
    bulle.style.top = (py / h * r.height) + "px";
    bulle.textContent = `${nf(points[i].v)} $ · ${new Date(points[i].t).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
  };
  const sortie = () => { vis.setAttribute("opacity", "0"); pt.setAttribute("opacity", "0"); bulle.style.opacity = "0"; };
  const cap = $("capteur");
  cap.addEventListener("mousemove", survol);
  cap.addEventListener("mouseleave", sortie);
  cap.addEventListener("touchmove", survol, { passive: true });
  cap.addEventListener("touchend", sortie);

  $("n-eq").textContent = `${points.length} points`;
}

/* ===== hero et tuiles ===== */

function rendreHero() {
  const d = E.pf || {};
  const f = d.futures || {}, pe = d.performance || {};
  const eq = Number(f.total) || Number(d.spot && d.spot.total) || 0;
  const jour = Number(pe.dailyPnL) || 0;

  poserNombre($("h-val"), eq, (v) => nf(v));

  const dl = $("h-delta");
  dl.className = "delta " + (jour > 0 ? "up" : jour < 0 ? "down" : "plat");
  dl.innerHTML = (jour === 0 ? "" :
    `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" style="transform:rotate(${jour > 0 ? 0 : 180}deg)">
       <path d="M6 10V2M6 2L2.5 5.5M6 2l3.5 3.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`)
    + `<span>${usd(jour)}</span>`;
  $("h-note").textContent = `aujourd'hui · ${Number(pe.dailyTrades) || 0} trade${(Number(pe.dailyTrades) || 0) > 1 ? "s" : ""}`;

  etincelle(d.history ? d.history.spot : [], jour);
}

const TUILES = [
  { cle: "marge", e: "Marge engagée", v: (d) => Number(d.positions && d.positions.totalMargin) || 0, fmt: (v) => nf(v) + " $",
    s: (d) => `notionnel ${nf(Number(d.positions && d.positions.totalValue) || 0)} $` },
  { cle: "latent", e: "PnL latent", v: (d) => Number(d.futures && d.futures.unrealizedPnL) || 0, fmt: usd, teinte: true,
    s: () => "sur les positions ouvertes" },
  { cle: "ouvertes", e: "Positions", v: (d) => Number(d.positions && d.positions.count) || 0, fmt: (v) => String(Math.round(v)),
    s: (d) => `disponible ${nf(Number(d.futures && d.futures.available) || 0)} $` },
  { cle: "gain", e: "Taux de gain", v: (d) => Number(d.performance && d.performance.winrate) || 0, fmt: (v) => nf(v, 1) + " %",
    s: (d) => `${Number(d.performance && d.performance.totalTrades) || 0} trades au total` },
];

function rendreTuiles() {
  const d = E.pf || {};
  const z = $("tuiles");
  if (!z.children.length) {
    z.innerHTML = TUILES.map((t, i) => `<div class="tuile entre" data-t="${t.cle}" style="animation-delay:${i * 60}ms">
      <div class="e">${t.e}</div><div class="v"></div><div class="s"></div></div>`).join("");
  }
  for (const t of TUILES) {
    const el = z.querySelector(`[data-t="${t.cle}"]`);
    const v = el.querySelector(".v");
    poserNombre(v, t.v(d), t.fmt, t.teinte);
    if (t.teinte) v.className = "v " + signe(t.v(d));
    el.querySelector(".s").textContent = t.s(d);
  }
}

/* ===== sante ===== */

const NOMS = {
  wsPublic: "Flux public", wsPrivate: "Flux privé", rest: "API REST",
  dataFlow: "Données", strategy: "Stratégie", aiEngine: "Moteur",
  orders: "Ordres", stops: "Protections", portfolio: "Portefeuille",
};
function rendreSante() {
  const m = E.sante.modules || {};
  const cles = Object.keys(m);
  const z = $("z-sante");
  if (!cles.length) { z.innerHTML = `<div class="vide" style="padding:26px">En attente du premier battement.</div>`; return; }
  let ok = 0;
  z.innerHTML = cles.map((k, i) => {
    const v = m[k] || {};
    const s = String(v.status || "").toUpperCase();
    if (s === "OK") ok++;
    const c = s === "OK" ? "bon" : s === "FAULT" ? "critique" : "attention";
    const detail = s + (v.info ? " · " + String(v.info) : "");
    // Le statut ne se lit pas quau point : le mot est a cote.
    return `<div class="mod${E.premier ? " entre" : ""}" style="animation-delay:${i * 35}ms" title="${ech(detail)}">
      <span class="pt ${c}${s === "OK" ? " vif" : ""}"></span>
      <div><div class="n">${ech(NOMS[k] || k)}</div><div class="i">${ech(detail)}</div></div></div>`;
  }).join("");
  $("n-sante").textContent = `${ok} / ${cles.length} au vert`;
}

/* ===== journal ===== */

const CLASSE = (e) => {
  const s = String(e || "");
  if (s.includes("ENTER")) return "e-in";
  if (s.includes("EXIT")) return "e-out";
  if (s.startsWith("STOP")) return "e-stop";
  if (s.includes("GUARD")) return "e-gard";
  return "";
};
let _vuJournal = 0;
function rendreJournal() {
  const z = $("z-jrn");
  if (!E.journal.length) {
    z.innerHTML = `<div class="vide" style="padding:34px">Rien pour l'instant. Le journal se remplit dès que le moteur agit.</div>`;
    _vuJournal = 0; return;
  }
  const auBas = z.scrollTop + z.clientHeight >= z.scrollHeight - 44;
  const vis = E.journal.slice(-260);
  z.innerHTML = vis.map((l, i) => {
    const { ts, event, ...reste } = l;
    const h = ts ? new Date(ts).toLocaleTimeString("fr-FR", { hour12: false }) : "--:--:--";
    const c = CLASSE(event);
    const neuf = i >= vis.length - (E.journal.length - _vuJournal) ? " neuf" : "";
    return `<div class="jl ${c}${neuf}"><span class="t">${ech(h)}</span>
      <span class="e ${c}">${ech(event || "—")}</span>
      <span class="d">${ech(JSON.stringify(reste).slice(1, -1).replace(/","/g, " · ").replace(/"/g, ""))}</span></div>`;
  }).join("");
  _vuJournal = E.journal.length;
  if (auBas) z.scrollTop = z.scrollHeight;
  $("n-jrn").textContent = String(E.journal.length);
}

/* ===== entete ===== */

function rendreEntete() {
  $("pt-lien").className = "pt " + (E.relie ? "bon vif" : "critique");
  $("t-lien").textContent = E.relie ? "relié" : "hors ligne";
  $("pt-moteur").className = "pt " + (E.moteur ? "bon vif" : "");
  $("t-moteur").textContent = E.moteur ? "moteur en marche" : "moteur à l'arrêt";

  // Sans cles, le compte affiche zero. Le dire est plus utile que de le
  // montrer : un zero muet se lit comme une perte ou une panne.
  const sansCles = !!(E.pf && E.pf.clesOkx === false);
  $("avis-cles").hidden = !sansCles;

  const pilote = E.mode === "full";
  $("t-mode").textContent = pilote ? "pilotage" : "lecture seule";
  $("avis-lecture").hidden = pilote;

  const b = $("b-moteur");
  b.textContent = E.moteur ? "Arrêter" : "Démarrer";
  b.className = E.moteur ? "stop" : "primaire";
  b.disabled = !pilote;
  b.title = pilote ? "" : "Indisponible en lecture seule";
}

/* ===== boucle ===== */

async function rafraichir() {
  try {
    const [pf, etat, live, mode] = await Promise.all([
      api.invoke("fetch-portfolio"), api.invoke("get-ai-state"),
      api.invoke("ai:live-status"), api.invoke("ui-mode"),
    ]);
    if (pf && pf.data) E.pf = pf.data;
    if (live) E.moteur = !!live.liveEnabled;
    if (mode && mode.mode) E.mode = mode.mode;
    if (etat && Array.isArray(etat.logs) && etat.logs.length && !E.journal.length) {
      E.journal = etat.logs.slice(-260); rendreJournal();
    }
    E.relie = true;
  } catch { E.relie = false; }

  rendreEntete(); rendreHero(); rendreTuiles(); rendrePositions();
  // La grande courbe se redessine avec son animation de trace : on ne
  // la rejoue donc que si les points ont change de nombre, sinon elle
  // se redessinerait toutes les quatre secondes.
  const h = (E.pf && E.pf.history && E.pf.history.spot) || [];
  if (h.length !== rafraichir._n) { rafraichir._n = h.length; courbe(h); }
  E.premier = false;
}
rafraichir._n = -1;

/* ===== branchements ===== */

api.surSante((h) => { E.sante = h || {}; rendreSante(); });
api.subscribe((l) => { if (!l) return; E.journal.push(l); if (E.journal.length > 600) E.journal.shift(); rendreJournal(); });
api.surLien((s) => { E.relie = !!(s && s.relie); rendreEntete(); });

$("b-moteur").addEventListener("click", async () => {
  $("b-moteur").disabled = true;
  try { await api.invoke("toggle-ai", !E.moteur); } catch {}
  await rafraichir();
});
$("b-vue").addEventListener("click", () => {
  E.tableau = !E.tableau;
  $("b-vue").textContent = E.tableau ? "Vue cartes" : "Vue tableau";
  $("z-pos").innerHTML = "";           // la grille se reconstruit au retour
  rendrePositions();
});
$("b-vider").addEventListener("click", () => { E.journal = []; rendreJournal(); });

// Lamorcage des cles depuis la page. Les champs sont vides des la
// reponse recue, quelle quelle soit : un secret qui reste affiche dans
// un formulaire est un secret quun regard par-dessus lepaule ramasse.
$("c-poser").addEventListener("click", async () => {
  const b = $("c-poser"), e = $("cles-etat");
  const env = $("c-env").value;
  if (!env.trim()) { e.className = "cles-etat ko"; e.textContent = "Collez d'abord les lignes de votre .env."; return; }
  b.disabled = true; e.className = "cles-etat"; e.textContent = "Test auprès d'OKX…";
  try {
    const r = await api.invoke("poser-cles", { env });
    // Le champ est vide des la reponse recue, quelle quelle soit : un
    // secret qui reste affiche est un secret quun regard par-dessus
    // lepaule ramasse.
    $("c-env").value = "";
    if (r && r.ok) {
      e.className = "cles-etat ok";
      e.textContent = `Acceptées par OKX — compte niveau ${r.niveau}, mode ${r.modePosition}. Le moteur les utilise déjà.`;
      setTimeout(rafraichir, 1200);
    } else {
      e.className = "cles-etat ko";
      e.textContent = (r && (r.message || r.error)) || "refus sans explication";
    }
  } catch (err) {
    e.className = "cles-etat ko"; e.textContent = String(err.message || err);
  }
  b.disabled = false;
});

// Le theme : le choix explicite lemporte sur le systeme et tient dun
// passage a lautre. Toute lecture de stockage est gardee — un
// navigateur en navigation privee la refuse, et la page doit sen
// remettre sans rien casser.
(function theme() {
  let a = null;
  try { a = localStorage.getItem("hermes-theme"); } catch {}
  if (a) document.documentElement.setAttribute("data-theme", a);
  $("b-theme").addEventListener("click", () => {
    const sombreSys = matchMedia("(prefers-color-scheme: dark)").matches;
    const cur = document.documentElement.getAttribute("data-theme") || (sombreSys ? "dark" : "light");
    const nxt = cur === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", nxt);
    try { localStorage.setItem("hermes-theme", nxt); } catch {}
    rafraichir._n = -1; rafraichir();
  });
})();

rendreEntete(); rendreJournal(); rendreSante(); rafraichir();
setInterval(rafraichir, 4000);
