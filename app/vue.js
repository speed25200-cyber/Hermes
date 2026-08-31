"use strict";
/*
 * Le rendu.
 *
 * Une regle traverse ce fichier : la couleur ne porte jamais seule une
 * information. Ce nest pas un principe abstrait, cest une mesure. Le
 * validateur de palette donne, entre le vert #0ca30c et le rouge
 * #d03b3b, un ecart de 4,1 en deuteranopie — autrement dit deux tons
 * indiscernables pour une partie des gens. Or ce sont exactement les
 * couleurs quune interface de trading pose sur le take-profit et le
 * stop. Elles sont donc gardees, parce quelles parlent au lecteur
 * habitue, mais chaque repere porte AUSSI son mot, sa forme et sa
 * position. Si quelquun retire les etiquettes un jour en pensant que
 * la couleur suffit, la jauge cesse detre lisible pour lui.
 */

/* ===== mise en forme ===== */

const nf = (n, d = 2) => (Number.isFinite(n) ? n : 0).toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });

// Un prix na pas un nombre fixe de decimales : BTC a 110 000 et PUMP a
// 0,0043 ne se lisent pas avec la meme regle. On choisit selon lordre
// de grandeur, sinon on affiche soit du bruit, soit rien.
function prix(p) {
  const v = Number(p);
  if (!Number.isFinite(v) || v === 0) return "—";
  const a = Math.abs(v);
  const d = a >= 1000 ? 1 : a >= 10 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 5 : 7;
  return v.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
}
// Une taille non plus na pas un nombre fixe de decimales : 0,045 BTC et
// 820 000 PUMP sont deux tailles legitimes, et « 820 000,0000 » ne dit
// rien de plus que « 820 000 » — il occupe seulement la place ou
// devrait tenir un chiffre utile.
function taille(q) {
  const v = Number(q);
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const d = a >= 1000 ? 0 : a >= 10 ? 2 : a >= 1 ? 3 : 4;
  return v.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
}
const usd = (n) => (n >= 0 ? "+" : "−") + nf(Math.abs(n)) + "\u00a0$";
const pct = (n) => (n >= 0 ? "+" : "−") + nf(Math.abs(n)) + "\u00a0%";
const classeSigne = (n) => (n > 0 ? "gain" : n < 0 ? "perte" : "");

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
const ech = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (id) => document.getElementById(id);

/* ===== etat ===== */

const E = {
  portefeuille: null,
  sante: {},
  mode: "viewer",
  moteurActif: false,
  relie: false,
  journal: [],
  vueTableau: false,
};

/* ============================================================
   La reglette dune position.

   Cest la piece que lobjectif demandait : voir dun coup dœil la
   taille, la marge, le levier, les TP et SL poses, et le trail qui
   suit. Une ligne de prix unique porte quatre reperes — stop,
   entree, prix courant, take-profit — a leur place reelle sur
   lechelle. La distance entre deux reperes se lit donc directement,
   ce quune liste de nombres ne permet jamais.
   ============================================================ */
