#!/usr/bin/env node
"use strict";

/*
 * One autonomous, fail-closed reconciliation cycle.
 *
 * Inputs are files produced by discovery, quantitative validation, shadow
 * observation and two independent Ed25519 signers. This CLI owns no private key,
 * has no exchange client and cannot submit an order.
 */

const path = require("node:path");
const { runCycleFromFiles } = require("../modules/autopilot_cycle.js");

const VALUE_FLAGS = new Set([
  "--root", "--state", "--candidates", "--bundle", "--monitor", "--policy",
  "--gate-policy", "--public-key", "--monitoring-public-key", "--ledger", "--now",
]);

function usage() {
  return [
    "Usage: node deploy/autopilot_cycle.js [options]",
    "",
    "  --root DIR          racine Hermes (defaut: repo courant)",
    "  --candidates FILE   catalogue de candidats et rapports 1/2/3 ans",
    "  --bundle FILE       {roster,evidence} signe Ed25519 independamment",
    "  --monitor FILE      metriques rolling du canary",
    "  --state FILE        etat persistant du cycle",
    "  --ledger FILE       ledger append-only logique des essais vus",
    "  --policy FILE       politique de recherche/autopilot",
    "  --gate-policy FILE  politique du gate live",
    "  --public-key FILE   cle PUBLIQUE Ed25519 de preuve seulement",
    "  --monitoring-public-key FILE  cle PUBLIQUE Ed25519 monitoring distincte",
    "  --now ISO           horodatage explicite (dry-run/rejeu uniquement)",
    "  --dry-run           verifie sans ecrire ni promouvoir/quarantiner",
    "  --help              affiche cette aide",
  ].join("\n");
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help") { out.help = true; continue; }
    if (flag === "--dry-run") { out.dryRun = true; continue; }
    if (!VALUE_FLAGS.has(flag)) throw new Error(`argument inconnu: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`valeur absente: ${flag}`);
    const name = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    out[name] = value;
  }
  if (out.now != null && out.dryRun !== true) {
    throw new Error("--now est reserve au mode --dry-run");
  }
  if (out.now != null) {
    const parsed = Date.parse(out.now);
    if (!Number.isFinite(parsed)) throw new Error("--now doit etre une date ISO valide");
    out.nowMs = parsed;
    delete out.now;
  }
  if (out.root) out.root = path.resolve(out.root);
  return out;
}

function publicSummary(result) {
  return {
    stage: result.state.stage,
    candidateId: result.state.candidateId || null,
    championCandidateId: result.state.championCandidateId || null,
    actions: result.actions,
    reasons: result.reasons,
    trialsRecorded: result.trialRecords.length,
    dryRun: result.dryRun === true,
    files: {
      state: result.files.state,
      ledger: result.files.ledger,
      candidates: result.files.candidates,
      bundle: result.files.bundle,
      monitor: result.files.monitor,
      monitoringPublicKey: result.files.monitoringPublicKey,
      monitorHighWater: result.files.monitorHighWater,
    },
  };
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    const result = runCycleFromFiles(options);
    process.stdout.write(`${JSON.stringify(publicSummary(result), null, 2)}\n`);
    return result.exitCode;
  } catch (error) {
    process.stderr.write(`[AUTOPILOT] refus fail-closed: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { VALUE_FLAGS, usage, parseArgs, publicSummary, main };
