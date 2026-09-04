"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  STRATEGY_FAMILY,
  carryRosterSha256,
  selectPointInTimeMovers,
  robustFundingForecast,
  enumerateCarryCandidates,
  sizeDeltaNeutral,
  authorizeCarryCandidate,
  createOrchestratorProposal,
  generateCarryConfigurationSpace,
  generateAndScoreCarryCandidates,
  evaluateCarryHorizons,
  evaluateCarryExit,
} = require("../modules/carry_strategy.js");

const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const YEAR = 365.25 * DAY;

function fundingHistory(rate, count = 12) {
  return Array.from({ length: count }, (_, index) => ({
    timestampMs: NOW - (count - index) * 8 * HOUR,
    rate,
  }));
}

function spotLeg(overrides = {}) {
  return {
    asset: "BTC",
    venue: "OKX",
    kind: "spot",
    instType: "SPOT",
    instCategory: "1",
    state: "live",
    ruleType: "normal",
    instrumentId: "BTC-USDT",
    active: true,
    canLong: true,
    canShort: false,
    observedAtMs: NOW,
    bid: 99.99,
    ask: 100.01,
    volume24hUsd: 20_000_000,
    bookDepthUsd: 100_000,
    takerFeeBps: 2,
    feeObservedAtMs: NOW,
    slippageBps: 1,
    impactBps: 0.5,
    borrowApr: 0.05,
    borrowAvailableUsd: 50_000,
    lotSize: 0.0001,
    baseUnitsPerOrderUnit: 1,
    maxLeverage: 2,
    basisVolAnnualized: 0.2,
    priceCorrelation: 0.995,
    ...overrides,
  };
}

function perpLeg(overrides = {}) {
  return {
    asset: "BTC",
    venue: "OKX",
    kind: "perp",
    instType: "SWAP",
    instCategory: "1",
    state: "live",
    ruleType: "normal",
    instrumentId: "BTC-USDT-SWAP",
    active: true,
    canLong: true,
    canShort: true,
    observedAtMs: NOW,
    bid: 100.49,
    ask: 100.51,
    volume24hUsd: 50_000_000,
    bookDepthUsd: 200_000,
    openInterestUsd: 50_000_000,
    takerFeeBps: 2,
    feeObservedAtMs: NOW,
    slippageBps: 1,
    impactBps: 0.5,
    fundingIntervalHours: 8,
    fundingHistory: fundingHistory(0.002),
    lotSize: 1,
    contractValueBase: 0.01,
    maxLeverage: 2,
    basisVolAnnualized: 0.2,
    priceCorrelation: 0.995,
    ...overrides,
  };
}

function moverAsset(index, overrides = {}) {
  const magnitude = (index + 1) / 100;
  const end = 100 * (1 + (index % 2 ? -magnitude : magnitude));
  const legs = [
    spotLeg({ asset: `C${index}`, instrumentId: `C${index}-USDT` }),
    perpLeg({ asset: `C${index}`, instrumentId: `C${index}-USDT-SWAP` }),
  ];
  return {
    asset: `C${index}`,
    listingTimeMs: NOW - 365 * DAY,
    market: {
      venue: "OKX", instType: "SPOT", instCategory: "1", state: "live", ruleType: "normal",
      observedAtMs: NOW, volume24hUsd: 20_000_000, bookDepthUsd: 200_000, spreadBps: 2,
      liquidityHistory: Array.from({ length: 30 }, (_, sample) => ({
        timestampMs: NOW - sample * DAY,
        volume24hUsd: 20_000_000,
        bookDepthUsd: 200_000,
        spreadBps: 2,
      })),
    },
    priceHistory: [
      { timestampMs: NOW - 24 * HOUR, price: 100, confirmed: true },
      { timestampMs: NOW, price: end, confirmed: true },
    ],
    legs,
    ...overrides,
  };
}

