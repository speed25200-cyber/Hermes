"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  STAGES,
  applyPromotionBundle,
  assessHorizonBundle,
  buildCandidateRoster,
  candidateId,
  executableStrategyIdentity,
  initialAutopilotState,
  mergeCandidateCatalog,
  quarantineApprovedRoster,
  rankCandidates,
  transitionAutopilot,
  trialLedgerRecord,
} = require("../modules/autopilot.js");
const {
  DEFAULT_POLICY,
  engineSha256,
  evidenceSigningPayload,
  publicKeySpkiSha256,
  rosterSha256,
} = require("../modules/live_safety.js");

function writeImmutableEngineFixture(root) {
  for (const relative of DEFAULT_POLICY.engineFiles) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `fixture:${relative.replace(/\\/g, "/")}\n`);
  }
}

function approvedMetrics() {
  return {
    oosTrades: 2200,
    oosDays: 1095,
    netMeanPerTrade: 0.003,
    netMeanLower99: 0.001,
    costStressLower95: 0.0005,
    familywisePValue: 0.005,
    pbo: 0.05,
    deflatedSharpeProbability: 0.98,
    spaPValue: 0.01,
    whiteRealityCheckPValue: 0.01,
    nullReplications: 10000,
    profitableFoldRate: 0.8,
    maxProfitConcentration: 0.2,
    effectiveDays: 300,
    independentBaskets: 150,
    calendarYearProfitConcentration: 0.5,
    instrumentProfitConcentration: 0.08,
    topFiveProfitConcentration: 0.4,
    maxDrawdownPct: 0.07,
    profitFactor: 1.3,
    shadowLiveDays: 90,
    shadowLiveTrades: 120,
    shadowLiveNet: 0.02,
    validatedHorizonsDays: [365, 730, 1095],
    primaryHorizonDays: 1095,
  };
}

function approvedMethodology() {
  return Object.fromEntries(DEFAULT_POLICY.requiredMethodology.map((name) => [name, true]));
}

function report(horizonDays, overrides = {}) {
  return {
    horizonDays,
    quantEvidenceSha256: "d".repeat(64),
    quantPolicySha256: "e".repeat(64),
    candidateId: "c".repeat(64),
    cutoff: "2026-08-31T00:00:00.000Z",
    coverageRatio: 0.999,
    pointInTimeUniverse: true,
    includesDelistedInstruments: true,
    portfolioSynchronized: true,
    confirmedDataOnly: true,
    completeCostModel: true,
    folds: 12,
    oosTrades: 2200,
    oosDays: 1095,
    netMeanPerTrade: 0.003,
    netMeanLower95: 0.0015,
    netMeanLower99: 0.001,
    costStressLower95: 0.0004,
    familywisePValue: 0.005,
    nullReplications: 10000,
    pbo: 0.08,
    deflatedSharpeProbability: 0.97,
    profitableFoldRate: 0.75,
    maxProfitConcentration: 0.20,
    calendarYearProfitConcentration: 0.50,
    instrumentProfitConcentration: 0.08,
    topFiveProfitConcentration: 0.40,
    independentBaskets: 150,
    effectiveDays: 300,
    maxDrawdownPct: 0.07,
    profitFactor: 1.25,
    expectedShortfall95: 0.02,
    costPerTrade: 0.0005,
    ...overrides,
  };
}

function candidate(lower99 = 0.001) {
  const value = {
    schemaVersion: 1,
    family: "momentum",
    executionType: "directional-signal",
    params: { lookback: 24, variant: lower99 },
    universe: { venue: "OKX", ranking: "absolute-return-24h", topN: 30 },
    horizonReports: [report(365), report(730), report(1095, { netMeanLower99: lower99 })],
    quantPolicySha256: "e".repeat(64),
    perles: {
      "BTC-USDT-SWAP": {
        sig: "roc_suit",
        ov: { tpPctMargin: 0.8, slPctMargin: 0.3, trailActPctMargin: 0.1, holdMs: 21600000 },
      },
    },
  };
  const id = candidateId(value);
  for (const horizon of value.horizonReports) horizon.candidateId = id;
  return value;
}

test("candidateId est deterministe et sensible aux parametres", () => {
  const a = candidate();
  const b = JSON.parse(JSON.stringify(a));
  assert.equal(candidateId(a), candidateId(b));
  b.params.lookback = 48;
  assert.notEqual(candidateId(a), candidateId(b));
});

test("candidateId est sensible au mapping perles applique en live", () => {
  const a = candidate();
  const b = JSON.parse(JSON.stringify(a));
  b.perles["BTC-USDT-SWAP"].sig = "rsi_retourne";
  assert.notEqual(candidateId(a), candidateId(b));
});

