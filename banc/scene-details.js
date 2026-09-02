// La scene des details : tout ce qui se deplie ou se montre, verifie
// en CONTENUS — marque, taux de gain, historique, heros, courbe,
// tuile, sante, journal, methode, refus, perle, guet, capital, carte.
"use strict";
const { chromium } = require("playwright-core");
const http = require("http"); const fs = require("fs"); const path = require("path");
const APP = path.join(__dirname, "..", "app");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".woff2": "font/woff2" };
const srv = http.createServer((req, rep) => {
  let c = new URL(req.url, "http://x").pathname; if (c === "/") c = "/index.html";
  if (c === "/pont.js") { rep.writeHead(200, { "Content-Type": "text/javascript" }); rep.end(fs.readFileSync(path.join(__dirname, "pont-double.js"))); return; }
  const f = path.join(APP, c.replace(/^\/+/, "")); if (!fs.existsSync(f)) { rep.writeHead(404); rep.end(); return; }
  rep.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" }); rep.end(fs.readFileSync(f));
});

(async () => {
  await new Promise((ok) => srv.listen(8915, "127.0.0.1", ok));
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium" });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark", deviceScaleFactor: 2 });
  const pg = await ctx.newPage();
  const erreurs = [];
  pg.on("console", (m) => { if (m.type() === "error") erreurs.push("console : " + m.text()); });
  pg.on("pageerror", (e) => erreurs.push("page : " + e.message));
  const dire = (m) => erreurs.push(m);
  const $ = (js) => pg.evaluate(js);

  await pg.goto("http://127.0.0.1:8915/", { waitUntil: "networkidle" });
  await pg.waitForTimeout(800);

  // La marque, logotype.
  const marque = await $(() => ({
    texte: document.querySelector(".marque-ha")?.textContent.replace(/\s+/g, ""),
    astre: !!document.querySelector(".marque-ha .ha-astre"),
    fonte: getComputedStyle(document.querySelector(".marque-ha")).fontFamily,
    titre: document.title,
  }));
  if (marque.texte !== "HermesAstra") dire("marque : " + marque.texte);
  if (!marque.astre) dire("logo sans astre");
  if (!/Space Grotesk/.test(marque.fonte)) dire("fonte marque : " + marque.fonte);
  if (marque.titre !== "Hermes-Astra") dire("titre : " + marque.titre);

  // L'historique des cloturees et le taux de gain vrai.
  const hist = await $(() => ({
    n: document.querySelectorAll("#z-hist .hist").length,
    premier: document.querySelector("#z-hist .hist")?.textContent.replace(/\s+/g, " ").trim().slice(0, 60),
    gain: document.querySelector('[data-t="gain"] .v')?.textContent,
    sous: document.querySelector('[data-t="gain"] .s')?.textContent,
  }));
  if (hist.n !== 3) dire("historique : " + JSON.stringify(hist));
  if (!/SOON/.test(hist.premier || "")) dire("historique premier : " + hist.premier);
  if (!/100/.test(hist.gain || "")) dire("taux de gain : " + hist.gain);
  if (!/historique/.test(hist.sous || "")) dire("sous-titre gain : " + hist.sous);

  // Le heros s'ouvre sur six lignes ; un clic dans le tiroir ne referme pas.
  await pg.click("#hero .hero-etiq"); await pg.waitForTimeout(400);
  const hero = await $(() => ({ ouvert: document.getElementById("hero")?.getAttribute("aria-expanded"), lignes: document.querySelectorAll("#h-detail .t-ligne").length }));
  if (hero.ouvert !== "true" || hero.lignes !== 6) dire("heros : " + JSON.stringify(hero));
  await pg.click("#h-detail .t-ligne"); await pg.waitForTimeout(200);
  if ((await $(() => document.getElementById("hero")?.getAttribute("aria-expanded"))) !== "true") dire("le clic dans le tiroir a referme le heros");

  // La courbe s'ouvre sur quatre statistiques.
  await pg.click("#eq-tete"); await pg.waitForTimeout(400);
  const eq = await $(() => ({ ouvert: document.getElementById("eq-tete")?.getAttribute("aria-expanded"), lignes: document.querySelectorAll("#eq-stats .t-ligne").length }));
  if (eq.ouvert !== "true" || eq.lignes !== 4) dire("courbe stats : " + JSON.stringify(eq));

  // La tuile de marge, par position ; celle du gain, deux comptes.
  await pg.click('[data-t="marge"]'); await pg.waitForTimeout(400);
  const tuile = await $(() => [...document.querySelectorAll('[data-t="marge"] .t-ligne')].map((l) => l.textContent.replace(/\s+/g, " ").trim()));
  if (tuile.length !== 2 || !tuile.some((l) => l.startsWith("MEGA"))) dire("tuile marge : " + JSON.stringify(tuile));
  await pg.click('[data-t="gain"]'); await pg.waitForTimeout(400);
  const gain = await $(() => [...document.querySelectorAll('[data-t="gain"] .t-ligne')].map((l) => l.textContent.replace(/\s+/g, " ").trim()));
  if (!gain.some((l) => /24 h.*2\/2/.test(l)) || !gain.some((l) => /historique.*3\/3/.test(l))) dire("tuile gain : " + JSON.stringify(gain));

  // Un module de sante raconte son metier.
  await $(() => { E.sante = { modules: { wsPublic: { status: "OK" }, stops: { status: "OK", info: "2 gardes" } } }; rendreSante(); });
  await pg.click('[data-mod="stops"]'); await pg.waitForTimeout(300);
  const mod = await $(() => document.querySelector('[data-mod="stops"] .m-desc')?.textContent || "");
  if (!/stops et .*take-profits/.test(mod)) dire("sante stops : " + JSON.stringify(mod));

  // Une ligne de journal se deplie.
  await pg.click(".jl[data-jl]"); await pg.waitForTimeout(300);
  const dApres = await $(() => document.querySelector(".jl.ouvert .d")?.textContent || "");
  if (!dApres.includes("\n") || !dApres.includes("symbol : AXS-USDT-SWAP")) dire("journal depli : " + JSON.stringify(dApres.slice(0, 90)));

  // Le laboratoire.
  await pg.click("#nav-labo"); await pg.waitForTimeout(900);

  // Le capital en places, dans la meta.
  const meta = await $(() => document.getElementById("lb-meta")?.textContent.replace(/\s+/g, " ") || "");
  if (!/2\/3 places/.test(meta) || !/4,16/.test(meta)) dire("capital meta : " + meta.slice(0, 200));

  // La methode.
  await pg.click("#lb-methode-tete"); await pg.waitForTimeout(400);
  const meth = await $(() => ({ ouvert: document.getElementById("lb-methode-corps")?.classList.contains("ouvert"), pas: document.querySelectorAll(".meth-pas h3").length,
    frise: [...document.querySelectorAll(".meth-frise text")].map((n) => n.textContent).join(" | ") }));
  if (!meth.ouvert || meth.pas !== 3 || !/Fenêtre A/.test(meth.frise)) dire("methode : " + JSON.stringify(meth));

  // Un refus recale en validation, un refus « aucune ».
  await pg.click('[data-depli="r:BTC-USDT-SWAP"]'); await pg.waitForTimeout(400);
  const refus = await $(() => { const it = document.querySelector('[data-depli="r:BTC-USDT-SWAP"]').parentElement; return {
    ouvert: it.querySelector(".depli")?.classList.contains("ouvert"), barres: it.querySelectorAll(".fenetre").length,
    mauvaise: !!it.querySelector(".f-barre i.mauvais"), porte: it.querySelector(".r-porte")?.textContent, podium: it.querySelectorAll(".podium .p-rang").length }; });
  if (!refus.ouvert || refus.barres !== 4 || !refus.mauvaise || refus.podium !== 2 || !/négatif/.test(refus.porte || "")) dire("refus BTC : " + JSON.stringify(refus));
  await pg.click('[data-depli="r:ETH-USDT-SWAP"]'); await pg.waitForTimeout(400);
  const eth = await $(() => { const it = document.querySelector('[data-depli="r:ETH-USDT-SWAP"]').parentElement; return { presque: it.querySelector(".r-titre")?.textContent, barres: it.querySelectorAll(".fenetre").length }; });
  if (!/proche du but/.test(eth.presque || "") || eth.barres !== 3) dire("refus ETH : " + JSON.stringify(eth));

  // Le guet : chaque perle dit ce qu'elle attend.
  const guet = await $(() => ({
    axs: document.querySelector('[data-depli="p:AXS-USDT-SWAP"] .p-guet')?.className + " | " + (document.querySelector('[data-depli="p:AXS-USDT-SWAP"] .p-guet span')?.textContent || ""),
    doge: document.querySelector('[data-depli="p:DOGE-USDT-SWAP"] .p-guet')?.textContent.replace(/\s+/g, " ") || "",
    zec: document.querySelector('[data-depli="p:ZEC-USDT-SWAP"] .p-guet')?.textContent || "",
    note: !!document.querySelector(".guet-note"),
  }));
  if (!/enpos/.test(guet.axs) || !/En position/.test(guet.axs)) dire("guet AXS : " + guet.axs);
  if (!/l’affût|l'affût/.test(guet.doge) || !/aucun signal/.test(guet.doge)) dire("guet DOGE : " + guet.doge);
  if (!/bloquée/.test(guet.zec) || !/budget/.test(guet.zec)) dire("guet ZEC : " + guet.zec);
  if (!guet.note) dire("note du guet absente");

  // Le partage par sens d'une perle.
  const sens = await $(() => document.querySelector('[data-depli="p:AXS-USDT-SWAP"] .p-sens')?.textContent || "");
  if (!/21 longs/.test(sens) || !/13 shorts/.test(sens)) dire("sens AXS : " + sens);

  // Une perle s'ouvre : fenetres A/B et podium.
  await pg.click('[data-depli="p:AXS-USDT-SWAP"]'); await pg.waitForTimeout(400);
  const perle = await $(() => { const c = document.querySelector('[data-depli="p:AXS-USDT-SWAP"]'); return {
    ouvert: c.getAttribute("aria-expanded"), fen: c.querySelectorAll(".p-plus .fenetre").length, podium: c.querySelectorAll(".podium .p-rang").length }; });
  if (perle.ouvert !== "true" || perle.fen !== 2 || perle.podium !== 3) dire("perle AXS : " + JSON.stringify(perle));

  // La carte : perles, cendres, legende, hauteur.
  const carte = await $(() => { const svg = document.querySelector("#lb-carte svg"); const vb = svg.getAttribute("viewBox").split(" ").map(Number); return {
    hauteur: vb[3], perles: document.querySelectorAll("#lb-carte .lc-perle").length, cendres: document.querySelectorAll("#lb-carte .lc-cendre").length,
    legende: document.querySelector(".lc-leg")?.textContent || "" }; });
  if (carte.hauteur < 600 || carte.perles !== 6 || carte.cendres !== 3 || !/écartés/.test(carte.legende)) dire("carte : " + JSON.stringify(carte));

  /* L'EPREUVE DU HASARD. C'est la porte la plus severe du juge — huit
     perles sur onze retirees au premier passage — et une porte qui
     coupe autant doit se voir a l'ecran, sinon elle passe pour une
     panne. On verifie donc la pastille sur une perle retenue, et le
     detail chiffre sur une perle que le hasard a battue. */
  const pastille = await $(() => document.querySelector('[data-depli="p:AXS-USDT-SWAP"] .p-hasard')?.textContent || "");
  if (!/100/.test(pastille) || !/percentile/i.test(pastille)) dire("pastille du hasard sur AXS : " + pastille);

  const detailPerle = await $(() => {
    const c = document.querySelector('[data-depli="p:AXS-USDT-SWAP"]');
    const h = c.querySelector(".r-hasard");
    return { present: !!h, pct: h?.querySelector(".h-pct b")?.textContent || "", lignes: h?.querySelector(".h-lignes")?.textContent || "" };
  });
  if (!detailPerle.present || detailPerle.pct !== "100" || !/25 %/.test(detailPerle.lignes)) dire("detail du hasard sur AXS : " + JSON.stringify(detailPerle));

  const rejet = await $(() => document.querySelector('[data-depli="r:INJ-USDT-SWAP"]')?.textContent.replace(/\s+/g, " ") || "");
  if (!/hasard/i.test(rejet)) dire("refus INJ ne dit pas le hasard : " + rejet);

  await pg.click('[data-depli="r:INJ-USDT-SWAP"]'); await pg.waitForTimeout(400);
  const inj = await $(() => {
    const it = document.querySelector('[data-depli="r:INJ-USDT-SWAP"]').parentElement;
    const h = it.querySelector(".r-hasard");
    return { present: !!h, pct: h?.querySelector(".h-pct b")?.textContent || "",
             lignes: h?.querySelector(".h-lignes")?.textContent.replace(/\s+/g, " ") || "",
             explique: it.querySelector(".r-explique")?.textContent || "" };
  });
  if (!inj.present || inj.pct !== "58") dire("detail du hasard sur INJ : " + JSON.stringify(inj));
  if (!/58 %/.test(inj.lignes) || !/90/.test(inj.lignes)) dire("lignes du hasard sur INJ : " + inj.lignes);
  if (!/mélange|privé de sa mémoire/.test(inj.explique)) dire("explication du hasard absente : " + inj.explique.slice(0, 80));

  // Tout survit a un re-rendu.
  await $(() => Labo.charger()); await pg.waitForTimeout(600);
  const encore = await $(() => ({ perle: document.querySelector('[data-depli="p:AXS-USDT-SWAP"]')?.getAttribute("aria-expanded"),
    refus: document.querySelector('[data-depli="r:BTC-USDT-SWAP"]')?.parentElement.querySelector(".depli")?.classList.contains("ouvert") }));
  if (encore.perle !== "true" || !encore.refus) dire("re-rendu a referme : " + JSON.stringify(encore));

  await pg.screenshot({ path: path.join(__dirname, "details.png"), fullPage: true });
  await b.close(); srv.close();
  if (erreurs.length) { console.log("ERREURS :"); for (const e of erreurs) console.log("  " + e); process.exit(1); }
  console.log("les details se deplient, se relisent et survivent au re-rendu");
})();
