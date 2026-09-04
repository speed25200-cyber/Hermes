"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Q = require("../modules/quant_validation.js");
const CLI = require("../deploy/compiler_preuve_quantitative.js");
const Autopilot = require("../modules/autopilot.js");

function signAttestation(body, domain, privateKey) {
  return {
    ...body,
    signature: crypto.sign(null,
      Buffer.from(Q.quantAttestationSigningPayload(domain, body), "utf8"), privateKey).toString("base64"),
  };
}

function moverSeries(selectionTs, count = 31, futureShock = false) {
  const out = {};
  for (let index = 0; index < count; index++) {
    const instId = `M${String(index).padStart(2, "0")}-USDT-SWAP`;
    out[instId] = [
      { ts: selectionTs - Q.DAY_MS - 1, availableAt: selectionTs - Q.DAY_MS, close: 100, quoteVolume: 100,
        spreadBps: 1, spreadAvailableAt: selectionTs - Q.DAY_MS, confirmed: true },
      { ts: selectionTs - 1, availableAt: selectionTs, close: 100 + index, quoteVolume: 100,
        spreadBps: 1, spreadAvailableAt: selectionTs, confirmed: true },
    ];
    if (futureShock && index === 0) {
      out[instId].push({ ts: selectionTs + Q.DAY_MS, availableAt: selectionTs + 2 * Q.DAY_MS,
        close: 10000, quoteVolume: 1e12, spreadBps: 1, spreadAvailableAt: selectionTs + 2 * Q.DAY_MS, confirmed: true });
    }
  }
  return out;
}

function instrumentMasterFor(instIds, liveFrom, cutoffTs) {
  const events = [];
  for (const instId of instIds) {
    const spotInstId = instId.replace(/-SWAP$/, "");
    for (const [id, instType, spot] of [[instId, "SWAP", spotInstId], [spotInstId, "SPOT", null]]) {
      events.push({
        instId: id,
        availableAt: liveFrom,
        effectiveFrom: liveFrom,
        effectiveTo: null,
        instType,
        instCategory: "1",
        state: "live",
        ruleType: "normal",
        listTime: liveFrom,
        delistTime: null,
        spotInstId: spot,
      });
    }
  }
  const delistedAt = cutoffTs - 10 * Q.DAY_MS;
  for (const [id, instType, spot] of [["OLD-USDT-SWAP", "SWAP", "OLD-USDT"], ["OLD-USDT", "SPOT", null]]) {
    events.push({
      instId: id, availableAt: liveFrom, effectiveFrom: liveFrom, effectiveTo: delistedAt,
      instType, instCategory: "1", state: "live", ruleType: "normal",
      listTime: liveFrom, delistTime: delistedAt, spotInstId: spot,
    });
    events.push({
      instId: id, availableAt: delistedAt, effectiveFrom: delistedAt,
      instType, instCategory: "1", state: "delisted", ruleType: "normal",
      listTime: liveFrom, delistTime: delistedAt, spotInstId: spot,
    });
  }
  return Q.preparePointInTimeInstrumentMaster({
    source: { venue: "OKX", datasetId: "master-fixture", retrievalBatchId: "master-batch", endpoint: "/api/v5/public/instruments" },
    includesAllHistoricalInstruments: true,
    events,
  });
}

const smallUniversePolicy = {
  venue: "OKX",
  topN: 30,
  minimumEligible: 30,
  rankingMetric: "absolute-log-return",
  rankingWindowMs: Q.DAY_MS,
  liquidityWindowMs: Q.DAY_MS,
  minQuoteVolume: 1,
  maxSpreadBps: 15,
  rebalanceMs: Q.DAY_MS,
  barMs: Q.DAY_MS,
  maxEndpointStalenessMs: 1,
  minRosterCoverageRate: 1,
};

test("canonical JSON and hashes are deterministic and reject non-finite data", () => {
  assert.equal(Q.canonicalJson({ z: [2, 1], a: true }), '{"a":true,"z":[2,1]}');
  assert.equal(Q.sha256Canonical({ b: 2, a: 1 }), Q.sha256Canonical({ a: 1, b: 2 }));
  assert.throws(() => Q.canonicalJson({ bad: NaN }), /NaN/);
});

test("quant and autopilot share the exact stable executable candidate identity", () => {
  const candidate = {
    schemaVersion: 1,
    family: "directional",
    executionType: "directional-signal",
    params: { risk: 0.01 },
    universe: {
      venue: "OKX", topN: 30, snapshotSha256: "a".repeat(64),
      generatedAt: "2026-09-04T00:00:00.000Z", selected: ["BTC-USDT-SWAP"],
    },
    perles: {
      "BTC-USDT-SWAP": { sig: "rsi", ov: { period: 14 }, winRate: 0.99, trades: 1_000 },
    },
    sourcePriorSha256: "b".repeat(64),
  };
  assert.deepEqual(Q.quantitativeCandidateIdentity(candidate), Autopilot.executableStrategyIdentity(candidate));
  assert.equal(Q.quantitativeCandidateId(candidate), Autopilot.candidateId(candidate));
  const changedOnlyVolatile = structuredClone(candidate);
  changedOnlyVolatile.universe.snapshotSha256 = "c".repeat(64);
  changedOnlyVolatile.universe.generatedAt = "2027-01-01T00:00:00.000Z";
  changedOnlyVolatile.perles["BTC-USDT-SWAP"].winRate = 0.01;
  changedOnlyVolatile.sourcePriorSha256 = "d".repeat(64);
  assert.equal(Q.quantitativeCandidateId(changedOnlyVolatile), Autopilot.candidateId(candidate));
});

test("fail-closed CLI contract requires explicit input/output and has no signing option", () => {
  assert.deepEqual(CLI.parseArgs(["--input", "run.json", "--output", "evidence.json"]),
    { input: "run.json", output: "evidence.json" });
  assert.throws(() => CLI.parseArgs(["--input", "run.json"]), /usage/);
  assert.throws(() => CLI.parseArgs(["--sign", "key.pem", "--input", "run.json", "--output", "evidence.json"]), /argument inconnu/);
});

test("policy makes 1y/2y/3y, OKX top30, 9999 nulls and full embargo mandatory", () => {
  const policy = Q.mergePolicy();
  assert.deepEqual(policy.requiredHorizonsDays, [365, 730, 1095]);
  assert.equal(policy.universe.topN, 30);
  assert.equal(policy.statistics.nullReplications, 9999);
  assert.equal(policy.statistics.minModelMatrixCoverageRate, 1);
  assert.deepEqual(policy.statistics.blockLengthSensitivity, [6, 12, 24, 48]);
  assert.equal(policy.costs.requiredGrossPnlBasis, "fill-to-fill");
  assert.ok(policy.walkForward.embargoMs >= policy.walkForward.labelHorizonMs);
  assert.throws(() => Q.mergePolicy({ requiredHorizonsDays: [365] }), /365\/730\/1095/);
  assert.throws(() => Q.mergePolicy({ universe: { topN: 29 } }), /30 movers/);
  assert.throws(() => Q.mergePolicy({ statistics: { nullReplications: 9998 } }), /9999/);
  assert.throws(() => Q.mergePolicy({ statistics: { minModelMatrixCoverageRate: 0.99 } }), /100%/);
  assert.throws(() => Q.mergePolicy({ statistics: { blockLengthSensitivity: [12] } }), /6\/12\/24\/48/);
  assert.throws(() => Q.mergePolicy({ costs: { requiredGrossPnlBasis: "mid-to-mid" } }), /fill-to-fill/);
  assert.throws(() => Q.mergePolicy({ walkForward: { embargoMs: 1 } }), /embargo/);
});

test("top30 movers uses only information available at selection time", () => {
  const selectionTs = Date.UTC(2025, 0, 2);
  const raw = moverSeries(selectionTs, 31, true);
  const prepared = Q.preparePointInTimeSeries(raw, { barMs: Q.DAY_MS });
  const master = instrumentMasterFor(Object.keys(raw), selectionTs - 200 * Q.DAY_MS, selectionTs + Q.DAY_MS);
  const roster = Q.buildPointInTimeTopMovers(prepared, selectionTs, smallUniversePolicy, master);
  assert.equal(roster.accepted, true);
  assert.equal(roster.constituents.length, 30);
  assert.equal(roster.constituents[0].instId, "M30-USDT-SWAP");
  assert.equal(roster.constituents.some((item) => item.instId === "M00-USDT-SWAP"), false);
  assert.ok(roster.constituents.every((item) => item.inputMaxAvailableAt <= selectionTs));
  assert.deepEqual(Q.verifyRosterPointInTime(roster), { valid: true, reasons: [] });
});

test("a roster carrying one future-derived constituent is rejected", () => {
  const selectionTs = Date.UTC(2025, 0, 2);
  const raw = moverSeries(selectionTs);
  const prepared = Q.preparePointInTimeSeries(raw, { barMs: Q.DAY_MS });
  const master = instrumentMasterFor(Object.keys(raw), selectionTs - 200 * Q.DAY_MS, selectionTs + Q.DAY_MS);
  const roster = Q.buildPointInTimeTopMovers(prepared, selectionTs, smallUniversePolicy, master);
  roster.constituents[0].inputMaxAvailableAt = selectionTs + 1;
  const check = Q.verifyRosterPointInTime(roster);
  assert.equal(check.valid, false);
  assert.ok(check.reasons.includes("roster_utilise_le_futur"));
});

