"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  DEFAULT_POLICY,
  OkxBusinessError,
  assertOkxSuccess,
  quantityToLotString,
  computePositionSizing,
  effectiveStopLossMarginPct,
  makerOrderDirective,
  evaluateEntryStopRisk,
  evaluateEntryMarginBudget,
  validateRiskConfig,
  hermesAlgoOwnerNamespace,
  newHermesClientId,
  isHermesOwnedAlgo,
  isProtectiveStopAlgo,
  stableStringify,
  evidenceSigningPayload,
  monitoringSigningPayload,
  verifyEvidenceSignature,
  verifyMonitoringSignature,
  evaluateSignedMonitoring,
  emptyMonitoringHighWater,
  evaluateMonitoringReplay,
  publicKeySpkiSha256,
  normaliseLiveGatePolicy,
  evaluateAutopilotCanaryAuthority,
  rosterSha256,
  evaluateLiveGate,
} = require("../modules/live_safety.js");

const TEST_TRUST_ANCHOR = "f".repeat(64);
const TEST_TRUST_ARGS = Object.freeze({
  policy: {
    evidencePublicKeySpkiSha256: TEST_TRUST_ANCHOR,
    monitoringPublicKeySpkiSha256: "e".repeat(64),
  },
  evidencePublicKeySpkiSha256: TEST_TRUST_ANCHOR,
  expectedPublicKeySpkiSha256: TEST_TRUST_ANCHOR,
});

function monitoringTrustArgs(publicKey, evidenceAnchor = "e".repeat(64)) {
  const monitoringAnchor = publicKeySpkiSha256(publicKey);
  return {
    policyPublicKeySpkiSha256: monitoringAnchor,
    expectedPublicKeySpkiSha256: monitoringAnchor,
    evidencePublicKeySpkiSha256: evidenceAnchor,
  };
}

test("maker: le premier fill partiel annule et protege sans attendre le timeout", () => {
  let state = { cancelRequested: false, protectedQty: 0 };
  const first = makerOrderDirective({ state: "partially_filled", accFillSz: "0.2" }, state);
  assert.equal(first.requestCancel, true);
  assert.equal(first.protectQty, 0.2);
  assert.equal(first.terminal, false);

  state = { cancelRequested: true, protectedQty: 0.2 };
  const growing = makerOrderDirective({ state: "partially_filled", accFillSz: "0.3" }, state);
  assert.equal(growing.requestCancel, false);
  assert.ok(Math.abs(growing.protectQty - 0.1) < 1e-12);

  state = { cancelRequested: true, protectedQty: 0.3 };
  const canceled = makerOrderDirective({ state: "canceled", accFillSz: "0.3" }, state);
  assert.equal(canceled.terminal, true);
  assert.equal(canceled.filled, false);
  assert.ok(canceled.protectQty < 1e-12);

  const mmpCanceled = makerOrderDirective({ state:"mmp_canceled", accFillSz:"0.3" }, state);
  assert.equal(mmpCanceled.terminal, true);
  assert.equal(mmpCanceled.filledQty, 0.3);

  for (const incomplete of [
    { state:"filled" },
    { state:"filled", accFillSz:"0" },
    { state:"canceled" },
  ]) {
    const directive = makerOrderDirective(incomplete, state);
    assert.equal(directive.terminal, false);
    assert.equal(directive.inconsistent, true);
  }
});

test("market: le prix rempli ne peut pas eloigner le stop au-dela du budget", () => {
  const ok = evaluateEntryStopRisk({
    side:"long", entryPx:100, stopPx:99, qty:5, contractValue:1,
    equity:1000, riskPct:0.005, tickSize:0.01,
  });
  assert.equal(ok.allowed, true);
  assert.equal(ok.plannedLoss, 5);

  const slipped = evaluateEntryStopRisk({
    side:"long", entryPx:102, stopPx:99, qty:5, contractValue:1,
    equity:1000, riskPct:0.005, tickSize:0.01,
  });
  assert.equal(slipped.allowed, false);
  assert.equal(slipped.correctSide, true);
  assert.equal(evaluateEntryStopRisk({
    side:"short", entryPx:100, stopPx:99, qty:1, contractValue:1,
    equity:1000, riskPct:0.005,
  }).allowed, false);
  assert.equal(evaluateEntryStopRisk({
    side:"long", entryPx:100.9, stopPx:100, qty:5, contractValue:1,
    equity:400, riskPct:0.005, tickSize:1,
  }).allowed, false);
});