function reglette(p) {
  // Le repere interne doit avoir le MEME rapport largeur/hauteur que la
  // place ou il sera dessine. Sinon, avec le comportement par defaut du
  // SVG, le dessin se met a lechelle de la plus petite dimension et se
  // tasse au centre entre deux bandes vides — cetait le cas, et les
  // reperes semblaient tous colles alors que lechelle etait juste.
  const L = 320, H = 122;
  const marge = { g: 12, d: 12 };
  const large = L - marge.g - marge.d;

  // Quatre etiquettes sur une seule ligne se chevauchent des que deux
  // prix sont proches — et deux prix proches, cest le cas NORMAL : un
  // stop au seuil est a lentree, un prix qui court est pres du
  // take-profit. Chaque repere a donc SA ligne, et deux etiquettes ne
  // peuvent plus se rencontrer quel que soit lecart des prix.
  const yAxe = 56;
  const LIGNE = { tp: 16, prix: 36, sl: 94, entree: 114 };

  const entree = Number(p.entryPrice) || 0;
  const marque = Number(p.markPrice) || entree;
  const tp = Number(p.takeProfit) || null;
  const sl = Number(p.stopActuel || p.stopLoss) || null;
  const slInit = Number(p.stopLoss) || null;

  const pts = [entree, marque, tp, sl, slInit].filter((v) => Number.isFinite(v) && v > 0);
  if (pts.length < 2) return `<div style="font-size:12px;color:var(--texte-3);padding:6px 0">Pas assez de repères pour tracer l'échelle.</div>`;

  let min = Math.min(...pts), max = Math.max(...pts);
  const pad = (max - min) * 0.14 || Math.abs(entree) * 0.004 || 1;
  min -= pad; max += pad;
  const x = (v) => marge.g + ((v - min) / (max - min)) * large;

  const long = p.side === "LONG";
  const gagne = long ? marque > entree : marque < entree;

  // La bande entre lentree et le prix courant : elle dit le sens ET
  // lampleur du mouvement sans quon ait a comparer deux nombres.
  const bx1 = Math.min(x(entree), x(marque));
  const bx2 = Math.max(x(entree), x(marque));
  const teinte = gagne ? "var(--gain)" : "var(--perte)";

  function repere(v, couleur, etiquette, forme, yTexte) {
    if (!Number.isFinite(v) || v <= 0) return "";
    const px = x(v);
    const dessous = yTexte > yAxe;
    const yMarque = dessous ? yAxe + 7 : yAxe - 7;

    const tete = forme === "losange"
      ? `<rect x="${(px - 4).toFixed(1)}" y="${(yMarque - 4).toFixed(1)}" width="8" height="8" fill="${couleur}" transform="rotate(45 ${px.toFixed(1)} ${yMarque.toFixed(1)})"/>`
      : forme === "bas"
      ? `<path d="M${(px - 5).toFixed(1)} ${(yMarque - 4).toFixed(1)} L${(px + 5).toFixed(1)} ${(yMarque - 4).toFixed(1)} L${px.toFixed(1)} ${(yMarque + 4.5).toFixed(1)} Z" fill="${couleur}"/>`
      : forme === "haut"
      ? `<path d="M${(px - 5).toFixed(1)} ${(yMarque + 4).toFixed(1)} L${(px + 5).toFixed(1)} ${(yMarque + 4).toFixed(1)} L${px.toFixed(1)} ${(yMarque - 4.5).toFixed(1)} Z" fill="${couleur}"/>`
      : `<circle cx="${px.toFixed(1)}" cy="${yMarque.toFixed(1)}" r="4.6" fill="${couleur}" stroke="var(--surface)" stroke-width="2"/>`;

    // Le texte est ancre au milieu, mais recale aux bords : sinon les
    // etiquettes extremes sortent du cadre sur telephone.
    const demi = etiquette.length * 3.1;
    const ancre = px - demi < marge.g ? "start" : px + demi > L - marge.d ? "end" : "middle";
    const tx = ancre === "start" ? marge.g : ancre === "end" ? L - marge.d : px;
    // Le trait de rappel part du texte et rejoint le repere, pour quon
    // sache quelle etiquette appartient a quel point meme quand elle a
    // ete recalee au bord.
    const yFin = dessous ? yTexte - 9 : yTexte + 3;
    return `
      <line x1="${px.toFixed(1)}" y1="${yAxe.toFixed(1)}" x2="${px.toFixed(1)}" y2="${yFin.toFixed(1)}" stroke="${couleur}" stroke-width="1" opacity="0.5"/>
      ${tete}
      <text x="${tx.toFixed(1)}" y="${yTexte}" text-anchor="${ancre}" font-size="11.5" font-weight="650" fill="${couleur}" font-family="var(--mono)">${etiquette}</text>`;
  }

  const modeStop = p.stopMode || null;
  const etiqStop = modeStop === "TRAIL" ? "TRAIL " : modeStop === "BE" ? "SEUIL " : "SL ";

  // Un stop au-dessus de lentree sur un long — ou en dessous sur un
  // short — nest PAS un risque : cest un gain deja verrouille. Le
  // peindre en rouge comme un stop de perte dit exactement le
  // contraire de ce quil signifie. La couleur suit donc ce que le
  // stop fait, pas le fait quil sappelle « stop ».
  const stopVerrouille = Number.isFinite(sl) && entree > 0
    && (long ? sl >= entree : sl <= entree);
  const couleurStop = stopVerrouille ? "var(--bon)" : "var(--critique)";

  // Le stop dorigine, quand le trail la deplace. Sans lui, lechelle
  // setend jusqua un point quon ne voit pas, et surtout on ne mesure
  // pas le chemin parcouru — qui est justement ce quun trail apporte.
  let fantome = "";
  if (Number.isFinite(slInit) && Number.isFinite(sl) && Math.abs(slInit - sl) > (max - min) * 0.01) {
    const xa = x(slInit), xb = x(sl);
    fantome = `
      <line x1="${xa.toFixed(1)}" y1="${(yAxe + 7).toFixed(1)}" x2="${xb.toFixed(1)}" y2="${(yAxe + 7).toFixed(1)}"
            stroke="var(--texte-3)" stroke-width="1.2" stroke-dasharray="3 3" opacity="0.75"/>
      <path d="M${(xa - 4).toFixed(1)} ${(yAxe + 3.5).toFixed(1)} L${(xa + 4).toFixed(1)} ${(yAxe + 3.5).toFixed(1)} L${xa.toFixed(1)} ${(yAxe + 10).toFixed(1)} Z"
            fill="none" stroke="var(--texte-3)" stroke-width="1.2" opacity="0.75"/>
      <text x="${xa.toFixed(1)}" y="${(yAxe + 19).toFixed(1)}" text-anchor="middle" font-size="9"
            fill="var(--texte-3)" font-family="var(--mono)">départ ${prix(slInit)}</text>`;
  }

  return `
  <svg viewBox="0 0 ${L} ${H}" style="width:100%;height:auto;display:block" role="img"
       aria-label="Échelle de prix : stop ${prix(sl)}${stopVerrouille ? " (gain verrouillé)" : ""}, entrée ${prix(entree)}, prix courant ${prix(marque)}, take-profit ${prix(tp)}">
    <rect x="${bx1.toFixed(1)}" y="${(yAxe - 3).toFixed(1)}" width="${Math.max(0, bx2 - bx1).toFixed(1)}" height="6"
          fill="${teinte}" opacity="0.32" rx="1"/>
    <line x1="${marge.g}" y1="${yAxe}" x2="${L - marge.d}" y2="${yAxe}" stroke="var(--bord-fort)" stroke-width="1.4"/>
    ${fantome}
    ${repere(tp, "var(--bon)", "TP " + prix(tp), "haut", LIGNE.tp)}
    ${repere(marque, long ? "var(--long)" : "var(--short)", prix(marque), "rond", LIGNE.prix)}
    ${repere(sl, couleurStop, etiqStop + prix(sl), "bas", LIGNE.sl)}
    ${repere(entree, "var(--texte-2)", "ENTRÉE " + prix(entree), "losange", LIGNE.entree)}
  </svg>`;
}