test("candidateId ignore metriques et snapshot volatils mais lie sorties executables", () => {
  const a = candidate();
  const b = JSON.parse(JSON.stringify(a));
  b.universe.snapshotSha256 = "f".repeat(64);
  b.universe.asOf = "2026-09-04T01:00:00.000Z";
  b.perles["BTC-USDT-SWAP"].winRate = 0.99;
  b.perles["BTC-USDT-SWAP"].trades = 999999;
  b.horizonReports[2].netMeanLower99 = 123;
  b.sourcePriorSha256 = "1".repeat(64);
  assert.equal(candidateId(a), candidateId(b));
  b.perles["BTC-USDT-SWAP"].ov.holdMs += 1;
  assert.notEqual(candidateId(a), candidateId(b));
});

test("le ledger autonome embarque l'identite executable exacte et recalculable", () => {
  const value = candidate();
  value.universe.snapshotSha256 = "9".repeat(64);
  value.perles["BTC-USDT-SWAP"].winRate = 0.999;
  const record = trialLedgerRecord(value, { allowed: false, reasons: ["fixture"] }, {
    runId: "discovery-fixture",
    recordedAt: "2026-09-04T00:00:00.000Z",
  });
  assert.deepEqual(record.candidateIdentity, executableStrategyIdentity(value));
  assert.equal(record.candidateId, candidateId(value));
  assert.equal(record.candidateIdentity.universe.snapshotSha256, undefined);
  assert.equal(record.candidateIdentity.perles["BTC-USDT-SWAP"].winRate, undefined);
});

test("le merge seeker preserve chaque candidat enrichi exact", () => {
  const validated = candidate();
  const sameDiscovery = JSON.parse(JSON.stringify(validated));
  sameDiscovery.horizonReports = [];
  sameDiscovery.validationStatus = "discovery-only";
  sameDiscovery.perles["BTC-USDT-SWAP"].winRate = 0.999;
  const otherValidated = candidate(0.002);
  otherValidated.params.lookback = 48;
  const otherId = candidateId(otherValidated);
  for (const horizon of otherValidated.horizonReports) horizon.candidateId = otherId;

  const merged = mergeCandidateCatalog({
    schemaVersion: 1,
    incumbentCandidateId: candidateId(validated),
    candidates: [validated, otherValidated],
  }, [sameDiscovery], { runId: "new-run", generatedAt: "2026-09-04T00:00:00.000Z" });
  assert.equal(merged.candidates.length, 2);
  assert.equal(merged.incumbentCandidateId, candidateId(validated));
  const exact = merged.candidates.find((row) => candidateId(row) === candidateId(validated));
  assert.equal(exact.horizonReports.length, 3);
  assert.equal(exact.validationStatus, undefined);
});

test("les rapports quantitatifs sont lies au candidat et a une politique unique", () => {
  const value = candidate();
  const wrongCandidate = structuredClone(value.horizonReports);
  wrongCandidate[1].candidateId = "f".repeat(64);
  const candidateVerdict = assessHorizonBundle(wrongCandidate, { expectedCandidateId: candidateId(value) });
  assert.equal(candidateVerdict.allowed, false);
  assert.ok(candidateVerdict.reasons.includes("candidate_id_quantitatif_absent_ou_multiple"));

  const wrongPolicy = structuredClone(value.horizonReports);
  wrongPolicy[2].quantPolicySha256 = "a".repeat(64);
  const policyVerdict = assessHorizonBundle(wrongPolicy, {
    expectedCandidateId: candidateId(value),
    expectedQuantPolicySha256: value.quantPolicySha256,
  });
  assert.equal(policyVerdict.allowed, false);
  assert.ok(policyVerdict.reasons.includes("politique_quantitative_absente_ou_multiple"));
});

test("les horizons 1/2/3 ans partagent obligatoirement le meme cutoff", () => {
  const bad = [report(365), report(730), report(1095, { cutoff: "2026-08-30T00:00:00.000Z" })];
  const verdict = assessHorizonBundle(bad);
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.reasons.includes("cutoffs_non_identiques"));
});

test("la validation complete 1/2/3 ans passe les gates preinscrits", () => {
  const verdict = assessHorizonBundle([report(365), report(730), report(1095)]);
  assert.equal(verdict.allowed, true, verdict.reasons.join(","));
});

test("la fenetre primaire doit contenir 1 095 jours OOS reels", () => {
  const verdict = assessHorizonBundle([
    report(365), report(730), report(1095, { oosDays: 1094 }),
  ]);
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.reasons.includes("1095j_oos_jours_insuffisants"));
});

test("une fenetre manquante ou un univers survivant est refuse", () => {
  const missing = assessHorizonBundle([report(365), report(1095)]);
  assert.ok(missing.reasons.includes("horizon_absent_730"));
  const biased = assessHorizonBundle([
    report(365), report(730, { pointInTimeUniverse: false }), report(1095),
  ]);
  assert.ok(biased.reasons.includes("730j_univers_non_point_in_time"));
});

test("le classement optimise la borne nette, jamais le win rate", () => {
  const weak = candidate(0.0004);
  weak.params.name = "weak-high-winrate";
  weak.winRate = 0.95;
  const strong = candidate(0.0012);
  strong.params.name = "strong-lower-bound";
  strong.winRate = 0.52;
  const ranked = rankCandidates([weak, strong]);
  assert.equal(ranked[0].candidate.params.name, "strong-lower-bound");
});

