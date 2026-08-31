"use strict";
/*
 * Une doublure d Electron, adossee a un serveur HTTP.
 *
 * Pourquoi une doublure plutot quune reecriture. Le moteur tient dans
 * main.js — deux mille sept cent soixante-huit lignes — et cest lui qui
 * porte les strategies validees par le classement du 31 aout. Le
 * reecrire pour le sortir dElectron, ce serait risquer de casser
 * justement ce quon veut garder. Or le couplage a Electron est mince :
 * quarante et un points de contact, dont onze canaux entrants et deux
 * sortants. Ce fichier presente exactement la meme surface, et une
 * seule ligne de main.js change — le require du haut.
 *
 * La traduction est directe :
 *   ipcMain.handle(canal, fn)   ->  POST /api/<canal>
 *   webContents.send(canal, x)  ->  un evenement sur /api/flux
 *   new BrowserWindow()         ->  le serveur se met a ecouter
 *   win.loadFile(f)             ->  f devient la page servie a la racine
 *   app.whenReady()             ->  resolue tout de suite
 *   globalShortcut.register()   ->  sans objet, un serveur na pas de clavier
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");

const PORT = Number(process.env.HERMES_PORT || 8899);
const HOTE = process.env.HERMES_HOST || "0.0.0.0";
const CLE = String(process.env.HERMES_DASH_TOKEN || "");
const RACINE_APP = __dirname;
const RACINE_PUB = path.join(__dirname, "..", "public");

const CORPS_MAX = 256 * 1024;      // une requete dUI ne pese jamais cela
const BATTEMENT_MS = 20000;        // garde le flux ouvert a travers les relais

function tracer(...a) { console.log("[SERVEUR]", ...a); }

/* ===== authentification =====
 *
 * Meme mecanique que le tableau de bord precedent, a dessein : le
 * proprietaire connait deja ce geste. Une cle dans lURL une seule fois,
 * un cookie ensuite. Sans HERMES_DASH_TOKEN le serveur refuse de
 * demarrer — un robot de trading joignable sur Internet sans cle
 * nest pas une commodite, cest un incident qui attend.
 */
function memeChaine(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function autorise(req) {
  const q = new URL(req.url, "http://x").searchParams.get("key");
  if (q && memeChaine(q, CLE)) {
    return { ok: true, cookie: `hermes_key=${CLE}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax` };
  }
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === "hermes_key" && memeChaine(part.slice(i + 1), CLE)) {
      return { ok: true, cookie: null };
    }
  }
  return { ok: false, cookie: null };
}

/* ===== la doublure ===== */

const gestionnaires = new Map();   // canal -> fn(evenement, argument)
const abonnes = new Set();         // les reponses SSE ouvertes

const ipcMain = {
  handle(canal, fn) { gestionnaires.set(String(canal), fn); },
  on(canal, fn) { gestionnaires.set(String(canal), fn); },
  removeHandler(canal) { gestionnaires.delete(String(canal)); },
};

function diffuser(canal, charge) {
  const ligne = `data: ${JSON.stringify({ canal, charge })}\n\n`;
  for (const rep of abonnes) {
    try { rep.write(ligne); } catch { abonnes.delete(rep); }
  }
}

// Le contenu de la « fenetre ». Cest lui qui recoit webContents.send.
const webContents = new EventEmitter();
webContents.send = (canal, charge) => diffuser(canal, charge);
webContents.getURL = () => `http://127.0.0.1:${PORT}/`;
webContents.openDevTools = () => {};
webContents.reload = () => {};

let pageServie = null;   // le fichier rendu a la racine

class BrowserWindow extends EventEmitter {
  constructor() {
    super();
    this.webContents = webContents;
    BrowserWindow._toutes.push(this);
    demarrer();
  }
  async loadFile(fichier) {
    pageServie = fichier;
    tracer("page servie a la racine :", fichier);
    // did-finish-load porte deux effets dans main.js : il fixe le mode
    // de linterface et lance le prechargement des bougies 5m. Sans lui,
    // le moteur demarre sans historique.
    setImmediate(() => webContents.emit("did-finish-load"));
  }
  async loadURL(url) {
    tracer("source distante demandee, ignoree sur serveur :", url);
    setImmediate(() => webContents.emit("did-finish-load"));
  }
  isMinimized() { return false; }
  restore() {}
  focus() {}
  static getAllWindows() { return BrowserWindow._toutes; }
}
BrowserWindow._toutes = [];

const app = new EventEmitter();
app.requestSingleInstanceLock = () => true;
app.whenReady = () => Promise.resolve();
app.quit = () => { app.emit("will-quit"); process.exit(0); };

const globalShortcut = {
  register: () => false,     // un serveur na pas de clavier
  unregisterAll: () => {},
};

/* ===== le serveur ===== */

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

function repondre(rep, code, corps, type, entetes) {
  const buf = Buffer.isBuffer(corps) ? corps : Buffer.from(String(corps));
  rep.writeHead(code, Object.assign({
    "Content-Type": type || "text/plain; charset=utf-8",
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  }, entetes || {}));
  rep.end(buf);
}