function carteposition(p) {
  const long = p.side === "LONG";
  const pnl = Number(p.unrealizedPnl) || 0;
  const pnlPct = Number(p.pnlPctOfMargin) || 0;

  // La legende doit dire la meme chose que le dessin. Un stop remonte
  // au-dela de lentree y est vert ; annoncer « stop » en rouge dans la
  // legende ferait mentir lun des deux.
  const slAff = Number(p.stopActuel || p.stopLoss);
  const entreeAff = Number(p.entryPrice);
  const stopVerrouille = Number.isFinite(slAff) && entreeAff > 0
    && (long ? slAff >= entreeAff : slAff <= entreeAff);

  let marqueStop = "";
  if (p.stopMode === "TRAIL") {
    marqueStop = `<span class="marque-trail" title="Le stop suit le prix et ne redescend jamais">↗ TRAIL ACTIF</span>`;
  } else if (p.stopMode === "BE") {
    marqueStop = `<span class="marque-be" title="Stop remonté au point mort : la position ne peut plus perdre">= SEUIL</span>`;
  }
  const marqueAlgo = p.trailArme
    ? `<span class="marque-trail" title="Un ordre de suivi est posé côté exchange">⛓ suivi posé</span>` : "";

  return `
  <article class="position">
    <div class="position-tete">
      <span class="sym">${ech(court(p.symbol))}</span>
      <span class="sens ${long ? "long" : "short"}">${long ? "↑ LONG" : "↓ SHORT"}</span>
      <span class="levier">×${ech(p.leverage || "?")}</span>
      ${marqueStop}${marqueAlgo}
      <div class="position-pnl">
        <div class="u ${classeSigne(pnl)}">${usd(pnl)}</div>
        <div class="p">${pct(pnlPct)} de la marge</div>
      </div>
    </div>

    <div class="faits">
      <div class="fait"><div class="e">Taille</div><div class="v">${taille(p.size)}</div></div>
      <div class="fait"><div class="e">Marge</div><div class="v">${nf(Number(p.margin) || 0)}\u00a0$</div></div>
      <div class="fait"><div class="e">Notionnel</div><div class="v">${nf(Number(p.notional) || 0)}\u00a0$</div></div>
      <div class="fait"><div class="e">Tenue</div><div class="v">${duree(p.entryTime)}</div></div>
    </div>

    <div class="jauge-zone">
      ${reglette(p)}
      <div class="jauge-legende">
        <span><i style="background:${stopVerrouille ? "var(--bon)" : "var(--critique)"}"></i>${stopVerrouille ? "stop (gain verrouillé)" : "stop"}</span>
        <span><i style="background:var(--texte-2)"></i>entrée</span>
        <span><i style="background:${long ? "var(--long)" : "var(--short)"}"></i>prix</span>
        <span><i style="background:var(--bon)"></i>take-profit</span>
      </div>
    </div>
  </article>`;
}