test("top30 rejects the whole ranking when one otherwise eligible instrument has a missing bar", () => {
  const selectionTs = Date.UTC(2025, 0, 2);
  const barMs = Q.DAY_MS / 2;
  const raw = {};
  for (let index = 0; index < 31; index++) {
    const instId = `G${String(index).padStart(2, "0")}-USDT-SWAP`;
    raw[instId] = [0, 1, 2].map((offset) => ({
      ts: selectionTs - Q.DAY_MS - 1 + offset * barMs,
      availableAt: selectionTs - Q.DAY_MS + offset * barMs,
      close: 100 + index + offset,
      quoteVolume: 100,
      spreadBps: 1,
      spreadAvailableAt: selectionTs - Q.DAY_MS + offset * barMs,
      confirmed: true,
    }));
  }
  raw["G00-USDT-SWAP"].splice(1, 1);
  const prepared = Q.preparePointInTimeSeries(raw, { barMs });
  const master = instrumentMasterFor(Object.keys(raw), selectionTs - 200 * Q.DAY_MS, selectionTs + Q.DAY_MS);
  const roster = Q.buildPointInTimeTopMovers(prepared, selectionTs,
    { ...smallUniversePolicy, barMs }, master);
  assert.equal(roster.accepted, false);
  assert.ok(roster.reasons.includes("serie_marche_eligible_incomplete"));
  assert.ok(roster.rejected.some((item) => item.instId === "G00-USDT-SWAP"
    && item.reason === "ranking_bar_grid_incomplete"));
});

test("top30 refuses missing, future, stale or excessive observed spread", () => {
  const selectionTs = Date.UTC(2025, 0, 2);
  const cases = [
    ["missing", (row) => { delete row.spreadBps; delete row.spreadAvailableAt; }, "spread_observe_absent"],
    ["future", (row) => { row.spreadAvailableAt = selectionTs + 1; }, "spread_observe_futur"],
    ["stale", (row) => { row.spreadAvailableAt = selectionTs - 2; }, "spread_observe_stale"],
    ["wide", (row) => { row.spreadBps = 16; }, "spread_superieur_au_plafond"],
  ];
  for (const [name, mutate, reason] of cases) {
    const raw = moverSeries(selectionTs, 30);
    mutate(raw["M00-USDT-SWAP"][1]);
    const prepared = Q.preparePointInTimeSeries(raw, { barMs: Q.DAY_MS });
    const master = instrumentMasterFor(Object.keys(raw), selectionTs - 200 * Q.DAY_MS, selectionTs + Q.DAY_MS);
    const roster = Q.buildPointInTimeTopMovers(prepared, selectionTs, smallUniversePolicy, master);
    assert.equal(roster.accepted, false, name);
    assert.ok(roster.rejected.some((item) => item.instId === "M00-USDT-SWAP" && item.reason === reason), name);
  }
  assert.throws(() => Q.preparePointInTimeSeries({
    "BAD-USDT-SWAP": [{ ts: 1, availableAt: 2, close: 1, quoteVolume: 1,
      spreadBps: null, spreadAvailableAt: 2, confirmed: true }],
  }, { barMs: 1 }), /nombre fini explicite/);
});

test("instrument master rejects wrong category/state, young or imminent-delist swaps and missing spot hedge", () => {
  const selectionTs = Date.UTC(2025, 0, 2);
  const instId = "M00-USDT-SWAP";
  const baseline = instrumentMasterFor([instId], selectionTs - 200 * Q.DAY_MS, selectionTs + Q.DAY_MS);
  assert.equal(Q.instrumentEligibilityAt(baseline, instId, selectionTs, smallUniversePolicy).eligible, true);
  const cases = [
    ["instCategory", "2", "swap_categorie_invalide"],
    ["state", "suspend", "swap_non_live"],
    ["listTime", selectionTs - 10 * Q.DAY_MS, "swap_listing_trop_recent"],
    ["delistTime", selectionTs + Q.DAY_MS, "swap_delist_imminent_ou_passe"],
    ["spotInstId", null, "spot_hedge_non_reference"],
  ];
  for (const [field, value, reason] of cases) {
    const events = structuredClone(baseline.events);
    const event = events.find((item) => item.instId === instId);
    event[field] = value;
    if (field === "listTime") { event.effectiveFrom = value; event.availableAt = value; }
    const master = Q.preparePointInTimeInstrumentMaster({
      source: baseline.source, includesAllHistoricalInstruments: true, events,
    });
    const result = Q.instrumentEligibilityAt(master, instId, selectionTs, smallUniversePolicy);
    assert.equal(result.eligible, false, field);
    assert.ok(result.reasons.includes(reason), `${field}: ${result.reasons.join(",")}`);
  }
});

test("instrument-master manifest checks delist coverage but rejects unauthenticated inventory claims", () => {
  const cutoffTs = Date.UTC(2025, 0, 3);
  const complete = instrumentMasterFor(["M00-USDT-SWAP"], cutoffTs - 200 * Q.DAY_MS, cutoffTs);
  const prepared = Q.preparePointInTimeSeries({
    "M00-USDT-SWAP": [{ ts: cutoffTs - 2 * Q.DAY_MS, availableAt: cutoffTs - Q.DAY_MS, close: 1, quoteVolume: 1, confirmed: true }],
    "OLD-USDT-SWAP": [{ ts: cutoffTs - 20 * Q.DAY_MS, availableAt: cutoffTs - 19 * Q.DAY_MS, close: 1, quoteVolume: 1, confirmed: true }],
  }, { barMs: Q.DAY_MS });
  const completeAudit = Q.createInstrumentMasterManifest(complete, cutoffTs, prepared, smallUniversePolicy);
  assert.equal(completeAudit.verified, false);
  assert.ok(completeAudit.reasons.includes("instrument_master_inventaire_okx_non_authentifie"));
  assert.equal(completeAudit.includesDelisted, true);
  const survivorOnly = Q.preparePointInTimeInstrumentMaster({
    source: complete.source,
    includesAllHistoricalInstruments: true,
    events: complete.events.filter((event) => !event.instId.startsWith("OLD-USDT")),
  });
  const survivorPrepared = Q.preparePointInTimeSeries({
    "M00-USDT-SWAP": [{ ts: cutoffTs - 2 * Q.DAY_MS, availableAt: cutoffTs - Q.DAY_MS, close: 1, quoteVolume: 1, confirmed: true }],
  }, { barMs: Q.DAY_MS });
  const audit = Q.createInstrumentMasterManifest(survivorOnly, cutoffTs, survivorPrepared, smallUniversePolicy);
  assert.equal(audit.verified, false);
  assert.ok(audit.reasons.includes("instrument_master_sans_delistes"));
});

test("roster coverage fails closed when fewer than 30 liquid instruments exist", () => {
  const selectionTs = Date.UTC(2025, 0, 2);
  const raw = moverSeries(selectionTs, 29);
  const prepared = Q.preparePointInTimeSeries(raw, { barMs: Q.DAY_MS });
  const master = instrumentMasterFor(Object.keys(raw), selectionTs - 200 * Q.DAY_MS, selectionTs + Q.DAY_MS);
  const schedule = Q.buildRosterSchedule(prepared, selectionTs, selectionTs + Q.DAY_MS, smallUniversePolicy, master);
  assert.equal(schedule.coverageRate, 0);
  assert.deepEqual(schedule.reasons, ["couverture_roster_insuffisante"]);
});