test("ownership algo: namespace stable, IDs uniques et annulation strictement attribuee", () => {
  const owner = "vps-production-a";
  const id1 = newHermesClientId("oco", owner);
  const id2 = newHermesClientId("oco", owner);
  assert.match(id1, /^[A-Za-z0-9]{1,32}$/);
  assert.notEqual(id1, id2);
  assert.ok(id1.startsWith(hermesAlgoOwnerNamespace(owner)));
  assert.equal(isHermesOwnedAlgo({ algoClOrdId: id1 }, owner), true);
  assert.equal(isHermesOwnedAlgo({ attachAlgoClOrdId: newHermesClientId("attach", owner) }, owner), true);
  assert.equal(isHermesOwnedAlgo({ algoClOrdId: newHermesClientId("entry", owner) }, owner), false);
  assert.equal(isHermesOwnedAlgo({ algoClOrdId: id1 }, "autre-instance"), false);
  assert.equal(isHermesOwnedAlgo({ algoClOrdId: id1 }, ""), false);
});

test("protection: un TP/ordre d'entree ne peut pas se faire passer pour un stop", () => {
  const context = { positionSide:"long", entryPx:100, hedgeMode:false };
  assert.equal(isProtectiveStopAlgo({ ordType:"oco", side:"sell", slTriggerPx:"97", sz:"100" }, context), true);
  assert.equal(isProtectiveStopAlgo({ ordType:"trigger", side:"sell", triggerPx:"97", reduceOnly:true }, context), true);
  assert.equal(isProtectiveStopAlgo({ ordType:"trigger", side:"buy", triggerPx:"97", reduceOnly:false }, context), false);
  assert.equal(isProtectiveStopAlgo({ ordType:"trigger", side:"sell", triggerPx:"103", reduceOnly:true }, context), false);
  assert.equal(isProtectiveStopAlgo({ ordType:"conditional", side:"sell", tpTriggerPx:"103", sz:"100" }, context), false);
});

test("preuve: signature Ed25519 couvre tout le contenu", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const evidence = { schemaVersion: 1, decision: "approved", metrics: { net: 1 } };
  evidence.signature = crypto.sign(null, Buffer.from(evidenceSigningPayload(evidence)), privateKey).toString("base64");
  assert.equal(verifyEvidenceSignature(evidence, publicKey), true);
  evidence.metrics.net = -1;
  assert.equal(verifyEvidenceSignature(evidence, publicKey), false);
});

test("signatures: les domaines preuve live et monitoring ne sont jamais interchangeables", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const artifact = { schemaVersion: 1, decision: "approved", sequence: 7 };
  const asMonitoring = {
    ...artifact,
    signature: crypto.sign(
      null, Buffer.from(monitoringSigningPayload(artifact)), privateKey,
    ).toString("base64"),
  };
  assert.equal(verifyMonitoringSignature(asMonitoring, publicKey), true);
  assert.equal(verifyEvidenceSignature(asMonitoring, publicKey), false);

  const asEvidence = {
    ...artifact,
    signature: crypto.sign(
      null, Buffer.from(evidenceSigningPayload(artifact)), privateKey,
    ).toString("base64"),
  };
  assert.equal(verifyEvidenceSignature(asEvidence, publicKey), true);
  assert.equal(verifyMonitoringSignature(asEvidence, publicKey), false);

  const legacyUnsigned = { ...artifact };
  const legacy = {
    ...artifact,
    signature: crypto.sign(
      null, Buffer.from(stableStringify(legacyUnsigned)), privateKey,
    ).toString("base64"),
  };
  assert.equal(verifyEvidenceSignature(legacy, publicKey), false);
  assert.equal(verifyMonitoringSignature(legacy, publicKey), false);
});