function tableauPositions(liste) {
  if (!liste.length) return "";
  const l = liste.map((p) => `
    <tr>
      <td>${ech(court(p.symbol))}</td>
      <td>${p.side === "LONG" ? "↑ LONG" : "↓ SHORT"}</td>
      <td>×${ech(p.leverage || "?")}</td>
      <td>${taille(p.size)}</td>
      <td>${nf(Number(p.margin) || 0)}\u00a0$</td>
      <td>${prix(p.entryPrice)}</td>
      <td>${prix(p.markPrice)}</td>
      <td>${prix(p.stopActuel || p.stopLoss)}</td>
      <td>${p.stopMode ? ech(p.stopMode) : "—"}</td>
      <td>${prix(p.takeProfit)}</td>
      <td class="${classeSigne(Number(p.unrealizedPnl) || 0)}">${usd(Number(p.unrealizedPnl) || 0)}</td>
      <td>${duree(p.entryTime)}</td>
    </tr>`).join("");
  return `<div class="enrouler"><table>
    <thead><tr><th>Instrument</th><th>Sens</th><th>Levier</th><th>Taille</th><th>Marge</th>
    <th>Entrée</th><th>Prix</th><th>Stop</th><th>Mode</th><th>TP</th><th>PnL</th><th>Tenue</th></tr></thead>
    <tbody>${l}</tbody></table></div>`;
}

/* ===== la courbe dequite ===== */

