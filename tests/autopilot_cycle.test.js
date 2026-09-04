"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const A = require("../modules/autopilot.js");
const C = require("../modules/autopilot_cycle.js");
const {
  DEFAULT_POLICY,
  emptyMonitoringHighWater,
  engineSha256,
  evidenceSigningPayload,
  monitoringSigningPayload,
  publicKeySpkiSha256,
  rosterSha256,
} = require("../modules/live_safety.js");
const { parseArgs } = require("../deploy/autopilot_cycle.js");

const NOW = Date.parse("2026-09-04T12:00:00.000Z");

function report(horizonDays, lower99 = 0.001, overrides = {}) {
  return {
    horizonDays,
    quantEvidenceSha256: "d".repeat(64),
    quantPolicySha256: "e".repeat(64),
    candidateId: "c".repeat(64),
    cutoff: "2026-08-31T00:00:00.000Z",
    coverageRatio: 1,
    pointInTimeUniverse: true,
    includesDelistedInstruments: true,
    portfolioSynchronized: true,
    confirmedDataOnly: true,
    completeCostModel: true,
    folds: 12,
    oosTrades: 2000,
    oosDays: 1095,
    netMeanPerTrade: 0.003,
    netMeanLower95: 0.0015,
    netMeanLower99: lower99,
    costStressLower95: 0.0005,
    familywisePValue: 0.005,
    nullReplications: 10000,
    pbo: 0.05,
    deflatedSharpeProbability: 0.98,
    profitableFoldRate: 0.8,
    maxProfitConcentration: 0.2,
    calendarYearProfitConcentration: 0.5,
    instrumentProfitConcentration: 0.08,
    topFiveProfitConcentration: 0.4,
    independentBaskets: 150,
    effectiveDays: 300,
    maxDrawdownPct: 0.07,
    profitFactor: 1.3,
    expectedShortfall95: 0.02,
    costPerTrade: 0.0005,
    ...overrides,
  };
}

function directionalCandidate(name = "candidate", lower99 = 0.001) {
  const value = {
    schemaVersion: 1,
    family: "momentum",
    executionType: "directional-signal",
    params: { name, lookback: 24 },
    universe: { venue: "OKX", ranking: "absolute-return-24h", topN: 30 },
    horizonReports: [report(365), report(730), report(1095, lower99)],
    quantPolicySha256: "e".repeat(64),
    perles: {
      "BTC-USDT-SWAP": {
        sig: "roc_suit",
        ov: { tpPctMargin: 0.8, slPctMargin: 0.3, trailActPctMargin: 0.1, holdMs: 21600000 },
      },
    },
  };
  const id = A.candidateId(value);
  for (const horizon of value.horizonReports) horizon.candidateId = id;
  return value;
}

function carryCandidate() {
  const value = {
    schemaVersion: 1,
    family: "spot-perpetual-carry",
    executionType: "spot-perpetual",
    params: { holdingHours: 24 },
    universe: { venue: "OKX", ranking: "absolute-return-24h", topN: 30 },
    horizonReports: [report(365), report(730), report(1095)],
    quantPolicySha256: "e".repeat(64),
  };
  const id = A.candidateId(value);
  for (const horizon of value.horizonReports) horizon.candidateId = id;
  return value;
}

function policy() {
  return {
    backtest: { horizonsDays: [365, 730, 1095], primaryHorizonDays: 1095 },
    promotion: {
      automaticLiveApplication: true,
      minimumNetLowerBoundImprovement: 0,
      initialCanaryEquityPct: 0.01,
      maximumCanaryEquityPct: 0.01,
      automaticScaleUp: false,
    },
    demotion: {
      automatic: true,
      minimumTrades: 30,
      maximumMonitoringStalenessMinutes: 5,
      quarantineIfGateFails: true,
      quarantineIfNetLower95AtMost: 0,
      quarantineIfProfitFactorBelow: 1,
      quarantineIfCostRatioAbove: 0.8,
      quarantineIfTrackingErrorBpsAbove: 25,
    },
  };
}