test("univers OKX: top 30 movers absolus, haussiers et baissiers, sans fuite future", () => {
  const assets = Array.from({ length: 35 }, (_, index) => moverAsset(index));
  assets.push(moverAsset(99, {
    asset: "ILLIQ",
    market: {
      venue: "OKX", instType: "SPOT", instCategory: "1", state: "live", ruleType: "normal",
      observedAtMs: NOW, volume24hUsd: 1, bookDepthUsd: 1, spreadBps: 500,
    },
  }));
  const first = selectPointInTimeMovers({ assets, asOfMs: NOW });
  assert.equal(first.topN, 30);
  assert.equal(first.accepted, true);
  assert.equal(first.selected.length, 30);
  assert.ok(first.selected.some((row) => row.direction === "up"));
  assert.ok(first.selected.some((row) => row.direction === "down"));
  assert.equal(first.selected[0].asset, "C34");
  assert.ok(first.excluded.find((row) => row.asset === "ILLIQ").reasons.includes("spread_excessif"));

  const withFutureShock = assets.map((asset) => asset.asset === "C0"
      ? {
        ...asset,
        priceHistory: [...asset.priceHistory, { timestampMs: NOW + 1, price: 1_000_000, confirmed: true }],
        market: {
          ...asset.market,
          liquidityHistory: [...asset.market.liquidityHistory, {
            timestampMs: NOW + 1, volume24hUsd: 0, bookDepthUsd: 0, spreadBps: 10000,
          }],
        },
      }
    : asset);
  const second = selectPointInTimeMovers({ assets: withFutureShock, asOfMs: NOW });
  assert.deepEqual(second, first);
});

test("univers OKX: métadonnée future, listing récent et jambe manquante sont rejetés", () => {
  const futureMarket = moverAsset(1, { market: {
    venue: "OKX", instType: "SPOT", instCategory: "1", state: "live", ruleType: "normal",
    observedAtMs: NOW + 1, volume24hUsd: 20_000_000, bookDepthUsd: 200_000, spreadBps: 2,
  } });
  const recent = moverAsset(2, { listingTimeMs: NOW - 2 * DAY });
  const oneLeg = moverAsset(3, { legs: [spotLeg({ asset: "C3", instrumentId: "C3-USDT" })] });
  const missingListing = moverAsset(4, { listingTimeMs: null });
  const wrongCategory = moverAsset(5, { market: { ...moverAsset(5).market, instCategory: "2" } });
  const suspendedLegs = moverAsset(6, { legs: [
    spotLeg({ asset: "C6", instrumentId: "C6-USDT", state: "suspend" }),
    perpLeg({ asset: "C6", instrumentId: "C6-USDT-SWAP", ruleType: "pre_market" }),
  ] });
  const wrongVenueLegs = moverAsset(7, { legs: [
    spotLeg({ asset: "C7", instrumentId: "C7-USDT", venue: "BINANCE" }),
    perpLeg({ asset: "C7", instrumentId: "C7-USDT-SWAP", venue: "BINANCE" }),
  ] });
  const result = selectPointInTimeMovers({
    assets: [futureMarket, recent, oneLeg, missingListing, wrongCategory, suspendedLegs, wrongVenueLegs],
    asOfMs: NOW,
  });
  assert.equal(result.selected.length, 0);
  assert.equal(result.accepted, false);
  assert.ok(result.excluded.find((row) => row.asset === "C1").reasons.includes("marche_perime_ou_futur"));
  assert.ok(result.excluded.find((row) => row.asset === "C2").reasons.includes("anciennete_insuffisante"));
  assert.ok(result.excluded.find((row) => row.asset === "C3").reasons.includes("jambes_indisponibles"));
  assert.ok(result.excluded.find((row) => row.asset === "C4").reasons.includes("anciennete_insuffisante"));
  assert.ok(result.excluded.find((row) => row.asset === "C5").reasons.includes("categorie_crypto_invalide"));
  assert.ok(result.excluded.find((row) => row.asset === "C6").reasons.includes("jambes_indisponibles"));
  assert.ok(result.excluded.find((row) => row.asset === "C7").reasons.includes("jambes_indisponibles"));
});

test("forecast funding: winsorisation, persistance et exclusion stricte du futur", () => {
  const leg = perpLeg({ fundingHistory: [...fundingHistory(0.001), { timestampMs: NOW + 1, rate: -10 }] });
  const config = {
    minFundingSamples: 6,
    fundingLookbackDays: 30,
    maxFundingAgeHours: 24,
    maxAbsFundingRatePerInterval: 0.01,
    fundingHalfLifeSamples: 12,
    fundingWinsorQuantile: 0.1,
    fundingPersistenceFloor: 0.25,
  };
  const forecast = robustFundingForecast(leg, NOW, config);
  assert.equal(forecast.valid, true);
  assert.equal(forecast.samples, 12);
  assert.ok(Math.abs(forecast.ratePerInterval - 0.001) < 1e-12);
  assert.equal(robustFundingForecast(perpLeg({ fundingHistory: fundingHistory(0.001, 2) }), NOW, config).valid, false);
});

