/* eslint-disable no-console */
"use strict";

/**
 * HERMES — Main process (refonte)
 * - UI mode : FULL (aucun viewer)
 * - IPC safe (no double handle)
 * - OKX WS robustes (ping/pong binaire, liveness > 60s, reconnect propre)
 * - DNS ipv4first
 */

const path = require("path");
const fs = require("fs");
const dns = require("dns");
const crypto = require("crypto");
const { app, BrowserWindow, ipcMain, shell, nativeTheme } = require("electron");

let WebSocket;
try { WebSocket = require("ws"); } catch {
  console.warn("[BOOT] Module 'ws' manquant. Installez-le: npm i ws");
}

try { dns.setDefaultResultOrder && dns.setDefaultResultOrder("ipv4first"); } catch {}
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "1";

const ROOT = path.join(__dirname, "..");
const APPDIR = __dirname;
const INDEX_FILE = path.join(APPDIR, "index.html");
const PRELOAD_FILE = path.join(APPDIR, "preload.js");

function now() { return new Date().toISOString(); }
function log(tag, ...a) { console.log(`[${now()}] [${tag}]`, ...a); }

let mainWindow;

/* ----------------------------- UI / IPC State ----------------------------- */
const uiState = {
  mode: "full",          // <— forcer FULL
  ai: { active: false, logs: [] },
};

function aiLog(message) {
  const item = { ts: Date.now(), message: String(message) };
  uiState.ai.logs.push(item);
  try { mainWindow?.webContents?.send?.("ai-log", item); } catch {}
}

/* ---- safeHandle : évite "Attempted to register a second handler…" ---- */
function safeHandle(channel, handler) {
  try { ipcMain.removeHandler(channel); } catch {}
  ipcMain.handle(channel, handler);
}

/* ----------------------------- BrowserWindow ------------------------------ */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 860,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: fs.existsSync(PRELOAD_FILE) ? PRELOAD_FILE : undefined,
      sandbox: false,
    },
  });

  // On charge le fichier local (pas de DEV_URL viewer).
  mainWindow.loadFile(INDEX_FILE).catch((e) => log("BOOT", "loadFile error:", e?.message || e));

  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url); return { action: "deny" };
  });
}

/* ------------------------------ IPC Handlers ------------------------------ */
// 1) Mode UI : toujours FULL (et sans doublon de handler)
safeHandle("ui-mode", async () => ({ mode: "full" }));

// 2) État IA minimal (compatible avec l’UI)
safeHandle("get-ai-state", async () => uiState.ai);
safeHandle("toggle-ai", async (_e, next) => {
  const prev = !!uiState.ai.active;
  uiState.ai.active = !!next;
  if (prev !== uiState.ai.active) aiLog(`IA ${uiState.ai.active ? "activée" : "désactivée"}`);
  // Si ton moteur IA est présent et exposé, on essaie de le piloter proprement :
  try { global.__HERMES_ENGINE__?.setActive?.(uiState.ai.active); } catch {}
  return uiState.ai;
});

// 3) Portefeuille (stub — à brancher à ton core si présent)
safeHandle("fetch-portfolio", async () => {
  // Branche ici tes états spot/futures/positions basés sur tes modules (si présents).
  return { success: true, data: {
    spot: [], futures: [], positions: [], performance: {}, history: [],
    openPositionsDetails: [], lastUpdate: Date.now(),
  }};
});

/* ----------------------------- OKX WebSockets ----------------------------- */
/**
 * On implémente un client robuste :
 *  - ping/pong binaire miroir (OKX envoie des ping frames -> renvoyer un pong avec le même payload)
 *  - liveness 65s
 *  - reconnect exponentiel + jitter
 *  - login privé + réabonnements (account / positions / orders)
 *
 * Tes logs montraient des coupures régulières (~9–12s) “heartbeat timeout -> terminate”.
 * Ce fichier supprime les terminate agressifs et aligne le heartbeat sur les exigences OKX.  ← voir logs
 */