function courbe(points) {
  const zone = $("zone-courbe");
  if (!points || points.length < 2) {
    zone.innerHTML = `<div class="vide"><strong>Pas encore d'historique</strong>La courbe apparaît dès que le moteur a relevé quelques points d'équité.</div>`;
    return;
  }
  const L = 800, H = 210, m = { g: 62, d: 14, h: 14, b: 26 };
  const vs = points.map((p) => Number(p.v) || 0);
  let min = Math.min(...vs), max = Math.max(...vs);

  // Une serie plate na pas de courbe, et lui en fabriquer une est pire
  // que de nen montrer aucune : les graduations se dupliquent, lecart
  // affiche vient du remplissage et non des donnees, et le lecteur
  // croit voir une variation. On le dit, cest tout.
  if (max === min) {
    zone.innerHTML = `<div class="vide"><strong>Équité constante à ${nf(min)}\u00a0$</strong>
      ${points.length} points relevés, tous identiques. La courbe apparaîtra dès que l'équité bougera.</div>`;
    $("n-equite").textContent = `${points.length} points, plats`;
    return;
  }

  const pad = (max - min) * 0.1; min -= pad; max += pad;

  const x = (i) => m.g + (i / (points.length - 1)) * (L - m.g - m.d);
  const y = (v) => m.h + (1 - (v - min) / (max - min)) * (H - m.h - m.b);

  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
  const aire = `${d} L${x(points.length - 1).toFixed(1)} ${y(min).toFixed(1)} L${x(0).toFixed(1)} ${y(min).toFixed(1)} Z`;

  // Quatre graduations. Plus, et la grille se met a concurrencer la
  // ligne quelle est censee servir.
  //
  // Le nombre de decimales se deduit de LETENDUE, pas dune constante :
  // arrondir a lentier une plage de trois dollars imprime « 1, 1, 0 »,
  // deux etiquettes identiques a des hauteurs differentes. Une
  // graduation qui se repete est pire quaucune graduation.
  const etendue = max - min;
  const dec = etendue >= 400 ? 0 : etendue >= 40 ? 1 : etendue >= 4 ? 2 : 3;
  let grille = "";
  for (let i = 0; i <= 4; i++) {
    const v = min + (i / 4) * (max - min);
    const yy = y(v);
    grille += `<line x1="${m.g}" y1="${yy.toFixed(1)}" x2="${L - m.d}" y2="${yy.toFixed(1)}" stroke="var(--bord)" stroke-width="1"/>
      <text x="${m.g - 7}" y="${(yy + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--texte-3)" font-family="var(--mono)">${nf(v, dec)}</text>`;
  }

  zone.innerHTML = `
    <svg viewBox="0 0 ${L} ${H}" width="100%" height="${H}" id="svg-courbe" style="display:block;overflow:visible">
      <defs><linearGradient id="degrade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--serie)" stop-opacity="0.24"/>
        <stop offset="100%" stop-color="var(--serie)" stop-opacity="0"/>
      </linearGradient></defs>
      ${grille}
      <path d="${aire}" fill="url(#degrade)"/>
      <path d="${d}" fill="none" stroke="var(--serie)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <line id="viseur" x1="0" y1="${m.h}" x2="0" y2="${H - m.b}" stroke="var(--texte-3)" stroke-width="1" stroke-dasharray="3 3" opacity="0"/>
      <circle id="viseur-pt" r="4" fill="var(--serie)" stroke="var(--surface)" stroke-width="2" opacity="0"/>
      <rect x="${m.g}" y="${m.h}" width="${L - m.g - m.d}" height="${H - m.h - m.b}" fill="transparent" id="capteur"/>
    </svg>
    <div class="infobulle" id="bulle"></div>`;

  const svg = $("svg-courbe"), bulle = $("bulle"), vis = $("viseur"), pt = $("viseur-pt");
  const capteur = $("capteur");
  function survol(ev) {
    const r = svg.getBoundingClientRect();
    const cx = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left) / r.width * L;
    let i = Math.round(((cx - m.g) / (L - m.g - m.d)) * (points.length - 1));
    i = Math.max(0, Math.min(points.length - 1, i));
    const px = x(i), py = y(points[i].v);
    vis.setAttribute("x1", px); vis.setAttribute("x2", px); vis.setAttribute("opacity", "0.55");
    pt.setAttribute("cx", px); pt.setAttribute("cy", py); pt.setAttribute("opacity", "1");
    bulle.style.opacity = "1";
    bulle.style.left = (px / L * r.width) + "px";
    bulle.style.top = (py / H * r.height - 10) + "px";
    const t = new Date(points[i].t);
    bulle.textContent = `${nf(points[i].v)}\u00a0$ · ${t.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
  }
  function sortie() { vis.setAttribute("opacity", "0"); pt.setAttribute("opacity", "0"); bulle.style.opacity = "0"; }
  capteur.addEventListener("mousemove", survol);
  capteur.addEventListener("mouseleave", sortie);
  capteur.addEventListener("touchmove", survol, { passive: true });
  capteur.addEventListener("touchend", sortie);

  $("n-equite").textContent = `${points.length} points`;
}

/* ===== rendu general ===== */

function rendreChiffres() {
  const d = E.portefeuille || {};
  const f = d.futures || {}, po = d.positions || {}, pe = d.performance || {};
  const equite = Number(f.total) || Number(d.spot?.total) || 0;
  const latent = Number(f.unrealizedPnL) || 0;
  const jour = Number(pe.dailyPnL) || 0;

  const t = [
    { e: "Équité", v: nf(equite) + "\u00a0$", s: `disponible ${nf(Number(f.available) || 0)}\u00a0$` },
    { e: "PnL latent", v: usd(latent), s: "sur les positions ouvertes", c: classeSigne(latent) },
    { e: "PnL du jour", v: usd(jour), s: `${Number(pe.dailyTrades) || 0} trades aujourd'hui`, c: classeSigne(jour) },
    { e: "Marge engagée", v: nf(Number(po.totalMargin) || 0) + "\u00a0$", s: `notionnel ${nf(Number(po.totalValue) || 0)}\u00a0$` },
    { e: "Positions", v: String(Number(po.count) || 0), s: "ouvertes en ce moment" },
    { e: "Taux de gain", v: nf(Number(pe.winrate) || 0, 1) + "\u00a0%", s: `${Number(pe.totalTrades) || 0} trades au total` },
  ];
  $("chiffres").innerHTML = t.map((k) => `
    <div class="tuile">
      <div class="etiq">${k.e}</div>
      <div class="valeur ${k.c || ""}">${k.v}</div>
      <div class="sous">${k.s}</div>
    </div>`).join("");
}