test("carry spot-perp: le funding reçu doit rester positif après coûts et stress", () => {
  const legs = [spotLeg(), perpLeg()];
  const candidates = enumerateCarryCandidates({ asset: "BTC", legs, asOfMs: NOW });
  const winner = candidates.find((candidate) => candidate.longLegId === "BTC-USDT" && candidate.shortLegId === "BTC-USDT-SWAP");
  assert.equal(winner.eligible, true);
  assert.ok(winner.fundingBps > 50);
  assert.ok(winner.netEdgeBps > 0);
  assert.ok(winner.stressedEdgeBps >= 1);
  const impossibleReverse = candidates.find((candidate) => candidate.longLegId === "BTC-USDT-SWAP");
  assert.equal(impossibleReverse.eligible, false);
  assert.ok(impossibleReverse.reasons.includes("cote_non_empruntable"));
});

test("carry: coûts élevés et emprunt cher invalident les faux profits", () => {
  const highCost = enumerateCarryCandidates({
    asset: "BTC",
    legs: [spotLeg({ takerFeeBps: 20, slippageBps: 15 }), perpLeg({ takerFeeBps: 20, slippageBps: 15 })],
    asOfMs: NOW,
  }).find((candidate) => candidate.longLegId === "BTC-USDT");
  assert.equal(highCost.eligible, false);
  assert.ok(highCost.reasons.includes("edge_net_insuffisant"));
  const missingCost = enumerateCarryCandidates({
    asset: "BTC",
    legs: [spotLeg({ takerFeeBps: null }), perpLeg()],
    asOfMs: NOW,
  }).find((candidate) => candidate.longLegId === "BTC-USDT");
  assert.equal(missingCost.eligible, false);
  assert.ok(missingCost.reasons.includes("long_cout_incomplet"));
  const staleFee = enumerateCarryCandidates({
    asset: "BTC",
    legs: [spotLeg({ feeObservedAtMs: NOW - 25 * HOUR }), perpLeg()],
    asOfMs: NOW,
  }).find((candidate) => candidate.longLegId === "BTC-USDT");
  assert.equal(staleFee.eligible, false);
  assert.ok(staleFee.reasons.includes("long_frais_perimes"));

  const negativeFunding = perpLeg({ fundingHistory: fundingHistory(-0.002) });
  const expensiveBorrow = spotLeg({ canShort: true, borrowApr: 5 });
  const reverse = enumerateCarryCandidates({ asset: "BTC", legs: [expensiveBorrow, negativeFunding], asOfMs: NOW })
    .find((candidate) => candidate.longLegId === "BTC-USDT-SWAP");
  assert.equal(reverse.eligible, false);
  assert.ok(reverse.financingBps > 100);
});

test("sizing: notionnels limités et quantités delta-neutres après arrondi de lots", () => {
  const legs = [spotLeg(), perpLeg()];
  const opportunity = enumerateCarryCandidates({ asset: "BTC", legs, asOfMs: NOW })
    .find((candidate) => candidate.eligible);
  const sizing = sizeDeltaNeutral({ opportunity, legs, equityUsd: 100_000 });
  assert.equal(sizing.allowed, true);
  assert.ok(sizing.matchedNotionalUsd <= 5_001);
  assert.equal(sizing.deltaBaseUnits, 0);
  assert.equal(sizing.deltaMismatchBps, 0);
  assert.ok(sizing.grossNotionalUsd <= 10_100);

  const blocked = sizeDeltaNeutral({
    opportunity,
    legs,
    equityUsd: 100_000,
    portfolio: { assetNetDeltaUsd: { BTC: 1_000 } },
  });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.reasons.includes("delta_preexistant_excessif"));
});