function lireCorps(req) {
  return new Promise((resoudre, rejeter) => {
    let total = 0;
    const morceaux = [];
    req.on("data", (c) => {
      total += c.length;
      if (total > CORPS_MAX) { rejeter(new Error("CORPS_TROP_GROS")); req.destroy(); return; }
      morceaux.push(c);
    });
    req.on("end", () => {
      const brut = Buffer.concat(morceaux).toString("utf8");
      if (!brut) return resoudre({});
      try { resoudre(JSON.parse(brut)); } catch { rejeter(new Error("JSON_INVALIDE")); }
    });
    req.on("error", rejeter);
  });
}

// Un chemin statique ne doit jamais sortir des deux dossiers servis.
// Cest la seule protection qui compte ici : sans elle, « /../../.env »
// rend les cles OKX a qui les demande.
function fichierStatique(chemin) {
  const propre = path.normalize(chemin).replace(/^(\.\.[/\\])+/, "");
  for (const base of [RACINE_APP, RACINE_PUB]) {
    const cible = path.resolve(base, "." + (propre.startsWith("/") ? propre : "/" + propre));
    if (!cible.startsWith(path.resolve(base) + path.sep)) continue;
    if (fs.existsSync(cible) && fs.statSync(cible).isFile()) return cible;
  }
  return null;
}

async function traiter(req, rep) {
  const url = new URL(req.url, "http://x");
  const chemin = url.pathname;

  const auth = autorise(req);
  if (!auth.ok) {
    repondre(rep, 403, "Hermes : cle dacces requise");
    return;
  }
  const entetes = auth.cookie ? { "Set-Cookie": auth.cookie } : {};

  // Le flux devenements : ce que webContents.send poussait a la fenetre.
  if (chemin === "/api/flux") {
    rep.writeHead(200, Object.assign({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    }, entetes));
    rep.write(": ouvert\n\n");
    abonnes.add(rep);
    const battement = setInterval(() => { try { rep.write(": .\n\n"); } catch {} }, BATTEMENT_MS);
    req.on("close", () => { clearInterval(battement); abonnes.delete(rep); });
    return;
  }

  // Les canaux : un POST par gestionnaire enregistre.
  if (chemin.startsWith("/api/")) {
    const canal = decodeURIComponent(chemin.slice(5));
    const fn = gestionnaires.get(canal);
    if (!fn) { repondre(rep, 404, JSON.stringify({ ok: false, error: "CANAL_INCONNU", canal }), TYPES[".json"], entetes); return; }
    if (req.method !== "POST") { repondre(rep, 405, JSON.stringify({ ok: false, error: "METHODE" }), TYPES[".json"], entetes); return; }
    let corps;
    try { corps = await lireCorps(req); }
    catch (e) { repondre(rep, 400, JSON.stringify({ ok: false, error: String(e.message) }), TYPES[".json"], entetes); return; }
    try {
      // Les gestionnaires sont ecrits pour Electron : ils recoivent
      // dabord un evenement, quils nutilisent pas, puis largument.
      const res = await fn({ sender: webContents }, corps.arg);
      repondre(rep, 200, JSON.stringify(res === undefined ? { ok: true } : res), TYPES[".json"], entetes);
    } catch (e) {
      tracer("canal", canal, "a echoue :", e && e.message);
      repondre(rep, 500, JSON.stringify({ ok: false, error: String((e && e.message) || e) }), TYPES[".json"], entetes);
    }
    return;
  }

  // La liste des canaux, pour que linterface sache ce qui existe
  // plutot que de le deviner.
  if (chemin === "/api") {
    repondre(rep, 200, JSON.stringify({ ok: true, canaux: [...gestionnaires.keys()].sort() }), TYPES[".json"], entetes);
    return;
  }

  if (chemin === "/" || chemin === "/index.html") {
    if (!pageServie || !fs.existsSync(pageServie)) { repondre(rep, 503, "Hermes : interface pas encore chargee", "text/plain; charset=utf-8", entetes); return; }
    repondre(rep, 200, fs.readFileSync(pageServie), TYPES[".html"], entetes);
    return;
  }

  const f = fichierStatique(chemin);
  if (f) { repondre(rep, 200, fs.readFileSync(f), TYPES[path.extname(f).toLowerCase()] || "application/octet-stream", entetes); return; }

  repondre(rep, 404, "introuvable", "text/plain; charset=utf-8", entetes);
}

let serveur = null;
function demarrer() {
  if (serveur) return serveur;
  if (!CLE) {
    console.error("[SERVEUR] HERMES_DASH_TOKEN est vide. Un robot de trading joignable");
    console.error("[SERVEUR] sur Internet sans cle nest pas une commodite. Arret.");
    process.exit(1);
  }
  serveur = http.createServer((req, rep) => {
    traiter(req, rep).catch((e) => {
      tracer("requete echouee :", e && e.message);
      try { repondre(rep, 500, "erreur interne"); } catch {}
    });
  });
  serveur.headersTimeout = 60000;
  serveur.listen(PORT, HOTE, () => {
    tracer(`a lecoute sur ${HOTE}:${PORT}`);
    tracer(`canaux exposes : ${[...gestionnaires.keys()].sort().join(", ")}`);
  });
  return serveur;
}

module.exports = { app, BrowserWindow, ipcMain, globalShortcut, demarrer, diffuser };