function gatePolicy(evidencePublicKeySpkiSha256 = "a".repeat(64),
  monitoringPublicKeySpkiSha256 = "b".repeat(64)) {
  return {
    ...DEFAULT_POLICY,
    evidencePublicKeySpkiSha256,
    monitoringPublicKeySpkiSha256,
  };
}

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-cycle-"));
  for (const relative of DEFAULT_POLICY.engineFiles) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `fixture:${relative.replace(/\\/g, "/")}\n`);
  }
  return root;
}

function promotionFixture(root, candidate, keys, now = NOW) {
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  const expectedPublicKeySpkiSha256 = publicKeySpkiSha256(publicKey);
  const monitoringKeys = crypto.generateKeyPairSync("ed25519");
  const monitoringPublicKey = monitoringKeys.publicKey.export({ type: "spki", format: "pem" });
  const expectedMonitoringPublicKeySpkiSha256 = publicKeySpkiSha256(monitoringPublicKey);
  const liveGatePolicy = gatePolicy(
    expectedPublicKeySpkiSha256, expectedMonitoringPublicKeySpkiSha256,
  );
  const roster = A.buildCandidateRoster(candidate, {
    selectionRunId: "independent-run-1",
    dataManifestSha256: "a".repeat(64),
    generatedAt: new Date(now).toISOString(),
  });
  const evidence = {
    schemaVersion: 1,
    decision: "approved",
    generatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 7 * 86400000).toISOString(),
    rosterSha256: rosterSha256(roster),
    quantEvidenceSha256: roster.quantEvidenceSha256,
    engineSha256: engineSha256(root, liveGatePolicy.engineFiles),
    metrics: {
      oosTrades: 2000,
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
    },
    methodology: Object.fromEntries(DEFAULT_POLICY.requiredMethodology.map((name) => [name, true])),
  };
  evidence.signature = crypto.sign(null, Buffer.from(evidenceSigningPayload(evidence)), keys.privateKey).toString("base64");
  return {
    roster,
    evidence,
    liveGatePolicy,
    expectedPublicKeySpkiSha256,
    monitoringPublicKey,
    monitoringPrivateKey: monitoringKeys.privateKey,
    expectedMonitoringPublicKeySpkiSha256,
  };
}

function healthyMonitoring(bundle, candidate, now = NOW, sequence = 1) {
  const monitoring = {
    schemaVersion: 1,
    source: "okx-account-reconciliation-v1",
    sequence,
    candidateId: A.candidateId(candidate),
    rosterSha256: rosterSha256(bundle.roster),
    generatedAt: new Date(now).toISOString(),
    riskBreach: false,
    killSwitch: false,
    venueHealthy: true,
    trades: 0,
  };
  monitoring.signature = crypto.sign(
    null, Buffer.from(monitoringSigningPayload(monitoring)), bundle.monitoringPrivateKey,
  ).toString("base64");
  return monitoring;
}

function matureShadowState(candidate, now = NOW) {
  return {
    ...A.initialAutopilotState(now - 90 * 86400000),
    stage: A.STAGES.SHADOW,
    candidateId: A.candidateId(candidate),
    enteredAt: new Date(now - 90 * 86400000).toISOString(),
  };
}

