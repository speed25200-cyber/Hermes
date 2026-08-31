// CHANTIER PERTURBATION — test de robustesse d'un module candidat.
// Principe : un VRAI edge survit quand on bouscule ses paramètres ; un artefact
// de sur-optimisation s'effondre. On génère des variantes du module :
//   - paramètres numériques ±25 % (bande ±20-30 %) :
//       a) constantes nommées `const NOM = nombre` (haut de fichier ou dans detect)
//       b) seuils inline dans les comparaisons `> < >= <=` (ex. run >= 5, v > 2*mv),
//          groupés par valeur absolue (5 et -5 = un seul paramètre, perturbé partout)
//   - exits (tp/sl/act/cb/holdH) : ±1 cran sur les grilles grossières historiques
// puis on mesure l'espérance de CHAQUE variante sur le banc 30 j (harness_lib.evaluer,
// mêmes règles : levier x15, coûts, pire-cas, IS 20 j / OOS 10 j).
// Les variantes STRICTEMENT identiques à la baseline (perturbation sans effet, ex.
// garde de warm-up) sont marquées `identique` et EXCLUES du score.
// Score de robustesse = % de variantes effectives dont l'espérance globale 30 j reste > 0.
// Un module < 50 % est signalé SUSPECT (artefact probable).
// Modules « wrapper » (`module.exports = { ...require("./base.js"), exits: {...} }`) :
// les paramètres sont perturbés dans la SOURCE DE LA BASE, les exits du wrapper sont conservés.
//
// Usage : node tools/perturbation.js candidates/<id>.js
//   → écrit tools/rapports/robustesse_<id>.json et affiche un résumé.
// Ne modifie AUCUN fichier existant : les variantes sont compilées en mémoire.

const fs = require("fs");
const path = require("path");
const Module = require("module");

const AGENTS = path.resolve(__dirname, "..");
const { chargerCandles, evaluer } = require(path.join(AGENTS, "harness_lib.js"));

// Grilles GROSSIÈRES (mêmes ordres de grandeur que les campagnes précédentes :
// TP 10-120 %, SL cap 30 %, act 5-40 %, trail 3-30 %, hold 4-36 h). ±1 cran = case voisine.
const GRILLES = {
  tp:    [0.10, 0.20, 0.30, 0.40, 0.60, 0.80, 1.00, 1.20],
  sl:    [0.10, 0.15, 0.20, 0.25, 0.30], // sl <= 0.30 imposé par le harness
  act:   [0.05, 0.10, 0.15, 0.20, 0.30, 0.40],
  cb:    [0.03, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30],
  holdH: [4, 6, 8, 12, 16, 24, 36],
};
const FACTEURS = [0.75, 1.25];   // ±25 %
const ABS_MAX = 100000;          // au-delà = constante d'unité de temps (ms), pas un paramètre

/* Masque commentaires et chaînes par des espaces (offsets préservés) pour que
   l'extraction de paramètres ne lise jamais du texte libre. */
function masquer(src) {
  const out = src.split("");
  let etat = "code", q = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i], d = src[i + 1];
    if (etat === "code") {
      if (c === "/" && d === "/") { etat = "ligne"; out[i] = out[i + 1] = " "; i++; }
      else if (c === "/" && d === "*") { etat = "bloc"; out[i] = out[i + 1] = " "; i++; }
      else if (c === '"' || c === "'" || c === "`") { etat = "chaine"; q = c; }
    } else if (etat === "ligne") {
      if (c === "\n") etat = "code"; else out[i] = " ";
    } else if (etat === "bloc") {
      if (c === "*" && d === "/") { etat = "code"; out[i] = out[i + 1] = " "; i++; }
      else if (c !== "\n") out[i] = " ";
    } else { // chaine
      if (c === "\\") { out[i] = " "; if (i + 1 < src.length) { out[i + 1] = " "; i++; } }
      else if (c === q) etat = "code";
      else if (c !== "\n") out[i] = " ";
    }
  }
  return out.join("");
}

/* a) Constantes numériques nommées : tout déclarateur `NOM = nombre` d'une déclaration
   `const`. Les `let` sont exclus (variables d'état), ainsi que 0 et les constantes
   d'unité de temps (>= 100000). Retourne [{nom, valeur, occurrences:[{start,end}]}]. */
function extraireConstNommees(masked) {
  const params = [];
  const reConst = /\bconst\s+/g;
  let m;
  while ((m = reConst.exec(masked))) {
    let i = m.index + m[0].length, depth = 0, segStart = i, fini = false;
    const segs = [];
    for (; i < masked.length && !fini; i++) {
      const ch = masked[i];
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) { if (depth === 0) break; depth--; }
      else if (ch === "," && depth === 0) { segs.push([segStart, i]); segStart = i + 1; }
      else if (ch === ";" && depth === 0) { segs.push([segStart, i]); fini = true; }
    }
    for (const [a, b] of segs) {
      const seg = masked.slice(a, b);
      const mm = seg.match(/^(\s*[A-Za-z_$][\w$]*\s*=\s*)(-?\d+(?:\.\d+)?)(\s*)$/);
      if (!mm) continue;
      const valeur = Number(mm[2]);
      if (valeur === 0 || Math.abs(valeur) >= ABS_MAX) continue;
      const nom = seg.match(/[A-Za-z_$][\w$]*/)[0];
      params.push({ nom, valeur, occurrences: [{ start: a + mm[1].length, end: a + mm[1].length + mm[2].length }] });
    }
  }
  return params;
}