test("monitoring canary: signature, roster et TTL cinq minutes sont obligatoires", () => {
  const keys = crypto.generateKeyPairSync("ed25519");
  const roster = { strategyCandidateId: "a".repeat(64), perles: { BTC: {} } };
  const now = Date.parse("2026-09-04T12:00:00.000Z");
  const monitoring = {
    schemaVersion: 1,
    source: "okx-account-reconciliation-v1",
    sequence: 7,
    candidateId: roster.strategyCandidateId,
    rosterSha256: rosterSha256(roster),
    generatedAt: new Date(now - 60_000).toISOString(),
    trades: 10,
    riskBreach: false,
    killSwitch: false,
    venueHealthy: true,
  };
  monitoring.signature = crypto.sign(
    null, Buffer.from(monitoringSigningPayload(monitoring)), keys.privateKey,
  ).toString("base64");
  const valid = evaluateSignedMonitoring({
    ...monitoringTrustArgs(keys.publicKey),
    monitoring, roster, publicKey: keys.publicKey, nowMs: now,
    autopilotPolicy: { demotion: { maximumMonitoringStalenessMinutes: 5 } },
  });
  assert.equal(valid.allowed, true, valid.reasons.join(","));
  const reusedEvidenceKey = evaluateSignedMonitoring({
    ...monitoringTrustArgs(keys.publicKey, publicKeySpkiSha256(keys.publicKey)),
    monitoring, roster, publicKey: keys.publicKey, nowMs: now,
  });
  assert.equal(reusedEvidenceKey.allowed, false);
  assert.ok(reusedEvidenceKey.reasons.includes("monitoring_cle_non_distincte"));
  assert.equal(reusedEvidenceKey.replayEligible, false);
  const stale = evaluateSignedMonitoring({
    ...monitoringTrustArgs(keys.publicKey),
    monitoring, roster, publicKey: keys.publicKey, nowMs: now + 6 * 60_000,
  });
  assert.equal(stale.allowed, false);
  assert.ok(stale.reasons.includes("monitoring_perime_ou_futur"));
  const tampered = evaluateSignedMonitoring({
    ...monitoringTrustArgs(keys.publicKey),
    monitoring: { ...monitoring, sequence: 8 }, roster,
    publicKey: keys.publicKey, nowMs: now,
  });
  assert.equal(tampered.allowed, false);
  assert.ok(tampered.reasons.includes("monitoring_signature_invalide"));
});