const OKX = {
  sim: /^1|true$/i.test(String(process.env.OKX_SIM || "")),
  key: process.env.OKX_KEY || "",
  secret: process.env.OKX_SECRET || "",
  pass: process.env.OKX_PASS || "",
};

const WS_ENDPOINT = {
  public: OKX.sim ? "wss://wspap.okx.com:8443/ws/v5/public"  : "wss://ws.okx.com:8443/ws/v5/public",
  private: OKX.sim ? "wss://wspap.okx.com:8443/ws/v5/private" : "wss://ws.okx.com:8443/ws/v5/private",
};

// Heartbeat robuste (ping/pong binaire + liveness > 60s)
function attachOkxHeartbeat(ws, name = "WS") {
  let lastBeat = Date.now();
  const CLIENT_PING_MS = 20000;  // ping client optionnel
  const LIVENESS_MS    = 65000;  // > 60s

  ws.on("open", () => {
    log("HB", `[${name}] open`);
    try { clearInterval(ws._hbPing); clearInterval(ws._hbWatch); } catch {}
    ws._hbPing = setInterval(() => { // optionnel
      if (ws.readyState === ws.OPEN) {
        try { ws.ping(); } catch {}
      }
    }, CLIENT_PING_MS);

    ws._hbWatch = setInterval(() => {
      if (Date.now() - lastBeat > LIVENESS_MS) {
        console.warn(`[HB][${name}] no activity > ${LIVENESS_MS}ms -> close`);
        try { ws.close(4000, "hb-timeout"); } catch {}
      }
    }, 5000);
  });

  ws.on("ping", (data) => { lastBeat = Date.now(); try { ws.pong(data); } catch {} }); // miroir
  ws.on("pong", () => { lastBeat = Date.now(); });
  ws.on("message", () => { lastBeat = Date.now(); });
  ws.on("close", () => {
    try { clearInterval(ws._hbPing); clearInterval(ws._hbWatch); } catch {}
    ws._hbPing = ws._hbWatch = null;
  });
}

// util
function sendJson(ws, obj) {
  try {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  } catch (e) {
    log("WS", "sendJson error", e?.message || e);
  }
}

// signature OKX (WebSocket login) : timestamp + 'GET' + '/users/self/verify'
function okxSign(ts, method, path, body = "") {
  const prehash = ts + method + path + body;
  return crypto.createHmac("sha256", OKX.secret).update(prehash).digest("base64");
}

function loginPrivate(ws, name = "private") {
  const ts = new Date().toISOString();
  const sign = okxSign(ts, "GET", "/users/self/verify", "");
  const payload = {
    op: "login",
    args: [{ apiKey: OKX.key, passphrase: OKX.pass, timestamp: ts, sign }]
  };
  log("WS", `${name} -> login`);
  sendJson(ws, payload);
}

function subscribeDefaults(ws, name) {
  // Public : tickers de base (ajoutez vos instId)
  if (name === "public") {
    const args = [
      { channel: "tickers", instId: "BTC-USDT-SWAP" },
      { channel: "tickers", instId: "ETH-USDT-SWAP" },
    ];
    sendJson(ws, { op: "subscribe", args });
    log("WS", "public subscribed -> tickers");
  }
  // Privé : compte / positions / ordres (instType=SWAP)
  if (name === "private") {
    const args = [
      { channel: "account" },
      { channel: "positions", instType: "SWAP" },
      { channel: "orders",    instType: "SWAP" },
    ];
    sendJson(ws, { op: "subscribe", args });
    log("WS", "private subscribed -> account, positions, orders");
  }
}

