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
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short" }) + " " +
      String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  };
  const compte = (ms) => {
    if (ms <= 0) return "imminente";
    const h = Math.floor(ms / 3600e3), m = Math.floor((ms % 3600e3) / 60e3);
    return "dans " + (h ? h + " h " : "") + m + " min";
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
      ? `perle${noms.length > 1 ? "s" : ""} sur ${nCand} candidats`
      : "en attente du premier verdict";

    const meta = [];
    if (r) {
      meta.push(`<span class="g-niv">Dernière passe <b>${ech(quand(r.genere))}</b>${r.dureeS ? ` · ${Math.round(r.dureeS / 60)} min` : ""}</span>`);
      meta.push(`<span class="g-niv">Prochaine <b data-prochaine>${ech(compte(new Date(r.genere).getTime() + 30 * 60e3 - Date.now()))}</b></span>`);
      const f = r.fenetres || {};
      meta.push(`<span class="g-niv">Fenêtres <b>${f.jours ?? 30} j · validation ${f.validationJours ?? 7} j</b></span>`);
    }
    if (donnees?.joue) {
      const repli = donnees.joue.source !== "chercheur";
      meta.push(`<span class="g-niv" style="--c:${repli ? "var(--short)" : "var(--bon)"}"><i></i>Le moteur joue <b>${repli ? "le repli du 31/08" : "ce verdict"}</b></span>`);
    }
    const prog = donnees?.progression || null;
    if (prog) {
      const depuis = Math.max(0, Math.round((Date.now() - new Date(prog.debut).getTime()) / 1000));
      const ou = prog.rang ? `${prog.rang}/${prog.total} · ${ech(prog.instId || "")}` : "candidats…";
      meta.push(`<span class="g-niv labo-vif"><i class="labo-pouls"></i>Recherche en cours <b>${ou}</b> · ${depuis} s</span>`);
    }
    meta.push(`<button id="lb-chercher" class="primaire" ${prog ? "disabled" : ""}>${prog ? "Recherche en cours…" : "Lancer une recherche"}</button>`);
    $l("lb-meta").innerHTML = meta.join("");

    rendreCarte(perles);
    rendrePerles(perles, r);
    rendreRefus(refus);
  }

  /* — la carte : sélection en x, validation en y — */

  function rendreCarte(perles) {
    const zone = $l("lb-carte");
    const pts = Object.entries(perles).map(([id, p]) => ({
      nom: court(id),
      x: p.mesures?.sel?.winrate ?? null,
      y: p.mesures?.val?.winrate ?? null,
      net: (p.mesures?.sel?.netMarge ?? 0) + (p.mesures?.val?.netMarge ?? 0),
    })).filter((p) => p.x != null && p.y != null);
    $l("lb-carte-n").textContent = pts.length ? `${pts.length} posée${pts.length > 1 ? "s" : ""}` : "—";

    if (!pts.length) {
      zone.innerHTML = `<div class="labo-vide">La constellation se dessinera au premier verdict du chercheur.<br>
        Chaque perle y sera posée par ses deux winrates — sélection et validation —<br>
        et le sur-ajustement se verra à l'œil : loin sous la diagonale, une stratégie a promis plus qu'elle n'a tenu.</div>`;
      return;
    }

    const W = Math.max(320, zone.clientWidth || 640), H = Math.min(420, Math.max(300, W * 0.52));
    const M = { g: 44, d: 16, h: 18, b: 34 };
    const pw = W - M.g - M.d, ph = H - M.h - M.b;
    let x0 = 40, x1 = 100, y0 = 30, y1 = 100;
    for (const p of pts) { x0 = Math.min(x0, p.x - 5); y0 = Math.min(y0, p.y - 5); }
    const X = (v) => M.g + ((v - x0) / (x1 - x0)) * pw;
    const Y = (v) => M.h + (1 - (v - y0) / (y1 - y0)) * ph;

    const netMax = Math.max(0.001, ...pts.map((p) => Math.abs(p.net)));
    const rayon = (n) => 5 + 9 * Math.sqrt(Math.abs(n) / netMax);

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

    const points = pts.map((p, i) => `
      <g class="lc-perle" style="animation-delay:${i * 90}ms">
        <circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="${(rayon(p.net) + 6).toFixed(1)}"
                fill="var(--long)" opacity=".14" filter="url(#lc-flou)"/>
        <circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="${rayon(p.net).toFixed(1)}"
                fill="var(--long)" fill-opacity=".85" stroke="var(--surface)" stroke-width="1.5"/>
        <text x="${(X(p.x) + rayon(p.net) + 6).toFixed(1)}" y="${(Y(p.y) + 3.5).toFixed(1)}" class="lc-nom">${ech(p.nom)}</text>
        <title>${ech(p.nom)} — sélection ${p.x.toFixed(0)} %, validation ${p.y.toFixed(0)} %, net ${netTxt(p.net)} marges</title>
      </g>`).join("");

    zone.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Constellation : winrate de sélection contre winrate de validation">
        <defs><filter id="lc-flou"><feGaussianBlur stdDeviation="4"/></filter></defs>
        <style>
          .lc-grad { font: 400 9.5px var(--mono); fill: var(--texte-3); }
          .lc-nom  { font: 600 10.5px var(--sans); fill: var(--texte); paint-order: stroke; stroke: var(--surface); stroke-width: 3px; }
          .lc-axe  { font: 600 9.5px var(--sans); fill: var(--texte-3); letter-spacing: .08em; text-transform: uppercase; }
          .lc-diag { font: 500 9.5px var(--sans); fill: var(--texte-3); }
          .lc-perle { animation: lc-nait .7s var(--ressort) backwards; transform-box: fill-box; transform-origin: center; }
          @keyframes lc-nait { from { opacity: 0; transform: scale(.3); } }
        </style>
        <rect x="${X(ax).toFixed(1)}" y="${M.h}" width="${(X(x1) - X(ax)).toFixed(1)}"
              height="${(Y(ay) - M.h).toFixed(1)}" fill="var(--bon)" opacity=".06"/>
        <path d="${grille}" stroke="var(--bord)" stroke-opacity=".5" fill="none" shape-rendering="crispEdges"/>
        ${grads}
        <line x1="${X(ax).toFixed(1)}" y1="${M.h}" x2="${X(ax).toFixed(1)}" y2="${M.h + ph}" stroke="var(--bon)" stroke-opacity=".5" stroke-dasharray="4 4"/>
        <line x1="${M.g}" y1="${Y(ay).toFixed(1)}" x2="${M.g + pw}" y2="${Y(ay).toFixed(1)}" stroke="var(--bon)" stroke-opacity=".5" stroke-dasharray="4 4"/>
        <line x1="${X(dx0).toFixed(1)}" y1="${Y(dx0).toFixed(1)}" x2="${X(dx1).toFixed(1)}" y2="${Y(dx1).toFixed(1)}"
              stroke="var(--texte-3)" stroke-opacity=".55" stroke-dasharray="2 5"/>
        <text x="${(X(dx1) - 4).toFixed(1)}" y="${(Y(dx1) + 14).toFixed(1)}" text-anchor="end" class="lc-diag">au-dessus&nbsp;: a confirmé mieux qu'annoncé</text>
        ${points}
        <text x="${M.g + pw}" y="${H - 2}" text-anchor="end" class="lc-axe">winrate de sélection (%)</text>
        <text x="12" y="${M.h + 10}" class="lc-axe" transform="rotate(-90 12 ${M.h + 10})" text-anchor="end">winrate de validation (%)</text>
      </svg>`;
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
        Le chercheur n'a pas encore rendu son premier verdict — il concourt en ce moment,
        et cette page se remplira seule.<br><br>
        En attendant, le moteur joue le roster de repli du 31/08&nbsp;:<br>
        <span style="font-size:12px">${nomsJoue.join(" &nbsp; ") || "—"}</span></div>`;
      return;
    }

    const barre = (etiq, m) => `
      <div class="fenetre">
        <div class="f-et"><span>${etiq} · ${m.trades} trades</span><b>${m.winrate.toFixed(0)} %</b></div>
        <div class="f-barre"><s></s><i style="width:${Math.min(100, m.winrate).toFixed(0)}%"></i></div>
      </div>`;

    zone.innerHTML = entrees.map(([id, p]) => {
      const m = p.mesures || {};
      const ov = p.ov || {};
      return `<article class="perle">
        <div class="p-tete"><span class="p-nom">${ech(court(id))}</span><span class="p-sig">${ech(p.sig)}</span></div>
        <div class="p-sorties">TP +${Math.round((ov.tpPctMargin || 0) * 100)} % marge · trail dès +${Math.round((ov.trailActPctMargin || 0) * 100)} % · ≤ ${Math.round((ov.holdMs || 0) / 3600e3)} h</div>
        <div class="p-fen">
          ${m.sel ? barre("Sélection", m.sel) : ""}
          ${m.val ? barre("Validation", m.val) : ""}
        </div>
        <div class="p-net">net <b>${netTxt(m.sel?.netMarge ?? 0)}</b> marges en sélection · <b>${netTxt(m.val?.netMarge ?? 0)}</b> en validation</div>
      </article>`;
    }).join("");
  }

  /* — les écartées — */

  function rendreRefus(refus) {
    const zone = $l("lb-refus");
    const entrees = Object.entries(refus);
    $l("lb-refus-n").textContent = entrees.length ? String(entrees.length) : "—";
    if (!entrees.length) {
      zone.innerHTML = `<div class="refus" style="justify-content:center;color:var(--texte-3)">Rien d'écarté sur la dernière passe.</div>`;
      return;
    }
    zone.innerHTML = entrees.map(([id, r]) => `
      <div class="refus"><b>${ech(court(id))}</b><span>${ech(r.raison || "—")}</span>
        <span class="r-note">${r.concourantes || 0} concourante${(r.concourantes || 0) > 1 ? "s" : ""}</span></div>`).join("");
  }

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
    e.target.textContent = "Recherche en cours…";
    try {
      const r = await api.invoke("chercher-perles", {});
      if (r && (r.lance || r.dejaEnCours)) suivreLaPasse();
      else { e.target.disabled = false; e.target.textContent = "Lancer une recherche"; }
    } catch {
      e.target.disabled = false;
      e.target.textContent = "Lancer une recherche";
    }
  });

  /* ===== démarrage ===== */

  let choix = "marche";
  try { choix = localStorage.getItem("hermes-page") || "marche"; } catch {}
  if (choix === "labo") montrer(true);
  charger();   // même sur la page marché : le nombre est prêt quand on ouvre l'onglet

  return { montrer, charger };
})();