test("anti-rejeu monitoring: high-water monotone, idempotent et sensible aux collisions", () => {
  const keys = crypto.generateKeyPairSync("ed25519");
  const roster = { strategyCandidateId: "b".repeat(64), perles: { BTC: {} } };
  const now = Date.parse("2026-09-04T12:00:00.000Z");
  const signedMonitoring = (sequence, overrides = {}) => {
    const monitoring = {
      schemaVersion: 1,
      source: "okx-account-reconciliation-v1",
      sequence,
      candidateId: roster.strategyCandidateId,
      rosterSha256: rosterSha256(roster),
      generatedAt: new Date(now - 30_000).toISOString(),
      trades: 40,
      riskBreach: false,
      killSwitch: false,
      venueHealthy: true,
      netLower95: 0.001,
      profitFactor: 1.2,
      costRatio: 0.2,
      trackingErrorBps: 5,
      ...overrides,
    };
    monitoring.signature = crypto.sign(
      null, Buffer.from(monitoringSigningPayload(monitoring)), keys.privateKey,
    ).toString("base64");
    return monitoring;
  };
  const gateFor = (monitoring) => evaluateSignedMonitoring({
    ...monitoringTrustArgs(keys.publicKey),
    monitoring, roster, publicKey: keys.publicKey, nowMs: now,
  });

  const firstGate = gateFor(signedMonitoring(7));
  const first = evaluateMonitoringReplay({
    monitoringGate: firstGate, highWater: emptyMonitoringHighWater(),
  });
  assert.equal(first.allowed, true, first.reasons.join(","));
  assert.equal(first.shouldAdvance, true);
  assert.equal(first.nextHighWater.entries[first.identityKey].sequence, 7);

  const repeated = evaluateMonitoringReplay({
    monitoringGate: firstGate, highWater: first.nextHighWater,
  });
  assert.equal(repeated.allowed, true);
  assert.equal(repeated.shouldAdvance, false);

  /* Le changement de candidat/roster ne cree plus un nouveau compteur : un
     ancien bundle signe ne peut donc pas reinitialiser la sequence. */
  const otherPair = evaluateMonitoringReplay({
    monitoringGate: {
      ...firstGate,
      candidateId: "c".repeat(64),
      rosterSha256: "d".repeat(64),
      sequence: 1,
      monitoringSha256: "e".repeat(64),
      replayEligible: true,
    },
    highWater: first.nextHighWater,
  });
  assert.equal(otherPair.allowed, false);
  assert.equal(otherPair.shouldAdvance, false);
  assert.ok(otherPair.reasons.includes("monitoring_sequence_regressive"));

  const otherSigner = crypto.generateKeyPairSync("ed25519");
  const otherSignerMonitoring = signedMonitoring(1);
  otherSignerMonitoring.signature = crypto.sign(
    null, Buffer.from(monitoringSigningPayload(otherSignerMonitoring)), otherSigner.privateKey,
  ).toString("base64");
  const otherSignerGate = evaluateSignedMonitoring({
    ...monitoringTrustArgs(otherSigner.publicKey),
    monitoring: otherSignerMonitoring, roster, publicKey: otherSigner.publicKey, nowMs: now,
  });
  const isolatedAuthority = evaluateMonitoringReplay({
    monitoringGate: otherSignerGate, highWater: first.nextHighWater,
  });
  assert.equal(isolatedAuthority.allowed, true, isolatedAuthority.reasons.join(","));
  assert.equal(isolatedAuthority.shouldAdvance, true);
  assert.equal(Object.keys(isolatedAuthority.nextHighWater.entries).length, 2);
  assert.equal(isolatedAuthority.nextHighWater.entries[first.identityKey].sequence, 7);

  const regressive = evaluateMonitoringReplay({
    monitoringGate: gateFor(signedMonitoring(6)), highWater: first.nextHighWater,
  });
  assert.equal(regressive.allowed, false);
  assert.ok(regressive.reasons.includes("monitoring_sequence_regressive"));

  const collision = evaluateMonitoringReplay({
    monitoringGate: gateFor(signedMonitoring(7, { trades: 41 })),
    highWater: first.nextHighWater,
  });
  assert.equal(collision.allowed, false);
  assert.ok(collision.reasons.includes("monitoring_sequence_collision"));

  const unhealthyGate = gateFor(signedMonitoring(8, { riskBreach: true }));
  assert.equal(unhealthyGate.allowed, false);
  assert.ok(unhealthyGate.reasons.includes("monitoring_risque_explicite"));
  const unhealthy = evaluateMonitoringReplay({
    monitoringGate: unhealthyGate, highWater: first.nextHighWater,
  });
  assert.equal(unhealthy.allowed, true, unhealthy.reasons.join(","));
  assert.equal(unhealthy.shouldAdvance, true);
  assert.equal(unhealthy.nextHighWater.entries[unhealthy.identityKey].sequence, 8);
  const restoredOldHealthy = evaluateMonitoringReplay({
    monitoringGate: firstGate, highWater: unhealthy.nextHighWater,
  });
  assert.equal(restoredOldHealthy.allowed, false);
  assert.ok(restoredOldHealthy.reasons.includes("monitoring_sequence_regressive"));

  const corruptState = evaluateMonitoringReplay({
    monitoringGate: firstGate,
    highWater: { schemaVersion: 1, entries: { invalid: { sequence: 999 } } },
  });
  assert.equal(corruptState.allowed, false);
  assert.ok(corruptState.reasons.includes("monitoring_high_water_entree_invalide"));
});

test("gate live: la politique locale ne peut ni desactiver la signature ni assouplir les invariants", () => {
  const relaxed = normaliseLiveGatePolicy({
    requireEvidenceSignature: false,
    minOosTrades: 0,
    maxDrawdownPct: 1,
    engineFiles: [],
    requiredMethodology: [],
  });
  assert.equal(relaxed.policy.requireEvidenceSignature, true);
  assert.equal(relaxed.policy.minOosTrades, DEFAULT_POLICY.minOosTrades);
  assert.equal(relaxed.policy.maxDrawdownPct, DEFAULT_POLICY.maxDrawdownPct);
  assert.ok(relaxed.policy.engineFiles.includes("config/live-gate.policy.json"));
  assert.ok(relaxed.reasons.includes("politique_signature_desactivee"));
  assert.ok(relaxed.reasons.includes("politique_assouplie_minOosTrades"));
  const sharedKey = normaliseLiveGatePolicy({
    evidencePublicKeySpkiSha256: "a".repeat(64),
    monitoringPublicKeySpkiSha256: "a".repeat(64),
  });
  assert.ok(sharedKey.reasons.includes("politique_cles_signature_non_distinctes"));
});