function rendrePositions() {
  const liste = (E.portefeuille && E.portefeuille.openPositionsDetails) || [];
  $("n-positions").textContent = liste.length ? `${liste.length} ouverte${liste.length > 1 ? "s" : ""}` : "aucune";

  const zc = $("zone-positions"), zt = $("zone-positions-table");
  if (!liste.length) {
    zc.innerHTML = `<div class="vide"><strong>Aucune position ouverte</strong>Les positions apparaissent ici dès qu'une stratégie en ouvre une, avec leur stop et leur take-profit.</div>`;
    zt.innerHTML = "";
    zc.hidden = false; zt.hidden = true;
    return;
  }
  zc.innerHTML = `<div class="positions">${liste.map(carteposition).join("")}</div>`;
  zt.innerHTML = tableauPositions(liste);
  zc.hidden = E.vueTableau;
  zt.hidden = !E.vueTableau;
}

const NOMS = {
  wsPublic: "Flux public", wsPrivate: "Flux privé", rest: "API REST",
  dataFlow: "Données", strategy: "Stratégie", aiEngine: "Moteur",
  orders: "Ordres", stops: "Protections", portfolio: "Portefeuille",
};
function rendreSante() {
  const m = E.sante.modules || {};
  const cles = Object.keys(m);
  if (!cles.length) { $("zone-sante").innerHTML = `<div class="vide">En attente du premier battement.</div>`; return; }
  let nOk = 0;
  $("zone-sante").innerHTML = cles.map((k) => {
    const v = m[k] || {};
    const s = String(v.status || "").toUpperCase();
    if (s === "OK") nOk++;
    const c = s === "OK" ? "bon" : s === "FAULT" ? "critique" : "attention";
    // Le statut ne se lit pas quau point : le mot est a cote.
    const detail = (s || "?") + (v.info ? " · " + String(v.info) : "");
    return `<div class="module" title="${ech(detail)}">
      <span class="point ${c}"></span>
      <div>
        <div class="n">${ech(NOMS[k] || k)}</div>
        <div class="i">${ech(detail)}</div>
      </div>
    </div>`;
  }).join("");
  $("n-sante").textContent = `${nOk} / ${cles.length} au vert`;
}

const CLASSE_EVT = (e) => {
  const s = String(e || "");
  if (s.includes("ENTER")) return "e-entree";
  if (s.includes("EXIT")) return "e-sortie";
  if (s.startsWith("STOP")) return "e-stop";
  if (s.includes("GUARD")) return "e-garde";
  return "";
};
function rendreJournal() {
  const z = $("zone-journal");
  if (!E.journal.length) { z.innerHTML = `<div class="vide" style="padding:20px">Rien pour l'instant. Le journal se remplit dès que le moteur agit.</div>`; return; }
  const auBas = z.scrollTop + z.clientHeight >= z.scrollHeight - 40;
  z.innerHTML = E.journal.slice(-300).map((l) => {
    const { ts, event, ...reste } = l;
    const h = ts ? new Date(ts).toLocaleTimeString("fr-FR", { hour12: false }) : "--:--:--";
    return `<div class="l">
      <span class="t">${ech(h)}</span>
      <span class="e ${CLASSE_EVT(event)}">${ech(event || "—")}</span>
      <span class="d">${ech(JSON.stringify(reste).slice(1, -1).replace(/","/g, " · ").replace(/"/g, ""))}</span>
    </div>`;
  }).join("");
  if (auBas) z.scrollTop = z.scrollHeight;
  $("n-journal").textContent = String(E.journal.length);
}

