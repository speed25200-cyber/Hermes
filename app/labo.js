/* ============================================================
   L'onglet Laboratoire.

   Il montre ce que le chercheur autonome a trouvé — et ce qu'il a
   refusé, car un laboratoire qui n'affiche que ses succès est une
   vitrine, pas un laboratoire. La pièce centrale est la carte des
   perles : chaque stratégie retenue posée sur un plan
   sélection × validation. La diagonale y est la ligne de vérité —
   une perle sous elle a promis en sélection plus qu'elle n'a tenu
   en validation, et cela se voit sans lire un seul nombre.
   ============================================================ */
"use strict";

const Labo = (() => {
  const $l = (id) => document.getElementById(id);
  let donnees = null;
  /* Quels details sont ouverts. La page se re-rend toutes les minutes
     (toutes les quatre secondes pendant une passe) : sans cette
     memoire, chaque rafraichissement refermerait ce qu'on lit. */
  const deplies = new Set();
  let minuterie = null, tictac = null;
  let ouvert = false;

  /* ===== navigation ===== */

  const pageMarche = document.querySelector(".page:not(#page-labo)");
  const pageLabo = $l("page-labo");

  function montrer(labo) {
    ouvert = labo;
    pageMarche.hidden = labo;
    pageLabo.hidden = !labo;
    $l("nav-marche").setAttribute("aria-pressed", String(!labo));
    $l("nav-labo").setAttribute("aria-pressed", String(labo));
    try { localStorage.setItem("hermes-page", labo ? "labo" : "marche"); } catch {}
    if (labo) { charger(); demarrerTictac(); }
    else arreterTictac();
  }
  $l("nav-marche").addEventListener("click", () => montrer(false));
  $l("nav-labo").addEventListener("click", () => montrer(true));

  /* ===== données ===== */

  async function charger() {
    try {
      const r = await api.invoke("laboratoire", {});
      if (r && r.ok) { donnees = r; rendre(); }
    } catch {}
  }
  clearInterval(minuterie);
  minuterie = setInterval(() => { if (ouvert) charger(); }, 60 * 1000);

  /* ===== petits outils ===== */

  const quand = (iso) => {
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.toLocaleDateString(Langues.locale(), { day: "2-digit", month: "short" }) + " " +
      String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  };
  const compte = (ms) => {
    if (ms <= 0) return t("labo.imminente");
    const h = Math.floor(ms / 3600e3), m = Math.floor((ms % 3600e3) / 60e3);
    return t("labo.dans", { v: h ? t("t.heures", { h, m }) : t("t.minutes", { m }) });
  };

  /* Les raisons de refus arrivent dans la langue du serveur — le
     francais du journal. On les traduit par MOTIF, pas par texte :
     chaque forme connue a sa cle, et une forme inconnue passe telle
     quelle plutot que de disparaitre. */
  const raisonTexte = (brut) => {
    const c = String(brut || "");
    let m = c.match(/^le vainqueur \((.+)\) echoue en validation$/);
    if (m) return t("refus.validation", { v: m[1] });
    if (/aucune (?:positive|concourante positive) dans A/i.test(c)) return t("refus.aucune");
    if (/histoire trop courte/.test(c)) return t("refus.courte");
    m = c.match(/^echec de collecte\s*:?\s*(.*)$/);
    if (m) return t("refus.collecte") + (m[1] ? " : " + m[1] : "");
    return c;
  };
  const netTxt = (v) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(2);

  /* Le compte à rebours de la prochaine passe vit à la seconde : un
     nombre qui bouge dit « ce laboratoire est vivant » mieux que
     n'importe quel adjectif. */
  function demarrerTictac() {
    arreterTictac();
    tictac = setInterval(() => {
      const el = document.querySelector("[data-prochaine]");
      if (!el || !donnees?.roster?.genere) return;
      el.textContent = compte(new Date(donnees.roster.genere).getTime() + 30 * 60e3 - Date.now());
    }, 1000);
  }
  function arreterTictac() { clearInterval(tictac); tictac = null; }

  /* ===== le rendu ===== */

  function rendre() {
    const r = donnees?.roster || null;
    const perles = r?.perles || {};
    const refus = r?.refus || {};
    const noms = Object.keys(perles);
    const nCand = Array.isArray(r?.candidats) ? r.candidats.length
                : noms.length + Object.keys(refus).length;

    $l("lb-n").textContent = r ? String(noms.length) : "—";
    $l("lb-sur").textContent = r
      ? t("labo.perles.sur", { n: nCand, s: noms.length > 1 ? "s" : "" })
      : t("labo.attente");

    const meta = [];
    if (r) {
      meta.push(`<span class="g-niv">${ech(t("labo.derniere"))} <b>${ech(quand(r.genere))}</b>${r.dureeS ? ` · ${Math.round(r.dureeS / 60)} min` : ""}</span>`);
      meta.push(`<span class="g-niv">${ech(t("labo.prochaine"))} <b data-prochaine>${ech(compte(new Date(r.genere).getTime() + 30 * 60e3 - Date.now()))}</b></span>`);
      const f = r.fenetres || {};
      meta.push(`<span class="g-niv">${ech(t("labo.fenetres"))} <b>${ech(t("labo.fenetres.val", { j: f.jours ?? 30, v: f.validationJours ?? 7 }))}</b></span>`);
    }
    if (donnees?.joue) {
      const repli = donnees.joue.source !== "chercheur";
      meta.push(`<span class="g-niv" style="--c:${repli ? "var(--short)" : "var(--bon)"}"><i></i>${ech(t("labo.joue"))} <b>${ech(repli ? t("labo.repli") : t("labo.verdict"))}</b></span>`);
    }
    if (donnees?.capital && donnees.capital.places > 0) {
      const c = donnees.capital;
      meta.push(`<span class="g-niv" style="--c:var(--accent)"><i></i>${ech(t("labo.capital", { o: c.ouvertes, p: c.places, m: nf(c.parTrade) }))}</span>`);
    }
    if (donnees?.moteur === false) {
      meta.push(`<span class="g-niv" style="--c:var(--perte)"><i></i><b>${ech(t("guet.moteuroff"))}</b></span>`);
    }
    const prog = donnees?.progression || null;
    if (prog) {
      const depuis = Math.max(0, Math.round((Date.now() - new Date(prog.debut).getTime()) / 1000));
      const ou = prog.rang ? `${prog.rang}/${prog.total} · ${ech(prog.instId || "")}` : ech(t("labo.candidats"));
      meta.push(`<span class="g-niv labo-vif"><i class="labo-pouls"></i>${ech(t("labo.encours"))} <b>${ou}</b> · ${ech(t("t.secondes", { s: depuis }))}</span>`);
    }
    meta.push(`<button id="lb-chercher" class="primaire" ${prog ? "disabled" : ""}>${ech(prog ? t("labo.enrecherche") : t("labo.lancer"))}</button>`);
    $l("lb-meta").innerHTML = meta.join("");

    rendreCarte(perles, refus);
    rendrePerles(perles, r);
    rendreRefus(refus);
    rendreMethode();
    rendreHisto();
  }

  /* — la carte : sélection en x, validation en y — */

  function rendreCarte(perles, refus) {
    const zone = $l("lb-carte");
    const pts = Object.entries(perles).map(([id, p]) => ({
      nom: court(id),
      x: p.mesures?.sel?.winrate ?? null,
      y: p.mesures?.val?.winrate ?? null,
      net: (p.mesures?.sel?.netMarge ?? 0) + (p.mesures?.val?.netMarge ?? 0),
    })).filter((p) => p.x != null && p.y != null);
    // Les vainqueurs ECARTES aussi ont deux winrates : les poser en
    // pale repond a « ou est passee ma perle d'hier ? » d'un coup
    // d'oeil — elle est tombee sous la barre, la voila.
    const morts = Object.entries(refus || {}).map(([id, r]) => ({
      nom: court(id),
      x: r.vainqueur?.mesures?.sel?.winrate ?? null,
      y: r.vainqueur?.mesures?.val?.winrate ?? null,
    })).filter((p) => p.x != null && p.y != null);
    $l("lb-carte-n").textContent = pts.length ? t("labo.posees", { n: pts.length }) : "—";

    if (!pts.length && !morts.length) {
      zone.innerHTML = `<div class="labo-vide">${t("labo.carte.vide")}</div>`;
      return;
    }

    const W = Math.max(340, zone.clientWidth || 640), H = Math.min(620, Math.max(400, W * 0.56));
    const M = { g: 48, d: 18, h: 20, b: 38 };
    const pw = W - M.g - M.d, ph = H - M.h - M.b;
    let x0 = 40, x1 = 100, y0 = 30, y1 = 100;
    for (const p of pts) { x0 = Math.min(x0, p.x - 5); y0 = Math.min(y0, p.y - 5); }
    for (const p of morts) { x0 = Math.min(x0, p.x - 5); y0 = Math.min(y0, p.y - 5); }
    const X = (v) => M.g + ((v - x0) / (x1 - x0)) * pw;
    const Y = (v) => M.h + (1 - (v - y0) / (y1 - y0)) * ph;

    const netMax = Math.max(0.001, ...pts.map((p) => Math.abs(p.net)));
    const rayon = (n) => 6 + 10 * Math.sqrt(Math.abs(n) / netMax);

    let grille = "", grads = "";
    for (let v = Math.ceil(x0 / 10) * 10; v <= x1; v += 10) {
      grille += `M${X(v).toFixed(1)} ${M.h}V${M.h + ph}`;
      grads += `<text x="${X(v).toFixed(1)}" y="${H - 14}" text-anchor="middle" class="lc-grad">${v}</text>`;
    }
    for (let v = Math.ceil(y0 / 10) * 10; v <= y1; v += 10) {
      grille += `M${M.g} ${Y(v).toFixed(1)}H${M.g + pw}`;
      grads += `<text x="${M.g - 8}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end" class="lc-grad">${v}</text>`;
    }

    /* La zone d'acceptation du juge (wr sélection >= 55, validation >= 50),
       et la diagonale de vérité. */
    const ax = Math.max(x0, 55), ay = Math.max(y0, 50);
    const dx0 = Math.max(x0, y0), dx1 = Math.min(x1, y1);

    const cendres = morts.map((p, i) => `
      <g class="lc-cendre" style="animation-delay:${i * 40}ms">
        <circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="4" fill="var(--perte)" fill-opacity=".38"/>
        <text x="${(X(p.x) + 8).toFixed(1)}" y="${(Y(p.y) + 3).toFixed(1)}" class="lc-cendre-nom">${ech(p.nom)}</text>
        <title>${ech(t("labo.point.titre", { nom: p.nom, x: p.x.toFixed(0), y: p.y.toFixed(0), net: "—" }))}</title>
      </g>`).join("");

    const points = pts.map((p, i) => `
      <g class="lc-perle" style="animation-delay:${i * 90}ms">
        <circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="${(rayon(p.net) + 6).toFixed(1)}"
                fill="var(--long)" opacity=".14" filter="url(#lc-flou)"/>
        <circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="${rayon(p.net).toFixed(1)}"
                fill="var(--long)" fill-opacity=".85" stroke="var(--surface)" stroke-width="1.5"/>
        <text x="${(X(p.x) + rayon(p.net) + 6).toFixed(1)}" y="${(Y(p.y) + 3.5).toFixed(1)}" class="lc-nom">${ech(p.nom)}</text>
        <title>${ech(t("labo.point.titre", { nom: p.nom, x: p.x.toFixed(0), y: p.y.toFixed(0), net: netTxt(p.net) }))}</title>
      </g>`).join("");

    zone.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${ech(t("labo.carte.aria"))}">
        <defs><filter id="lc-flou"><feGaussianBlur stdDeviation="4"/></filter></defs>
        <style>
          .lc-grad { font: 400 9.5px var(--num); fill: var(--texte-3); }
          .lc-nom  { font: 600 10.5px var(--sans); fill: var(--texte); paint-order: stroke; stroke: var(--surface); stroke-width: 3px; }
          .lc-axe  { font: 600 9.5px var(--sans); fill: var(--texte-3); letter-spacing: .08em; text-transform: uppercase; }
          .lc-diag { font: 500 9.5px var(--sans); fill: var(--texte-3); }
          .lc-perle { animation: lc-nait .7s var(--ressort) backwards; transform-box: fill-box; transform-origin: center; }
          .lc-cendre { animation: lc-nait .6s var(--ressort) backwards; transform-box: fill-box; transform-origin: center; }
          .lc-cendre-nom { font: 500 9px var(--sans); fill: var(--texte-3); paint-order: stroke; stroke: var(--surface); stroke-width: 2.5px; }
          @keyframes lc-nait { from { opacity: 0; transform: scale(.3); } }
        </style>
        <rect x="${X(ax).toFixed(1)}" y="${M.h}" width="${(X(x1) - X(ax)).toFixed(1)}"
              height="${(Y(ay) - M.h).toFixed(1)}" fill="var(--bon)" opacity=".04"/>
        <path d="${grille}" stroke="var(--bord)" stroke-opacity=".5" fill="none" shape-rendering="crispEdges"/>
        ${grads}
        <line x1="${X(ax).toFixed(1)}" y1="${M.h}" x2="${X(ax).toFixed(1)}" y2="${M.h + ph}" stroke="var(--bon)" stroke-opacity=".5" stroke-dasharray="4 4"/>
        <line x1="${M.g}" y1="${Y(ay).toFixed(1)}" x2="${M.g + pw}" y2="${Y(ay).toFixed(1)}" stroke="var(--bon)" stroke-opacity=".5" stroke-dasharray="4 4"/>
        <line x1="${X(dx0).toFixed(1)}" y1="${Y(dx0).toFixed(1)}" x2="${X(dx1).toFixed(1)}" y2="${Y(dx1).toFixed(1)}"
              stroke="var(--texte-3)" stroke-opacity=".55" stroke-dasharray="2 5"/>
        <text x="${(X(dx1) - 4).toFixed(1)}" y="${(Y(dx1) + 14).toFixed(1)}" text-anchor="end" class="lc-diag">${ech(t("labo.diagonale"))}</text>
        ${cendres}
        ${points}
        <text x="${M.g + pw}" y="${H - 2}" text-anchor="end" class="lc-axe">${ech(t("labo.axe.x"))}</text>
        <text x="12" y="${M.h + 10}" class="lc-axe" transform="rotate(-90 12 ${M.h + 10})" text-anchor="end">${ech(t("labo.axe.y"))}</text>
      </svg>
      <div class="lc-leg">
        <span><i style="background:var(--long)"></i>${ech(t("labo.leg.perles"))}</span>
        ${morts.length ? `<span><i style="background:var(--perte);opacity:.5"></i>${ech(t("labo.leg.ecartes"))}</span>` : ""}
      </div>`;
  }

  /* — les pieces communes des details — */

  const CHEVRON = `<svg class="chevron" width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path d="M3 5.2l4 4 4-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  const barreFen = (etiq, m, mauvaise) => m ? `
    <div class="fenetre">
      <div class="f-et"><span>${etiq} · ${ech(t("labo.trades", { n: m.trades }))}</span><b>${m.winrate.toFixed(0)} % · ${netTxt(m.netMarge)}</b></div>
      <div class="f-barre"><s></s><i class="${mauvaise ? "mauvais" : ""}" style="width:${Math.min(100, Math.max(2, m.winrate)).toFixed(0)}%"></i></div>
    </div>` : "";

  const sortiesTxt = (ov) => t("labo.sorties", {
    tp: Math.round(((ov || {}).tpPctMargin || 0) * 100),
    act: Math.round(((ov || {}).trailActPctMargin || 0) * 100),
    h: Math.round(((ov || {}).holdMs || 0) / 3600e3),
  });

  const strate = (sig, ov, porte) => `
    <div class="r-strate"><span class="p-sig">${ech(sig)}</span>
      <span class="r-sorties">${ech(sortiesTxt(ov))}</span>
      ${porte ? `<span class="r-porte">${ech(t("labo.recale", { v: t("porte." + porte) }))}</span>` : ""}</div>`;

  const podiumHtml = (finalistes) => {
    if (!Array.isArray(finalistes) || !finalistes.length) return "";
    return `<div><div class="r-titre">${ech(t("labo.finalistes"))}</div>
      <div class="podium">${finalistes.map((f, i) => `
        <div class="p-rang"><span class="rang">${i + 1}</span><span class="p-sig">${ech(f.sig)}</span>
          <span class="r-sorties">${ech(sortiesTxt(f.ov))}</span>
          <span class="mes">wr ${Number(f.wr).toFixed(0)} % · ${netTxt(Number(f.net) || 0)}</span></div>`).join("")}
      </div></div>`;
  };

  /* Le detail d'un refus : l'explication d'abord — c'est elle qu'on
     vient chercher — puis les nombres qui la portent. */
  function detailRefus(r, roster) {
    const vj = roster?.fenetres?.validationJours ?? 7;
    const raison = String(r.raison || "");
    const parts = [];
    if (r.vainqueur) {
      const v = r.vainqueur, m = v.mesures || {};
      parts.push(`<div class="r-explique">${ech(t("refus.exp.valid", { v: vj }))}</div>`);
      parts.push(`<div><div class="r-titre">${ech(t("labo.vainqueur"))}</div>
        ${strate(v.sig, v.ov, v.porte || "negatif")}
        <div class="r-fens" style="margin-top:9px">
          ${barreFen(ech(t("labo.fen.a")), m.a)}
          ${barreFen(ech(t("labo.fen.b")), m.b)}
          ${barreFen(ech(t("labo.selection")), m.sel)}
          ${barreFen(ech(t("labo.validation")), m.val, true)}
        </div></div>`);
      parts.push(podiumHtml(r.finalistes));
    } else if (/aucune (?:positive|concourante positive) dans A/i.test(raison)) {
      parts.push(`<div class="r-explique">${ech(t("refus.exp.aucune"))}</div>`);
      if (r.presque) {
        const p = r.presque, m = p.mesures || {};
        parts.push(`<div><div class="r-titre">${ech(t("labo.presque"))}</div>
          ${strate(p.sig, p.ov, p.porte)}
          <div class="r-fens" style="margin-top:9px">
            ${barreFen(ech(t("labo.fen.a")), m.a, m.a && m.a.netMarge <= 0)}
            ${barreFen(ech(t("labo.fen.b")), m.b, m.b && m.b.netMarge <= 0)}
            ${barreFen(ech(t("labo.selection")), m.sel)}
          </div></div>`);
      }
    } else if (/histoire trop courte/.test(raison)) {
      parts.push(`<div class="r-explique">${ech(t("refus.exp.courte"))}</div>`);
    } else {
      parts.push(`<div class="r-explique">${ech(t("refus.exp.collecte"))}</div>`);
    }
    return parts.filter(Boolean).join("");
  }

  /* — la puce de guet : ce que le moteur attend pour CETTE perle — */

  const REFUS_GARDE = { budgetEpuise: "budget", cannotPlace: "place" };
  function puceGuet(id) {
    const g = donnees?.guet?.[id];
    if (!g) return "";
    const garde = REFUS_GARDE[g.refus] || g.refus || g.garde;
    let cls = "affut", texte = t("guet.affut");
    if (garde === "enPosition") { cls = "enpos"; texte = t("guet.enposition"); }
    else if (garde) {
      cls = "bloque";
      const raison = donnees?.moteur === false ? t("garde.moteur")
        : (String(garde).startsWith("garde.") ? t(garde) : t("garde." + garde));
      texte = t("guet.bloquee", { v: raison.startsWith("garde.") ? garde : raison });
    }
    const det = [];
    if (g.bougie) det.push(t("guet.bougie", { v: duree(g.bougie) }));
    det.push(g.dernierSignal ? t("guet.signal", { v: duree(g.dernierSignal) }) : t("guet.jamais"));
    return `<div class="p-guet ${cls}"><i></i><span>${ech(texte)}</span><span class="g-det">${ech(det.join(" · "))}</span></div>`;
  }

  /* — les cartes de perles — */

  function rendrePerles(perles, roster) {
    const zone = $l("lb-perles");
    const entrees = Object.entries(perles);
    $l("lb-perles-n").textContent = entrees.length ? String(entrees.length) : "—";

    if (!entrees.length) {
      const joue = donnees?.joue?.strats || {};
      const nomsJoue = Object.keys(joue).map((k) => `${court(k)} <span style="color:var(--texte-3)">·</span> <code style="font-family:var(--mono);font-size:10.5px">${ech(joue[k].sig)}</code>`);
      zone.innerHTML = `<div class="labo-vide" style="grid-column:1/-1">
        ${t("labo.vide.verdict")}<br><br>
        ${t("labo.vide.repli")}<br>
        <span style="font-size:12px">${nomsJoue.join(" &nbsp; ") || "—"}</span></div>`;
      return;
    }

    const barre = (etiq, m) => `
      <div class="fenetre">
        <div class="f-et"><span>${etiq} · ${ech(t("labo.trades", { n: m.trades }))}</span><b>${m.winrate.toFixed(0)} %</b></div>
        <div class="f-barre"><s></s><i style="width:${Math.min(100, m.winrate).toFixed(0)}%"></i></div>
      </div>`;

    zone.innerHTML = entrees.map(([id, p]) => {
      const m = p.mesures || {};
      const ov = p.ov || {};
      const cle = "p:" + id;
      const ouv = deplies.has(cle);
      // Le sous-sol de la carte : les deux sous-fenetres et le podium
      // n'apparaissent qu'au clic — la carte reste d'abord un verdict.
      const plus = `
        <div class="p-plus">
          <div class="r-explique">${ech(t("labo.perle.explique"))}</div>
          ${m.a || m.b ? `<div class="r-fens">
            ${barreFen(ech(t("labo.fen.a")), m.a)}
            ${barreFen(ech(t("labo.fen.b")), m.b)}
          </div>` : ""}
          ${podiumHtml(p.finalistes)}
        </div>`;
      return `<article class="perle" data-depli="${ech(cle)}" role="button" tabindex="0"
        aria-expanded="${ouv}" title="${ech(t("labo.deplier"))}">
        <div class="p-tete"><span class="p-nom">${ech(court(id))}</span><span class="p-sig">${ech(p.sig)}</span>${CHEVRON}</div>
        <div class="p-sorties">${ech(sortiesTxt(ov))}</div>
        ${m.sel?.longs && m.sel?.shorts ? `<div class="p-sens"><span class="l">↑</span> ${ech(t("labo.sens", { l: m.sel.longs.trades, wl: m.sel.longs.winrate.toFixed(0), s: m.sel.shorts.trades, ws: m.sel.shorts.winrate.toFixed(0) }))}</div>` : ""}
        ${puceGuet(id)}
        <div class="p-fen">
          ${m.sel ? barre(ech(t("labo.selection")), m.sel) : ""}
          ${m.val ? barre(ech(t("labo.validation")), m.val) : ""}
        </div>
        <div class="p-net">${t("labo.net", { a: `<b>${netTxt(m.sel?.netMarge ?? 0)}</b>`, b: `<b>${netTxt(m.val?.netMarge ?? 0)}</b>` })}</div>
        <div class="depli${ouv ? " ouvert" : ""}"><div class="depli-int">${plus}</div></div>
      </article>`;
    }).join("");
  }

  /* — les écartées — */

  function rendreRefus(refus) {
    const zone = $l("lb-refus");
    const entrees = Object.entries(refus);
    $l("lb-refus-n").textContent = entrees.length ? String(entrees.length) : "—";
    if (!entrees.length) {
      zone.innerHTML = `<div class="refus" style="justify-content:center;color:var(--texte-3)">${ech(t("labo.rien.ecarte"))}</div>`;
      return;
    }
    const roster = donnees?.roster;
    zone.innerHTML = entrees.map(([id, r]) => {
      const cle = "r:" + id;
      const ouv = deplies.has(cle);
      return `
      <div class="refus-item">
        <div class="refus" data-depli="${ech(cle)}" role="button" tabindex="0" aria-expanded="${ouv}"
             title="${ech(t("labo.deplier"))}">
          <b>${ech(court(id))}</b><span>${ech(raisonTexte(r.raison) || "—")}</span>
          <span class="r-note">${ech(t("labo.concourantes", { n: r.concourantes || 0 }))}</span>${CHEVRON}
        </div>
        <div class="depli${ouv ? " ouvert" : ""}"><div class="depli-int"><div class="r-corps">${detailRefus(r, roster)}</div></div></div>
      </div>`;
    }).join("");
  }

  /* — la methode du juge : la frise des fenetres et les trois pas — */

  function rendreMethode() {
    const zone = $l("lb-methode-int");
    if (!zone) return;
    const f = donnees?.roster?.fenetres || {};
    const jours = f.jours ?? 30, vj = f.validationJours ?? 7;
    const demiSel = (jours - vj) / 2;
    const W = 720, H = 64, y = 14, h = 26;
    const px = (j) => (j / jours) * W;
    const seg = (x0, j, couleur, op, etiq, sous, bord) => `
      <rect x="${px(x0).toFixed(1)}" y="${y}" width="${(px(j) - 1.5).toFixed(1)}" height="${h}" rx="6"
            fill="${couleur}" opacity="${op}"/>
      <text x="${(px(x0) + px(j) / 2).toFixed(1)}" y="${y + h / 2 + 3.5}" text-anchor="middle" class="mf-et">${etiq}</text>
      <text x="${bord ? W : (px(x0) + px(j) / 2).toFixed(1)}" y="${H - 4}" text-anchor="${bord ? "end" : "middle"}" class="mf-sous">${sous}</text>`;
    zone.innerHTML = `
      <div class="meth-frise">
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${ech(t("labo.methode"))}">
          <style>
            .mf-et { font: 650 11px var(--sans); fill: var(--texte); letter-spacing: .03em; }
            .mf-sous { font: 400 9.5px var(--num); fill: var(--texte-3); }
          </style>
          <defs><clipPath id="mf-clip"><rect x="0" y="${y}" width="${W}" height="${h}" rx="6"/></clipPath></defs>
          ${seg(0, demiSel, "var(--long)", ".28", ech(t("labo.fen.a")), demiSel.toFixed(1) + " j")}
          ${seg(demiSel, demiSel, "var(--long)", ".18", ech(t("labo.fen.b")), demiSel.toFixed(1) + " j")}
          ${seg(jours - vj, vj, "var(--bon)", ".26", ech(t("labo.validation")), vj + " j · " + ech(t("labo.fen.jamais")), true)}
          <g clip-path="url(#mf-clip)">
            <rect class="balaye" x="0" y="${y}" width="${(W * 0.12).toFixed(0)}" height="${h}"
                  fill="var(--texte)" opacity="0"/>
          </g>
        </svg>
      </div>
      <div class="meth">
        ${[1, 2, 3].map((n) => `<div class="meth-pas"><div class="num">${n}</div>
          <h3>${ech(t("labo.m" + n + ".titre"))}</h3><p>${ech(t("labo.m" + n + ".texte"))}</p></div>`).join("")}
      </div>`;
  }

  /* — les passes precedentes : une barre par passe, la derniere en
       lumiere. La hauteur dit le nombre de perles ; une passe bredouille
       est un pointille, pas un trou — zero est aussi un verdict. — */

  function rendreHisto() {
    const zone = $l("lb-histo");
    if (!zone) return;
    const h = Array.isArray(donnees?.historique) ? donnees.historique : [];
    $l("lb-histo-n").textContent = h.length ? String(h.length) : "—";
    if (!h.length) { zone.innerHTML = `<div class="labo-vide" style="flex:1">${ech(t("labo.attente"))}</div>`; return; }
    const max = Math.max(1, ...h.map((p) => p.perles || 0));
    zone.innerHTML = h.map((p, i) => {
      const n = p.perles || 0;
      const haut = n ? Math.max(14, (n / max) * 100) : 6;
      const dernier = i === h.length - 1;
      const d = p.dureeS >= 60 ? t("t.minutes", { m: Math.round(p.dureeS / 60) }) : t("t.secondes", { s: p.dureeS || 0 });
      return `<div class="h-barre${n ? "" : " vide"}${dernier ? " actuelle" : ""}"
        style="height:${haut.toFixed(0)}%;animation-delay:${Math.min(i * 18, 700)}ms"
        title="${ech(t("labo.histo.point", { p: quand(p.ts), n, d }))}"></div>`;
    }).join("");
  }

  /* ===== les depliables : un seul ecouteur pour tous ===== */

  function basculer(el) {
    const cle = el.dataset.depli;
    if (!cle) return;
    const panneau = cle === "methode" ? $l("lb-methode-corps")
      : el.matches(".perle") ? el.querySelector(":scope > .depli")
      : el.parentElement.querySelector(":scope > .depli");
    if (!panneau) return;
    const ouv = !deplies.has(cle);
    if (ouv) deplies.add(cle); else deplies.delete(cle);
    panneau.classList.toggle("ouvert", ouv);
    el.setAttribute("aria-expanded", String(ouv));
  }

  document.addEventListener("click", (e) => {
    const el = e.target.closest && e.target.closest("[data-depli]");
    if (!el) return;
    // Le sous-sol d'une perle est DANS la carte cliquable : un clic
    // dedans (copier un nombre, par exemple) ne doit pas la refermer.
    if (e.target.closest(".p-plus")) return;
    basculer(el);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const el = e.target.closest && e.target.closest("[data-depli]");
    if (el) { e.preventDefault(); basculer(el); }
  });

  /* ===== la recherche manuelle ===== */

  let suivi = null;
  function suivreLaPasse() {
    // Pendant une passe, la page respire toutes les quatre secondes au
    // lieu de la minute : la progression est faite pour etre regardee.
    clearInterval(suivi);
    suivi = setInterval(async () => {
      await charger();
      if (!donnees?.progression) { clearInterval(suivi); suivi = null; }
    }, 4000);
  }

  document.addEventListener("click", async (e) => {
    if (!e.target || e.target.id !== "lb-chercher") return;
    e.target.disabled = true;
    e.target.textContent = t("labo.enrecherche");
    try {
      const r = await api.invoke("chercher-perles", {});
      if (r && (r.lance || r.dejaEnCours)) suivreLaPasse();
      else { e.target.disabled = false; e.target.textContent = t("labo.lancer"); }
    } catch {
      e.target.disabled = false;
      e.target.textContent = t("labo.lancer");
    }
  });

  /* ===== démarrage ===== */

  Langues.surChangement(() => { if (donnees) rendre(); });

  let choix = "marche";
  try { choix = localStorage.getItem("hermes-page") || "marche"; } catch {}
  if (choix === "labo") montrer(true);
  charger();   // même sur la page marché : le nombre est prêt quand on ouvre l'onglet

  return { montrer, charger };
})();
