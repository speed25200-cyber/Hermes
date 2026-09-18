/* ============================================================================
   Le magasin de bougies 1 minute.

   Le moteur HERMES15 decide sur des bougies de 5 minutes relues par REST
   toutes les vingt secondes. A la minute, ce rythme ne tient plus : vingt
   instruments relus toutes les dix secondes feraient deux requetes par
   seconde vers OKX pour des donnees deja vues. Le flux WebSocket donne
   chaque bougie une fois, close ou non, avec le drapeau qui le dit.

   Deux faits d'OKX que ce module encode, parce qu'ils ne se devinent pas :

     1. Les canaux de chandelles (candle1m, candle5m…) ne sont PAS sur le
        point public : ils vivent sur le point « business »
        (wss://ws.okx.com:8443/ws/v5/business) depuis 2023. S'abonner sur
        le point public rend une erreur 60018 et aucun message.
     2. Chaque message porte la bougie en cours, mise a jour a chaque
        transaction, et la derniere valeur du tableau est `confirm` :
        "0" tant que la minute court, "1" a la cloture. On n'evalue que
        sur "1" — evaluer sur une bougie ouverte est le repaint que
        l'audit du 29 aout relevait dans l'ancien pipeline.

   Le magasin ne decide rien. Il garde, par instrument, un tableau
   ascendant de bougies CLOSES [ts, o, h, l, c, vol, volQuote], prechargees
   par REST puis prolongees par le flux, et il emet un evenement par
   cloture. Il sait aussi dire depuis combien de temps il n'a rien recu —
   un flux gele est la premiere chose qu'un decideur doit refuser.
   ============================================================================ */
"use strict";

const { EventEmitter } = require("events");

let WebSocket = null;
try { WebSocket = require("ws"); } catch { WebSocket = null; }

const REST_BASE = process.env.OKX_REST_BASE || "https://www.okx.com";
const WS_BUSINESS = (String(process.env.OKX_SIMULATED || "").toLowerCase() === "true")
  ? "wss://wspap.okx.com:8443/ws/v5/business"
  : "wss://ws.okx.com:8443/ws/v5/business";

const TAILLE_DEFAUT = 720;          // douze heures de minutes par instrument
const PRECHARGE_MAX = 300;          // limite REST d'un appel

/* Une ligne OKX -> notre bougie. Les champs REST et WS ont le meme ordre :
   [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]. */
function normaliser(c) {
  return [Number(c[0]), Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4]), Number(c[5]), Number(c[7] ?? 0)];
}

class MagasinBougies1m extends EventEmitter {
  /* options.taille       bougies closes gardees par instrument
     options.fetcher      fonction (url) => Promise<json>, pour les bancs et les tests
     options.sansFlux     true = pas de WebSocket (bancs, tests)
     options.journal      fonction de trace */
  constructor(options) {
    super();
    const o = options || {};
    this.taille = o.taille || TAILLE_DEFAUT;
    this.fetcher = o.fetcher || defautFetcher;
    this.sansFlux = !!o.sansFlux;
    this.tracer = o.journal || (() => {});
    this.series = new Map();        // instId -> bougies closes ascendantes
    this.enCours = new Map();       // instId -> derniere bougie ouverte vue
    this.dernierRx = new Map();     // instId -> ms du dernier message
    this.abonnes = new Set();
    this.ws = null;
    this.arrete = false;
    this.reculMs = 1000;
    this.stats = { messages: 0, clotures: 0, reconnexions: 0, erreurs: 0 };
  }

  /* --- lecture --- */

  bougies(instId) { return this.series.get(instId) || []; }

  /* Age du dernier message recu pour cet instrument, en ms. Infini si
     rien n'est jamais arrive : l'absence n'est pas la fraicheur. */
  age(instId) {
    const t = this.dernierRx.get(instId);
    return t ? Date.now() - t : Infinity;
  }

  derniereClose(instId) {
    const s = this.series.get(instId);
    return s && s.length ? s[s.length - 1] : null;
  }

  /* --- prechargement REST --- */

  async precharger(instId) {
    const url = `${REST_BASE}/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=1m&limit=${PRECHARGE_MAX}`;
    const j = await this.fetcher(url);
    const brut = (j && j.data) || [];
    if (!brut.length) return 0;
    // data[0] est la bougie EN COURS : exclue. L'API rend du plus recent
    // au plus ancien : on remet dans l'ordre du temps.
    const closes = brut.filter((c) => String(c[8] ?? "1") === "1").map(normaliser).reverse();
    this.series.set(instId, closes.slice(-this.taille));
    this.dernierRx.set(instId, Date.now());
    return closes.length;
  }

  /* --- flux --- */

  /* Abonne un lot d'instruments. Idempotent : reabonner un instrument
     deja suivi ne fait rien. Le prechargement se fait d'abord, pour
     qu'aucune decision ne parte sur une serie de trois bougies. */
  async suivre(instIds) {
    const neufs = instIds.filter((id) => !this.abonnes.has(id));
    for (const id of neufs) {
      try { await this.precharger(id); } catch (e) { this.stats.erreurs++; this.tracer("[1M] prechargement rate", id, e.message); }
      this.abonnes.add(id);
    }
    if (!this.sansFlux) {
      if (!this.ws) this.ouvrir();
      else if (this.ws.readyState === 1 && neufs.length) this.envoyerAbonnement(neufs);
    }
    return neufs.length;
  }