test("gate live: l'empreinte SPKI Ed25519 doit correspondre a la policy et au deploiement", () => {
  const keys = crypto.generateKeyPairSync("ed25519");
  const fingerprint = publicKeySpkiSha256(keys.publicKey);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  const { now, roster, evidence } = validFixture();
  const status = evaluateLiveGate({
    policy: { evidencePublicKeySpkiSha256: fingerprint },
    evidencePublicKeySpkiSha256: fingerprint,
    expectedPublicKeySpkiSha256: "0".repeat(64),
    roster, evidence, nowMs: now, expectedEngineSha256: "engine-hash",
    evidenceSignatureVerified: true,
  });
  assert.equal(status.allowed, false);
  assert.ok(status.reasons.includes("ancre_confiance_politique_differente"));
  assert.ok(status.reasons.includes("cle_publique_deploiement_differente"));
});

test("OKX: un code global non nul est un echec", () => {
  assert.throws(
    () => assertOkxSuccess({ code: "50011", msg: "rate limit", data: [] }, "GET balance"),
    (error) => error instanceof OkxBusinessError && error.okxCode === "50011"
  );
});

test("OKX: un sCode refuse ne devient jamais un ordre accepte", () => {
  assert.throws(
    () => assertOkxSuccess({ code: "0", data: [{ ordId: "", sCode: "51121", sMsg: "bad lot" }] }, "POST order"),
    (error) => error instanceof OkxBusinessError && error.okxCode === "51121"
  );
});

test("OKX: code et sCode a zero passent", () => {
  const payload = { code: "0", data: [{ ordId: "42", sCode: "0", sMsg: "" }] };
  assert.equal(assertOkxSuccess(payload, "POST order"), payload);
});

test("taille: la chaine envoyee est un multiple decimal exact", () => {
  assert.equal(quantityToLotString(0.6061, "0.1", "0.1"), "0.6");
  assert.equal(quantityToLotString(28.9, "0.1", "0.1"), "28.9");
  assert.equal(quantityToLotString(0.00000039, "1e-8", "1e-8"), "0.00000039");
  assert.equal(quantityToLotString(0.02, "0.1", "0.1"), "0.1");
  assert.equal(quantityToLotString(5, "0", "0"), "0");
});

test("risque: la taille derive de la perte au stop, pas de 90 % de marge", () => {
  const sized = computePositionSizing({
    equity: 1000, maxMarginPct: 0.25, riskPerTradePct: 0.005,
    stopLossMarginPct: 0.30, places: 3, maxPositions: 3,
    minMargin: 3, maxMargin: 200,
  });
  assert.equal(sized.maxPositions, 3);
  assert.ok(Math.abs(sized.perTradeUSDT * 0.30 - 5) < 1e-9);
  assert.ok(sized.perTradeUSDT * 3 <= 250);
});

test("risque: un petit compte n'est pas gonfle au plancher en violant le budget", () => {
  const sized = computePositionSizing({
    equity: 10, maxMarginPct: 0.25, riskPerTradePct: 0.005,
    stopLossMarginPct: 0.30, places: 3, maxPositions: 3,
    minMargin: 3, maxMargin: 200,
  });
  assert.equal(sized.perTradeUSDT, 0);
  assert.equal(sized.maxPositions, 0);
});

test("risque: le sizing respecte le stop effectif valide du roster", () => {
  const equity = 1000;
  const riskPerTradePct = 0.005;
  const effectiveStop = effectiveStopLossMarginPct({ slPctMargin: 0.80 }, 0.30);
  const sized = computePositionSizing({
    equity, maxMarginPct: 0.25, riskPerTradePct,
    stopLossMarginPct: effectiveStop, places: 3, maxPositions: 3,
    minMargin: 3, maxMargin: 200,
  });
  assert.ok(sized.perTradeUSDT * effectiveStop <= equity * riskPerTradePct);
  assert.equal(effectiveStopLossMarginPct({}, 0.30), 0.30);
  assert.throws(() => effectiveStopLossMarginPct({ slPctMargin: 0 }, 0.30), /slPctMargin/);
  assert.throws(() => effectiveStopLossMarginPct({ slPctMargin: 1.01 }, 0.30), /slPctMargin/);
  assert.throws(() => effectiveStopLossMarginPct({ slPctMargin: "0.30" }, 0.30), /slPctMargin/);
});