test("data manifest is reproducible, checksummed and excludes future rows", () => {
  const cutoffTs = Date.UTC(2025, 0, 3);
  const raw = moverSeries(cutoffTs - Q.DAY_MS, 31, true);
  raw["OLD-USDT-SWAP"] = [{ ts: cutoffTs - 20 * Q.DAY_MS, availableAt: cutoffTs - 19 * Q.DAY_MS,
    close: 1, quoteVolume: 1, confirmed: true }];
  const prepared = Q.preparePointInTimeSeries(raw, { barMs: Q.DAY_MS });
  const instrumentMaster = instrumentMasterFor(Object.keys(raw), cutoffTs - 201 * Q.DAY_MS, cutoffTs);
  const args = {
    prepared,
    instrumentMaster,
    source: { venue: "OKX", datasetId: "okx-fixture", retrievalBatchId: "batch-1", endpoint: "/api/v5/market/history-candles" },
    cutoffTs,
    universePolicy: smallUniversePolicy,
    feeScheduleManifest: { verified: true },
    executionDatasetManifest: { verified: true },
    cycleLedgerManifest: { valid: true },
    executionUniverseParity: { verified: true },
  };
  const first = Q.createDataManifest(args), second = Q.createDataManifest(args);
  assert.equal(first.verified, false);
  assert.ok(first.reasons.includes("instrument_master_inventaire_okx_non_authentifie"));
  assert.equal(first.manifestSha256, second.manifestSha256);
  assert.ok(first.instruments.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
  assert.equal(first.excludedFutureRows, 1);
  assert.ok(first.instruments.every((item) => item.lastAvailableAt < cutoffTs));
});

test("nested walk-forward is expanding, inner, purged and embargoed", () => {
  const day = Q.DAY_MS;
  const folds = Q.buildNestedPurgedWalkForward({
    historyStartTs: 0,
    evaluationStartTs: 20 * day,
    endTs: 30 * day,
    walkForward: {
      minimumTrainingMs: 10 * day,
      outerTestMs: 5 * day,
      outerStepMs: 5 * day,
      innerMinimumTrainingMs: 4 * day,
      innerValidationMs: 2 * day,
      innerStepMs: 2 * day,
      labelHorizonMs: day,
      purgeMs: day,
      embargoMs: day,
    },
  });
  assert.equal(folds.length, 2);
  assert.ok(folds.every((fold) => Q.verifyPurgedFold(fold).valid));
  const leaked = structuredClone(folds[0]);
  leaked.train.endTsExclusive = leaked.test.startTs;
  assert.ok(Q.verifyPurgedFold(leaked).reasons.includes("fuite_train_test"));
});

test("fill-to-fill PnL never double-counts observed execution friction and stress charges only its delta", () => {
  const trade = {
    grossPnlBasis: "fill-to-fill",
    grossPnlQuote: 10,
    entryNotionalQuote: 1000,
    exitNotionalQuote: 1000,
    riskCapitalQuote: 100,
    entryLiquidity: "maker",
    exitLiquidity: "taker",
    entryHalfSpreadBps: 1,
    exitHalfSpreadBps: 1,
    entrySlippageBps: 2,
    exitSlippageBps: 2,
    entryImpactBps: 3,
    exitImpactBps: 3,
    entryLatencyBps: 1,
    exitLatencyBps: 1,
    fundingCostQuote: 0.5,
    borrowCostQuote: 0.25,
    rejectionCostQuote: 0,
    liquidationCostQuote: 0,
    requestedQty: 10,
    filledQty: 8,
    rejected: false,
  };
  const result = Q.applyCompleteCosts(trade);
  assert.equal(result.breakdown.fee, 0.7);
  assert.equal(result.breakdown.spread, 0);
  assert.equal(result.breakdown.slippage, 0);
  assert.equal(result.breakdown.impact, 0);
  assert.equal(result.breakdown.latency, 0);
  assert.ok(Math.abs(result.embeddedExecutionFrictionQuote.total - 1.4) < 1e-12);
  assert.ok(Math.abs(result.netPnlQuote - 8.55) < 1e-12);
  assert.deepEqual(Q.missingCostObservations(result), []);
  const stressed = Q.applyCompleteCosts(trade, {}, true);
  assert.ok(Math.abs(stressed.breakdown.spread - 0.2) < 1e-12);
  assert.ok(Math.abs(stressed.netPnlQuote - 5.7) < 1e-12);
  assert.ok(stressed.netPnlQuote < result.netPnlQuote);
  assert.throws(() => Q.applyCompleteCosts({ ...trade, grossPnlBasis: undefined }), /base PnL brute/);
  assert.throws(() => Q.applyCompleteCosts({ ...trade, grossPnlBasis: "mid-to-mid" }), /base PnL brute/);
});

test("missing observed microstructure fields cannot silently pass as complete costs", () => {
  const result = Q.applyCompleteCosts({
    grossPnlBasis: "fill-to-fill",
    grossPnlQuote: 1, entryNotionalQuote: 100, exitNotionalQuote: 100, riskCapitalQuote: 10,
    entryLiquidity: "taker", exitLiquidity: "taker",
  });
  assert.deepEqual(Q.missingCostObservations(result).sort(),
    ["borrow", "funding", "impact", "latency", "liquidation", "partialFills", "rejections", "slippage", "spread"]);
  assert.throws(() => Q.applyCompleteCosts({
    grossPnlBasis: "fill-to-fill",
    grossPnlQuote: 1, entryNotionalQuote: 100, exitNotionalQuote: 100, riskCapitalQuote: 10,
    entryLiquidity: "taker", exitLiquidity: "taker", entryHalfSpreadBps: -1,
  }), /negatif/);
});

test("strict numeric and timestamp parsing rejects null, empty strings and booleans", () => {
  for (const value of [null, "", "   ", true, false]) {
    assert.throws(() => Q.finiteNumber(value, "strict.value"), /nombre fini explicite/);
    assert.throws(() => Q.timestamp(value, "strict.ts"), /date invalide/);
  }
  const baseline = {
    grossPnlBasis: "fill-to-fill",
    grossPnlQuote: 1, entryNotionalQuote: 100, exitNotionalQuote: 100, riskCapitalQuote: 10,
    entryLiquidity: "taker", exitLiquidity: "taker",
  };
  for (const field of ["entryHalfSpreadBps", "fundingCostQuote", "requestedQty", "rejectionCostQuote"]) {
    for (const value of [null, "", true]) {
      assert.throws(() => Q.applyCompleteCosts({ ...baseline, [field]: value }), /nombre fini explicite/,
        `${field}=${String(value)}`);
    }
  }
});

test("fee snapshots are point-in-time, checksummed and never accept an implicit tier", () => {
  const cutoffTs = Date.UTC(2026, 0, 1);
  const body = Q.feeSnapshotBody({
    source: { venue: "OKX", endpoint: "/api/v5/account/trade-fee", datasetId: "fee-ds",
      retrievalBatchId: "fee-batch", sourceArtifactSha256: "1".repeat(64) },
    accountTier: "VIP0", instrumentType: "SWAP", availableAt: cutoffTs - 1,
    makerFeeRate: 0.0002, takerFeeRate: 0.0005,
  });
  const valid = Q.prepareFeeSchedule([{ ...body, snapshotSha256: Q.sha256Canonical(body) }], cutoffTs);
  assert.equal(valid.verified, true, valid.reasons.join(","));
  const tampered = Q.prepareFeeSchedule([{ ...body, takerFeeRate: 0, snapshotSha256: Q.sha256Canonical(body) }], cutoffTs);
  assert.equal(tampered.verified, false);
  assert.ok(tampered.reasons.includes("fee_snapshot_hash_invalide"));
  assert.throws(() => Q.feeSnapshotBody({ ...body, makerFeeRate: null }), /nombre fini explicite/);
});

test("PnL replay is derived from prepared OKX fill prices and quantities, not declared PnL", () => {
  const cutoffTs = 100;
  const source = { venue: "OKX", endpoint: "/api/v5/trade/fills-history", datasetId: "fills",
    retrievalBatchId: "batch", sourceArtifactSha256: "2".repeat(64) };
  const fills = [
    { fillId: "e", instId: "BTC-USDT-SWAP", ts: 10, availableAt: 10, side: "buy", liquidity: "taker",
      price: 100, quantity: 2, contractValue: 1 },
    { fillId: "x", instId: "BTC-USDT-SWAP", ts: 20, availableAt: 20, side: "sell", liquidity: "taker",
      price: 103, quantity: 2, contractValue: 1 },
  ];
  const draft = Q.prepareExecutionDataset({ source, fills, executionDatasetSha256: "0".repeat(64) }, cutoffTs);
  const dataset = Q.prepareExecutionDataset({ source, fills, executionDatasetSha256: draft.executionDatasetSha256 }, cutoffTs);
  assert.ok(dataset.reasons.includes("execution_attribution_non_exhaustive"));
  assert.ok(dataset.reasons.includes("execution_attestation_absente"));
  const replay = Q.replayTradeFromExecutionDataset({ tradeId: "t", instId: "BTC-USDT-SWAP", side: "long",
    entryTs: 10, exitTs: 20, grossPnlQuote: 1_000_000, entryFillIds: ["e"], exitFillIds: ["x"] }, dataset);
  assert.equal(replay.entryNotionalQuote, 200);
  assert.equal(replay.exitNotionalQuote, 206);
  assert.equal(replay.grossPnlQuote, 6);
  assert.equal(replay.grossPnlBasis, "fill-to-fill");
});

test("portfolio audit recomputes every equity transition and catches a rehashed middle fabrication", () => {
  const trades = [
    { tradeId: "a", exitTs: 10, netPnlQuote: 1 },
    { tradeId: "b", exitTs: 20, netPnlQuote: -0.5 },
  ];
  const events = [
    { ts: 0, equity: 100, realizedNetPnlQuoteDelta: 0, markToMarketPnlQuote: 0,
      externalCashflowQuote: 0, tradeIds: [], markPriceObservationSha256: null },
    { ts: 10, equity: 101, realizedNetPnlQuoteDelta: 1, markToMarketPnlQuote: 0,
      externalCashflowQuote: 0, tradeIds: ["a"], markPriceObservationSha256: "3".repeat(64) },
    { ts: 20, equity: 100.5, realizedNetPnlQuoteDelta: -0.5, markToMarketPnlQuote: 0,
      externalCashflowQuote: 0, tradeIds: ["b"], markPriceObservationSha256: "3".repeat(64) },
    { ts: 30, equity: 100.5, realizedNetPnlQuoteDelta: 0, markToMarketPnlQuote: 0,
      externalCashflowQuote: 0, tradeIds: [], markPriceObservationSha256: "3".repeat(64) },
  ];
  const simulation = { synchronized: true, method: "event-driven-shared-equity", correlationStressIncluded: true,
    initialEquity: 100, events, returnSeriesSha256: Q.sha256Canonical({ initialEquity: 100, events }) };
  assert.equal(Q.validatePortfolioSimulation(simulation, 0, 30, trades).verified, true);
  const forged = structuredClone(simulation);
  forged.events[1].equity = 150;
  forged.returnSeriesSha256 = Q.sha256Canonical({ initialEquity: 100, events: forged.events });
  const audit = Q.validatePortfolioSimulation(forged, 0, 30, trades);
  assert.equal(audit.verified, false);
  assert.ok(audit.reasons.includes("portfolio_transition_equity_non_reconciliee"));
});

test("permutation p-values are exact when enumerable and Monte Carlo p-values have the +1 floor", () => {
  const exact = Q.blockSignPermutationTest([1, 1, 1, 1], { blockLength: 2, replications: 9999 });
  assert.equal(exact.exact, true);
  assert.equal(exact.replications, 4);
  assert.equal(exact.pValue, 0.25);
  const empirical = Q.empiricalExactPValue(1, new Array(9999).fill(0));
  assert.equal(empirical.pValue, 0.0001);
  assert.equal(empirical.replications, 9999);
});

test("moving-block confidence interval and Holm correction are deterministic", () => {
  const options = { confidence: 0.99, replications: 9999, blockLength: 2, seed: "fixed" };
  const first = Q.movingBlockBootstrapCI([0.03, 0.01, 0.03, 0.01], options);
  const second = Q.movingBlockBootstrapCI([0.03, 0.01, 0.03, 0.01], options);
  assert.deepEqual(first, second);
  assert.ok(first.oneSidedLower > 0);
  assert.deepEqual(Q.holmBonferroni([{ id: "a", pValue: 0.001 }, { id: "b", pValue: 0.02 }], 0.01), [
    { id: "a", pValue: 0.001, adjustedPValue: 0.002, rejected: true },
    { id: "b", pValue: 0.02, adjustedPValue: 0.02, rejected: false },
  ]);
  const clustered = Q.clusteredBasketBootstrapCI([
    { basketId: "a", entryTs: 1, netReturn: 0.03 }, { basketId: "a", entryTs: 2, netReturn: -0.01 },
    { basketId: "b", entryTs: 3, netReturn: 0.03 }, { basketId: "b", entryTs: 4, netReturn: -0.01 },
  ], options);
  assert.ok(clustered.oneSidedLower99 > 0);
  assert.equal(clustered.clusters, 2);
  const pnlClustered = Q.clusteredBasketPnlBootstrapCI([
    { basketId: "a", entryTs: 1, netPnlQuote: 3 }, { basketId: "a", entryTs: 2, netPnlQuote: -1 },
    { basketId: "b", entryTs: 3, netPnlQuote: 3 }, { basketId: "b", entryTs: 4, netPnlQuote: -1 },
  ], { ...options, initialEquity: 100 });
  assert.equal(pnlClustered.mean, 0.01);
  assert.ok(pnlClustered.oneSidedLower99 > 0);
  const sensitivity = Q.clusteredBasketPnlBootstrapSensitivity([
    { basketId: "a", entryTs: 1, netPnlQuote: 4 }, { basketId: "b", entryTs: 2, netPnlQuote: -1 },
    { basketId: "c", entryTs: 3, netPnlQuote: 3 }, { basketId: "d", entryTs: 4, netPnlQuote: -1 },
  ], { ...options, initialEquity: 100, blockLengths: [1, 2, 4] });
  assert.deepEqual(sensitivity.blockLengths, [1, 2, 4]);
  assert.equal(sensitivity.oneSidedLower,
    Math.min(...sensitivity.sensitivity.map((item) => item.oneSidedLower)));
  assert.equal(sensitivity.method, "worst-bound-over-preregistered-block-lengths");
});

test("CSCV/PBO, Deflated Sharpe, Hansen SPA and White Reality Check expose selection risk", () => {
  const matrix = Array.from({ length: 24 }, (_, index) => [
    0.02 + (index % 2 ? 0.001 : -0.001),
    -0.01 + (index % 3 ? 0.002 : -0.002),
    -0.005,
  ]);
  const pbo = Q.probabilityBacktestOverfitting(matrix, { slices: 8 });
  assert.equal(pbo.pbo, 0);
  assert.equal(pbo.combinations, 70);
  const dsr = Q.deflatedSharpeProbability(matrix.map((row) => row[0]), {
    trials: 3,
    trialSharpeRatios: [2, 0, -1],
    blockLength: 2,
  });
  assert.equal(dsr.valid, true);
  assert.ok(dsr.probability > 0.99);
  const resampling = Q.matrixBootstrapPValues(matrix, {
    spaReplications: 9999,
    realityReplications: 9999,
    blockLength: 2,
    seed: "advanced-tests",
  });
  assert.equal(resampling.hansenSpa.pValue, 0.0001);
  assert.equal(resampling.whiteRealityCheck.pValue, 0.0001);
  assert.ok(resampling.hansenSpa.upperPValue >= resampling.hansenSpa.consistentPValue);
  assert.ok(resampling.hansenSpa.consistentPValue >= resampling.hansenSpa.lowerPValue);
});

test("Deflated Sharpe fails closed without the complete family and penalizes dispersion and serial dependence", () => {
  const alternating = Array.from({ length: 80 }, (_, index) => index % 2 ? -0.005 : 0.02);
  const clustered = [...new Array(40).fill(0.02), ...new Array(40).fill(-0.005)];
  const missing = Q.deflatedSharpeProbability(alternating, { trials: 3, trialSharpeRatios: [0, 1] });
  assert.equal(missing.valid, false);
  assert.equal(missing.probability, 0);
  const lowDispersion = Q.deflatedSharpeProbability(alternating,
    { trials: 3, trialSharpeRatios: [-0.1, 0, 0.1], blockLength: 12 });
  const highDispersion = Q.deflatedSharpeProbability(alternating,
    { trials: 3, trialSharpeRatios: [-2, 0, 2], blockLength: 12 });
  assert.ok(highDispersion.expectedMaximumSharpe > lowDispersion.expectedMaximumSharpe);
  assert.ok(highDispersion.probability < lowDispersion.probability);
  const iidLike = Q.deflatedSharpeProbability(alternating,
    { trials: 3, trialSharpeRatios: [-0.1, 0, 0.1], blockLength: 12 });
  const autocorrelated = Q.deflatedSharpeProbability(clustered,
    { trials: 3, trialSharpeRatios: [-0.1, 0, 0.1], blockLength: 12 });
  assert.ok(autocorrelated.effectiveObservations < iidLike.effectiveObservations);
  assert.ok(autocorrelated.probability <= iidLike.probability);
});

test("Hansen SPA gates on the conservative upper p-value and all-negative models cannot look significant", () => {
  const negative = Array.from({ length: 48 }, (_, index) => [
    -0.01 + (index % 2 ? 0.001 : -0.001),
    -0.02 + (index % 3 ? 0.001 : -0.001),
  ]);
  const result = Q.matrixBootstrapPValues(negative, {
    spaReplications: 9999,
    realityReplications: 9999,
    blockLength: 4,
    seed: "negative-spa",
  });
  assert.equal(result.hansenSpa.observedStatistic, 0);
  assert.equal(result.hansenSpa.pValue, 1);
  assert.equal(result.hansenSpa.pValue, result.hansenSpa.upperPValue);
  assert.equal(result.whiteRealityCheck.pValue, 1);
  const sensitivity = Q.matrixBootstrapSensitivity(negative, {
    spaReplications: 999,
    realityReplications: 999,
    blockLengths: [2, 4, 8],
    seed: "negative-spa-sensitivity",
  });
  assert.equal(sensitivity.hansenSpa.pValue,
    Math.max(...sensitivity.hansenSpa.sensitivity.map((item) => item.hansenSpaUpperPValue)));
  assert.equal(sensitivity.whiteRealityCheck.pValue,
    Math.max(...sensitivity.whiteRealityCheck.sensitivity.map((item) => item.whiteRealityCheckPValue)));
});

test("model return matrices require every exact UTC day, including explicit zero-return days", () => {
  const startTs = Date.UTC(2025, 0, 1), endTs = startTs + 4 * Q.DAY_MS;
  const complete = {
    modelIds: ["a", "b"],
    rows: Array.from({ length: 4 }, (_, index) => ({
      ts: startTs + index * Q.DAY_MS,
      returns: index === 2 ? [0, 0] : [0.01, -0.01],
    })),
  };
  assert.equal(Q.normaliseModelReturnMatrix(complete, startTs, endTs, 1).coverageRate, 1);
  const missing = structuredClone(complete);
  missing.rows.splice(1, 1);
  assert.throws(() => Q.normaliseModelReturnMatrix(missing, startTs, endTs, 1), /exactement chaque jour/);
  assert.throws(() => Q.normaliseModelReturnMatrix(complete, startTs, endTs, 0.99), /exactement chaque jour/);
});

test("profit factor and profitability use additive quote PnL, not incomparable trade returns", () => {
  const performance = Q.calculatePerformance([
    { tradeId: "small-win", instId: "A", exitTs: 1, netReturn: 0.10, netPnlQuote: 0.10 },
    { tradeId: "large-loss", instId: "B", exitTs: 2, netReturn: -0.01, netPnlQuote: -1 },
  ]);
  assert.ok(Math.abs(performance.netPnlQuote + 0.9) < 1e-12);
  assert.ok(Math.abs(performance.profitFactor - 0.1) < 1e-12);
  assert.ok(performance.meanReturn > 0);
});

test("legacy PDF trial ledger is counted but rejected until the exact search family is reconstructed", () => {
  const ledger = {
    schemaVersion: 1,
    complete: false,
    trials: [{ id: "pdf", knownHypothesisCountLowerBound: 88, sourceArtifactSha256: "a".repeat(64), eligibleAsEvidence: false }],
  };
  const audit = Q.validateTrialLedger(ledger);
  assert.equal(audit.hypothesisCountLowerBound, 88);
  assert.equal(audit.valid, false);
  assert.ok(audit.reasons.includes("historical_trial_ledger_incomplete"));
});

test("cycle ledger records are deduplicated but require complete recomputable identity and a signed external anchor", () => {
  const candidate = { schemaVersion: 1, family: "carry", executionType: "paper", params: { z: 1 },
    universe: { topN: 30 }, sourcePriorSha256: null };
  const record = Autopilot.trialLedgerRecord(candidate, { allowed: false, reasons: ["x"] }, {
    runId: "r1", recordedAt: "2025-01-01T00:00:00.000Z",
  });
  const cutoffTs = Date.UTC(2025, 0, 2);
  const audit = Q.validateCycleLedger(
    { schemaVersion: 1, complete: true, records: [record, structuredClone(record)] }, cutoffTs);
  assert.equal(audit.hypothesisCount, 1);
  assert.equal(audit.valid, false);
  assert.equal(audit.reasons.includes("cycle_ledger_identite_candidat_incoherente"), false);
  assert.ok(audit.reasons.includes("cycle_ledger_attestation_absente"));
  const forged = structuredClone(record);
  forged.candidateId = "f".repeat(64);
  assert.ok(Q.validateCycleLedger({ schemaVersion: 1, complete: true, records: [forged] }, cutoffTs)
    .reasons.includes("cycle_ledger_identite_candidat_incoherente"));
  assert.ok(Q.validateCycleLedger({ schemaVersion: 1, records: [record] }, cutoffTs)
    .reasons.includes("cycle_ledger_completude_non_attestee"));
  const future = { ...record, recordedAt: new Date(cutoffTs).toISOString() };
  assert.ok(Q.validateCycleLedger({ schemaVersion: 1, complete: true, records: [future] }, cutoffTs)
    .reasons.includes("cycle_ledger_record_apres_cutoff"));
});

test("quant universe is semantically identical to the canonical execution universe and divergence rejects", () => {
  const executionPolicy = require("../config/autopilot.policy.json");
  const equal = Q.auditExecutionUniverseParity({}, executionPolicy);
  assert.equal(equal.verified, true, equal.mismatches.join(","));
  const divergent = structuredClone(executionPolicy);
  divergent.universe.minQuoteVolumeUsd += 1;
  const audit = Q.auditExecutionUniverseParity({}, divergent);
  assert.equal(audit.verified, false);
  assert.ok(audit.mismatches.includes("minQuoteVolume"));
});

test("master completeness rejects every historical swap missing market data and every market swap missing master", () => {
  const cutoffTs = Date.UTC(2025, 0, 1);
  const master = instrumentMasterFor(["M00-USDT-SWAP"], cutoffTs - 200 * Q.DAY_MS, cutoffTs);
  const preparedMissingOld = Q.preparePointInTimeSeries({
    "M00-USDT-SWAP": [{ ts: cutoffTs - 2, availableAt: cutoffTs - 1, close: 1, quoteVolume: 1, confirmed: true }],
  }, { barMs: 1 });
  const missing = Q.auditInstrumentMasterMarketCoverage(master, preparedMissingOld, cutoffTs, smallUniversePolicy);
  assert.ok(missing.missingMarketSeries.includes("OLD-USDT-SWAP"));
  assert.ok(missing.reasons.includes("instrument_master_swap_sans_market_series"));
  const preparedExtra = Q.preparePointInTimeSeries({
    "M00-USDT-SWAP": [{ ts: cutoffTs - 2, availableAt: cutoffTs - 1, close: 1, quoteVolume: 1, confirmed: true }],
    "OLD-USDT-SWAP": [{ ts: cutoffTs - 20, availableAt: cutoffTs - 19, close: 1, quoteVolume: 1, confirmed: true }],
    "GHOST-USDT-SWAP": [{ ts: cutoffTs - 2, availableAt: cutoffTs - 1, close: 1, quoteVolume: 1, confirmed: true }],
  }, { barMs: 1 });
  const extra = Q.auditInstrumentMasterMarketCoverage(master, preparedExtra, cutoffTs, smallUniversePolicy);
  assert.ok(extra.marketSeriesWithoutMaster.includes("GHOST-USDT-SWAP"));
  assert.ok(extra.reasons.includes("market_series_swap_sans_instrument_master"));
});

test("CLI exposes explicit cycle-ledger and execution-policy contracts", () => {
  assert.deepEqual(CLI.parseArgs(["--input", "run.json", "--output", "proof.json",
    "--cycle-ledger", "cycle.json", "--execution-policy", "autopilot.json"]), {
    input: "run.json", output: "proof.json", cycleLedger: "cycle.json", executionPolicy: "autopilot.json",
  });
});

test("research lifecycle never auto-authorizes live and requires two verified signatures for eligibility", () => {
  const candidate = { id: "s", version: "1", configSha256: "a".repeat(64) };
  assert.equal(Q.advanceResearchLifecycle({ currentState: "discovery", candidate }).state, "validate");
  assert.equal(Q.advanceResearchLifecycle({ currentState: "validate", validationEvidence: { decision: "passed", liveAuthorized: false } }).state, "shadow");
  const unsigned = Q.advanceResearchLifecycle({ currentState: "shadow", shadowEvidence: { days: 90, trades: 100, netReturn: 1 } });
  assert.equal(unsigned.state, "shadow");
  assert.ok(unsigned.reasons.includes("preuve_non_signee"));
  const eligible = Q.advanceResearchLifecycle({
    currentState: "shadow", shadowEvidence: { days: 90, trades: 100, netReturn: 1 },
    evidenceSignatureVerified: true, approvalSignatureVerified: true,
  });
  assert.equal(eligible.state, "eligible");
  assert.equal(eligible.liveAuthorized, false);
});

function fullSyntheticRun() {
  const cutoffTs = Date.UTC(2026, 0, 1);
  const universe = {
    ...smallUniversePolicy,
    rebalanceMs: 30 * Q.DAY_MS,
    maxEndpointStalenessMs: 2 * Q.DAY_MS,
  };
  const policy = Q.mergePolicy({
    universe,
    costs: { maxFeeSnapshotStalenessMs: 2_000 * Q.DAY_MS },
    statistics: { blockLength: 12 },
    gates: {
      minimumTradesPerHorizon: 1,
      minimumProfitableFoldRate: 0,
      maximumProfitConcentration: 1,
      maximumDrawdownPct: 1,
      minimumProfitFactor: 0.1,
      maximumPbo: 0.2,
      minimumDeflatedSharpeProbability: 0,
      maximumSpaPValue: 0.01,
      maximumRealityCheckPValue: 0.01,
      maximumTop5ProfitConcentration: 1,
      maximumBasketProfitConcentration: 1,
      maximumYearProfitConcentrationByHorizon: { 365: 1, 730: 1, 1095: 1 },
      minimumEffectiveTradingDayRate: 0.02,
      minimumIndependentBasketsPerYear: 1,
    },
  });
  const firstTs = Q.requiredDataStart(cutoffTs, 1095, policy) - Q.DAY_MS;
  const series = {};
  for (let instrument = 0; instrument < 31; instrument++) {
    const instId = `S${String(instrument).padStart(2, "0")}-USDT-SWAP`;
    series[instId] = [];
    let close = 100;
    for (let availableAt = firstTs; availableAt <= cutoffTs; availableAt += Q.DAY_MS) {
      close *= 1 + (instrument + 1) / 100_000;
      series[instId].push({ ts: availableAt - Q.DAY_MS, availableAt, close, quoteVolume: 1e9,
        spreadBps: 1, spreadAvailableAt: availableAt, confirmed: true });
    }
  }
  series["OLD-USDT-SWAP"] = [];
  for (let availableAt = firstTs; availableAt <= cutoffTs - 10 * Q.DAY_MS; availableAt += Q.DAY_MS) {
    series["OLD-USDT-SWAP"].push({ ts: availableAt - Q.DAY_MS, availableAt,
      close: 50, quoteVolume: 1e9, spreadBps: 1, spreadAvailableAt: availableAt, confirmed: true });
  }
  const feeBody = Q.feeSnapshotBody({
    source: { venue: "OKX", endpoint: "/api/v5/account/trade-fee", datasetId: "fees-test",
      retrievalBatchId: "fees-batch", sourceArtifactSha256: "f".repeat(64) },
    accountTier: "test-tier", instrumentType: "SWAP", availableAt: firstTs - Q.DAY_MS,
    makerFeeRate: 0.0002, takerFeeRate: 0.0005,
  });
  const feeSnapshot = { ...feeBody, snapshotSha256: Q.sha256Canonical(feeBody) };
  const fills = [];
  const config = { signal: "synthetic-only", threshold: 1 };
  const configSha256 = Q.sha256Canonical(config);
  const candidateIdentity = Q.quantitativeCandidateIdentity({
    schemaVersion: 1, family: "synthetic", executionType: "paper", params: { signal: "test" },
    universe: policy.universe, perles: null, sourcePriorSha256: null,
  });
  const cycleCandidateId = Q.quantitativeCandidateId(candidateIdentity);
  const familyModelIds = [
    "synthetic-process:v1",
    "discarded-a",
    "discarded-b",
    `universe:top30-default-test:${Q.sha256Canonical(policy.universe)}`,
    "historical:old-search:old-search:h1",
    `cycle:cycle-test:${cycleCandidateId}`,
  ];
  const horizons = policy.requiredHorizonsDays.map((days) => {
    const startTs = cutoffTs - days * Q.DAY_MS;
    const historyStartTs = startTs - policy.walkForward.minimumTrainingMs
      - Math.max(policy.walkForward.purgeMs, policy.walkForward.embargoMs, policy.walkForward.labelHorizonMs);
    const folds = Q.buildNestedPurgedWalkForward({
      evaluationStartTs: startTs,
      endTs: cutoffTs,
      historyStartTs,
      walkForward: policy.walkForward,
    }).map((fold) => ({
      ...fold,
      selectionCompletedAt: fold.test.startTs,
      selectionDataMaxAvailableAt: fold.train.endTsExclusive,
      strategy: { id: "synthetic-process", version: "1.0.0-test", config, configSha256 },
      hypothesesEvaluated: ["synthetic-process:v1", "discarded-a", "discarded-b"],
      trades: [
        syntheticTrade(fills, feeSnapshot, `${days}-${fold.id}-L`, "long", fold.test.startTs + 1, fold.test.startTs + 2, 4),
        syntheticTrade(fills, feeSnapshot, `${days}-${fold.id}-S`, "short", fold.test.startTs + 3, fold.test.startTs + 4, -1),
      ],
    }));
    const modelRows = Array.from({ length: days }, (_, index) => ({
      ts: startTs + index * Q.DAY_MS,
      returns: [
        0.02 + (index % 2 ? 0.001 : -0.001),
        -0.01 + (index % 3 ? 0.002 : -0.002),
        -0.005 + (index % 5 ? 0.0005 : -0.0005),
        -0.006 + (index % 7 ? 0.0005 : -0.0005),
        -0.007 + (index % 11 ? 0.0004 : -0.0004),
        -0.008 + (index % 13 ? 0.0003 : -0.0003),
      ],
    }));
    const allTrades = folds.flatMap((fold) => fold.trades).sort((a, b) => a.exitTs - b.exitTs);
    let equity = 10_000;
    const events = [{ ts: startTs, equity, realizedNetPnlQuoteDelta: 0, markToMarketPnlQuote: 0,
      externalCashflowQuote: 0, tradeIds: [], markPriceObservationSha256: null }];
    for (const trade of allTrades) {
      const fillEntry = fills.find((fill) => fill.fillId === trade.entryFillIds[0]);
      const fillExit = fills.find((fill) => fill.fillId === trade.exitFillIds[0]);
      const gross = trade.side === "long" ? fillExit.price - fillEntry.price : fillEntry.price - fillExit.price;
      const net = gross - (fillEntry.price + fillExit.price) * feeSnapshot.takerFeeRate;
      equity += net;
      events.push({ ts: trade.exitTs, equity, realizedNetPnlQuoteDelta: net, markToMarketPnlQuote: 0,
        externalCashflowQuote: 0, tradeIds: [trade.tradeId], markPriceObservationSha256: "e".repeat(64) });
    }
    events.push({ ts: cutoffTs, equity, realizedNetPnlQuoteDelta: 0, markToMarketPnlQuote: 0,
      externalCashflowQuote: 0, tradeIds: [], markPriceObservationSha256: "e".repeat(64) });
    return {
      days,
      startTs,
      endTsExclusive: cutoffTs,
      folds,
      nullMethod: "full-process-block-permutation",
      nullStatistic: "mean-net-pnl-quote-per-trade-over-initial-equity",
      selectionRerunForEveryNull: true,
      nullProcessStatistics: new Array(9999).fill(-0.01),
      modelReturnMatrix: {
        method: "daily-net-after-complete-costs",
        returnUnit: "shared-portfolio-equity-return",
        zeroReturnDaysExplicit: true,
        containsEveryTrial: true,
        modelIds: familyModelIds,
        rows: modelRows,
      },
      portfolioSimulation: {
        synchronized: true,
        method: "event-driven-shared-equity",
        correlationStressIncluded: true,
        initialEquity: 10_000,
        events,
        returnSeriesSha256: Q.sha256Canonical({ initialEquity: 10_000, events }),
      },
    };
  });
  const executionSource = { venue: "OKX", endpoint: "/api/v5/trade/fills-history", datasetId: "fills-test",
    retrievalBatchId: "fills-batch", sourceArtifactSha256: "a".repeat(64) };
  const executionDraft = Q.prepareExecutionDataset({ source: executionSource, fills,
    executionDatasetSha256: "0".repeat(64) }, cutoffTs);
  const cycleRecord = {
    schemaVersion: 1, recordedAt: new Date(cutoffTs - Q.DAY_MS).toISOString(), runId: "cycle-test",
    candidateId: cycleCandidateId, family: candidateIdentity.family,
    executionType: candidateIdentity.executionType, sourcePriorSha256: null,
    paramsSha256: Q.sha256Canonical(candidateIdentity.params),
    universeSha256: Q.sha256Canonical(candidateIdentity.universe), accepted: false,
    rejectionReasons: ["fixture"], primaryMetrics: null, candidateIdentity,
  };
  const executionPolicy = {
    schemaVersion: 1,
    universe: {
      venue: policy.universe.venue, instrumentType: "SWAP", quoteCurrency: "USDT", instrumentCategory: "1",
      ranking: "absolute-return-24h", rankingMetric: "absolute-log-return",
      rankingWindowHours: policy.universe.rankingWindowMs / 3_600_000,
      topN: 30, refreshMinutes: policy.universe.rebalanceMs / 60_000, barMinutes: policy.universe.barMs / 60_000,
      minQuoteVolumeUsd: policy.universe.minQuoteVolume, maxTickerAgeMs: policy.universe.maxEndpointStalenessMs,
      maxSpreadBps: policy.universe.maxSpreadBps,
      minListingDays: policy.universe.minimumListingAgeMs / Q.DAY_MS,
      minTimeToDelistDays: policy.universe.minimumTimeToDelistMs / Q.DAY_MS,
      requiredInstrumentState: "live", requiredRuleType: "normal", requireLiveState: true,
      requireSpotHedgeForCarry: true, pointInTimeSnapshotsRequired: true,
    },
  };
  return {
    policy,
    prepared: Q.preparePointInTimeSeries(series, { barMs: Q.DAY_MS }),
    instrumentMaster: instrumentMasterFor(Object.keys(series).filter((id) => id !== "OLD-USDT-SWAP"),
      firstTs - 200 * Q.DAY_MS, cutoffTs),
    runRecord: {
      runId: "offline-synthetic-1",
      candidateId: Q.quantitativeCandidateId(candidateIdentity),
      candidateIdentity,
      cutoffTs,
      source: { venue: "OKX", datasetId: "synthetic-not-real", retrievalBatchId: "fixture-1", endpoint: "offline://fixture" },
      feeSnapshots: [feeSnapshot],
      executionDataset: { source: executionSource, fills,
        executionDatasetSha256: executionDraft.executionDatasetSha256 },
      universeHypothesesEvaluated: [{
        id: "top30-default-test",
        config: policy.universe,
        configSha256: Q.sha256Canonical(policy.universe),
      }],
      horizons,
    },
    ledger: {
      schemaVersion: 1,
      complete: true,
      trials: [{
        id: "old-search",
        knownHypothesisCountLowerBound: 1,
        sourceArtifactSha256: "b".repeat(64),
        eligibleAsEvidence: false,
        hypotheses: [{
          id: "old-search:h1",
          strategyVersion: "legacy-test",
          configSha256: "c".repeat(64),
          universeConfigSha256: "d".repeat(64),
        }],
      }],
    },
    cycleLedger: { schemaVersion: 1, complete: true, records: [cycleRecord] },
    executionPolicy,
  };
}

function syntheticTrade(fills, feeSnapshot, tradeId, side, entryTs, exitTs, grossPnlQuote) {
  const entryPrice = 100;
  const exitPrice = side === "long" ? entryPrice + grossPnlQuote : entryPrice - grossPnlQuote;
  const entryFillId = `${tradeId}-entry`, exitFillId = `${tradeId}-exit`;
  fills.push({ fillId: entryFillId, instId: "S30-USDT-SWAP", ts: entryTs, availableAt: entryTs,
    side: side === "long" ? "buy" : "sell", liquidity: "taker", price: entryPrice, quantity: 1, contractValue: 1 });
  fills.push({ fillId: exitFillId, instId: "S30-USDT-SWAP", ts: exitTs, availableAt: exitTs,
    side: side === "long" ? "sell" : "buy", liquidity: "taker", price: exitPrice, quantity: 1, contractValue: 1 });
  return {
    tradeId,
    instId: "S30-USDT-SWAP",
    side,
    entryTs,
    exitTs,
    entryFillIds: [entryFillId],
    exitFillIds: [exitFillId],
    feeSnapshotSha256: feeSnapshot.snapshotSha256,
    makerFeeRateApplied: feeSnapshot.makerFeeRate,
    takerFeeRateApplied: feeSnapshot.takerFeeRate,
    riskCapitalQuote: 100,
    grossPnlBasis: "fill-to-fill",
    entryLiquidity: "taker",
    exitLiquidity: "taker",
    entryHalfSpreadBps: 0,
    exitHalfSpreadBps: 0,
    entrySlippageBps: 0,
    exitSlippageBps: 0,
    entryImpactBps: 0,
    exitImpactBps: 0,
    entryLatencyBps: 0,
    exitLatencyBps: 0,
    fundingCostQuote: 0,
    borrowCostQuote: 0,
    rejectionCostQuote: 0,
    liquidationCostQuote: 0,
    requestedQty: 1,
    filledQty: 1,
    rejected: false,
  };
}

function signedFullSyntheticRun() {
  const fixture = fullSyntheticRun();
  const executionKeys = crypto.generateKeyPairSync("ed25519");
  const cycleKeys = crypto.generateKeyPairSync("ed25519");
  const executionAnchor = Q.publicKeySpkiSha256(executionKeys.publicKey);
  const cycleAnchor = Q.publicKeySpkiSha256(cycleKeys.publicKey);
  fixture.policy = Q.mergePolicy({
    ...fixture.policy,
    attestations: {
      executionAndProcess: {
        ...fixture.policy.attestations.executionAndProcess,
        publicKeySpkiSha256: executionAnchor,
      },
      cycleLedger: {
        ...fixture.policy.attestations.cycleLedger,
        publicKeySpkiSha256: cycleAnchor,
      },
    },
  });
  const trust = {
    executionAttestationPublicKey: executionKeys.publicKey,
    expectedExecutionAttestationPublicKeySpkiSha256: executionAnchor,
    cycleLedgerAttestationPublicKey: cycleKeys.publicKey,
    expectedCycleLedgerAttestationPublicKeySpkiSha256: cycleAnchor,
    expectedQuantPolicySha256: Q.sha256Canonical(fixture.policy),
  };
  const request = Q.compileQuantitativeEvidence({
    runRecord: fixture.runRecord,
    prepared: fixture.prepared,
    instrumentMaster: fixture.instrumentMaster,
    policy: fixture.policy,
    trialLedger: fixture.ledger,
    cycleLedger: fixture.cycleLedger,
    executionPolicy: fixture.executionPolicy,
    ...trust,
  }).attestationRequests;
  fixture.runRecord.executionDataset.attestation = signAttestation(
    request.executionDataset, Q.QUANT_EXECUTION_SIGNATURE_DOMAIN, executionKeys.privateKey);
  fixture.runRecord.quantProcessAttestation = signAttestation(
    request.quantProcess, Q.QUANT_PROCESS_SIGNATURE_DOMAIN, executionKeys.privateKey);
  fixture.cycleLedger.attestation = signAttestation(
    request.cycleLedger, Q.QUANT_CYCLE_LEDGER_SIGNATURE_DOMAIN, cycleKeys.privateKey);
  return { ...fixture, trust, executionKeys, cycleKeys };
}

test("a complete run with pinned, distinct and domain-separated attestations can pass end to end", () => {
  const fixture = signedFullSyntheticRun();
  const result = Q.compileQuantitativeEvidence({
    runRecord: fixture.runRecord, prepared: fixture.prepared, instrumentMaster: fixture.instrumentMaster,
    policy: fixture.policy, trialLedger: fixture.ledger, cycleLedger: fixture.cycleLedger,
    executionPolicy: fixture.executionPolicy, ...fixture.trust,
  });
  assert.equal(result.evidence.decision, "passed", result.evidence.rejectionReasons.join(","));
  assert.equal(result.evidence.liveAuthorized, false);
  assert.equal(result.evidence.quantPolicyAnchorVerified, true);
  assert.equal(result.executionDatasetAudit.verified, true, result.executionDatasetAudit.reasons.join(","));
  assert.equal(result.cycleLedgerAudit.valid, true, result.cycleLedgerAudit.reasons.join(","));
  assert.equal(result.processAttestationAudit.verified, true, result.processAttestationAudit.reasons.join(","));
  assert.ok(result.evidence.horizons.every((report) => report.decision === "provisionally-passed"));
  assert.ok(result.evidence.horizons.every((report) => report.advancedTests.coverageRate === 1));
  assert.ok(result.evidence.horizons.every((report) => report.advancedTests.deflatedSharpe.valid === true));
  assert.ok(result.evidence.horizons.every((report) =>
    report.advancedTests.hansenSpa.pValue === report.advancedTests.hansenSpa.upperPValue));
  assert.ok(result.evidence.horizons.every((report) =>
    JSON.stringify(report.bootstrapDiagnostics.net.blockLengths) === JSON.stringify([6, 12, 24, 48])));
  assert.ok(result.evidence.horizons.every((report) =>
    report.advancedTests.hansenSpa.selectedWorstBlockLength != null
      && report.advancedTests.whiteRealityCheck.selectedWorstBlockLength != null
      && report.advancedTests.deflatedSharpe.selectedWorstBlockLength != null));
  assert.ok(result.evidence.horizons.every((report) =>
    report.costAccounting.grossPnlBasis === "fill-to-fill"
      && report.costAccounting.observedExecutionFriction === "embedded-in-fill-prices-diagnostic-only"));
  assert.ok(result.evidence.horizons.every((report) => report.portfolioNetReturn > 0));
  assert.equal(result.evidence.methodology.processLevel, true);
  assert.equal(result.evidence.methodology.portfolioMetricsRecomputed, true);
  assert.equal(result.evidence.methodology.exclusiveFillToFillCostDecomposition, true);
  assert.equal(result.processReplayManifest.costAccounting.grossPnlBasis, "fill-to-fill");
  assert.equal(result.attestationRequests.quantProcess.claims.exclusiveFillToFillCostDecompositionReplayed, true);
});

test("tampering, cross-domain signatures, same keys and a missing external policy anchor fail closed", () => {
  const fixture = signedFullSyntheticRun();
  const args = {
    prepared: fixture.prepared, instrumentMaster: fixture.instrumentMaster, policy: fixture.policy,
    trialLedger: fixture.ledger, cycleLedger: fixture.cycleLedger,
    executionPolicy: fixture.executionPolicy, ...fixture.trust,
  };
  const tampered = structuredClone(fixture.runRecord);
  tampered.executionDataset.fills[0].price += 1;
  const changed = Q.compileQuantitativeEvidence({ ...args, runRecord: tampered });
  assert.equal(changed.evidence.decision, "rejected");
  assert.ok(changed.executionDatasetAudit.reasons.includes("execution_dataset_hash_invalide"));
  assert.ok(changed.executionDatasetAudit.reasons.includes("execution_attestation_payload_incoherent"));

  const crossed = structuredClone(fixture.runRecord);
  crossed.quantProcessAttestation.signature = crypto.sign(null,
    Buffer.from(Q.quantAttestationSigningPayload(Q.QUANT_EXECUTION_SIGNATURE_DOMAIN,
      crossed.quantProcessAttestation), "utf8"), fixture.executionKeys.privateKey).toString("base64");
  const crossDomain = Q.compileQuantitativeEvidence({ ...args, runRecord: crossed });
  assert.equal(crossDomain.processAttestationAudit.verified, false);
  assert.ok(crossDomain.processAttestationAudit.reasons.includes("quant_process_attestation_signature_non_verifiee"));

  const noPolicyAnchor = Q.compileQuantitativeEvidence({ ...args, runRecord: fixture.runRecord,
    expectedQuantPolicySha256: null });
  assert.ok(noPolicyAnchor.evidence.rejectionReasons.includes("quant_policy_ancre_externe_non_configuree"));
  assert.throws(() => Q.mergePolicy({ attestations: {
    executionAndProcess: { publicKeySpkiSha256: "a".repeat(64) },
    cycleLedger: { publicKeySpkiSha256: "a".repeat(64) },
  } }), /doivent etre distinctes/);
});

test("catalog enrichment mutates only the exact candidate after a passed untampered proof", () => {
  const fixture = signedFullSyntheticRun();
  const { evidence } = Q.compileQuantitativeEvidence({
    runRecord: fixture.runRecord, prepared: fixture.prepared, instrumentMaster: fixture.instrumentMaster,
    policy: fixture.policy, trialLedger: fixture.ledger, cycleLedger: fixture.cycleLedger,
    executionPolicy: fixture.executionPolicy, ...fixture.trust,
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-quant-catalog-"));
  const file = path.join(directory, "candidates.json");
  const candidate = { ...fixture.runRecord.candidateIdentity, horizonReports: [], validationStatus: "discovery-only" };
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, candidates: [candidate] }));
  const enriched = CLI.enrichCandidateCatalog({ file, candidateId: evidence.candidateId, evidence });
  assert.equal(enriched.reports, 3);
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(after.candidates[0].horizonReports.length, 3);
  assert.ok(after.candidates[0].horizonReports.every((report) =>
    report.candidateId === evidence.candidateId && report.quantPolicySha256 === evidence.policySha256));
  assert.equal(Autopilot.candidateId(after.candidates[0]), evidence.candidateId);
  const autopilotAssessment = Autopilot.assessHorizonBundle(after.candidates[0].horizonReports, {
    expectedCandidateId: Autopilot.candidateId(after.candidates[0]),
    expectedQuantPolicySha256: after.candidates[0].quantPolicySha256,
    minimumCoverageRatio: 1,
    minimumFolds: 1,
    minOosTrades: 1,
    minOosDays: 1095,
    minNullReplications: 1,
    maxFamilywisePValue: 1,
    maxPbo: 1,
    minDeflatedSharpeProbability: 0,
    minProfitableFoldRate: 0,
    maxProfitConcentration: 1,
    maxDrawdownPct: 1,
    minProfitFactor: 0,
    maxCalendarYearProfitConcentration: 1,
    maxInstrumentProfitConcentration: 1,
    maxTopFiveProfitConcentration: 1,
    minimumIndependentBaskets: 1,
    minimumEffectiveDays: 1,
  });
  assert.equal(autopilotAssessment.allowed, true, autopilotAssessment.reasons.join(","));

  const baseline = fs.readFileSync(file, "utf8");
  assert.throws(() => CLI.enrichCandidateCatalog({ file, candidateId: "f".repeat(64), evidence }), /ne correspond pas/);
  assert.equal(fs.readFileSync(file, "utf8"), baseline);
  const rejected = { ...evidence, decision: "rejected" };
  assert.throws(() => CLI.enrichCandidateCatalog({ file, candidateId: evidence.candidateId, evidence: rejected }),
    /rejetee ou alteree/);
  assert.equal(fs.readFileSync(file, "utf8"), baseline);
  const tampered = structuredClone(evidence);
  tampered.horizons[0].netMeanPerTrade += 1;
  assert.throws(() => CLI.enrichCandidateCatalog({ file, candidateId: evidence.candidateId, evidence: tampered }),
    /rejetee ou alteree/);
  assert.equal(fs.readFileSync(file, "utf8"), baseline);
  const selfRehashedForgery = structuredClone(evidence);
  selfRehashedForgery.horizons[0].netMeanPerTrade += 1;
  delete selfRehashedForgery.evidenceSha256;
  selfRehashedForgery.evidenceSha256 = Q.sha256Canonical(selfRehashedForgery);
  assert.equal(Q.verifyQuantitativeEvidenceHash(selfRehashedForgery), true);
  assert.throws(() => Q.toAutopilotHorizonReports(selfRehashedForgery), /compilation courante/);
  assert.throws(() => CLI.enrichCandidateCatalog({ file, candidateId: evidence.candidateId,
    evidence: selfRehashedForgery }), /rejetee ou alteree/);
  assert.equal(fs.readFileSync(file, "utf8"), baseline);
  evidence.horizons[0].netMeanPerTrade += 1;
  delete evidence.evidenceSha256;
  evidence.evidenceSha256 = Q.sha256Canonical(evidence);
  assert.equal(Q.verifyQuantitativeEvidenceHash(evidence), true);
  assert.equal(Q.isFreshlyCompiledQuantitativeEvidence(evidence), false);
  assert.throws(() => CLI.enrichCandidateCatalog({ file, candidateId: evidence.candidateId, evidence }),
    /rejetee ou alteree/);
  assert.equal(fs.readFileSync(file, "utf8"), baseline);
});

