/* ============================================================================
   Le coupe-circuit journalier — le garde-fou qu'Hermes n'avait pas.

   direction.md, point 7 de « ce qu'il ne faut pas faire » : trader a x15
   avec un stop serre sans coupe-circuit journalier. Cinq stops font -13,5 %
   du capital, et rien dans le moteur ne l'empechait d'en prendre un sixieme.
   Le kill-switch par palier (tierBreach) regarde le PIC historique : il ne
   dit rien d'une journee qui part mal depuis une equite deja basse.

   La regle est simple et elle ne se negocie pas depuis l'interface :

     - a chaque jour UTC, l'equite du premier releve devient la reference ;
     - si l'equite courante passe sous reference x (1 - SEUIL), le circuit
       s'OUVRE : plus aucune ENTREE jusqu'au lendemain ;
     - les positions ouvertes ne sont pas touchees par ce module — leurs
       protections vivent sur OKX ; le moteur peut choisir de les fermer
       (HERMES_COUPE_CIRCUIT_FERMER=1), ce module ne fait que le dire.

   L'etat est PERSISTE : un redemarrage ne doit pas refermer un circuit que
   la journee a ouvert. C'est la lecon de la baseline « 250 en dur » de
   l'ancien kill-switch, qui repartait de zero a chaque boot.

   Tout est pur sauf la persistance, et la persistance est un fichier JSON
   dans runtime/, ecrit de facon atomique.
   ============================================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

const SEUIL_DEFAUT = 0.05;   // 5 % de l'equite de debut de journee

function jourUTC(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

class CoupeCircuit {
  /* options.fichier   ou persister (defaut runtime/coupe_circuit.json)
     options.seuilPct  fraction de perte journaliere qui ouvre le circuit
     options.horloge   fonction () => ms, pour les bancs */
  constructor(options) {
    const o = options || {};
    this.fichier = o.fichier || path.join(__dirname, "..", "runtime", "coupe_circuit.json");
    this.seuilPct = Number.isFinite(o.seuilPct) ? o.seuilPct : Number(process.env.HERMES_COUPE_CIRCUIT_PCT || SEUIL_DEFAUT);
    this.horloge = o.horloge || (() => Date.now());
    this.etat = { jour: null, equiteDebut: null, plancher: null, ouvert: false, ouvertA: null, equiteMin: null, motif: null };
    this.charger();
  }

  charger() {
    try {
      const j = JSON.parse(fs.readFileSync(this.fichier, "utf8"));
      if (j && typeof j === "object" && j.jour) this.etat = { ...this.etat, ...j };
    } catch {}
  }

  ecrire() {
    try {
      fs.mkdirSync(path.dirname(this.fichier), { recursive: true });
      const tmp = this.fichier + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ ...this.etat, ts: this.horloge() }));
      fs.renameSync(tmp, this.fichier);
    } catch {}
  }

  /* Le releve. A appeler a chaque lecture d'equite (le moteur en fait une
     toutes les quatre secondes). Rend le verdict courant, et ne change
     d'avis que dans un sens pendant la journee : un circuit ouvert ne se
     referme qu'au changement de jour, jamais parce que l'equite est
     remontee — un rebond de dix minutes n'est pas une raison de rouvrir
     les entrees sur une journee qui a deja prouve qu'elle est mauvaise. */
  relever(equite) {
    const e = Number(equite);
    if (!Number.isFinite(e) || e <= 0) return this.verdict();   // pas de releve fiable : rien ne bouge

    const jour = jourUTC(this.horloge());
    if (this.etat.jour !== jour) {
      this.etat = { jour, equiteDebut: e, plancher: e * (1 - this.seuilPct), ouvert: false, ouvertA: null, equiteMin: e, motif: null };
      this.ecrire();
      return this.verdict();
    }

    if (this.etat.equiteMin == null || e < this.etat.equiteMin) this.etat.equiteMin = e;
    if (!this.etat.ouvert && e <= this.etat.plancher) {
      this.etat.ouvert = true;
      this.etat.ouvertA = this.horloge();
      this.etat.motif = `equite ${e.toFixed(2)} sous le plancher ${this.etat.plancher.toFixed(2)} (debut de journee ${this.etat.equiteDebut.toFixed(2)}, seuil ${(100 * this.seuilPct).toFixed(1)} %)`;
      this.ecrire();
    } else if (e < (this.etat.equiteMin ?? Infinity) + 1e-9) {
      this.ecrire();   // le minimum a bouge : on le garde pour le rapport
    }
    return this.verdict();
  }

  /* Le verdict, sans effet de bord. `entreesPermises` est la seule chose
     que le chemin d'entree doit lire. */
  verdict() {
    const s = this.etat;
    const perte = (s.equiteDebut && s.equiteMin != null) ? (s.equiteDebut - s.equiteMin) / s.equiteDebut : 0;
    return {
      entreesPermises: !s.ouvert,
      ouvert: !!s.ouvert,
      jour: s.jour,
      equiteDebut: s.equiteDebut,
      plancher: s.plancher,
      equiteMin: s.equiteMin,
      perteJourPct: perte,
      seuilPct: this.seuilPct,
      ouvertA: s.ouvertA,
      motif: s.motif,
    };
  }

  /* Reouverture manuelle, par le proprietaire et lui seul. Elle est
     journalisee par l'appelant ; ici on ne fait que l'executer. Elle
     n'existe pas dans l'interface : un bouton « rouvrir » a portee de
     main est exactement ce qu'un coupe-circuit doit rendre difficile. */
  reinitialiser() {
    this.etat = { jour: null, equiteDebut: null, plancher: null, ouvert: false, ouvertA: null, equiteMin: null, motif: null };
    this.ecrire();
    return this.verdict();
  }
}

module.exports = { CoupeCircuit, SEUIL_DEFAUT, jourUTC };