test("risque: un gap du fallback market est recontrole au nouveau prix long et short", () => {
  const common = { qty: 5, contractValue: 1, equity: 1000, riskPct: 0.01, tickSize: 0.01 };
  assert.equal(evaluateEntryStopRisk({ ...common, side: "long", entryPx: 100, stopPx: 98 }).allowed, true);
  assert.equal(evaluateEntryStopRisk({ ...common, side: "long", entryPx: 120, stopPx: 117.6 }).allowed, false);
  assert.equal(evaluateEntryStopRisk({ ...common, side: "short", entryPx: 100, stopPx: 102 }).allowed, true);
  assert.equal(evaluateEntryStopRisk({ ...common, side: "short", entryPx: 120, stopPx: 122.4 }).allowed, false);
});

test("risque: un gap du fallback market ne peut depasser la reservation ni le canary", () => {
  const common = {
    qty: 0.5,
    contractValue: 1,
    leverage: 15,
    reservedMargin: 100 * 0.5 / 15,
    perTradeMargin: 10 / 3,
    totalUsedMargin: 10,
    totalMarginBudget: 10,
  };
  const planned = evaluateEntryMarginBudget({ ...common, entryPx: 100 });
  assert.equal(planned.allowed, true);
  assert.equal(planned.totalMarginAtQuote, 10);

  const gap = evaluateEntryMarginBudget({ ...common, entryPx: 120 });
  assert.equal(gap.allowed, false);
  assert.equal(gap.exactMargin, 4);
  assert.ok(gap.reasons.includes("marge_cotation_depasse_reservation"));
  assert.ok(gap.reasons.includes("marge_cotation_depasse_par_trade"));
  assert.ok(gap.reasons.includes("marge_cotation_depasse_budget_total"));
});

test("risque: le fill reel peut violer le canary sans violer le stop et doit etre refuse", () => {
  const reservedMargin = 100 * 0.49 / 15;
  const commonMargin = {
    qty: 0.49,
    contractValue: 1,
    leverage: 15,
    reservedMargin,
    perTradeMargin: 10 / 3,
    totalUsedMargin: (20 / 3) + reservedMargin,
    totalMarginBudget: 10,
  };
  const quote = evaluateEntryMarginBudget({ ...commonMargin, entryPx: 100 });
  assert.equal(quote.allowed, true, quote.reasons.join(","));

  const fill = evaluateEntryMarginBudget({ ...commonMargin, entryPx: 107 });
  assert.equal(fill.allowed, false);
  assert.ok(fill.totalMarginAtQuote > 10);
  assert.ok(fill.reasons.includes("marge_cotation_depasse_reservation"));
  assert.ok(fill.reasons.includes("marge_cotation_depasse_par_trade"));
  assert.ok(fill.reasons.includes("marge_cotation_depasse_budget_total"));

  const stop = evaluateEntryStopRisk({
    side: "long", entryPx: 107, stopPx: 98, qty: 0.49,
    contractValue: 1, equity: 1000, riskPct: 0.005, tickSize: 0.01,
  });
  assert.equal(stop.allowed, true);
  assert.ok(stop.plannedLoss <= stop.budget);
});

test("risque: NaN et assouplissements au-dela des plafonds arretent le boot", () => {
  const base = { maxPositions:3, leverage:15, maxMarginPct:0.25, riskPerTradePct:0.005,
    maxDrawdownPct:0.10, maxDailyLossPct:0.02, stopLossMarginPct:0.30,
    sameSideFull:2, correlationScale:0.6 };
  assert.deepEqual(validateRiskConfig(base), base);
  assert.throws(() => validateRiskConfig({ ...base, maxDrawdownPct:"NaN" }), /maxDrawdownPct/);
  assert.throws(() => validateRiskConfig({ ...base, maxMarginPct:0.90 }), /maxMarginPct/);
  assert.throws(() => validateRiskConfig({ ...base, maxPositions:4 }), /maxPositions/);
  assert.throws(() => validateRiskConfig({ ...base, correlationScale:60 }), /correlationScale/);
});