/* b) Seuils inline : littéraux numériques en membre droit d'une comparaison
   ordonnée (> < >= <=). Exclusions : 0, unités de temps, comparaisons de .length.
   Groupés par |valeur| (ex. run >= 5 et run <= -5 = un paramètre unique). */
function extraireSeuilsInline(masked, dejaCouverts) {
  const groupes = new Map();
  const re = /(?<![=<>!-])(>=|<=|>|<)(?!=)\s*(-?\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(masked))) {
    const valeur = Number(m[2]);
    if (valeur === 0 || Math.abs(valeur) >= ABS_MAX) continue;
    const avant = masked.slice(Math.max(0, m.index - 24), m.index).trimEnd();
    if (avant.endsWith(".length")) continue;
    const start = m.index + m[0].length - m[2].length, end = m.index + m[0].length;
    if (dejaCouverts.some(([a, b]) => start >= a && end <= b)) continue;
    const cle = Math.abs(valeur);
    if (!groupes.has(cle)) groupes.set(cle, { nom: "seuil_" + cle, valeur: cle, occurrences: [] });
    groupes.get(cle).occurrences.push({ start, end, signe: valeur < 0 ? -1 : 1 });
  }
  return [...groupes.values()];
}

/* Perturbe une valeur : entier -> entier (arrondi, décalé de ±1 si l'arrondi retombe
   sur l'original — indispensable pour les petites périodes) ; flottant -> ×facteur. */
function perturberValeur(orig, f) {
  if (Number.isInteger(orig)) {
    let v = Math.round(orig * f);
    if (v === orig) v = orig + (f > 1 ? 1 : -1);
    return v === 0 ? null : v;
  }
  return +Number(orig * f).toPrecision(6);
}

/* Réécrit la source avec chaque occurrence du paramètre remplacée (offsets décroissants). */
function reecrire(src, param, nouvelleValeur) {
  let out = src;
  const occ = [...param.occurrences].sort((a, b) => b.start - a.start);
  for (const o of occ) {
    const v = (o.signe || 1) < 0 ? -nouvelleValeur : nouvelleValeur;
    out = out.slice(0, o.start) + String(v) + out.slice(o.end);
  }
  return out;
}

/* Compile une source modifiée en mémoire (aucun fichier écrit), require résolu
   depuis candidates/ (node_modules du banc accessible). */
function compilerVariante(src, refPath, tag) {
  const filename = refPath.replace(/\.js$/, "") + ".__variante_" + tag + ".js";
  const mod = new Module(filename, null);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(refPath));
  mod._compile(src, filename);
  return mod.exports;
}

function resumer(r) {
  const espIS = r.A ? r.A.esp : null, espOOS = r.B ? r.B.esp : null;
  return {
    espIS, espOOS,
    espAll: r.all ? r.all.esp : null,
    worst: espIS !== null && espOOS !== null ? Math.min(espIS, espOOS) : null,
    nIS: r.A ? r.A.n : 0, nOOS: r.B ? r.B.n : 0,
    valide: !!(r.A && r.B && r.A.esp > 0 && r.B.esp > 0 && (r.A.n + r.B.n) >= 60 && r.B.n >= 15),
  };
}

function idxPlusProche(grille, v) {
  let idx = 0;
  for (let j = 1; j < grille.length; j++) if (Math.abs(grille[j] - v) < Math.abs(grille[idx] - v)) idx = j;
  return idx;
}

/* Wrapper `require("./base.js")` -> chemin de la base si elle existe à côté.
   On lit le chemin dans la source ORIGINALE (le masquage vide les chaînes) et on
   vérifie via le masque que le require n'est pas dans un commentaire. */