  oublier(instIds) {
    const partis = instIds.filter((id) => this.abonnes.has(id));
    for (const id of partis) this.abonnes.delete(id);
    if (this.ws && this.ws.readyState === 1 && partis.length) {
      this.ws.send(JSON.stringify({ op: "unsubscribe", args: partis.map((instId) => ({ channel: "candle1m", instId })) }));
    }
    // Les series restent : une position ouverte sur un instrument qui
    // quitte l'univers a encore besoin de son histoire.
  }

  envoyerAbonnement(instIds) {
    for (let i = 0; i < instIds.length; i += 40) {
      const lot = instIds.slice(i, i + 40);
      this.ws.send(JSON.stringify({ op: "subscribe", args: lot.map((instId) => ({ channel: "candle1m", instId })) }));
    }
  }

  ouvrir() {
    if (!WebSocket) { this.tracer("[1M] module ws absent : pas de flux"); return; }
    if (this.arrete) return;
    const ws = new WebSocket(WS_BUSINESS, { perMessageDeflate: false, handshakeTimeout: 15000 });
    this.ws = ws;
    let dernierMsg = Date.now();
    let pingEnvoye = 0;

    /* Le battement : OKX coupe une connexion muette apres trente
       secondes. On envoie « ping » apres vingt secondes de silence et on
       attend « pong » dix secondes — le minuteur n'est arme QU'APRES
       l'envoi, c'est la faute de l'ancien heartbeat qui tuait chaque
       connexion onze secondes apres l'ouverture. */
    const battement = setInterval(() => {
      if (ws.readyState !== 1) return;
      const silence = Date.now() - dernierMsg;
      if (pingEnvoye && Date.now() - pingEnvoye > 10000) { this.tracer("[1M] pong absent, fermeture"); try { ws.terminate(); } catch {} return; }
      if (!pingEnvoye && silence > 20000) { try { ws.send("ping"); pingEnvoye = Date.now(); } catch {} }
    }, 5000);

    ws.on("open", () => {
      this.tracer("[1M] flux business ouvert");
      this.reculMs = 1000;
      if (this.abonnes.size) this.envoyerAbonnement([...this.abonnes]);
    });

    ws.on("message", (raw) => {
      dernierMsg = Date.now();
      const texte = raw.toString();
      if (texte === "pong") { pingEnvoye = 0; return; }
      let m = null;
      try { m = JSON.parse(texte); } catch { return; }
      if (m.event === "error") { this.stats.erreurs++; this.tracer("[1M] erreur OKX", m.code, m.msg); return; }
      if (!m.arg || m.arg.channel !== "candle1m" || !Array.isArray(m.data)) return;
      this.stats.messages++;
      const id = m.arg.instId;
      this.dernierRx.set(id, Date.now());
      for (const c of m.data) this.ingerer(id, c);
    });

    ws.on("close", () => {
      clearInterval(battement);
      this.ws = null;
      if (this.arrete) return;
      this.stats.reconnexions++;
      const attente = this.reculMs + Math.floor(Math.random() * 500);
      this.reculMs = Math.min(this.reculMs * 2, 30000);   // le recul VIT entre deux tentatives, il n'est pas recree
      this.tracer("[1M] flux ferme, reconnexion dans", attente, "ms");
      setTimeout(() => this.ouvrir(), attente);
    });

    ws.on("error", (e) => { this.stats.erreurs++; this.tracer("[1M] erreur flux", e.message); });
  }

  /* Une ligne du flux. Une bougie ouverte remplace la precedente du meme
     horodatage ; une bougie close s'ajoute a la serie — une seule fois,
     meme si OKX la renvoie deux fois — et declenche l'evenement. */
  ingerer(instId, c) {
    const b = normaliser(c);
    const close = String(c[8]) === "1";
    if (!close) { this.enCours.set(instId, b); return; }
    const s = this.series.get(instId) || [];
    const dernier = s.length ? s[s.length - 1][0] : 0;
    if (b[0] <= dernier) return;             // deja vue, ou en retard : on ne reecrit pas le passe
    s.push(b);
    if (s.length > this.taille) s.splice(0, s.length - this.taille);
    this.series.set(instId, s);
    this.enCours.delete(instId);
    this.stats.clotures++;
    // Un trou : si la bougie close ne suit pas la precedente d'une
    // minute, il manque des bougies. On le dit, et on laisse l'appelant
    // decider de recharger — ici on ne bloque pas le flux sur du REST.
    if (dernier && b[0] - dernier > 60000 * 1.5) this.emit("trou", { instId, de: dernier, a: b[0] });
    this.emit("close", { instId, bougie: b, serie: s });
  }

  /* Injection directe, pour les bancs qui rejouent l'histoire sans
     reseau : meme chemin que le flux, meme evenement. */
  injecterClose(instId, bougie) {
    this.dernierRx.set(instId, Date.now());
    this.ingerer(instId, [...bougie.slice(0, 6), 0, bougie[6] ?? 0, "1"]);
  }

  fermer() {
    this.arrete = true;
    try { if (this.ws) this.ws.terminate(); } catch {}
    this.ws = null;
  }
}

async function defautFetcher(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

module.exports = { MagasinBougies1m, normaliser, WS_BUSINESS, TAILLE_DEFAUT };