test("evidence compiler evaluates comparable 1y/2y/3y process runs at one cutoff", () => {
  const fixture = fullSyntheticRun();
  const first = Q.compileQuantitativeEvidence({
    runRecord: fixture.runRecord,
    prepared: fixture.prepared,
    instrumentMaster: fixture.instrumentMaster,
    policy: fixture.policy,
    trialLedger: fixture.ledger,
    cycleLedger: fixture.cycleLedger,
    executionPolicy: fixture.executionPolicy,
  });
  const second = Q.compileQuantitativeEvidence({
    runRecord: fixture.runRecord,
    prepared: fixture.prepared,
    instrumentMaster: fixture.instrumentMaster,
    policy: fixture.policy,
    trialLedger: fixture.ledger,
    cycleLedger: fixture.cycleLedger,
    executionPolicy: fixture.executionPolicy,
  });
  assert.equal(first.evidence.decision, "rejected");
  assert.deepEqual(first.evidence.horizons.map((item) => item.days), [365, 730, 1095]);
  assert.ok(first.evidence.horizons.every((item) => item.endTsExclusive === fixture.runRecord.cutoffTs));
  assert.ok(first.evidence.horizons.every((item) => item.rosterCoverageRate === 1));
  assert.ok(first.evidence.horizons.every((item) => item.minimumDataCoverage.sufficient));
  assert.ok(first.evidence.horizons.every((item) => item.reasons.includes("matrice_et_null_non_rejoues_depuis_donnees")));
  assert.ok(first.evidence.horizons.every((item) => item.reasons.includes("risk_capital_et_couts_non_rejoues_depuis_donnees")));
  assert.ok(first.evidence.horizons.every((item) => item.portfolioSynchronized === false && item.completeCostModel === false));
  assert.equal(first.evidence.evidenceSha256, second.evidence.evidenceSha256);
  assert.equal(first.evidence.liveAuthorized, false);
});