function rendreEntete() {
  $("pt-lien").className = "point " + (E.relie ? "bon vif" : "critique");
  $("t-lien").textContent = E.relie ? "relié" : "hors ligne";

  $("pt-moteur").className = "point " + (E.moteurActif ? "bon vif" : "");
  $("t-moteur").textContent = E.moteurActif ? "moteur en marche" : "moteur à l'arrêt";

  const pilote = E.mode === "full";
  $("t-mode").textContent = pilote ? "pilotage" : "lecture seule";
  $("avis-lecture").hidden = pilote;

  const b = $("b-moteur");
  b.textContent = E.moteurActif ? "Arrêter" : "Démarrer";
  b.className = E.moteurActif ? "danger" : "principal";
  b.disabled = !pilote;
  b.title = pilote ? "" : "Indisponible en lecture seule";
}

/* ===== boucle ===== */

async function rafraichir() {
  try {
    const [pf, etat, live, mode] = await Promise.all([
      api.invoke("fetch-portfolio"),
      api.invoke("get-ai-state"),
      api.invoke("ai:live-status"),
      api.invoke("ui-mode"),
    ]);
    if (pf && pf.data) E.portefeuille = pf.data;
    if (live) E.moteurActif = !!live.liveEnabled;
    if (mode && mode.mode) E.mode = mode.mode;
    if (etat && Array.isArray(etat.logs) && etat.logs.length && !E.journal.length) E.journal = etat.logs.slice(-300);
    E.relie = true;
  } catch (e) {
    E.relie = false;
  }
  rendreEntete();
  rendreChiffres();
  rendrePositions();
  courbe(E.portefeuille && E.portefeuille.history ? E.portefeuille.history.spot : []);
}

/* ===== branchements ===== */

api.surSante((h) => { E.sante = h || {}; rendreSante(); });
api.subscribe((l) => { if (!l) return; E.journal.push(l); if (E.journal.length > 600) E.journal.shift(); rendreJournal(); });
api.surLien((s) => { E.relie = !!(s && s.relie); rendreEntete(); });

$("b-moteur").addEventListener("click", async () => {
  const b = $("b-moteur"); b.disabled = true;
  try { await api.invoke("toggle-ai", !E.moteurActif); } catch {}
  await rafraichir();
});

$("b-vue").addEventListener("click", () => {
  E.vueTableau = !E.vueTableau;
  $("b-vue").textContent = E.vueTableau ? "Vue cartes" : "Vue tableau";
  rendrePositions();
});

$("b-vider").addEventListener("click", () => { E.journal = []; rendreJournal(); });

// Le theme : le choix explicite lemporte sur le systeme, et il tient
// dun passage a lautre. Toute lecture de stockage est gardee — un
// navigateur en navigation privee la refuse, et la page doit sen
// remettre sans rien casser.
(function theme() {
  let actuel = null;
  try { actuel = localStorage.getItem("hermes-theme"); } catch {}
  if (actuel) document.documentElement.setAttribute("data-theme", actuel);
  $("b-theme").addEventListener("click", () => {
    const sombreSysteme = matchMedia("(prefers-color-scheme: dark)").matches;
    const maintenant = document.documentElement.getAttribute("data-theme") || (sombreSysteme ? "dark" : "light");
    const suivant = maintenant === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", suivant);
    try { localStorage.setItem("hermes-theme", suivant); } catch {}
    if (E.portefeuille) courbe(E.portefeuille.history ? E.portefeuille.history.spot : []);
  });
})();

rendreEntete();
rendreJournal();
rendreSante();
rafraichir();
setInterval(rafraichir, 4000);