test("orchestrateur: aucune activation sans gate global et entrée roster exactement identique", () => {
  const legs = [spotLeg(), perpLeg()];
  const opportunity = enumerateCarryCandidates({ asset: "BTC", legs, asOfMs: NOW }).find((candidate) => candidate.eligible);
  const sizing = sizeDeltaNeutral({
    opportunity,
    legs,
    equityUsd: 100_000,
    portfolio: {
      authoritative: true,
      grossNotionalUsd: 0,
      collateralUsedUsd: 0,
      assetGrossNotionalUsd: { BTC: 0 },
      assetNetDeltaUsd: { BTC: 0 },
      venueGrossNotionalUsd: { OKX: 0 },
    },
  });
  assert.equal(sizing.portfolioAuthoritative, true);
  assert.equal(sizing.allowed, true);
  const empty = createOrchestratorProposal({ opportunity, sizing, asOfMs: NOW });
  assert.equal(empty.status, "SHADOW_ONLY");
  assert.equal(empty.authorizedForLive, false);

  const approvedRoster = { perles: { [opportunity.id]: {
    strategyFamily: STRATEGY_FAMILY,
    asset: opportunity.asset,
    configSha256: opportunity.configSha256,
    longLegId: opportunity.longLegId,
    shortLegId: opportunity.shortLegId,
  } } };
  assert.equal(authorizeCarryCandidate({ opportunity, approvedRoster, liveGate: { allowed: false, rosterSha256: carryRosterSha256(approvedRoster) } }).allowed, false);
  approvedRoster.perles[opportunity.id].configSha256 = "0".repeat(64);
  assert.equal(authorizeCarryCandidate({ opportunity, approvedRoster, liveGate: { allowed: true, rosterSha256: carryRosterSha256(approvedRoster) } }).allowed, false);
  approvedRoster.perles[opportunity.id].configSha256 = opportunity.configSha256;
  assert.equal(authorizeCarryCandidate({
    opportunity,
    approvedRoster,
    liveGate: { allowed: true, rosterSha256: carryRosterSha256(approvedRoster) },
  }).allowed, true);
  const stillShadow = createOrchestratorProposal({
    opportunity,
    sizing,
    approvedRoster,
    liveGate: { allowed: true, rosterSha256: carryRosterSha256(approvedRoster) },
    asOfMs: NOW,
  });
  assert.equal(stillShadow.status, "SHADOW_ONLY");
  assert.equal(stillShadow.authorizedForLive, false);
  assert.equal(stillShadow.legs.length, 0);
  assert.equal(stillShadow.researchLegs.length, 2);
  assert.ok(stillShadow.reasons.includes("executeur_atomique_absent"));
});

test("génération autonome: espace borné et scoring sont déterministes", () => {
  const a = generateCarryConfigurationSpace();
  const b = generateCarryConfigurationSpace();
  assert.equal(a.length, 27);
  assert.deepEqual(a, b);
  assert.equal(new Set(a.map((candidate) => candidate.configSha256)).size, 27);

  const asset = moverAsset(10, { asset: "BTC", legs: [spotLeg(), perpLeg()] });
  const args = {
    assets: [asset],
    marketsByAsset: { BTC: [spotLeg(), perpLeg()] },
    asOfMs: NOW,
    equityUsd: 100_000,
    config: { universe: { topN: 1 } },
  };
  const first = generateAndScoreCarryCandidates(args);
  const second = generateAndScoreCarryCandidates(args);
  assert.deepEqual(first, second);
  assert.ok(first.candidates.length >= 2);
  assert.equal(first.candidates[0].proposal.status, "SHADOW_ONLY");
});