test("un cycle sans les trois horizons refuse le candidat sans inventer de resultat", () => {
  const root = makeRoot();
  try {
    const candidate = directionalCandidate();
    candidate.horizonReports = [report(365), report(1095)];
    const result = C.runAutopilotCycle({
      root, nowMs: NOW, policy: policy(), gatePolicy: gatePolicy(),
      candidatesArtifact: { schemaVersion: 1, runId: "r1", candidates: [candidate] },
    });
    assert.equal(result.state.stage, A.STAGES.DISCOVERY);
    assert.ok(result.reasons.includes("aucun_candidat_admissible"));
    assert.equal(fs.existsSync(path.join(root, "config", "approved-roster.json")), false);
    assert.equal(result.trialRecords[0].accepted, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("un candidat valide avance discovery -> validation -> shadow sans traverser le shadow", () => {
  const root = makeRoot();
  try {
    const candidate = directionalCandidate();
    const result = C.runAutopilotCycle({
      root, nowMs: NOW, policy: policy(), gatePolicy: gatePolicy(),
      candidatesArtifact: { schemaVersion: 1, runId: "r2", candidates: [candidate] },
    });
    assert.equal(result.state.stage, A.STAGES.SHADOW);
    assert.deepEqual(result.actions.map((action) => action.type), ["CANDIDATE_SELECTED", "VALIDATION_ACCEPTED", "SHADOW_STARTED"]);
    assert.deepEqual(result.reasons, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("le carry reste shadow-only tant que l'executeur atomique deux jambes manque", () => {
  const root = makeRoot();
  try {
    const candidate = carryCandidate();
    const result = C.runAutopilotCycle({
      root, nowMs: NOW, policy: policy(), gatePolicy: gatePolicy(),
      state: matureShadowState(candidate),
      candidatesArtifact: { schemaVersion: 1, runId: "r3", candidates: [candidate] },
    });
    assert.equal(result.state.stage, A.STAGES.SHADOW);
    assert.ok(result.reasons.includes("carry_shadow_only_executeur_atomique_deux_jambes_absent"));
    assert.equal(result.actions.at(-1).type, "SHADOW_ONLY");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("seul le bundle exact signe Ed25519 avance eligible -> canary et est installe", () => {
  const root = makeRoot();
  try {
    const candidate = directionalCandidate();
    const keys = crypto.generateKeyPairSync("ed25519");
    const bundle = promotionFixture(root, candidate, keys);
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
    const result = C.runAutopilotCycle({
      root, nowMs: NOW, policy: policy(), gatePolicy: bundle.liveGatePolicy, publicKey,
      expectedPublicKeySpkiSha256: bundle.expectedPublicKeySpkiSha256,
      state: matureShadowState(candidate),
      candidatesArtifact: { schemaVersion: 1, runId: "r4", candidates: [candidate] },
      promotionBundle: bundle,
    });
    assert.equal(result.state.stage, A.STAGES.CANARY);
    assert.equal(result.state.championCandidateId, A.candidateId(candidate));
    assert.equal(result.state.canaryEquityPct, 0.01);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "config", "approved-roster.json"))), bundle.roster);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "data", "live-evidence.json"))), bundle.evidence);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("un bundle signe ne peut pas court-circuiter les 90 jours de shadow", () => {
  const root = makeRoot();
  try {
    const candidate = directionalCandidate();
    const keys = crypto.generateKeyPairSync("ed25519");
    const bundle = promotionFixture(root, candidate, keys);
    const result = C.runAutopilotCycle({
      root, nowMs: NOW, policy: policy(), gatePolicy: bundle.liveGatePolicy,
      publicKey: keys.publicKey.export({ type: "spki", format: "pem" }),
      expectedPublicKeySpkiSha256: bundle.expectedPublicKeySpkiSha256,
      state: {
        ...matureShadowState(candidate),
        enteredAt: new Date(NOW - 89 * 86400000).toISOString(),
      },
      candidatesArtifact: { schemaVersion: 1, runId: "r4-early", candidates: [candidate] },
      promotionBundle: bundle,
    });
    assert.equal(result.state.stage, A.STAGES.SHADOW);
    assert.ok(result.reasons.includes("shadow_duree_insuffisante"));
    assert.equal(fs.existsSync(path.join(root, "config", "approved-roster.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("une preuve signee pour un autre roster reste bloquee en shadow", () => {
  const root = makeRoot();
  try {
    const selected = directionalCandidate("selected");
    const other = directionalCandidate("other");
    const keys = crypto.generateKeyPairSync("ed25519");
    const bundle = promotionFixture(root, other, keys);
    const result = C.runAutopilotCycle({
      root, nowMs: NOW, policy: policy(), gatePolicy: bundle.liveGatePolicy,
      publicKey: keys.publicKey.export({ type: "spki", format: "pem" }),
      expectedPublicKeySpkiSha256: bundle.expectedPublicKeySpkiSha256,
      state: matureShadowState(selected),
      candidatesArtifact: { schemaVersion: 1, runId: "r5", candidates: [selected] },
      promotionBundle: bundle,
    });
    assert.equal(result.state.stage, A.STAGES.SHADOW);
    assert.ok(result.reasons.includes("roster_ne_correspond_pas_au_candidat"));
    assert.equal(fs.existsSync(path.join(root, "config", "approved-roster.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("le challenger doit ameliorer la borne prudente du champion", () => {
  const incumbent = directionalCandidate("incumbent", 0.001);
  const weak = directionalCandidate("weak", 0.0009);
  const strong = directionalCandidate("strong", 0.0015);
  const incumbentId = A.candidateId(incumbent);
  const base = {
    artifact: C.normaliseCandidateArtifact({ schemaVersion: 1, candidates: [incumbent, weak] }),
    state: { championCandidateId: incumbentId },
    installedRoster: null,
    policy: policy(),
  };
  assert.equal(C.selectChampionOrChallenger(base).selected, null);
  const choice = C.selectChampionOrChallenger({
    ...base,
    artifact: C.normaliseCandidateArtifact({ schemaVersion: 1, candidates: [incumbent, strong] }),
  });
  assert.equal(choice.selected.candidateId, A.candidateId(strong));
  assert.equal(choice.reason, "challenger_superieur");
});

test("un canary maintient le champion pendant le shadow puis applique seulement le challenger signe", () => {
  const root = makeRoot();
  try {
    const champion = directionalCandidate("champion", 0.001);
    const challenger = directionalCandidate("challenger", 0.0015);
    const keys = crypto.generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
    const championBundle = promotionFixture(root, champion, keys, NOW);
    const challengerBundle = promotionFixture(root, challenger, keys, NOW);
    const championId = A.candidateId(champion);
    const challengerId = A.candidateId(challenger);
    const state = {
      ...A.initialAutopilotState(NOW),
      stage: A.STAGES.CANARY,
      candidateId: championId,
      championCandidateId: championId,
      canaryEquityPct: 0.01,
    };
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(path.join(root, "config", "approved-roster.json"), JSON.stringify(championBundle.roster));
    fs.writeFileSync(path.join(root, "data", "live-evidence.json"), JSON.stringify(championBundle.evidence));

    const selected = C.runAutopilotCycle({
      root, nowMs: NOW, policy: policy(), gatePolicy: championBundle.liveGatePolicy,
      publicKey, expectedPublicKeySpkiSha256: championBundle.expectedPublicKeySpkiSha256,
      monitoringPublicKey: championBundle.monitoringPublicKey,
      expectedMonitoringPublicKeySpkiSha256: championBundle.expectedMonitoringPublicKeySpkiSha256,
      state,
      candidatesArtifact: { schemaVersion: 1, runId: "challenger-1", candidates: [champion, challenger] },
      installedRoster: championBundle.roster,
      installedEvidence: championBundle.evidence,
      monitoring: healthyMonitoring(championBundle, champion),
      monitoringHighWater: emptyMonitoringHighWater(),
    });
    assert.equal(selected.state.stage, A.STAGES.CANARY);
    assert.equal(selected.state.candidateId, championId);
    assert.equal(selected.state.championCandidateId, championId);
    assert.equal(selected.state.challenger.stage, A.STAGES.SHADOW);
    assert.equal(selected.state.challenger.candidateId, challengerId);
    assert.ok(selected.actions.some((action) => action.type === "CHALLENGER_SHADOW_STARTED"));
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "config", "approved-roster.json"))).strategyCandidateId, championId);

    selected.state.challenger.enteredAt = new Date(NOW - 91 * 86400000).toISOString();
    const promoted = C.runAutopilotCycle({
      root, nowMs: NOW, policy: policy(), gatePolicy: championBundle.liveGatePolicy,
      publicKey, expectedPublicKeySpkiSha256: championBundle.expectedPublicKeySpkiSha256,
      monitoringPublicKey: championBundle.monitoringPublicKey,
      expectedMonitoringPublicKeySpkiSha256: championBundle.expectedMonitoringPublicKeySpkiSha256,
      state: selected.state,
      candidatesArtifact: { schemaVersion: 1, runId: "challenger-2", candidates: [champion, challenger] },
      promotionBundle: challengerBundle,
      installedRoster: championBundle.roster,
      installedEvidence: championBundle.evidence,
      monitoring: healthyMonitoring(championBundle, champion),
      monitoringHighWater: emptyMonitoringHighWater(),
    });
    assert.equal(promoted.state.stage, A.STAGES.CANARY);
    assert.equal(promoted.state.candidateId, challengerId);
    assert.equal(promoted.state.championCandidateId, challengerId);
    assert.equal(promoted.state.challenger, null);
    assert.ok(promoted.actions.some((action) => action.type === "CHALLENGER_CANARY_APPLIED"));
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "config", "approved-roster.json"))).strategyCandidateId, challengerId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("un crash apres installation du challenger repare exactement son etat signe", () => {
  const root = makeRoot();
  try {
    const champion = directionalCandidate("champion-before-crash", 0.001);
    const challenger = directionalCandidate("challenger-installed", 0.0015);
    const keys = crypto.generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
    const installed = promotionFixture(root, challenger, keys, NOW);
    const championId = A.candidateId(champion);
    const challengerId = A.candidateId(challenger);
    const state = {
      ...A.initialAutopilotState(NOW - 91 * 86400000),
      stage: A.STAGES.CANARY,
      candidateId: championId,
      championCandidateId: championId,
      canaryEquityPct: 0.01,
      challenger: {
        ...A.initialAutopilotState(NOW - 91 * 86400000),
        stage: A.STAGES.ELIGIBLE,
        candidateId: challengerId,
        enteredAt: new Date(NOW - 91 * 86400000).toISOString(),
      },
    };
    const recovered = C.runAutopilotCycle({
      root, nowMs: NOW, policy: policy(), gatePolicy: installed.liveGatePolicy,
      publicKey, expectedPublicKeySpkiSha256: installed.expectedPublicKeySpkiSha256,
      monitoringPublicKey: installed.monitoringPublicKey,
      expectedMonitoringPublicKeySpkiSha256: installed.expectedMonitoringPublicKeySpkiSha256,
      state,
      candidatesArtifact: { schemaVersion: 1, runId: "crash-recovery", candidates: [champion, challenger] },
      installedRoster: installed.roster,
      installedEvidence: installed.evidence,
      monitoring: healthyMonitoring(installed, challenger),
      monitoringHighWater: emptyMonitoringHighWater(),
    });
    assert.equal(recovered.state.stage, A.STAGES.CANARY);
    assert.equal(recovered.state.candidateId, challengerId);
    assert.equal(recovered.state.championCandidateId, challengerId);
    assert.equal(recovered.state.challenger.stage, A.STAGES.DISCOVERY);
    assert.equal(recovered.state.challenger.candidateId, null);
    assert.ok(recovered.actions.some((action) => action.type === "CHALLENGER_PROMOTION_STATE_RECOVERED"));
    assert.ok(!recovered.actions.some((action) => action.type === "QUARANTINE_APPLIED"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("une degradation du canary sauvegarde le champion puis installe un roster vide", () => {
  const root = makeRoot();
  try {
    const candidate = directionalCandidate();
    const keys = crypto.generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
    const bundle = promotionFixture(root, candidate, keys);
    const first = C.runAutopilotCycle({
      root, nowMs: NOW, policy: policy(), gatePolicy: bundle.liveGatePolicy, publicKey,
      expectedPublicKeySpkiSha256: bundle.expectedPublicKeySpkiSha256,
      state: matureShadowState(candidate),
      candidatesArtifact: { schemaVersion: 1, runId: "r6", candidates: [candidate] },
      promotionBundle: bundle,
    });
    const monitoring = {
      schemaVersion: 1,
      source: "okx-account-reconciliation-v1",
      sequence: 1,
      candidateId: A.candidateId(candidate),
      rosterSha256: rosterSha256(bundle.roster),
      generatedAt: new Date(NOW + 3600e3).toISOString(),
      riskBreach: false,
      killSwitch: false,
      venueHealthy: true,
      trades: 40,
      netLower95: -0.001,
      profitFactor: 0.9,
      costRatio: 0.9,
      trackingErrorBps: 30,
    };
    monitoring.signature = crypto.sign(
      null, Buffer.from(monitoringSigningPayload(monitoring)), bundle.monitoringPrivateKey,
    ).toString("base64");
    const second = C.runAutopilotCycle({
      root, nowMs: NOW + 3600e3, policy: policy(), gatePolicy: bundle.liveGatePolicy, publicKey,
      expectedPublicKeySpkiSha256: bundle.expectedPublicKeySpkiSha256,
      monitoringPublicKey: bundle.monitoringPublicKey,
      expectedMonitoringPublicKeySpkiSha256: bundle.expectedMonitoringPublicKeySpkiSha256,
      state: first.state,
      candidatesArtifact: { schemaVersion: 1, runId: "r6", candidates: [candidate] },
      installedRoster: bundle.roster,
      installedEvidence: bundle.evidence,
      monitoring,
    });
    assert.equal(second.state.stage, A.STAGES.QUARANTINED);
    assert.equal(second.actions[0].type, "QUARANTINE_APPLIED");
    assert.ok(second.reasons.includes("borne_nette_degradee"));
    const quarantined = JSON.parse(fs.readFileSync(path.join(root, "config", "approved-roster.json")));
    assert.deepEqual(quarantined.perles, {});
    assert.ok(second.actions[0].backup && fs.existsSync(second.actions[0].backup));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("le monitoring de degradation exige les drapeaux de securite explicites", () => {
  const candidate = directionalCandidate("strict-monitoring");
  const candidateId = A.candidateId(candidate);
  const rosterHash = "b".repeat(64);
  const base = {
    schemaVersion: 1,
    source: "okx-account-reconciliation-v1",
    sequence: 1,
    candidateId,
    rosterSha256: rosterHash,
    generatedAt: new Date(NOW).toISOString(),
    trades: 0,
  };
  const security = { signatureVerified: true, expectedRosterSha256: rosterHash };
  const missing = C.evaluateDegradation(base, policy(), candidateId, NOW, null, security);
  assert.equal(missing.degraded, true);
  for (const reason of ["monitoring_riskBreach_absent", "monitoring_killSwitch_absent", "monitoring_venueHealthy_absent"]) {
    assert.ok(missing.reasons.includes(reason), reason);
  }
  const healthy = C.evaluateDegradation({
    ...base, riskBreach: false, killSwitch: false, venueHealthy: true,
  }, policy(), candidateId, NOW, null, security);
  assert.equal(healthy.degraded, false, healthy.reasons.join(","));
});

test("l'orchestrateur met en quarantaine un monitoring signe frais mais regressive", () => {
  const root = makeRoot();
  try {
    const candidate = directionalCandidate("monitor-replay");
    const candidateId = A.candidateId(candidate);
    const keys = crypto.generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
    const bundle = promotionFixture(root, candidate, keys);
    const state = {
      ...matureShadowState(candidate),
      stage: A.STAGES.CANARY,
      championCandidateId: candidateId,
      canaryEquityPct: 0.01,
    };
    const signedMonitoring = (sequence) => {
      const value = {
        schemaVersion: 1,
        source: "okx-account-reconciliation-v1",
        sequence,
        candidateId,
        rosterSha256: rosterSha256(bundle.roster),
        generatedAt: new Date(NOW).toISOString(),
        riskBreach: false,
        killSwitch: false,
        venueHealthy: true,
        trades: 0,
      };
      value.signature = crypto.sign(
        null, Buffer.from(monitoringSigningPayload(value)), bundle.monitoringPrivateKey,
      ).toString("base64");
      return value;
    };
    const first = C.runAutopilotCycle({
      root, nowMs: NOW, dryRun: true, policy: policy(), gatePolicy: bundle.liveGatePolicy,
      publicKey, expectedPublicKeySpkiSha256: bundle.expectedPublicKeySpkiSha256,
      monitoringPublicKey: bundle.monitoringPublicKey,
      expectedMonitoringPublicKeySpkiSha256: bundle.expectedMonitoringPublicKeySpkiSha256,
      state, candidatesArtifact: { schemaVersion: 1, runId: "replay", candidates: [candidate] },
      installedRoster: bundle.roster, installedEvidence: bundle.evidence,
      monitoring: signedMonitoring(7), monitoringHighWater: emptyMonitoringHighWater(),
    });
    const advanced = first.actions.find((action) => action.type === "ACTIVE_CHAMPION_HEALTHY")
      ?.monitoringReplay?.nextHighWater;
    assert.ok(advanced);

    const replay = C.runAutopilotCycle({
      root, nowMs: NOW, dryRun: true, policy: policy(), gatePolicy: bundle.liveGatePolicy,
      publicKey, expectedPublicKeySpkiSha256: bundle.expectedPublicKeySpkiSha256,
      monitoringPublicKey: bundle.monitoringPublicKey,
      expectedMonitoringPublicKeySpkiSha256: bundle.expectedMonitoringPublicKeySpkiSha256,
      state, candidatesArtifact: { schemaVersion: 1, runId: "replay", candidates: [candidate] },
      installedRoster: bundle.roster, installedEvidence: bundle.evidence,
      monitoring: signedMonitoring(6), monitoringHighWater: advanced,
    });
    assert.equal(replay.state.stage, A.STAGES.QUARANTINED);
    assert.ok(replay.reasons.includes("monitoring_sequence_regressive"));
    assert.equal(replay.actions[0].type, "QUARANTINE_WOULD_APPLY");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("le cycle fichier initialise le sentinel avant activation mais jamais avec un roster actif", () => {
  const root = makeRoot();
  try {
    fs.writeFileSync(path.join(root, "config", "autopilot.policy.json"), JSON.stringify(policy()));
    fs.writeFileSync(path.join(root, "config", "live-gate.policy.json"), JSON.stringify(gatePolicy()));
    const first = C.runCycleFromFiles({ root });
    const highWaterFile = path.join(root, "data", "autopilot", "monitoring-high-water.json");
    assert.deepEqual(JSON.parse(fs.readFileSync(highWaterFile, "utf8")), emptyMonitoringHighWater());

    const candidate = directionalCandidate("missing-checkpoint");
    const roster = A.buildCandidateRoster(candidate, {
      selectionRunId: "missing-checkpoint",
      dataManifestSha256: "a".repeat(64),
      generatedAt: new Date().toISOString(),
    });
    fs.writeFileSync(path.join(root, "config", "approved-roster.json"), JSON.stringify(roster));
    fs.unlinkSync(highWaterFile);
    const stateBefore = fs.readFileSync(first.files.state, "utf8");
    assert.throws(() => C.runCycleFromFiles({ root }), /high-water absent/);
    assert.equal(fs.existsSync(highWaterFile), false);
    assert.equal(fs.readFileSync(first.files.state, "utf8"), stateBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("une observation authentique avance le high-water meme si la preuve live a expire", () => {
  const root = makeRoot();
  try {
    const now = Date.now();
    const candidate = directionalCandidate("expired-evidence-monitor");
    const candidateId = A.candidateId(candidate);
    const keys = crypto.generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
    const bundle = promotionFixture(root, candidate, keys, now);
    bundle.evidence.expiresAt = new Date(now - 60_000).toISOString();
    const monitoring = {
      schemaVersion: 1,
      source: "okx-account-reconciliation-v1",
      sequence: 11,
      candidateId,
      rosterSha256: rosterSha256(bundle.roster),
      generatedAt: new Date(now).toISOString(),
      riskBreach: true,
      killSwitch: false,
      venueHealthy: true,
      trades: 0,
    };
    monitoring.signature = crypto.sign(
      null, Buffer.from(monitoringSigningPayload(monitoring)), bundle.monitoringPrivateKey,
    ).toString("base64");

    fs.mkdirSync(path.join(root, "data", "autopilot"), { recursive: true });
    fs.writeFileSync(path.join(root, "config", "autopilot.policy.json"), JSON.stringify(policy()));
    fs.writeFileSync(path.join(root, "config", "live-gate.policy.json"), JSON.stringify(bundle.liveGatePolicy));
    fs.writeFileSync(path.join(root, "config", "evidence-public-key.pem"), publicKey);
    fs.writeFileSync(path.join(root, "config", "monitoring-public-key.pem"), bundle.monitoringPublicKey);
    fs.writeFileSync(path.join(root, "config", "approved-roster.json"), JSON.stringify(bundle.roster));
    bundle.evidence.engineSha256 = engineSha256(root, bundle.liveGatePolicy.engineFiles);
    bundle.evidence.signature = crypto.sign(
      null, Buffer.from(evidenceSigningPayload(bundle.evidence)), keys.privateKey,
    ).toString("base64");
    fs.writeFileSync(path.join(root, "data", "live-evidence.json"), JSON.stringify(bundle.evidence));
    fs.writeFileSync(path.join(root, "data", "autopilot", "monitoring.json"), JSON.stringify(monitoring));
    fs.writeFileSync(path.join(root, "data", "autopilot", "monitoring-high-water.json"),
      JSON.stringify(emptyMonitoringHighWater()));

    const result = C.runCycleFromFiles({
      root,
      expectedPublicKeySpkiSha256: bundle.expectedPublicKeySpkiSha256,
      expectedMonitoringPublicKeySpkiSha256: bundle.expectedMonitoringPublicKeySpkiSha256,
    });
    assert.equal(result.state.stage, A.STAGES.QUARANTINED);
    const persisted = JSON.parse(fs.readFileSync(
      path.join(root, "data", "autopilot", "monitoring-high-water.json"), "utf8",
    ));
    const entry = Object.values(persisted.entries)[0];
    assert.equal(entry.sequence, 11);
    assert.equal(entry.candidateId, candidateId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("l'orchestrateur refuse toute cle privee et le CLI rejette les arguments ambigus", () => {
  assert.throws(() => C.assertPublicKeyOnly("-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----"), /interdite/);
  assert.equal(C.canaryEnvelope(policy()).valid, true);
  assert.deepEqual(C.canaryEnvelope({ promotion: { initialCanaryEquityPct: 0.10, maximumCanaryEquityPct: 0.05 } }).reasons,
    ["plafond_canary_initial_invalide"]);
  assert.throws(() => parseArgs(["--bundle"]), /valeur absente/);
  assert.throws(() => parseArgs(["--execute-orders"]), /argument inconnu/);
  assert.equal(parseArgs(["--monitoring-public-key", "monitor.pem"]).monitoringPublicKey, "monitor.pem");
  assert.throws(() => parseArgs(["--now", "2026-12-04T12:00:00Z"]), /dry-run/);
  const args = parseArgs(["--dry-run", "--now", "2026-09-04T12:00:00Z"]);
  assert.equal(args.dryRun, true);
  assert.equal(args.nowMs, NOW);
});

test("un nowMs injecte ne peut ni ecrire l'etat ni promouvoir en mode mutatif", () => {
  const root = makeRoot();
  try {
    const candidate = directionalCandidate("clock-bypass");
    const keys = crypto.generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
    const fingerprint = publicKeySpkiSha256(publicKey);
    const autopilotPolicy = policy();
    const liveGatePolicy = gatePolicy(fingerprint);
    fs.writeFileSync(path.join(root, "config", "autopilot.policy.json"), JSON.stringify(autopilotPolicy));
    fs.writeFileSync(path.join(root, "config", "live-gate.policy.json"), JSON.stringify(liveGatePolicy));

    const forgedNow = NOW + 100 * 86400000;
    const bundle = promotionFixture(root, candidate, keys, forgedNow);
    const stateFile = path.join(root, "data", "autopilot", "state.json");
    const candidatesFile = path.join(root, "data", "autopilot", "candidates.json");
    const bundleFile = path.join(root, "data", "autopilot", "promotion-bundle.json");
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const state = {
      ...matureShadowState(candidate, NOW),
      enteredAt: new Date(NOW).toISOString(),
    };
    fs.writeFileSync(stateFile, JSON.stringify(state));
    fs.writeFileSync(candidatesFile, JSON.stringify({ schemaVersion: 1, runId: "clock-run", candidates: [candidate] }));
    fs.writeFileSync(bundleFile, JSON.stringify(bundle));
    fs.writeFileSync(path.join(root, "config", "evidence-public-key.pem"), publicKey);
    const stateBefore = fs.readFileSync(stateFile, "utf8");

    assert.throws(() => C.runCycleFromFiles({ root, nowMs: forgedNow }), /dry-run/);
    assert.equal(fs.readFileSync(stateFile, "utf8"), stateBefore);
    assert.equal(fs.existsSync(path.join(root, "config", "approved-roster.json")), false);
    assert.equal(fs.existsSync(path.join(root, "data", "live-evidence.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