function chercherBase(src, masked, modPathAbs) {
  const re = /require\(\s*["']\.\/([\w.-]+\.js)["']\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    if (masked[m.index] !== "r") continue; // commentaire ou chaîne
    const p = path.join(path.dirname(modPathAbs), m[1]);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/* Analyse complète d'un module candidat. Retourne le rapport (objet). */
function perturber(modPathAbs) {
  const base = require(modPathAbs);
  const c5 = chargerCandles("data", base.instId);
  const baseline = resumer(evaluer(base, c5));

  // source à perturber pour les PARAMÈTRES : le module lui-même, ou sa base si wrapper
  let srcPath = modPathAbs;
  let src = fs.readFileSync(srcPath, "utf8");
  let masked = masquer(src);
  const basePath = chercherBase(src, masked, modPathAbs);
  if (basePath) {
    srcPath = basePath;
    src = fs.readFileSync(srcPath, "utf8");
    masked = masquer(src);
  }
  const constNommees = extraireConstNommees(masked);
  const couverts = constNommees.map(p => [p.occurrences[0].start, p.occurrences[0].end]);
  const seuils = extraireSeuilsInline(masked, couverts);
  const params = constNommees.concat(seuils);
  const variantes = [];

  const evaluerVariante = (rec, construire) => {
    try {
      Object.assign(rec, resumer(evaluer(construire(), c5)));
    } catch (e) { rec.erreur = String((e && e.message) || e).slice(0, 200); }
    rec.identique = !rec.erreur && rec.espAll === baseline.espAll &&
      rec.nIS === baseline.nIS && rec.nOOS === baseline.nOOS &&
      rec.espIS === baseline.espIS && rec.espOOS === baseline.espOOS;
    rec.positif = (rec.espAll != null ? rec.espAll : -1) > 0;
    rec.positifWorst = (rec.worst != null ? rec.worst : -1) > 0;
    variantes.push(rec);
  };

  // 1) paramètres numériques ±25 % (un paramètre à la fois, toutes occurrences ensemble)
  for (const p of params) {
    for (const f of FACTEURS) {
      const nv = perturberValeur(p.valeur, f);
      if (nv === null || nv === p.valeur) continue;
      const rec = {
        type: "param", nom: p.nom, facteur: f, valOrig: p.valeur, valVar: nv,
        nbOccurrences: p.occurrences.length,
      };
      evaluerVariante(rec, () => {
        const vsrc = reecrire(src, p, nv);
        const vmod = compilerVariante(vsrc, srcPath, p.nom + "_" + String(f).replace(".", ""));
        return basePath
          ? { instId: base.instId, exits: base.exits, detect: vmod.detect.bind(vmod) }
          : vmod;
      });
    }
  }

  // 2) exits ±1 cran (grilles grossières), un axe à la fois
  for (const k of Object.keys(GRILLES)) {
    const cur = base.exits[k];
    if (cur == null) continue;
    const g = GRILLES[k];
    const idx = idxPlusProche(g, cur);
    for (const d of [-1, +1]) {
      const j = idx + d;
      if (j < 0 || j >= g.length) continue;
      const nv = g[j];
      if (nv === cur) continue;
      if (k === "sl" && nv > 0.30) continue;
      const rec = { type: "exit", nom: k, cran: d, valOrig: cur, valVar: nv };
      evaluerVariante(rec, () => ({
        instId: base.instId,
        exits: Object.assign({}, base.exits, { [k]: nv }),
        detect: base.detect.bind(base),
      }));
    }
  }

  const effectives = variantes.filter(v => !v.identique);
  const nbPos = effectives.filter(v => v.positif).length;
  const nbPosWorst = effectives.filter(v => v.positifWorst).length;
  const nEff = effectives.length;
  const score = nEff ? +(100 * nbPos / nEff).toFixed(1) : null;
  const scoreWorst = nEff ? +(100 * nbPosWorst / nEff).toFixed(1) : null;

  return {
    module: path.relative(AGENTS, modPathAbs).replace(/\\/g, "/"),
    instId: base.instId,
    exitsOrig: base.exits,
    sourceParams: path.relative(AGENTS, srcPath).replace(/\\/g, "/"),
    baseline,
    parametresDetectes: params.map(p => ({ nom: p.nom, valeur: p.valeur, occurrences: p.occurrences.length })),
    nbVariantes: variantes.length,
    nbVariantesEffectives: nEff,       // hors variantes sans effet (identiques à la baseline)
    nbPositives: nbPos,
    scoreRobustesse: score,            // % de variantes effectives à espérance globale 30 j > 0
    scoreRobustesseWorst: scoreWorst,  // % à min(espIS, espOOS) > 0 (plus strict)
    suspect: score !== null && score < 50,
    variantes,
    genere: new Date().toISOString(),
  };
}

module.exports = { perturber, masquer, extraireConstNommees, extraireSeuilsInline, perturberValeur, GRILLES, FACTEURS };

if (require.main === module) {
  const arg = process.argv[2];
  if (!arg) { console.error("usage: node tools/perturbation.js candidates/<id>.js"); process.exit(1); }
  const abs = path.isAbsolute(arg) ? arg : path.resolve(AGENTS, arg);
  const rapport = perturber(abs);
  const id = path.basename(abs, ".js");
  const outDir = path.join(__dirname, "rapports");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "robustesse_" + id + ".json");
  fs.writeFileSync(outFile, JSON.stringify(rapport, null, 1));
  console.log(JSON.stringify({
    module: rapport.module, instId: rapport.instId,
    baselineEspAll: rapport.baseline.espAll, baselineWorst: rapport.baseline.worst,
    nbVariantes: rapport.nbVariantes, nbVariantesEffectives: rapport.nbVariantesEffectives,
    scoreRobustesse: rapport.scoreRobustesse,
    scoreRobustesseWorst: rapport.scoreRobustesseWorst, suspect: rapport.suspect,
    rapport: path.relative(AGENTS, outFile).replace(/\\/g, "/"),
  }, null, 1));
}