test("évaluation 1/2/3 ans: même cutoff, régimes distincts, coûts et futur exclus", () => {
  const observations = [];
  for (let ageDays = 1095; ageDays >= 0; ageDays -= 1) {
    const timestampMs = NOW - ageDays * DAY;
    const rate = ageDays <= 365 ? 0.001 : ageDays <= 730 ? -0.001 : 0.0006;
    const basis = 0.5 * (ageDays / 1095);
    observations.push({
      timestampMs,
      long: { kind: "spot", price: 100, borrowApr: 0, takerFeeBps: 2, spreadBps: 2, slippageBps: 1, impactBps: 0.5 },
      short: { kind: "perp", price: 100 + basis, fundingRatePaid: rate, takerFeeBps: 2, spreadBps: 2, slippageBps: 1, impactBps: 0.5 },
    });
  }
  const diagnosticConfig = { backtest: {
    samplingContractVersion: "carry-static-pair-daily-test-v1",
    expectedIntervalMs: DAY,
    maxGapMs: 2 * DAY,
    maxEndpointGapMs: DAY,
    minimumCoverageRatio: 0.99,
    minimumDensityRatio: 0.99,
  } };
  const base = evaluateCarryHorizons({ observations, cutoffMs: NOW, config: diagnosticConfig });
  assert.deepEqual(base.map((row) => row.years), [1, 2, 3]);
  assert.ok(base.every((row) => row.cutoffMs === NOW && row.valid));
  assert.ok(base.every((row) => row.diagnosticType === "STATIC_PAIR_CARRY_DIAGNOSTIC_V1"));
  assert.ok(base.every((row) => row.confirmatoryPortfolioBacktest === false));
  assert.ok(base.every((row) => row.coverageRatio >= 0.99 && row.densityRatio >= 0.99));
  assert.ok(base[0].netReturnBps > 0);
  assert.ok(base[1].netReturnBps < base[0].netReturnBps);
  assert.notEqual(base[2].netReturnBps, base[1].netReturnBps);
  assert.ok(base.every((row) => row.executionCostBps > 0 && row.financingBps > 0));

  const futurePoison = { ...observations.at(-1), timestampMs: NOW + 1, short: { ...observations.at(-1).short, fundingRatePaid: -999 } };
  assert.deepEqual(evaluateCarryHorizons({
    observations: [...observations, futurePoison], cutoffMs: NOW, config: diagnosticConfig,
  }), base);

  const missingFunding = observations.map((row, index) => index === 1
    ? { ...row, short: { ...row.short, fundingRatePaid: null } }
    : row);
  const invalid = evaluateCarryHorizons({ observations: missingFunding, cutoffMs: NOW, config: diagnosticConfig });
  assert.ok(invalid.some((row) => row.valid === false && row.reasons.includes("funding_short_manquant")));

  const twoPoints = evaluateCarryHorizons({
    observations: [observations[0], observations.at(-1)],
    cutoffMs: NOW,
    horizonsYears: [3],
    config: diagnosticConfig,
  })[0];
  assert.ok(twoPoints.coverageRatio >= 0.99, "les endpoints seuls donnent une couverture calendaire trompeuse");
  assert.equal(twoPoints.valid, false);
  assert.ok(twoPoints.reasons.includes("densite_echantillonnage_insuffisante"));
  assert.ok(twoPoints.reasons.includes("trou_interne_excessif"));

  const internalHole = observations.filter((row) => !(
    row.timestampMs > NOW - 201 * DAY && row.timestampMs < NOW - 189 * DAY
  ));
  const holed = evaluateCarryHorizons({
    observations: internalHole,
    cutoffMs: NOW,
    horizonsYears: [1],
    config: diagnosticConfig,
  })[0];
  assert.equal(holed.valid, false);
  assert.ok(holed.reasons.includes("densite_echantillonnage_insuffisante"));
  assert.ok(holed.reasons.includes("trou_interne_excessif"));

  const missingStart = evaluateCarryHorizons({
    observations: observations.filter((row) => row.timestampMs >= NOW - 350 * DAY),
    cutoffMs: NOW,
    horizonsYears: [1],
    config: diagnosticConfig,
  })[0];
  assert.equal(missingStart.valid, false);
  assert.ok(missingStart.reasons.includes("endpoint_debut_trop_eloigne"));
});

test("diagnostic statique: le contrat de fréquence et le seuil 99 % sont obligatoires", () => {
  assert.throws(
    () => evaluateCarryHorizons({ observations: [], cutoffMs: NOW, config: { backtest: { expectedIntervalMs: null } } }),
    /backtest\.expectedIntervalMs/
  );
  assert.throws(
    () => evaluateCarryHorizons({ observations: [], cutoffMs: NOW, config: { backtest: { minimumCoverageRatio: 0.98 } } }),
    /backtest\.minimumCoverageRatio/
  );
  assert.throws(
    () => evaluateCarryHorizons({ observations: [], cutoffMs: NOW, config: { backtest: { maxGapMs: HOUR } } }),
    /backtest\.maxGapMs/
  );
});

test("exit: hold sain, rebalance mesuré et sortie immédiate sur dégradation", () => {
  const position = {
    openedAtMs: NOW - HOUR,
    entryBasisBps: 100,
    unrealizedPnlBps: 0,
    adverseFundingIntervals: 0,
    shortKind: "perp",
  };
  const healthyLeg = { observedAtMs: NOW, venueHealthy: true, spreadBps: 2, bookDepthUsd: 100_000 };
  const healthy = {
    long: healthyLeg,
    short: healthyLeg,
    basisBps: 20,
    deltaDriftBps: 0,
    remainingNetEdgeBps: 5,
  };
  assert.equal(evaluateCarryExit({ position, market: healthy, nowMs: NOW }).action, "HOLD");
  assert.equal(evaluateCarryExit({ position, market: { ...healthy, deltaDriftBps: 30 }, nowMs: NOW }).action, "REBALANCE");
  const diverged = evaluateCarryExit({ position, market: { ...healthy, basisBps: 260 }, nowMs: NOW });
  assert.equal(diverged.action, "EXIT");
  assert.equal(diverged.urgency, "emergency");
  const stale = evaluateCarryExit({ position, market: { ...healthy, long: { ...healthyLeg, observedAtMs: NOW - 100_000 } }, nowMs: NOW });
  assert.equal(stale.urgency, "emergency");
  const adverse = evaluateCarryExit({ position: { ...position, adverseFundingIntervals: 2 }, market: healthy, nowMs: NOW });
  assert.equal(adverse.action, "EXIT");
  assert.ok(adverse.reasons.includes("funding_adverse_persistant"));
});