test("la machine autonome ne saute jamais validation et shadow", () => {
  const t0 = Date.parse("2026-09-04T00:00:00Z");
  let state = initialAutopilotState(t0);
  state = transitionAutopilot(state, {
    type: "PROMOTION_VERIFIED", liveGateAllowed: true, signedEvidenceVerified: true,
  }, { promotion: { automaticLiveApplication: true } }, t0 + 1);
  assert.equal(state.stage, STAGES.DISCOVERY);

  state = transitionAutopilot(state, { type: "CANDIDATE_SELECTED", candidateId: "abc" }, {}, t0 + 2);
  assert.equal(state.stage, STAGES.VALIDATION);
  state = transitionAutopilot(state, { type: "VALIDATION_COMPLETED", allowed: true }, {}, t0 + 3);
  assert.equal(state.stage, STAGES.SHADOW);
  state = transitionAutopilot(state, { type: "SHADOW_COMPLETED", allowed: true }, {}, t0 + 4);
  assert.equal(state.stage, STAGES.SHADOW);
  state = transitionAutopilot(state, {
    type: "SHADOW_COMPLETED", allowed: true, signedEvidenceVerified: true,
  }, {}, t0 + 5);
  assert.equal(state.stage, STAGES.ELIGIBLE);
  state = transitionAutopilot(state, {
    type: "PROMOTION_VERIFIED", liveGateAllowed: true, signedEvidenceVerified: true,
  }, { promotion: { automaticLiveApplication: true } }, t0 + 6);
  assert.equal(state.stage, STAGES.CANARY);
  state = transitionAutopilot(state, { type: "GATE_FAILED" }, {}, t0 + 7);
  assert.equal(state.stage, STAGES.QUARANTINED);
});

test("seul un candidat compatible avec le moteur live produit un roster", () => {
  const directional = candidate();
  const roster = buildCandidateRoster(directional, {
    selectionRunId: "run-1",
    dataManifestSha256: "a".repeat(64),
    generatedAt: "2026-09-04T00:00:00.000Z",
  });
  assert.equal(roster.universePolicy.topN, 30);
  assert.equal(Object.keys(roster.perles).length, 1);
  assert.throws(() => buildCandidateRoster({ ...directional, executionType: "spot-perpetual" }, {
    dataManifestSha256: "a".repeat(64),
  }), /non pris en charge/);
});

test("la promotion ecrit seulement un bundle signe qui passe le gate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-autopilot-"));
  try {
    writeImmutableEngineFixture(root);
    const now = Date.parse("2026-09-04T12:00:00Z");
    const roster = buildCandidateRoster(candidate(), {
      selectionRunId: "run-signed",
      dataManifestSha256: "b".repeat(64),
      generatedAt: new Date(now).toISOString(),
    });
    const keys = crypto.generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
    const expectedPublicKeySpkiSha256 = publicKeySpkiSha256(publicKey);
    const gatePolicy = {
      ...DEFAULT_POLICY,
      evidencePublicKeySpkiSha256: expectedPublicKeySpkiSha256,
    };
    const evidence = {
      schemaVersion: 1,
      decision: "approved",
      generatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 7 * 86400000).toISOString(),
      rosterSha256: rosterSha256(roster),
      quantEvidenceSha256: roster.quantEvidenceSha256,
      engineSha256: engineSha256(root, gatePolicy.engineFiles),
      metrics: approvedMetrics(),
      methodology: approvedMethodology(),
    };
    evidence.signature = crypto.sign(null, Buffer.from(evidenceSigningPayload(evidence)), keys.privateKey).toString("base64");
    const applied = applyPromotionBundle({
      root, roster, evidence, gatePolicy, publicKey, nowMs: now, expectedPublicKeySpkiSha256,
    });
    assert.equal(applied.applied, true, applied.verification.reasons.join(","));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "config", "approved-roster.json"))), roster);

    const tampered = { ...evidence, decision: "rejected" };
    const refused = applyPromotionBundle({
      root, roster, evidence: tampered, gatePolicy, publicKey, nowMs: now, expectedPublicKeySpkiSha256,
    });
    assert.equal(refused.applied, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("la quarantaine sauvegarde le champion et installe un roster vide", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-quarantine-"));
  try {
    const approved = path.join(root, "config", "approved-roster.json");
    fs.mkdirSync(path.dirname(approved), { recursive: true });
    fs.writeFileSync(approved, JSON.stringify({ perles: { BTC: {} } }));
    const result = quarantineApprovedRoster(root, "couts_derivent", Date.parse("2026-09-04T00:00:00Z"));
    assert.ok(result.backup && fs.existsSync(result.backup));
    const current = JSON.parse(fs.readFileSync(approved));
    assert.deepEqual(current.perles, {});
    assert.equal(current.quarantine.reason, "couts_derivent");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