function makeReconnector(kind, url) {
  let ws = null;
  let backoff = 1000;

  function connect() {
    if (!WebSocket) return;
    ws = new WebSocket(url);
    attachOkxHeartbeat(ws, kind);

    ws.on("open", () => {
      log("WS", `${kind} open`);
      backoff = 1000; // reset
      if (kind === "private") {
        if (!OKX.key || !OKX.secret || !OKX.pass) {
          log("WS", "private missing credentials -> close");
          try { ws.close(4403, "missing-credentials"); } catch {}
          return;
        }
        loginPrivate(ws, kind);
      } else {
        subscribeDefaults(ws, kind);
      }
    });

    ws.on("message", (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      // login OK (code: "0" ou event:"login" ok)
      if (kind === "private") {
        if ((msg.event === "login" && String(msg.code) === "0") ||
            (msg.code === "0" && msg.msg === "")) {
          log("WS", "private login OK -> subscribe account, positions, orders");
          subscribeDefaults(ws, "private");
        }
      }
      // debug minimal
      if (msg.event === "error" || msg.code && msg.code !== "0") {
        console.warn("[WS][", kind, "] error:", msg);
      }
    });

    ws.on("close", (code, reason) => {
      log("WS", `${kind} close | code: ${code} reason: ${reason?.toString?.() || ""}`);
      scheduleReconnect();
    });

    ws.on("error", (err) => {
      log("WS", `${kind} error`, err?.message || err);
    });
  }

  function scheduleReconnect() {
    const delay = backoff + Math.floor(Math.random() * 400);
    backoff = Math.min(backoff * 1.6, 15000);
    log("WS", `${kind} reconnect in ${delay}ms`);
    setTimeout(connect, delay);
  }

  connect();
  return () => { try { ws?.close(1000, "app-exit"); } catch {} };
}

/* ------------------------------ Engine (option) --------------------------- */
/**
 * Si ton moteur IA (Engine) est présent dans ton projet, on l’initialise
 * proprement et on relie toggle-ai -> engine.setActive(true/false).
 * Sinon, tout le reste fonctionne quand même.
 *
 * Remarque : ton Engine tourne des boucles (signalLoop ≈ 7s, manageLoop ≈ 1s, etc.),
 * et lit ses configs JSON (strategy.current.json, risk.json, whitelist.json). 
 */
async function tryInitEngine() {
  let Engine = null;
  const candidates = [
    path.join(APPDIR, "core", "engine.js"),
    path.join(APPDIR, "services", "engine.js"),
    path.join(ROOT, "core", "engine.js"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) { try { Engine = require(p); break; } catch {} }
  }
  if (!Engine) { log("AI", "Engine non détecté (ok)."); return; }

  try {
    const dataDir = path.join(ROOT, "data");
    const configDir = path.join(ROOT, "config");
    const okxApi = {}; // branche ici tes REST si tu en as
    const getTopSymbols = async () => ["BTC-USDT-SWAP","ETH-USDT-SWAP","SOL-USDT-SWAP"];
    global.__HERMES_ENGINE__ = Engine;

    await Engine.init({
      okxApi,
      getTopSymbols,
      dataDir,
      configDir,
      logToUi: (m) => aiLog(String(m)),
    });

    Engine.setActive(uiState.ai.active);
    aiLog("Engine prêt.");
  } catch (e) {
    aiLog("Engine init error: " + (e?.message || e));
  }
}

/* --------------------------------- BOOT ---------------------------------- */
app.whenReady().then(async () => {
  log("BOOT", "=== whenReady ===");
  log("BOOT", "__dirname:", __dirname);
  log("BOOT", "ROOT:", ROOT);
  log("BOOT", "INDEX_FILE exists:", fs.existsSync(INDEX_FILE));
  log("BOOT", "PRELOAD_FILE exists:", fs.existsSync(PRELOAD_FILE));
  createWindow();

  // WS OKX
  const stopPub  = makeReconnector("public",  WS_ENDPOINT.public);
  const stopPriv = makeReconnector("private", WS_ENDPOINT.private);
  app.on("before-quit", () => { stopPub(); stopPriv(); });

  // Engine optionnel
  try { await tryInitEngine(); } catch {}

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Sécurité / thème
try { nativeTheme.themeSource = "dark"; } catch {}