test("compiler excludes duplicate/empty trade IDs, exact-matches model family and enforces applied fee tier", () => {
  const fixture = fullSyntheticRun();
  const h365 = fixture.runRecord.horizons.find((horizon) => horizon.days === 365);
  h365.folds[0].trades[1].tradeId = h365.folds[0].trades[0].tradeId;
  h365.folds[1].trades[0].tradeId = "   ";
  const h730 = fixture.runRecord.horizons.find((horizon) => horizon.days === 730);
  h730.modelReturnMatrix.modelIds.push("not-evaluated");
  for (const row of h730.modelReturnMatrix.rows) row.returns.push(-0.02);
  const h1095 = fixture.runRecord.horizons.find((horizon) => horizon.days === 1095);
  h1095.folds[0].trades[0].makerFeeRateApplied = 0;
  h1095.folds[0].trades[1].grossPnlQuote = 999;
  h1095.folds[1].trades[0].grossPnlBasis = "mid-to-mid";
  const { evidence } = Q.compileQuantitativeEvidence({
    runRecord: fixture.runRecord, prepared: fixture.prepared, instrumentMaster: fixture.instrumentMaster,
    policy: fixture.policy, trialLedger: fixture.ledger, cycleLedger: fixture.cycleLedger,
    executionPolicy: fixture.executionPolicy,
  });
  const r365 = evidence.horizons.find((report) => report.days === 365);
  assert.ok(r365.reasons.includes("trade_id_duplique"));
  assert.ok(r365.reasons.includes("trade_id_absent"));
  assert.equal(r365.trades, h365.folds.reduce((sum, fold) => sum + fold.trades.length, 0) - 2);
  const r730 = evidence.horizons.find((report) => report.days === 730);
  assert.ok(r730.reasons.includes("matrice_modeles_ne_couvre_pas_exactement_hypotheses"));
  const r1095 = evidence.horizons.find((report) => report.days === 1095);
  assert.ok(r1095.reasons.includes("fee_snapshot_taux_non_appliques"));
  assert.ok(r1095.reasons.includes("pnl_ou_notionnel_declare_non_reconcilie"));
  assert.ok(r1095.reasons.includes("base_pnl_brute_absente_ou_ambigue"));
  assert.ok(r1095.tradeValidationErrors.some((item) => item.reason === "base_pnl_brute_absente_ou_ambigue"));
});

test("canonical adapter refuses rejected horizons, rejected evidence and tampering", () => {
  const fixture = fullSyntheticRun();
  const { evidence } = Q.compileQuantitativeEvidence({
    runRecord: fixture.runRecord,
    prepared: fixture.prepared,
    instrumentMaster: fixture.instrumentMaster,
    policy: fixture.policy,
    trialLedger: fixture.ledger,
    cycleLedger: fixture.cycleLedger,
    executionPolicy: fixture.executionPolicy,
  });
  assert.throws(() => Q.toAutopilotHorizonReports(evidence), /preuve quantitative rejetee/);
  const horizonRejected = structuredClone(evidence);
  horizonRejected.decision = "passed";
  horizonRejected.rejectionReasons = [];
  delete horizonRejected.evidenceSha256;
  horizonRejected.evidenceSha256 = Q.sha256Canonical(horizonRejected);
  assert.throws(() => Q.toAutopilotHorizonReports(horizonRejected), /horizon quantitatif/);
  const tampered = structuredClone(evidence);
  tampered.horizons[0].netMeanPerTrade += 1;
  assert.throws(() => Q.toAutopilotHorizonReports(tampered), /hash de preuve/);
});
