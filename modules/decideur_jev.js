/* ============================================================================
   Le decideur Jev — une decision par bougie 1 minute close.

   Il ecoute le magasin de bougies, fabrique l'etat (etat_jev.js), pose
   les trois questions en UN appel, applique la regle de decision ecrite,
   et remet le resultat a qui l'ecoute. Il ne passe aucun ordre : c'est
   le moteur qui decide s'il ENTRE, apres ses propres gardes. Le decideur
   ne sait meme pas s'il tourne en observation ou en reel.

   Ce qu'il garantit, et pourquoi :

     - un budget de LATENCE : une decision qui arrive apres la minute
       suivante decide sur un monde qui n'existe plus. Au-dela du budget
       la reponse est jetee, et c'est compte.
     - un budget de COUT par jour UTC, estime avant l'appel. Au plafond,
       il se tait et le dit une fois.
     - une CONCURRENCE bornee : vingt instruments cloturent la meme
       seconde ; on n'ouvre pas vingt connexions. Une cloture plus
       recente du meme instrument remplace celle qui attendait — decider
       en retard sur une bougie perimee ne vaut rien.
     - un JOURNAL de chaque decision, prise ou non, avec l'etat, la
       reponse, la latence et le prix : c'est la matiere de la
       calibration (deploy/calibration_jev.js). Sans lui, « Jev a-t-il
       raison ? » n'a pas de reponse.
     - Jev injoignable = pas d'avis, jamais un incident. `interrogerOuNull`
       fait ce que son nom dit.
   ============================================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const jev = require("./jev.js");
const ETAT = require("./etat_jev.js");

const USD_PAR_MTOK = 0.042;

function jourUTC(ts) { return new Date(ts).toISOString().slice(0, 10); }

function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

class DecideurJev extends EventEmitter {
  /* options.magasin        MagasinBougies1m (ou tout emetteur de "close")
     options.contexte       (instId) => { tick, regime, autorise, fraisTaker } — ce que le moteur sait
     options.fichierJournal jsonl des decisions
     options.latenceMaxMs   budget de latence (defaut 2000)
     options.budgetUsdJour  plafond de cout par jour UTC (defaut 5)
     options.concurrence    appels simultanes (defaut 6)
     options.horizonMin     horizon des questions
     options.seuils         { sens, cout }
     options.interroger     remplacant de jev.interrogerOuNull, pour les bancs
     options.journal        fonction de trace */
  constructor(options) {
    super();
    const o = options || {};
    this.magasin = o.magasin || null;
    this.contexte = o.contexte || (() => ({}));
    this.fichierJournal = o.fichierJournal || path.join(__dirname, "..", "data", "jev-decisions.jsonl");
    this.latenceMaxMs = o.latenceMaxMs || Number(process.env.HERMES_JEV_LATENCE_MAX_MS || 2000);
    this.budgetUsdJour = Number.isFinite(o.budgetUsdJour) ? o.budgetUsdJour : Number(process.env.HERMES_JEV_BUDGET_USD_JOUR || 5);
    this.concurrence = o.concurrence || Number(process.env.HERMES_JEV_CONCURRENCE || 6);
    this.horizonMin = o.horizonMin || ETAT.HORIZON_MIN_DEFAUT;
    this.seuils = o.seuils || null;
    this.interroger = o.interroger || ((etat, questions, opt) => jev.interrogerOuNull(etat, questions, opt));
    this.tracer = o.journal || (() => {});
    this.modele = o.modele || process.env.JEV_MODEL || "jev-latest";

    this.enVol = 0;
    this.attente = new Map();     // instId -> serie en attente (la plus recente seulement)
    this.latences = [];           // fenetre glissante
    this.dernieres = [];          // les vingt dernieres decisions, pour l'interface
    this.parInstrument = {};      // instId -> derniere decision
    this.jour = jourUTC(Date.now());
    this.stats = { appels: 0, reponses: 0, erreurs: 0, tardives: 0, jetees: 0, budgetAtteint: 0, coutJourUsd: 0, tokensJour: 0, entreesProposees: 0 };
    this.budgetSignale = false;

    if (this.magasin) this.magasin.on("close", (ev) => this.surCloture(ev.instId, ev.serie));
  }

  surCloture(instId, serie) {
    // La plus recente remplace celle qui attendait : on ne decide jamais
    // deux fois sur le meme instrument pour deux minutes differentes.
    this.attente.set(instId, serie);
    this.pomper();
  }

  pomper() {
    while (this.enVol < this.concurrence && this.attente.size) {
      const [instId, serie] = this.attente.entries().next().value;
      this.attente.delete(instId);
      this.enVol++;
      this.decider(instId, serie).catch((e) => { this.stats.erreurs++; this.tracer("[JEV] decision en erreur", instId, e.message); })
        .finally(() => { this.enVol--; this.pomper(); });
    }
  }

  tournerJour() {
    const j = jourUTC(Date.now());
    if (j === this.jour) return;
    this.jour = j;
    this.stats.coutJourUsd = 0; this.stats.tokensJour = 0; this.stats.budgetAtteint = 0;
    this.budgetSignale = false;
  }

  async decider(instId, serie) {
    this.tournerJour();
    const ctx = this.contexte(instId) || {};
    const etat = ETAT.construireEtat({
      instId, bougies: serie, tick: ctx.tick, regime: ctx.regime, autorise: ctx.autorise,
      fraisTaker: ctx.fraisTaker, horizonMin: this.horizonMin,
    });
    if (!etat) return null;   // pas assez d'histoire : on attend

    const tokens = ETAT.estimerTokens(etat);
    const cout = tokens / 1e6 * USD_PAR_MTOK;
    if (this.stats.coutJourUsd + cout > this.budgetUsdJour) {
      this.stats.budgetAtteint++;
      if (!this.budgetSignale) { this.budgetSignale = true; this.tracer(`[JEV] budget du jour atteint (${this.budgetUsdJour} USD) : plus de decision jusqu'a demain UTC`); this.emit("budget", { jour: this.jour }); }
      return null;
    }

    const t0 = Date.now();
    this.stats.appels++;
    const r = await this.interroger(etat, ETAT.QUESTIONS, { delaiMs: this.latenceMaxMs, essais: 0, modele: this.modele });
    const latence = Date.now() - t0;
    this.latences.push(latence); if (this.latences.length > 500) this.latences.shift();
    this.stats.tokensJour += tokens; this.stats.coutJourUsd += cout;

    const ligne = { ts: Date.now(), instId, bougie: etat.ts, prix: serie[serie.length - 1][4], signature: ETAT.SIGNATURE, modele: this.modele, latenceMs: latence, tokensEstimes: tokens, etat };

    if (!r.ok) {
      this.stats.erreurs++;
      ligne.erreur = r.motif;
      this.journaliser(ligne);
      this.retenir({ ts: ligne.ts, instId, sens: null, motif: "sans avis : " + r.motif, latenceMs: latence });
      return null;
    }
    this.stats.reponses++;
    const decision = ETAT.decider(r.reponse, this.seuils, etat.autorise);
    // Une reponse arrivee apres le budget est journalisee (elle vaut pour
    // la calibration) mais n'est PAS remise au moteur : la minute est finie.
    const tardive = latence > this.latenceMaxMs;
    if (tardive) this.stats.tardives++;
    ligne.reponse = r.reponse.answers || r.reponse;
    ligne.decision = decision;
    ligne.tardive = tardive;
    this.journaliser(ligne);

    const resume = { ts: ligne.ts, instId, bougie: etat.ts, prix: ligne.prix, sens: tardive ? null : decision.sens,
                     pLong: decision.pLong, pShort: decision.pShort, pDepasse: decision.pDepasse, conviction: decision.conviction,
                     motif: tardive ? `tardive (${latence} ms > ${this.latenceMaxMs})` : decision.motif, latenceMs: latence };
    this.retenir(resume);
    if (resume.sens) { this.stats.entreesProposees++; this.emit("decision", resume); }
    return resume;
  }

  retenir(d) {
    this.parInstrument[d.instId] = d;
    this.dernieres.push(d); if (this.dernieres.length > 20) this.dernieres.shift();
    this.emit("avis", d);
  }

  journaliser(ligne) {
    try {
      fs.mkdirSync(path.dirname(this.fichierJournal), { recursive: true });
      fs.appendFileSync(this.fichierJournal, JSON.stringify(ligne) + "\n");
    } catch (e) { this.tracer("[JEV] journal inaccessible", e.message); }
  }

  /* Ce que l'interface montre. */
  etat() {
    return {
      signature: ETAT.SIGNATURE, modele: this.modele, horizonMin: this.horizonMin,
      seuils: { ...ETAT.SEUILS_DEFAUT, ...(this.seuils || {}) },
      latence: { p50: percentile(this.latences, 0.5), p95: percentile(this.latences, 0.95), max: this.latenceMaxMs, n: this.latences.length },
      budget: { jour: this.jour, coutUsd: Math.round(this.stats.coutJourUsd * 1e4) / 1e4, plafondUsd: this.budgetUsdJour, tokens: this.stats.tokensJour },
      stats: { ...this.stats },
      enVol: this.enVol, enAttente: this.attente.size,
      dernieres: [...this.dernieres].reverse(),
      parInstrument: this.parInstrument,
    };
  }
}

module.exports = { DecideurJev, USD_PAR_MTOK };