function validFixture() {
  const now = Date.parse("2026-09-04T12:00:00.000Z");
  const roster = {
    schemaVersion: 1,
    genere: "2026-09-04T10:00:00.000Z",
    selectionRunId: "ci-run-123",
    dataManifestSha256: "a".repeat(64),
    quantEvidenceSha256: "d".repeat(64),
    strategyCandidateId: "c".repeat(64),
    perles: { "BTC-USDT-SWAP": { sig: "example", ov: { holdMs: 3600000 } } },
  };
  const methodology = Object.fromEntries(DEFAULT_POLICY.requiredMethodology.map((name) => [name, true]));
  const evidence = {
    schemaVersion: 1,
    decision: "approved",
    generatedAt: "2026-09-04T11:00:00.000Z",
    expiresAt: "2026-09-20T00:00:00.000Z",
    rosterSha256: rosterSha256(roster),
    quantEvidenceSha256: roster.quantEvidenceSha256,
    engineSha256: "engine-hash",
    metrics: {
      oosTrades: 2000, oosDays: 1095,
      netMeanPerTrade: 0.02, netMeanLower99: 0.004, costStressLower95: 0.002,
      familywisePValue: 0.005, nullReplications: 9999,
      pbo: 0.05, deflatedSharpeProbability: 0.98,
      spaPValue: 0.02, whiteRealityCheckPValue: 0.03,
      profitableFoldRate: 0.8, maxProfitConcentration: 0.2,
      effectiveDays: 400, independentBaskets: 140,
      calendarYearProfitConcentration: 0.50,
      instrumentProfitConcentration: 0.08,
      topFiveProfitConcentration: 0.40,
      maxDrawdownPct: 0.08, profitFactor: 1.25,
      shadowLiveDays: 90, shadowLiveTrades: 150, shadowLiveNet: 1.2,
      validatedHorizonsDays: [365, 730, 1095], primaryHorizonDays: 1095,
    },
    methodology,
  };
  return { now, roster, evidence };
}

test("gate live: une preuve complete, fraiche et liee au code est acceptee", () => {
  const { now, roster, evidence } = validFixture();
  const status = evaluateLiveGate({ ...TEST_TRUST_ARGS, roster, evidence, nowMs: now, expectedEngineSha256: "engine-hash", evidenceSignatureVerified: true });
  assert.equal(status.allowed, true);
  assert.deepEqual(status.reasons, []);
});

test("gate live: une preuve non signee reste fermee", () => {
  const { now, roster, evidence } = validFixture();
  const status = evaluateLiveGate({ ...TEST_TRUST_ARGS, roster, evidence, nowMs: now, expectedEngineSha256: "engine-hash" });
  assert.equal(status.allowed, false);
  assert.ok(status.reasons.includes("preuve_signature_invalide"));
});

test("gate live: roster vide signifie zero trade", () => {
  const { now, roster, evidence } = validFixture();
  roster.perles = {};
  evidence.rosterSha256 = rosterSha256(roster);
  const status = evaluateLiveGate({ ...TEST_TRUST_ARGS, roster, evidence, nowMs: now, expectedEngineSha256: "engine-hash", evidenceSignatureVerified: true });
  assert.equal(status.allowed, false);
  assert.ok(status.reasons.includes("roster_vide"));
});

test("gate live: un changement du roster ou du moteur invalide la preuve", () => {
  const { now, roster, evidence } = validFixture();
  evidence.rosterSha256 = "ancien-roster";
  evidence.engineSha256 = "ancien-moteur";
  const status = evaluateLiveGate({ ...TEST_TRUST_ARGS, roster, evidence, nowMs: now, expectedEngineSha256: "engine-hash", evidenceSignatureVerified: true });
  assert.equal(status.allowed, false);
  assert.ok(status.reasons.includes("preuve_roster_different"));
  assert.ok(status.reasons.includes("preuve_moteur_different"));
});

test("gate live: la date du roster fait partie de la preuve", () => {
  const { now, roster, evidence } = validFixture();
  roster.genere = "2026-09-04T10:01:00.000Z";
  const status = evaluateLiveGate({ ...TEST_TRUST_ARGS, roster, evidence, nowMs: now, expectedEngineSha256: "engine-hash", evidenceSignatureVerified: true });
  assert.equal(status.allowed, false);
  assert.ok(status.reasons.includes("preuve_roster_different"));
});

test("gate live: dates futures et domaines statistiques absurdes sont refuses", () => {
  const { now, roster, evidence } = validFixture();
  evidence.generatedAt = "2099-01-01T00:00:00.000Z";
  evidence.expiresAt = "2100-01-01T00:00:00.000Z";
  evidence.metrics.familywisePValue = -999;
  evidence.metrics.profitableFoldRate = 999;
  evidence.metrics.maxProfitConcentration = -1;
  evidence.metrics.maxDrawdownPct = -999;
  const status = evaluateLiveGate({ ...TEST_TRUST_ARGS, roster, evidence, nowMs: now, expectedEngineSha256: "engine-hash", evidenceSignatureVerified: true });
  assert.equal(status.allowed, false);
  for (const reason of ["preuve_date_future", "preuve_validite_excessive", "p_value_invalide", "taux_folds_invalide", "concentration_invalide", "drawdown_invalide"]) {
    assert.ok(status.reasons.includes(reason), reason);
  }
});

