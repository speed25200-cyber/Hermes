#!/usr/bin/env node
"use strict";

/* Compile un run de recherche deja produit en preuve deterministe NON SIGNEE.
   Ce programme ne contacte ni OKX ni le moteur live, et ne peut promouvoir
   aucune strategie. Code retour 0 = tests quantitatifs passes, 2 = preuve
   refusee, 1 = entree/contrat invalide. */

const fs = require("fs");
const path = require("path");
const Q = require("../modules/quant_validation.js");

const ROOT = path.join(__dirname, "..");

function parseArgs(argv) {
  const out = {};
  const accepted = ["--input", "--output", "--policy", "--ledger", "--cycle-ledger", "--execution-policy",
    "--execution-attestation-public-key", "--execution-attestation-spki-sha256",
    "--cycle-ledger-attestation-public-key", "--cycle-ledger-attestation-spki-sha256",
    "--expected-policy-sha256", "--candidate-catalog", "--candidate-id"];
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!accepted.includes(key) || !argv[index + 1]) {
      throw new Error(`argument inconnu ou sans valeur: ${key}`);
    }
    out[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[++index];
  }
  if (!out.input || !out.output || Boolean(out.candidateCatalog) !== Boolean(out.candidateId)) {
    throw new Error("usage: compiler_preuve_quantitative.js --input RUN.json --output PREUVE.json [--policy POLICY.json] [--ledger LEDGER.json] [--cycle-ledger CYCLE.json] [--execution-policy AUTOPILOT.json] [--execution-attestation-public-key PUB.pem --execution-attestation-spki-sha256 SHA256] [--cycle-ledger-attestation-public-key PUB.pem --cycle-ledger-attestation-spki-sha256 SHA256] [--expected-policy-sha256 SHA256] [--candidate-catalog CANDIDATES.json --candidate-id SHA256]");
  }
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function atomicWrite(file, content) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = null;
    fs.renameSync(temporary, file);
    try {
      const directoryDescriptor = fs.openSync(directory, "r");
      fs.fsyncSync(directoryDescriptor); fs.closeSync(directoryDescriptor);
    } catch {}
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function readPublicKeyOnly(file, explicit) {
  if (!file) return null;
  try {
    const value = fs.readFileSync(file, "utf8");
    if (/BEGIN [^\r\n]*PRIVATE KEY/.test(value)) {
      throw new Error("une cle privee est interdite dans le compilateur quantitatif");
    }
    if (!/BEGIN PUBLIC KEY/.test(value)) throw new Error("cle publique Ed25519 absente ou invalide");
    return value;
  } catch (error) {
    if (explicit || !/ENOENT/.test(String(error?.code || error?.message))) throw error;
    return null;
  }
}

function enrichCandidateCatalogUnlocked({ file, candidateId, evidence }) {
  const expectedId = String(candidateId || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedId)) throw new Error("candidate-id doit etre un SHA-256 hex");
  if (evidence?.decision !== "passed" || !Q.isFreshlyCompiledQuantitativeEvidence(evidence)) {
    throw new Error("preuve rejetee ou alteree: catalogue intact");
  }
  if (String(evidence.candidateId || "").toLowerCase() !== expectedId) {
    throw new Error("candidate-id ne correspond pas a la preuve quantitative");
  }
  const catalog = readJson(file);
  if (!catalog || Number(catalog.schemaVersion) !== 1 || !Array.isArray(catalog.candidates)) {
    throw new Error("catalogue candidats absent ou invalide");
  }
  const matches = [];
  catalog.candidates.forEach((candidate, index) => {
    if (Q.quantitativeCandidateId(candidate) === expectedId) matches.push({ candidate, index });
  });
  if (matches.length !== 1) throw new Error("candidate exact absent ou duplique dans le catalogue");
  const current = matches[0].candidate;
  const existing = Array.isArray(current.horizonReports) ? current.horizonReports : [];
  const existingHashes = new Set(existing.map((report) => String(report?.quantEvidenceSha256 || "").toLowerCase())
    .filter((hash) => /^[a-f0-9]{64}$/.test(hash)));
  if (existing.length && (existingHashes.size !== 1 || !existingHashes.has(evidence.evidenceSha256))) {
    throw new Error("candidat deja enrichi par une autre preuve: catalogue intact");
  }
  const horizonReports = Q.toAutopilotHorizonReports(evidence);
  catalog.candidates[matches[0].index] = {
    ...current,
    horizonReports,
    validationStatus: "quantitative-passed-awaiting-shadow",
    quantEvidenceSha256: evidence.evidenceSha256,
    quantPolicySha256: evidence.policySha256,
    dataManifestSha256: evidence.dataManifestSha256,
  };
  atomicWrite(file, `${JSON.stringify(catalog, null, 2)}\n`);
  return { file, candidateId: expectedId, reports: horizonReports.length };
}

function enrichCandidateCatalog(args) {
  const file = path.resolve(args.file);
  const lockFile = `${file}.quant.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let descriptor = null;
  try {
    descriptor = fs.openSync(lockFile, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, candidateId: args.candidateId })}\n`, "utf8");
    fs.fsyncSync(descriptor);
    return enrichCandidateCatalogUnlocked({ ...args, file });
  } catch (error) {
    if (String(error?.code || "") === "EEXIST") {
      throw new Error("catalogue verrouille par un autre processus: aucune mutation");
    }
    throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (descriptor !== null) {
      try { fs.unlinkSync(lockFile); } catch {}
    }
  }
}

