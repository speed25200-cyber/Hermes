/* ============================================================
   La vue graphique d'une position.

   Un clic sur une carte ouvre l'instrument en chandelles, avec les
   niveaux de la position posés dessus : entrée, take-profit, stop,
   liquidation, prix. C'est la réponse à une question simple que la
   carte ne peut pas traiter : « où est mon stop PAR RAPPORT au
   marché ? » — une distance ne se lit que sur une échelle.

   Tout le dessin est un seul SVG reconstruit d'un bloc. À l'échelle
   d'un graphe (quelques centaines de nœuds), reconstruire est plus
   simple ET plus sûr que réconcilier : aucun état intermédiaire ne
   peut survivre à tort. L'exception est le réticule, redessiné seul
   au mouvement du pointeur — reconstruire trois cents chandelles à
   chaque millimètre de souris ferait ramer le téléphone qui est
   précisément l'écran principal ici.
   ============================================================ */
"use strict";

const Graphe = (() => {

  const CADRES = ["1m", "5m", "15m", "1H", "4H", "1D"];
  const MIN_VISIBLES = 18;          // en deçà, zoomer n'apprend plus rien

  const G = {
    ouvert: false,
    instId: null,
    bar: "5m",
    rows: [],                        // [ts, o, h, l, c, vol], du plus ancien au plus récent
    a: 0, b: 0,                      // fenêtre visible, indexes fractionnaires
    montre: null,                    // { x, y } du réticule, en px
    minuterie: null,
    geste: null,                     // panoramique ou pincement en cours
  };

  const $g = (id) => document.getElementById(id);
  const NS = "http://www.w3.org/2000/svg";
  const el = (nom, attrs) => {
    const n = document.createElementNS(NS, nom);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };

  /* ===== données ===== */

  function positionCourante() {
    const liste = (E.pf && E.pf.openPositionsDetails) || [];
    return liste.find((p) => p.symbol === G.instId) || null;
  }

  async function charger() {
    try {
      const r = await api.invoke("chandelles", { instId: G.instId, bar: G.bar });
      if (!r || !r.ok || !Array.isArray(r.rows) || !r.rows.length) {
        $g("g-zone").innerHTML = `<div class="attente">Les chandelles ne sont pas arrivées${r && r.error ? " — " + ech(r.error) : ""}.</div>`;
        return;
      }
      const colle = G.rows.length && G.b >= G.rows.length - 1.5;   // l'œil était au bord droit
      const memesBornes = G.rows.length && G.rows[0][0] === r.rows[0][0];
      G.rows = r.rows;
      if (!memesBornes || colle || G.b === 0) {
        G.b = G.rows.length;
        G.a = Math.max(0, G.b - 120);
      } else {
        G.b = Math.min(G.b, G.rows.length);
        G.a = Math.max(0, Math.min(G.a, G.b - MIN_VISIBLES));
      }
      dessiner();
    } catch (e) {
      $g("g-zone").innerHTML = `<div class="attente">Le serveur n'a pas répondu.</div>`;
    }
  }

  /* ===== échelles ===== */

  // Des graduations « rondes » : 1, 2 ou 5 fois une puissance de dix.
  // Un axe gradué à 0,0371 / 0,0446 / 0,0521 se lit comme un code ;
  // à 0,038 / 0,040 / 0,042 il se lit comme un prix.
  function graduations(min, max, cible) {
    const brut = (max - min) / Math.max(1, cible);
    const p = Math.pow(10, Math.floor(Math.log10(brut)));
    const pas = [1, 2, 5, 10].map((m) => m * p).find((v) => v >= brut) || 10 * p;
    const debut = Math.ceil(min / pas) * pas;
    const out = [];
    for (let v = debut; v <= max + pas * 1e-9; v += pas) out.push(v);
    return out;
  }

  function heure(ts) {
    const d = new Date(ts);
    const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    if (G.bar === "1D") return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short" });
    return hm;
  }
  function heurePleine(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short" }) + " " +
           String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  /* ===== le dessin ===== */

  function dessiner() {
    const zone = $g("g-zone");
    const W = zone.clientWidth, H = zone.clientHeight;
    if (!W || !H || !G.rows.length) return;

    const AXE_D = 74, AXE_B = 22, HAUT = 10;
    const pw = W - AXE_D, ph = H - AXE_B - HAUT;
    const volH = Math.round(ph * 0.14);

    const i0 = Math.max(0, Math.floor(G.a)), i1 = Math.min(G.rows.length, Math.ceil(G.b));
    const visibles = G.rows.slice(i0, i1);
    if (!visibles.length) return;

    const pos = positionCourante();
    const dernier = G.rows[G.rows.length - 1];
    const prixCourant = (pos && pos.markPrice) || dernier[4];

    // Le domaine vertical : ce que le marché a fait, PLUS les niveaux
    // de la position — un take-profit hors cadre serait précisément ce
    // que cette vue existe pour montrer. La liquidation, souvent très
    // loin, n'étire l'échelle que si elle est raisonnablement proche :
    // écraser 300 chandelles pour un niveau à -20 % rendrait tout le
    // reste illisible, et son éloignement est dit dans les niveaux.
    let bas = Infinity, hautP = -Infinity;
    for (const k of visibles) { if (k[3] < bas) bas = k[3]; if (k[2] > hautP) hautP = k[2]; }
    const etendue0 = hautP - bas || bas * 0.01 || 1;
    const niveaux = [];
    if (pos) {
      if (pos.entryPrice > 0) niveaux.push(pos.entryPrice);
      if (pos.takeProfit > 0) niveaux.push(pos.takeProfit);
      if (pos.stopActuel > 0) niveaux.push(pos.stopActuel);
      if (pos.liqPrice > 0 && Math.abs(pos.liqPrice - prixCourant) < etendue0 * 1.6) niveaux.push(pos.liqPrice);
    }
    for (const v of niveaux) { if (v < bas) bas = v; if (v > hautP) hautP = v; }
    const marge = (hautP - bas) * 0.07 || bas * 0.004 || 1;
    bas -= marge; hautP += marge;

    const volMax = Math.max(...visibles.map((k) => k[5])) || 1;
    const cw = pw / Math.max(1e-9, G.b - G.a);
    const corps = Math.max(1, Math.min(13, cw * 0.62));

    const x = (i) => (i + 0.5 - G.a) * cw;
    const y = (v) => HAUT + (1 - (v - bas) / (hautP - bas)) * (ph - volH - 6);

    const style = getComputedStyle(document.documentElement);
    const C = (n) => style.getPropertyValue(n).trim();
    const cGain = C("--gain"), cPerte = C("--perte"), cBord = C("--bord"),
          cT2 = C("--texte-2"), cT3 = C("--texte-3"), cBon = C("--bon"),
          cCrit = C("--critique"), cSurface = C("--surface");

    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H });

    /* — la grille, sous tout le reste — */
    const grille = el("g", { "shape-rendering": "crispEdges" });
    const gradsY = graduations(bas, hautP, Math.max(3, Math.round(ph / 64)));
    for (const v of gradsY) {
      grille.appendChild(el("line", { x1: 0, x2: pw, y1: y(v).toFixed(1), y2: y(v).toFixed(1), stroke: cBord, "stroke-opacity": ".5" }));
      const t = el("text", { x: pw + 8, y: (y(v) + 3.5).toFixed(1), fill: cT3, "font-size": 10, "font-family": "var(--mono)" });
      t.textContent = prix(v);
      svg.appendChild(t);
    }
    // Une graduation temporelle tous les ~92 px — posée sur une heure
    // RONDE. Un axe qui dit 03:19, 06:14, 09:09 se lit chandelle par
    // chandelle ; 04:00, 06:00, 08:00 se lit d'un regard. On choisit le
    // plus petit pas « rond » qui respecte l'espacement, puis on ne
    // marque que les chandelles dont l'heure tombe juste.
    const BAR_MS = { "1m": 60e3, "5m": 300e3, "15m": 900e3, "1H": 3600e3, "4H": 14400e3, "1D": 86400e3 };
    const RONDS = [60e3, 300e3, 900e3, 1800e3, 3600e3, 7200e3, 14400e3, 43200e3, 86400e3, 172800e3];
    const besoin = (92 / cw) * (BAR_MS[G.bar] || 300e3);
    const rond = RONDS.find((v) => v >= besoin) || RONDS[RONDS.length - 1];
    const decalage = new Date(G.rows[0][0]).getTimezoneOffset() * 60e3;
    const barMs = BAR_MS[G.bar] || 300e3;
    for (let i = i0; i < i1; i++) {
      if (!G.rows[i]) continue;
      // La premiere chandelle A ou APRES chaque frontiere ronde. Exiger
      // le zero exact suppose des horodatages parfaitement alignes —
      // vrai chez OKX aujourdhui, mais une graduation ne doit pas
      // dependre de cette perfection pour exister.
      const r = (((G.rows[i][0] - decalage) % rond) + rond) % rond;
      if (r >= barMs) continue;
      const px = x(i);
      grille.appendChild(el("line", { x1: px.toFixed(1), x2: px.toFixed(1), y1: HAUT, y2: HAUT + ph, stroke: cBord, "stroke-opacity": ".3" }));
      const t = el("text", { x: px.toFixed(1), y: H - 7, fill: cT3, "font-size": 10, "text-anchor": "middle", "font-family": "var(--mono)" });
      t.textContent = heure(G.rows[i][0]);
      svg.appendChild(t);
    }
    svg.appendChild(grille);

    /* — volumes, discrets, sous les chandelles — */
    const gVol = el("g", {});
    for (let i = i0; i < i1; i++) {
      const k = G.rows[i];
      const h = Math.max(1, (k[5] / volMax) * volH);
      gVol.appendChild(el("rect", {
        x: (x(i) - corps / 2).toFixed(1), y: (HAUT + ph - h).toFixed(1),
        width: corps.toFixed(1), height: h.toFixed(1),
        fill: k[4] >= k[1] ? cGain : cPerte, "fill-opacity": ".16", rx: 1
      }));
    }
    svg.appendChild(gVol);

    /* — les chandelles — */
    const gCh = el("g", {});
    for (let i = i0; i < i1; i++) {
      const k = G.rows[i];
      const monte = k[4] >= k[1];
      const c = monte ? cGain : cPerte;
      const cx = x(i);
      gCh.appendChild(el("line", {
        x1: cx.toFixed(1), x2: cx.toFixed(1),
        y1: y(k[2]).toFixed(1), y2: y(k[3]).toFixed(1),
        stroke: c, "stroke-width": Math.max(1, corps * 0.14).toFixed(1)
      }));
      const yO = y(k[1]), yC = y(k[4]);
      gCh.appendChild(el("rect", {
        x: (cx - corps / 2).toFixed(1), y: Math.min(yO, yC).toFixed(1),
        width: corps.toFixed(1), height: Math.max(1, Math.abs(yO - yC)).toFixed(1),
        fill: c, rx: corps > 3 ? 1 : 0
      }));
    }
    svg.appendChild(gCh);

    /* — les niveaux de la position — */
    const ligne = (v, couleur, texte, pointille) => {
      if (!(v > 0) || v < bas || v > hautP) return;
      const py = y(v);
      svg.appendChild(el("line", {
        x1: 0, x2: pw, y1: py.toFixed(1), y2: py.toFixed(1),
        stroke: couleur, "stroke-width": 1.2,
        ...(pointille ? { "stroke-dasharray": pointille } : {})
      }));
      const etiquette = el("g", {});
      const larg = texte.length * 6.4 + 10;
      etiquette.appendChild(el("rect", {
        x: pw + 1, y: (py - 9).toFixed(1), width: Math.min(72, Math.max(58, larg)), height: 18, rx: 4,
        fill: couleur
      }));
      const t = el("text", {
        x: pw + 1 + Math.min(72, Math.max(58, larg)) / 2, y: (py + 3.6).toFixed(1),
        fill: cSurface, "font-size": 10, "font-weight": 600,
        "text-anchor": "middle", "font-family": "var(--mono)"
      });
      t.textContent = texte;
      etiquette.appendChild(t);
      svg.appendChild(etiquette);
    };

    if (pos) {
      const verrou = pos.stopActuel > 0 && pos.entryPrice > 0 &&
        (pos.side === "LONG" ? pos.stopActuel >= pos.entryPrice : pos.stopActuel <= pos.entryPrice);
      ligne(pos.entryPrice, cT2, "ENTRÉE", "5 4");
      ligne(pos.takeProfit, cBon, "TP");
      ligne(pos.stopActuel, verrou ? cBon : cCrit, pos.stopMode === "TRAIL" ? "TRAIL" : verrou ? "SEUIL" : "SL");
      ligne(pos.liqPrice, cPerte, "LIQ", "2 4");
    }
    // Le prix, toujours : c'est la référence de tous les autres traits.
    const cPrix = dernier[4] >= dernier[1] ? cGain : cPerte;
    ligne(prixCourant, cPrix, prix(prixCourant), "1.5 3");

    /* — le réticule, sur sa propre couche — */
    const gCroix = el("g", { id: "g-croix", "pointer-events": "none" });
    svg.appendChild(gCroix);

    zone.innerHTML = "";
    zone.appendChild(svg);
    G._dims = { W, H, pw, ph, HAUT, AXE_D, y, x, bas, hautP, cw, i0, i1 };
    lecture(null);
    if (G.montre) reticule(G.montre.x, G.montre.y);
    niveauxPied(pos, prixCourant);
    entete(pos);
  }

  /* La ligne OHLC au-dessus du dessin. Sans réticule elle décrit la
     dernière chandelle ; sous le réticule, celle qu'on survole. */
  function lecture(i) {
    const zone = $g("g-ohlc");
    const k = (i != null && G.rows[i]) || G.rows[G.rows.length - 1];
    if (!k) { zone.innerHTML = ""; return; }
    const monte = k[4] >= k[1];
    const cls = monte ? "gain" : "perte";
    zone.innerHTML =
      `<span class="et">${ech(heurePleine(k[0]))}</span>` +
      `<span class="${cls}"><span class="et">O</span> <b>${prix(k[1])}</b></span>` +
      `<span class="${cls}"><span class="et">H</span> <b>${prix(k[2])}</b></span>` +
      `<span class="${cls}"><span class="et">B</span> <b>${prix(k[3])}</b></span>` +
      `<span class="${cls}"><span class="et">C</span> <b>${prix(k[4])}</b></span>` +
      `<span><span class="et">VOL</span> <b>${taille(k[5])}</b></span>`;
  }

  function reticule(px, py) {
    const d = G._dims;
    if (!d) return;
    const g = document.getElementById("g-croix");
    if (!g) return;
    while (g.firstChild) g.removeChild(g.firstChild);
    if (px == null) { lecture(null); return; }

    const i = Math.round(px / d.cw + G.a - 0.5);
    if (i < 0 || i >= G.rows.length) { lecture(null); return; }
    const cx = d.x(i);

    g.appendChild(el("line", { x1: cx.toFixed(1), x2: cx.toFixed(1), y1: d.HAUT, y2: d.HAUT + d.ph,
      stroke: "currentColor", "stroke-opacity": ".35", "stroke-dasharray": "3 3" }));
    if (py >= d.HAUT && py <= d.HAUT + d.ph) {
      g.appendChild(el("line", { x1: 0, x2: d.pw, y1: py.toFixed(1), y2: py.toFixed(1),
        stroke: "currentColor", "stroke-opacity": ".35", "stroke-dasharray": "3 3" }));
      const v = d.bas + (1 - (py - d.HAUT) / (d.ph - Math.round(d.ph * 0.14) - 6)) * (d.hautP - d.bas);
      const texte = prix(v);
      g.appendChild(el("rect", {
        x: d.pw + 1, y: (py - 9).toFixed(1),
        width: Math.min(72, texte.length * 6.4 + 10), height: 18, rx: 4,
        fill: "var(--texte)", "fill-opacity": ".92"
      }));
      const t = el("text", { x: d.pw + 1 + Math.min(72, texte.length * 6.4 + 10) / 2, y: (py + 3.6).toFixed(1),
        fill: "var(--surface)", "font-size": 10, "font-weight": 600,
        "text-anchor": "middle", "font-family": "var(--mono)" });
      t.textContent = texte;
      g.appendChild(t);
    }
    lecture(i);
  }

  /* ===== la tête et le pied ===== */

  function entete(pos) {
    const long = pos ? pos.side === "LONG" : true;
    const sens = $g("g-sens");
    sens.className = "sens " + (long ? "long" : "short");
    sens.textContent = pos ? (long ? "LONG" : "SHORT") : "";
    sens.hidden = !pos;
    $g("g-lev").textContent = pos ? "×" + (pos.leverage || "?") : "";
    $g("g-sym").textContent = court(G.instId);
    const u = $g("g-pnl"), p = $g("g-pct");
    if (pos) {
      const pnl = Number(pos.unrealizedPnl) || 0;
      u.className = "u " + signe(pnl);
      u.textContent = usd(pnl);
      p.className = "p " + signe(pnl);
      p.textContent = pct(Number(pos.pnlPctOfMargin) || 0) + " de la marge";
    } else { u.textContent = ""; p.textContent = "position fermée"; p.className = "p"; }
  }

  function niveauxPied(pos, prixCourant) {
    const zone = $g("g-niveaux");
    if (!pos) { zone.innerHTML = `<span class="g-niv">Cette position n'est plus ouverte — le graphique reste consultable.</span>`; return; }
    const d = (v) => (pos.entryPrice > 0 && v > 0)
      ? " · " + (((v - pos.entryPrice) / pos.entryPrice) * 100).toLocaleString("fr-FR", { maximumFractionDigits: 2, minimumFractionDigits: 2 }) + " %"
      : "";
    const verrou = pos.stopActuel > 0 && pos.entryPrice > 0 &&
      (pos.side === "LONG" ? pos.stopActuel >= pos.entryPrice : pos.stopActuel <= pos.entryPrice);
    const morceaux = [];
    const niv = (etiq, v, couleur, pointille, note) => {
      if (!(v > 0)) return;
      morceaux.push(`<span class="g-niv${pointille ? " pointille" : ""}" style="--c:${couleur}">
        <i></i>${etiq} <b>${prix(v)}</b>${note || ""}</span>`);
    };
    niv("Entrée", pos.entryPrice, "var(--texte-2)", true);
    niv("Take-profit", pos.takeProfit, "var(--bon)", false, d(pos.takeProfit));
    niv(pos.stopMode === "TRAIL" ? "Stop suiveur" : verrou ? "Stop (gain verrouillé)" : "Stop",
        pos.stopActuel, verrou ? "var(--bon)" : "var(--critique)", false, d(pos.stopActuel));
    niv("Liquidation", pos.liqPrice, "var(--perte)", true, d(pos.liqPrice));
    niv("Prix", prixCourant, "var(--texte)", false, d(prixCourant));
    morceaux.push(`<span class="g-niv" style="opacity:.75">Tenue <b>${duree(pos.entryTime)}</b></span>`);
    zone.innerHTML = morceaux.join("");
  }

  /* ===== gestes : molette, glisser, pincer ===== */

  function borner() {
    const n = G.rows.length;
    const larg = Math.max(MIN_VISIBLES, Math.min(n, G.b - G.a));
    G.a = Math.max(-larg * 0.15, Math.min(G.a, n - larg * 0.5));
    G.b = G.a + larg;
    if (G.b > n + larg * 0.15) { G.b = n + larg * 0.15; G.a = G.b - larg; }
  }

  function zoomer(facteur, fx) {
    const pivot = G.a + fx * (G.b - G.a);
    G.a = pivot - (pivot - G.a) * facteur;
    G.b = pivot + (G.b - pivot) * facteur;
    borner(); dessiner();
  }

  const doigts = new Map();

  function brancherGestes(zone) {
    zone.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = zone.getBoundingClientRect();
      zoomer(Math.exp(e.deltaY * 0.0016), (e.clientX - r.left) / Math.max(1, (G._dims?.pw || r.width)));
    }, { passive: false });

    zone.addEventListener("pointerdown", (e) => {
      zone.setPointerCapture(e.pointerId);
      doigts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (doigts.size === 1) G.geste = { type: "glisse", x: e.clientX, a: G.a, b: G.b };
      else if (doigts.size === 2) {
        const [p1, p2] = [...doigts.values()];
        G.geste = { type: "pince", ecart: Math.abs(p1.x - p2.x) || 1, a: G.a, b: G.b };
      }
    });

    zone.addEventListener("pointermove", (e) => {
      const r = zone.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      if (doigts.has(e.pointerId)) doigts.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (G.geste && G.geste.type === "glisse" && doigts.size === 1) {
        const dx = e.clientX - G.geste.x;
        const di = dx / Math.max(1e-9, G._dims?.cw || 1);
        G.a = G.geste.a - di; G.b = G.geste.b - di;
        borner(); dessiner();
        return;
      }
      if (G.geste && G.geste.type === "pince" && doigts.size === 2) {
        const [p1, p2] = [...doigts.values()];
        const ecart = Math.abs(p1.x - p2.x) || 1;
        const k = G.geste.ecart / ecart;
        const milieu = G.geste.a + 0.5 * (G.geste.b - G.geste.a);
        const larg = (G.geste.b - G.geste.a) * k;
        G.a = milieu - larg / 2; G.b = milieu + larg / 2;
        borner(); dessiner();
        return;
      }
      // Pas de geste : le pointeur promène le réticule.
      G.montre = { x: px, y: py };
      reticule(px, py);
    });

    const finDoigt = (e) => {
      doigts.delete(e.pointerId);
      if (!doigts.size) G.geste = null;
      else if (doigts.size === 1) {
        const [p] = [...doigts.values()];
        G.geste = { type: "glisse", x: p.x, a: G.a, b: G.b };
      }
    };
    zone.addEventListener("pointerup", finDoigt);
    zone.addEventListener("pointercancel", finDoigt);
    zone.addEventListener("pointerleave", () => { G.montre = null; reticule(null); });
    zone.addEventListener("dblclick", () => { G.b = G.rows.length; G.a = Math.max(0, G.b - 120); dessiner(); });
  }

  /* ===== ouverture, fermeture, cycle de vie ===== */

  function cadres() {
    const zone = $g("g-cadres");
    zone.innerHTML = CADRES.map((c) =>
      `<button role="tab" data-bar="${c}" aria-pressed="${c === G.bar}">${c}</button>`).join("");
    zone.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.bar === G.bar) return;
      G.bar = b.dataset.bar;
      G.rows = []; G.a = 0; G.b = 0;
      cadres();
      $g("g-zone").innerHTML = `<div class="attente">Chargement des chandelles…</div>`;
      charger();
    }));
  }

  function ouvrir(instId) {
    G.instId = instId; G.ouvert = true;
    G.rows = []; G.a = 0; G.b = 0; G.montre = null;
    const voile = $g("g-voile");
    voile.hidden = false;
    requestAnimationFrame(() => voile.classList.add("ouvert"));
    document.body.style.overflow = "hidden";
    cadres();
    entete(positionCourante());
    $g("g-zone").innerHTML = `<div class="attente">Chargement des chandelles…</div>`;
    $g("g-niveaux").innerHTML = "";
    $g("g-ohlc").innerHTML = "";
    charger();
    // Les chandelles se rafraîchissent d'elles-mêmes : le cache serveur
    // absorbe l'empressement, la page n'a qu'à demander.
    clearInterval(G.minuterie);
    G.minuterie = setInterval(() => { if (G.ouvert) charger(); }, 15000);
    $g("g-fermer").focus();
  }

  function fermer() {
    G.ouvert = false;
    clearInterval(G.minuterie);
    const voile = $g("g-voile");
    voile.classList.remove("ouvert");
    document.body.style.overflow = "";
    setTimeout(() => { if (!G.ouvert) voile.hidden = true; }, 320);
  }

  /* Appelé par la boucle de la page à chaque relevé : la tête, les
     niveaux et la ligne de prix restent vivants sans refaire un
     aller-retour chandelles. */
  function battement() {
    if (!G.ouvert || !G.rows.length) return;
    dessiner();
  }

  function brancher() {
    $g("g-fermer").addEventListener("click", fermer);
    $g("g-voile").addEventListener("click", (e) => { if (e.target === $g("g-voile")) fermer(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && G.ouvert) fermer(); });

    // La délégation : les cartes vivent et meurent au fil des relevés,
    // un écouteur par carte mourrait avec elle.
    document.addEventListener("click", (e) => {
      const carte = e.target.closest && e.target.closest(".pos[data-sym], #z-tab tbody tr[data-sym]");
      if (carte) ouvrir(carte.dataset.sym);
    });

    brancherGestes($g("g-zone"));
    new ResizeObserver(() => { if (G.ouvert && G.rows.length) dessiner(); }).observe($g("g-zone"));
  }

  brancher();
  return { ouvrir, fermer, battement, estOuvert: () => G.ouvert };
})();
