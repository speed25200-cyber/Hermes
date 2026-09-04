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
  validateRiskConfig,
  hermesAlgoOwnerNamespace,
  newHermesClientId,
  isHermesOwnedAlgo,
  isProtectiveStopAlgo,
  evidenceSigningPayload,
  verifyEvidenceSignature,
  rosterSha256,
  evaluateLiveGate,
} = require("../modules/live_safety.js");

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
    perles: { "BTC-USDT-SWAP": { sig: "example", ov: { holdMs: 3600000 } } },
  };
  const methodology = Object.fromEntries(DEFAULT_POLICY.requiredMethodology.map((name) => [name, true]));
  const evidence = {
    schemaVersion: 1,
    decision: "approved",
    generatedAt: "2026-09-04T11:00:00.000Z",
    expiresAt: "2026-09-20T00:00:00.000Z",
    rosterSha256: rosterSha256(roster),
    engineSha256: "engine-hash",
    metrics: {
      oosTrades: 2000, oosDays: 500,
      netMeanPerTrade: 0.02, netMeanLower99: 0.004, costStressLower95: 0.002,
      familywisePValue: 0.005, nullReplications: 9999,
      profitableFoldRate: 0.8, maxProfitConcentration: 0.2,
      maxDrawdownPct: 0.08, profitFactor: 1.25,
      shadowLiveDays: 90, shadowLiveTrades: 150, shadowLiveNet: 1.2,
    },
    methodology,
  };
  return { now, roster, evidence };
}

test("gate live: une preuve complete, fraiche et liee au code est acceptee", () => {
  const { now, roster, evidence } = validFixture();
  const status = evaluateLiveGate({ roster, evidence, nowMs: now, expectedEngineSha256: "engine-hash", evidenceSignatureVerified: true });
  assert.equal(status.allowed, true);
  assert.deepEqual(status.reasons, []);
});

test("gate live: une preuve non signee reste fermee", () => {
  const { now, roster, evidence } = validFixture();
  const status = evaluateLiveGate({ roster, evidence, nowMs: now, expectedEngineSha256: "engine-hash" });
  assert.equal(status.allowed, false);
  assert.ok(status.reasons.includes("preuve_signature_invalide"));
});

test("gate live: roster vide signifie zero trade", () => {
  const { now, roster, evidence } = validFixture();
  roster.perles = {};
  evidence.rosterSha256 = rosterSha256(roster);
  const status = evaluateLiveGate({ roster, evidence, nowMs: now, expectedEngineSha256: "engine-hash", evidenceSignatureVerified: true });
  assert.equal(status.allowed, false);
  assert.ok(status.reasons.includes("roster_vide"));
});

test("gate live: un changement du roster ou du moteur invalide la preuve", () => {
  const { now, roster, evidence } = validFixture();
  evidence.rosterSha256 = "ancien-roster";
  evidence.engineSha256 = "ancien-moteur";
  const status = evaluateLiveGate({ roster, evidence, nowMs: now, expectedEngineSha256: "engine-hash", evidenceSignatureVerified: true });
  assert.equal(status.allowed, false);
  assert.ok(status.reasons.includes("preuve_roster_different"));
  assert.ok(status.reasons.includes("preuve_moteur_different"));
});

test("gate live: la date du roster fait partie de la preuve", () => {
  const { now, roster, evidence } = validFixture();
  roster.genere = "2026-09-04T10:01:00.000Z";
  const status = evaluateLiveGate({ roster, evidence, nowMs: now, expectedEngineSha256: "engine-hash", evidenceSignatureVerified: true });
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
  const status = evaluateLiveGate({ roster, evidence, nowMs: now, expectedEngineSha256: "engine-hash", evidenceSignatureVerified: true });
  assert.equal(status.allowed, false);
  for (const reason of ["preuve_date_future", "preuve_validite_excessive", "p_value_invalide", "taux_folds_invalide", "concentration_invalide", "drawdown_invalide"]) {
    assert.ok(status.reasons.includes(reason), reason);
  }
});

test("gate live: des metriques manquantes ne valent jamais zero favorable", () => {
  const { now, roster, evidence } = validFixture();
  evidence.metrics = {};
  const status = evaluateLiveGate({ roster, evidence, nowMs: now, expectedEngineSha256: "engine-hash", evidenceSignatureVerified: true });
  assert.equal(status.allowed, false);
  assert.ok(status.reasons.includes("test_famille_non_significatif"));
  assert.ok(status.reasons.includes("drawdown_trop_eleve"));
});