test("gate live: des metriques manquantes ne valent jamais zero favorable", () => {
  const { now, roster, evidence } = validFixture();
  evidence.metrics = {};
  const status = evaluateLiveGate({ ...TEST_TRUST_ARGS, roster, evidence, nowMs: now, expectedEngineSha256: "engine-hash", evidenceSignatureVerified: true });
  assert.equal(status.allowed, false);
  assert.ok(status.reasons.includes("test_famille_non_significatif"));
  assert.ok(status.reasons.includes("drawdown_trop_eleve"));
});

test("gate live: les booleens ne sont jamais coercés en metriques favorables", () => {
  const { now, roster, evidence } = validFixture();
  evidence.metrics.familywisePValue = false;
  evidence.metrics.pbo = false;
  evidence.metrics.deflatedSharpeProbability = true;
  evidence.metrics.profitableFoldRate = true;
  evidence.metrics.maxDrawdownPct = false;
  const status = evaluateLiveGate({
    ...TEST_TRUST_ARGS, roster, evidence, nowMs: now,
    expectedEngineSha256: "engine-hash", evidenceSignatureVerified: true,
  });
  assert.equal(status.allowed, false);
  for (const reason of ["p_value_invalide", "pbo_invalide", "dsr_invalide", "taux_folds_invalide", "drawdown_invalide"]) {
    assert.ok(status.reasons.includes(reason), reason);
  }
});

test("gate live: refuse une strategie surajustee ou sans trois horizons", () => {
  const { now, roster, evidence } = validFixture();
  evidence.metrics.pbo = 0.25;
  evidence.metrics.deflatedSharpeProbability = 0.80;
  evidence.metrics.spaPValue = 0.20;
  evidence.metrics.validatedHorizonsDays = [365, 730];
  const status = evaluateLiveGate({ ...TEST_TRUST_ARGS, roster, evidence, nowMs: now, expectedEngineSha256: "engine-hash", evidenceSignatureVerified: true });
  assert.equal(status.allowed, false);
  for (const reason of ["pbo_trop_eleve", "dsr_insuffisant", "spa_non_significatif", "horizons_1_2_3_ans_incomplets"]) {
    assert.ok(status.reasons.includes(reason), reason);
  }
});

test("autopilot: un roster autonome exige le canary exact et plafonne a cinq pour cent", () => {
  const id = "a".repeat(64);
  const roster = { strategyCandidateId: id, perles: { "BTC-USDT-SWAP": {} } };
  const policy = { promotion: {
    initialCanaryEquityPct: 0.01,
    maximumCanaryEquityPct: 0.05,
    automaticScaleUp: false,
  } };
  assert.equal(evaluateAutopilotCanaryAuthority({ roster, state: null, policy }).allowed, false);
  assert.equal(evaluateAutopilotCanaryAuthority({
    roster,
    state: { stage: "canary", candidateId: id, championCandidateId: id, canaryEquityPct: 0.01 },
    policy,
  }).allowed, true);
  const excessive = evaluateAutopilotCanaryAuthority({
    roster,
    state: { stage: "canary", candidateId: id, championCandidateId: id, canaryEquityPct: 0.10 },
    policy,
  });
  assert.equal(excessive.allowed, false);
  assert.ok(excessive.reasons.includes("autopilot_plafond_canary_invalide"));
  const unsignedScale = evaluateAutopilotCanaryAuthority({
    roster,
    state: { stage: "canary", candidateId: id, championCandidateId: id, canaryEquityPct: 0.05 },
    policy,
  });
  assert.equal(unsignedScale.allowed, false);
  assert.ok(unsignedScale.reasons.includes("autopilot_scale_up_non_autorise"));
  const legacy = evaluateAutopilotCanaryAuthority({
    roster: { perles: { "BTC-USDT-SWAP": {} } }, state: null, policy,
  });
  assert.equal(legacy.required, true);
  assert.equal(legacy.allowed, false);
  assert.ok(legacy.reasons.includes("autopilot_roster_candidate_invalide"));
  assert.equal(evaluateAutopilotCanaryAuthority({ roster: { perles: {} } }).required, false);
});
