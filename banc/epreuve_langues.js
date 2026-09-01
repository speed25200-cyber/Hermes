// L'epreuve des langues : chaque cle du dictionnaire existe dans les
// trois colonnes, aucune n'est vide, les variables {x} sont les memes
// qu'en francais, et chaque cle demandee par le code existe.
"use strict";
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const APP = path.join(__dirname, "..", "app");

const bac = {
  localStorage: { getItem: () => null, setItem: () => {} },
  document: { documentElement: {}, querySelectorAll: () => [], addEventListener: () => {} },
  console,
};
vm.createContext(bac);
const src = fs.readFileSync(path.join(APP, "langues.js"), "utf8");
const Langues = vm.runInContext(src + "\n;Langues;", bac, { filename: "langues.js" });
if (!Langues || typeof Langues.t !== "function") { console.error("Langues absent"); process.exit(1); }

const bac2 = { ...bac };
vm.createContext(bac2);
const D = vm.runInContext(src.replace("return {", "return { __D: D,") + "\n;Langues.__D;", bac2, { filename: "langues-expose.js" });
if (!D) { console.error("D introuvable"); process.exit(1); }

let echecs = 0;
const dire = (m) => { console.error("  ECHEC :", m); echecs++; };
const vars = (s) => [...String(s).matchAll(/\{([a-z]+)\}/g)].map((m) => m[1]).sort().join(",");
const sans_s = (v) => v.split(",").filter((x) => x && x !== "s").join(",");
for (const [cle, e] of Object.entries(D)) {
  for (const l of ["fr", "en", "sq"]) if (typeof e[l] !== "string" || !e[l].trim()) dire(`${cle} : colonne ${l} absente ou vide`);
  const vf = vars(e.fr);
  for (const l of ["en", "sq"]) { const vl = vars(e[l] || ""); if (sans_s(vl) !== sans_s(vf)) dire(`${cle} : variables ${l} « ${vl} » != fr « ${vf} »`); }
}
const demandees = new Set();
for (const f of ["vue.js", "graphe.js", "labo.js", "index.html"]) {
  const c = fs.readFileSync(path.join(APP, f), "utf8");
  for (const m of c.matchAll(/\bt\("([a-z0-9.]+)"\s*[,)]/g)) demandees.add(m[1]);   // les cles dynamiques (t("labo.m" + i)) ne comptent pas
  for (const m of c.matchAll(/data-l(?:-ph|-title|-aria)?="([a-z0-9.]+)"/g)) demandees.add(m[1]);
}
for (const cle of demandees) { if (cle.endsWith(".")) continue; if (!D[cle]) dire(`cle demandee par le code, absente : ${cle}`); }
for (const k of ["wsPublic", "wsPrivate", "rest", "dataFlow", "strategy", "aiEngine", "orders", "stops", "portfolio"]) {
  if (!D["sante." + k]) dire(`cle dynamique absente : sante.${k}`);
  if (!D["sante.d." + k]) dire(`cle dynamique absente : sante.d.${k}`);
}
for (const k of ["moteur", "place", "budget", "solde", "equite", "levier", "flux", "repit"]) if (!D["garde." + k]) dire(`garde absente : ${k}`);
const t = Langues.t;
if (t("t.minutes", { m: 7 }) !== "7 min") dire("t.minutes : " + t("t.minutes", { m: 7 }));
if (t("pos.ouvertes", { n: 2 }) !== "2 ouvertes") dire("pluriel : " + t("pos.ouvertes", { n: 2 }));
console.log(`${Object.keys(D).length} cles, ${demandees.size} demandees par le code, ${echecs} echec(s)`);
process.exit(echecs ? 1 : 0);