function compileFromFiles(options) {
  const inputFile = path.resolve(options.input);
  const outputFile = path.resolve(options.output);
  const policyFile = path.resolve(options.policy || path.join(ROOT, "config", "quant-validation.policy.json"));
  const ledgerFile = path.resolve(options.ledger || path.join(ROOT, "config", "quant-trial-ledger.json"));
  const cycleLedgerFile = path.resolve(options.cycleLedger || path.join(ROOT, "data", "autopilot", "cycle-ledger.json"));
  const executionPolicyFile = path.resolve(options.executionPolicy || path.join(ROOT, "config", "autopilot.policy.json"));
  const executionKeyFile = path.resolve(options.executionAttestationPublicKey
    || process.env.HERMES_QUANT_EXECUTION_ATTESTATION_PUBLIC_KEY_FILE
    || path.join(ROOT, "config", "quant-execution-attestation-public-key.pem"));
  const cycleKeyFile = path.resolve(options.cycleLedgerAttestationPublicKey
    || process.env.HERMES_QUANT_CYCLE_LEDGER_ATTESTATION_PUBLIC_KEY_FILE
    || path.join(ROOT, "config", "quant-cycle-ledger-attestation-public-key.pem"));
  const input = readJson(inputFile);
  const policy = Q.mergePolicy(readJson(policyFile));
  const trialLedger = readJson(ledgerFile);
  const cycleLedger = readJson(cycleLedgerFile);
  const executionPolicy = readJson(executionPolicyFile);
  const executionAttestationPublicKey = readPublicKeyOnly(executionKeyFile,
    Boolean(options.executionAttestationPublicKey || process.env.HERMES_QUANT_EXECUTION_ATTESTATION_PUBLIC_KEY_FILE));
  const cycleLedgerAttestationPublicKey = readPublicKeyOnly(cycleKeyFile,
    Boolean(options.cycleLedgerAttestationPublicKey || process.env.HERMES_QUANT_CYCLE_LEDGER_ATTESTATION_PUBLIC_KEY_FILE));
  if (!input?.runRecord || !input?.marketSeries || typeof input.marketSeries !== "object" || !input?.instrumentMaster) {
    throw new Error("le run doit contenir runRecord, marketSeries et instrumentMaster point-in-time");
  }
  const prepared = Q.preparePointInTimeSeries(input.marketSeries, { barMs: policy.universe.barMs });
  const instrumentMaster = Q.preparePointInTimeInstrumentMaster(input.instrumentMaster);
  const result = Q.compileQuantitativeEvidence({ runRecord: input.runRecord, prepared, instrumentMaster, policy,
    trialLedger, cycleLedger, executionPolicy, executionAttestationPublicKey,
    expectedExecutionAttestationPublicKeySpkiSha256: options.executionAttestationSpkiSha256
      || process.env.HERMES_QUANT_EXECUTION_ATTESTATION_PUBLIC_KEY_SPKI_SHA256 || null,
    cycleLedgerAttestationPublicKey,
    expectedCycleLedgerAttestationPublicKeySpkiSha256: options.cycleLedgerAttestationSpkiSha256
      || process.env.HERMES_QUANT_CYCLE_LEDGER_ATTESTATION_PUBLIC_KEY_SPKI_SHA256 || null,
    expectedQuantPolicySha256: options.expectedPolicySha256
      || process.env.HERMES_QUANT_POLICY_SHA256 || null });
  const unsignedBundle = {
    schemaVersion: 1,
    artifactType: "hermes-unsigned-quantitative-evidence-bundle",
    evidence: result.evidence,
    dataManifest: result.dataManifest,
    trialLedgerAudit: result.trialLedgerAudit,
    cycleLedgerAudit: result.cycleLedgerAudit,
    feeScheduleAudit: result.feeScheduleAudit,
    executionDatasetAudit: result.executionDatasetAudit,
    executionUniverseParityAudit: result.executionUniverseParityAudit,
    processReplayManifest: result.processReplayManifest,
    processAttestationAudit: result.processAttestationAudit,
    attestationRequests: result.attestationRequests,
    signature: null,
    liveAuthorized: false,
    catalogEnrichmentRequested: Boolean(options.candidateCatalog || options.candidateId),
  };
  unsignedBundle.bundleSha256 = Q.sha256Canonical(unsignedBundle);
  if ((options.candidateCatalog || options.candidateId) && unsignedBundle.evidence.decision !== "passed") {
    throw new Error("preuve quantitative rejetee: catalogue intact");
  }
  atomicWrite(outputFile, `${Q.canonicalJson(unsignedBundle)}\n`);
  if (options.candidateCatalog || options.candidateId) {
    enrichCandidateCatalog({
      file: path.resolve(options.candidateCatalog),
      candidateId: options.candidateId,
      evidence: unsignedBundle.evidence,
    });
  }
  return unsignedBundle;
}

function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const bundle = compileFromFiles(args);
    process.stdout.write(`${JSON.stringify({
      decision: bundle.evidence.decision,
      evidenceSha256: bundle.evidence.evidenceSha256,
      bundleSha256: bundle.bundleSha256,
      output: path.resolve(args.output),
      rejectionReasons: bundle.evidence.rejectionReasons,
      liveAuthorized: false,
    }, null, 2)}\n`);
    return bundle.evidence.decision === "passed" ? 0 : 2;
  } catch (error) {
    process.stderr.write(`[PREUVE-QUANT] refus: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { parseArgs, atomicWrite, readPublicKeyOnly, enrichCandidateCatalog, compileFromFiles, main };
