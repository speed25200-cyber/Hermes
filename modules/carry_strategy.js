"use strict";

/*
 * Market-neutral carry research engine.
 *
 * This module is deliberately pure: it reads no clock, file, environment
 * variable or exchange endpoint and it never sends an order.  Its output is a
 * deterministic proposal that the live orchestrator may consume only after
 * the existing signed roster/evidence gate has approved the exact strategy
 * and configuration hash.
 */

const crypto = require("node:crypto");

const STRATEGY_FAMILY = "hermes-market-neutral-carry-v1";
/* No atomic two-leg executor exists in Hermes today. Changing this constant is
   a code change covered by engineSha256 and therefore requires new evidence. */
const ATOMIC_EXECUTOR_IMPLEMENTED = false;
const MS_HOUR = 3600e3;
const MS_DAY = 24 * MS_HOUR;
const MS_YEAR = 365.25 * MS_DAY;

const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: 1,
  universe: Object.freeze({
    venue: "OKX",
    topN: 30,
    rebalanceHours: 1,
    lookbackHours: 24,
    lookbackToleranceHours: 2,
    liquidityLookbackDays: 30,
    minLiquiditySamples: 20,
    minListingAgeDays: 90,
    minVolume24hUsd: 10_000_000,
    minBookDepthUsd: 100_000,
    minOpenInterestUsd: 10_000_000,
    maxSpreadBps: 12,
    maxSpreadP95Bps: 25,
    maxQuoteAgeMs: 2_000,
    maxMarketDataAgeMs: 2_000,
  }),
  economics: Object.freeze({
    horizonHours: 24,
    minFundingSamples: 6,
    fundingLookbackDays: 30,
    maxFundingAgeHours: 24,
    maxAbsFundingRatePerInterval: 0.01,
    maxFeeAgeHours: 24,
    fundingHalfLifeSamples: 12,
    fundingWinsorQuantile: 0.10,
    fundingPersistenceFloor: 0.25,
    fundingRetentionStress: 0.35,
    adverseFundingMultiplier: 1.25,
    basisMeanReversionFraction: 0.20,
    basisRetentionStress: 0,
    minNetEdgeBps: 8,
    minStressedEdgeBps: 1,
    maxAbsEntryBasisBps: 300,
    maxBasisVolAnnualized: 0.80,
    minPriceCorrelation: 0.95,
    capitalChargeApr: 0.04,
  }),
  risk: Object.freeze({
    maxPairNotionalPctEquity: 0.10,
    maxGrossNotionalPctEquity: 0.50,
    maxAssetGrossPctEquity: 0.15,
    maxVenueGrossPctEquity: 0.35,
    maxCollateralPctEquity: 0.25,
    maxBookParticipationPct: 0.05,
    maxDailyVolumeParticipationPct: 0.0005,
    maxOpenInterestParticipationPct: 0.001,
    maxLeverage: 2,
    minMatchedNotionalUsd: 100,
    maxDeltaMismatchBps: 5,
    maxPreExistingDeltaPctEquity: 0.005,
  }),
  backtest: Object.freeze({
    samplingContractVersion: "carry-static-pair-8h-v1",
    expectedIntervalMs: 8 * MS_HOUR,
    maxGapMs: 2 * 8 * MS_HOUR,
    maxEndpointGapMs: 8 * MS_HOUR,
    minimumCoverageRatio: 0.99,
    minimumDensityRatio: 0.99,
  }),
  exit: Object.freeze({
    maxHoldingHours: 24 * 30,
    maxQuoteAgeMs: 2_000,
    maxSpreadBps: 25,
    minBookDepthUsd: 25_000,
    maxBasisWideningBps: 150,
    closeBasisBps: 5,
    maxDeltaDriftBps: 25,
    emergencyDeltaDriftBps: 100,
    maxLossBps: 150,
    adverseFundingIntervals: 2,
    minRemainingEdgeBps: 0,
  }),
});

function finite(value, fallback = null) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function mergeConfig(config = {}) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...config,
    universe: { ...DEFAULT_CONFIG.universe, ...(config.universe || {}) },
    economics: { ...DEFAULT_CONFIG.economics, ...(config.economics || {}) },
    risk: { ...DEFAULT_CONFIG.risk, ...(config.risk || {}) },
    backtest: { ...DEFAULT_CONFIG.backtest, ...(config.backtest || {}) },
    exit: { ...DEFAULT_CONFIG.exit, ...(config.exit || {}) },
  };
  validateConfig(merged);
  return merged;
}

function requireRange(value, minimum, maximum, name, integer = false) {
  if (!Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
    throw new Error(`configuration carry invalide: ${name}`);
  }
}

function validateConfig(config) {
  if (Number(config.schemaVersion) !== 1) throw new Error("configuration carry invalide: schemaVersion");
  const u = config.universe;
  if (typeof u.venue !== "string" || !u.venue.trim()) throw new Error("configuration carry invalide: universe.venue");
  requireRange(u.topN, 1, 100, "universe.topN", true);
  requireRange(u.rebalanceHours, 1, 24 * 30, "universe.rebalanceHours");
  requireRange(u.lookbackHours, 1, 24 * 30, "universe.lookbackHours");
  requireRange(u.lookbackToleranceHours, 0, u.lookbackHours, "universe.lookbackToleranceHours");
  requireRange(u.liquidityLookbackDays, 1, 3650, "universe.liquidityLookbackDays");
  requireRange(u.minLiquiditySamples, 2, 10000, "universe.minLiquiditySamples", true);
  requireRange(u.minListingAgeDays, 0, 36500, "universe.minListingAgeDays");
  requireRange(u.minVolume24hUsd, 0, 1e15, "universe.minVolume24hUsd");
  requireRange(u.minBookDepthUsd, 0, 1e15, "universe.minBookDepthUsd");
  requireRange(u.minOpenInterestUsd, 0, 1e15, "universe.minOpenInterestUsd");
  requireRange(u.maxSpreadBps, 0, 1000, "universe.maxSpreadBps");
  requireRange(u.maxSpreadP95Bps, u.maxSpreadBps, 10000, "universe.maxSpreadP95Bps");
  requireRange(u.maxQuoteAgeMs, 1, MS_DAY, "universe.maxQuoteAgeMs");
  requireRange(u.maxMarketDataAgeMs, 1, MS_DAY, "universe.maxMarketDataAgeMs");

  const e = config.economics;
  requireRange(e.horizonHours, 1 / 60, 24 * 365, "economics.horizonHours");
  requireRange(e.minFundingSamples, 1, 10000, "economics.minFundingSamples", true);
  requireRange(e.fundingLookbackDays, 1, 3650, "economics.fundingLookbackDays");
  requireRange(e.maxFundingAgeHours, 1, 24 * 30, "economics.maxFundingAgeHours");
  requireRange(e.maxAbsFundingRatePerInterval, 0.000001, 1, "economics.maxAbsFundingRatePerInterval");
  requireRange(e.maxFeeAgeHours, 1, 24 * 30, "economics.maxFeeAgeHours");
  requireRange(e.fundingHalfLifeSamples, 1, 10000, "economics.fundingHalfLifeSamples");
  requireRange(e.fundingWinsorQuantile, 0, 0.49, "economics.fundingWinsorQuantile");
  requireRange(e.fundingPersistenceFloor, 0, 1, "economics.fundingPersistenceFloor");
  requireRange(e.fundingRetentionStress, 0, 1, "economics.fundingRetentionStress");
  requireRange(e.adverseFundingMultiplier, 1, 10, "economics.adverseFundingMultiplier");
  requireRange(e.basisMeanReversionFraction, 0, 1, "economics.basisMeanReversionFraction");
  requireRange(e.basisRetentionStress, -1, 1, "economics.basisRetentionStress");
  requireRange(e.minNetEdgeBps, -1000, 10000, "economics.minNetEdgeBps");
  requireRange(e.minStressedEdgeBps, -1000, 10000, "economics.minStressedEdgeBps");
  requireRange(e.maxAbsEntryBasisBps, 0, 10000, "economics.maxAbsEntryBasisBps");
  requireRange(e.maxBasisVolAnnualized, 0, 10, "economics.maxBasisVolAnnualized");
  requireRange(e.minPriceCorrelation, -1, 1, "economics.minPriceCorrelation");
  requireRange(e.capitalChargeApr, 0, 10, "economics.capitalChargeApr");

  const r = config.risk;
  for (const key of ["maxPairNotionalPctEquity", "maxGrossNotionalPctEquity", "maxAssetGrossPctEquity", "maxVenueGrossPctEquity", "maxCollateralPctEquity", "maxBookParticipationPct", "maxDailyVolumeParticipationPct", "maxOpenInterestParticipationPct", "maxPreExistingDeltaPctEquity"]) {
    requireRange(r[key], 0, 1, `risk.${key}`);
  }
  requireRange(r.maxLeverage, 1, 20, "risk.maxLeverage");
  requireRange(r.minMatchedNotionalUsd, 0, 1e9, "risk.minMatchedNotionalUsd");
  requireRange(r.maxDeltaMismatchBps, 0, 10000, "risk.maxDeltaMismatchBps");

  const b = config.backtest;
  if (typeof b.samplingContractVersion !== "string" || !b.samplingContractVersion.trim()) {
    throw new Error("configuration carry invalide: backtest.samplingContractVersion");
  }
  requireRange(b.expectedIntervalMs, 60_000, 30 * MS_DAY, "backtest.expectedIntervalMs", true);
  requireRange(b.maxGapMs, b.expectedIntervalMs, 90 * MS_DAY, "backtest.maxGapMs", true);
  requireRange(b.maxEndpointGapMs, 0, b.maxGapMs, "backtest.maxEndpointGapMs", true);
  requireRange(b.minimumCoverageRatio, 0.99, 1, "backtest.minimumCoverageRatio");
  requireRange(b.minimumDensityRatio, 0.99, 1, "backtest.minimumDensityRatio");

  const x = config.exit;
  requireRange(x.maxHoldingHours, 1, 24 * 3650, "exit.maxHoldingHours");
  requireRange(x.maxQuoteAgeMs, 1, MS_DAY, "exit.maxQuoteAgeMs");
  requireRange(x.maxSpreadBps, 0, 10000, "exit.maxSpreadBps");
  requireRange(x.minBookDepthUsd, 0, 1e15, "exit.minBookDepthUsd");
  requireRange(x.maxBasisWideningBps, 0, 10000, "exit.maxBasisWideningBps");
  requireRange(x.closeBasisBps, 0, 10000, "exit.closeBasisBps");
  requireRange(x.maxDeltaDriftBps, 0, 10000, "exit.maxDeltaDriftBps");
  requireRange(x.emergencyDeltaDriftBps, x.maxDeltaDriftBps, 10000, "exit.emergencyDeltaDriftBps");
  requireRange(x.maxLossBps, 0, 10000, "exit.maxLossBps");
  requireRange(x.adverseFundingIntervals, 1, 100, "exit.adverseFundingIntervals", true);
  requireRange(x.minRemainingEdgeBps, -10000, 10000, "exit.minRemainingEdgeBps");
  return true;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex");
}

function strategyConfigSha256(config) {
  return sha256(mergeConfig(config));
}

function historyPoint(raw) {
  const timestampMs = finite(Array.isArray(raw) ? raw[0] : raw?.timestampMs ?? raw?.ts);
  const price = finite(Array.isArray(raw) ? raw[1] : raw?.price ?? raw?.close);
  const confirmed = Array.isArray(raw) ? raw[2] === true || raw[2] === 1 || raw[2] === "1" : raw?.confirmed === true;
  return timestampMs !== null && price > 0 && confirmed ? { timestampMs, price } : null;
}

function quoteAgeOk(timestampMs, asOfMs, maxAgeMs) {
  return Number.isFinite(timestampMs) && timestampMs <= asOfMs && asOfMs - timestampMs <= maxAgeMs;
}

function quotedSpreadBps(leg) {
  const bid = finite(leg?.bid);
  const ask = finite(leg?.ask);
  if (!(bid > 0) || !(ask >= bid)) return Infinity;
  return (ask - bid) / ((ask + bid) / 2) * 10000;
}

function isLegPointInTimeEligible(leg, asOfMs, universeConfig) {
  const timestampMs = finite(leg?.observedAtMs ?? leg?.quoteTimeMs);
  const common = Boolean(
    leg && leg.active === true && ["spot", "perp"].includes(leg.kind)
    && String(leg.instrumentId || "").trim()
    && quoteAgeOk(timestampMs, asOfMs, universeConfig.maxQuoteAgeMs)
    && finite(leg.volume24hUsd, -1) >= universeConfig.minVolume24hUsd
    && finite(leg.bookDepthUsd, -1) >= universeConfig.minBookDepthUsd
    && (leg.kind !== "perp" || finite(leg.openInterestUsd, -1) >= universeConfig.minOpenInterestUsd)
    && quotedSpreadBps(leg) <= universeConfig.maxSpreadBps
  );
  if (!common) return false;
  /* This candidate is explicitly single-venue OKX. Accepting a leg from a
     different venue would silently change execution, custody and leg-risk
     assumptions while retaining the OKX configuration hash. */
  if (String(leg.venue || "").toUpperCase() !== universeConfig.venue.toUpperCase()) return false;
  const expectedType = leg.kind === "spot" ? "SPOT" : "SWAP";
  return String(leg.instCategory) === "1"
    && String(leg.state || "").toLowerCase() === "live"
    && String(leg.ruleType || "").toLowerCase() === "normal"
    && String(leg.instType || "").toUpperCase() === expectedType;
}

function hasHedgeableLegPair(legs) {
  for (let i = 0; i < legs.length; i += 1) {
    for (let j = i + 1; j < legs.length; j += 1) {
      if (legs[i].instrumentId === legs[j].instrumentId) continue;
      if (legs[i].kind === "spot" && legs[j].kind === "spot") continue;
      if (legs[i].venue === legs[j].venue && legs[i].kind === legs[j].kind) continue;
      return true;
    }
  }
  return false;
}

/*
 * Select the largest absolute past returns at one explicit decision time.
 * Future samples are ignored and never copied into the result. Market and leg
 * metadata must also be timestamped at or before asOfMs.
 */
function selectPointInTimeMovers({ assets, asOfMs, config = {} }) {
  const cfg = mergeConfig(config).universe;
  const decisionMs = finite(asOfMs);
  if (!Number.isFinite(decisionMs)) throw new Error("asOfMs invalide");
  if (!Array.isArray(assets)) throw new Error("assets doit etre un tableau");
  const cutoffMs = decisionMs - cfg.lookbackHours * MS_HOUR;
  const baselineToleranceMs = cfg.lookbackToleranceHours * MS_HOUR;
  const eligible = [];
  const excluded = [];

  for (const record of assets) {
    const asset = String(record?.asset || "").trim().toUpperCase();
    const reasons = [];
    if (!asset) reasons.push("asset_absent");
    const listingTimeMs = finite(record?.listingTimeMs);
    if (listingTimeMs === null || !(listingTimeMs <= decisionMs - cfg.minListingAgeDays * MS_DAY)) reasons.push("anciennete_insuffisante");

    const market = record?.market || {};
    const marketTimestampMs = finite(market.observedAtMs ?? market.timestampMs);
    if (String(market.venue || "").toUpperCase() !== cfg.venue.toUpperCase()) reasons.push("source_marche_invalide");
    if (String(market.instCategory) !== "1") reasons.push("categorie_crypto_invalide");
    if (String(market.state || "").toLowerCase() !== "live") reasons.push("instrument_non_live");
    if (String(market.ruleType || "").toLowerCase() !== "normal") reasons.push("instrument_non_normal");
    if (!["SPOT", "SWAP"].includes(String(market.instType || "").toUpperCase())) reasons.push("type_instrument_invalide");
    if (!quoteAgeOk(marketTimestampMs, decisionMs, cfg.maxMarketDataAgeMs)) reasons.push("marche_perime_ou_futur");
    if (finite(market.volume24hUsd, -1) < cfg.minVolume24hUsd) reasons.push("volume_insuffisant");
    if (finite(market.bookDepthUsd, -1) < cfg.minBookDepthUsd) reasons.push("profondeur_insuffisante");
    if (finite(market.spreadBps, Infinity) > cfg.maxSpreadBps) reasons.push("spread_excessif");

    const liquidityStartMs = decisionMs - cfg.liquidityLookbackDays * MS_DAY;
    const liquidityHistory = (Array.isArray(market.liquidityHistory) ? market.liquidityHistory : [])
      .map((sample) => ({
        timestampMs: finite(sample?.timestampMs ?? sample?.ts),
        volume24hUsd: finite(sample?.volume24hUsd),
        bookDepthUsd: finite(sample?.bookDepthUsd),
        spreadBps: finite(sample?.spreadBps),
      }))
      .filter((sample) => Number.isFinite(sample.timestampMs) && Number.isFinite(sample.volume24hUsd)
        && Number.isFinite(sample.bookDepthUsd) && Number.isFinite(sample.spreadBps)
        && sample.timestampMs >= liquidityStartMs && sample.timestampMs <= decisionMs
        && sample.volume24hUsd >= 0 && sample.bookDepthUsd >= 0 && sample.spreadBps >= 0)
      .sort((a, b) => a.timestampMs - b.timestampMs);
    if (liquidityHistory.length < cfg.minLiquiditySamples) reasons.push("historique_liquidite_insuffisant");
    const medianVolume24hUsd = quantile(liquidityHistory.map((sample) => sample.volume24hUsd).sort((a, b) => a - b), 0.5);
    const medianBookDepthUsd = quantile(liquidityHistory.map((sample) => sample.bookDepthUsd).sort((a, b) => a - b), 0.5);
    const medianSpreadBps = quantile(liquidityHistory.map((sample) => sample.spreadBps).sort((a, b) => a - b), 0.5);
    const spreadP95Bps = quantile(liquidityHistory.map((sample) => sample.spreadBps).sort((a, b) => a - b), 0.95);
    if (medianVolume24hUsd === null || medianVolume24hUsd < cfg.minVolume24hUsd) reasons.push("volume_median_insuffisant");
    if (medianBookDepthUsd === null || medianBookDepthUsd < cfg.minBookDepthUsd) reasons.push("profondeur_mediane_insuffisante");
    if (medianSpreadBps === null || medianSpreadBps > cfg.maxSpreadBps) reasons.push("spread_median_excessif");
    if (spreadP95Bps === null || spreadP95Bps > cfg.maxSpreadP95Bps) reasons.push("spread_p95_excessif");

    const points = (Array.isArray(record?.priceHistory) ? record.priceHistory : [])
      .map(historyPoint)
      .filter((point) => point && point.timestampMs <= decisionMs)
      .sort((a, b) => a.timestampMs - b.timestampMs || a.price - b.price);
    if (points.some((point, index) => index > 0 && point.timestampMs === points[index - 1].timestampMs)) {
      reasons.push("prix_timestamp_duplique");
    }
    const latest = points.at(-1);
    const baseline = points.filter((point) => point.timestampMs <= cutoffMs).at(-1);
    if (!latest || !quoteAgeOk(latest.timestampMs, decisionMs, cfg.maxQuoteAgeMs)) reasons.push("prix_final_absent_ou_perime");
    if (!baseline || cutoffMs - baseline.timestampMs > baselineToleranceMs) reasons.push("prix_depart_absent");

    const eligibleLegs = (Array.isArray(record?.legs) ? record.legs : [])
      .filter((leg) => String(leg?.asset || "").trim().toUpperCase() === asset)
      .filter((leg) => isLegPointInTimeEligible(leg, decisionMs, cfg));
    if (!hasHedgeableLegPair(eligibleLegs)) reasons.push("jambes_indisponibles");

    if (reasons.length) {
      excluded.push({ asset: asset || null, reasons: [...new Set(reasons)].sort() });
      continue;
    }
    const returnPct = latest.price / baseline.price - 1;
    eligible.push({
      asset,
      returnPct,
      absoluteReturnPct: Math.abs(returnPct),
      direction: returnPct > 0 ? "up" : returnPct < 0 ? "down" : "flat",
      startTimestampMs: baseline.timestampMs,
      endTimestampMs: latest.timestampMs,
      startPrice: baseline.price,
      endPrice: latest.price,
      volume24hUsd: market.volume24hUsd,
      bookDepthUsd: market.bookDepthUsd,
      spreadBps: market.spreadBps,
      medianVolume24hUsd,
      medianBookDepthUsd,
      medianSpreadBps,
      spreadP95Bps,
      eligibleLegIds: eligibleLegs.map((leg) => leg.instrumentId).sort(),
    });
  }

  const assetCounts = eligible.reduce((counts, row) => counts.set(row.asset, (counts.get(row.asset) || 0) + 1), new Map());
  for (const [asset, count] of assetCounts) {
    if (count > 1) excluded.push({ asset, reasons: ["asset_duplique"] });
  }
  const uniqueEligible = eligible.filter((row) => assetCounts.get(row.asset) === 1);
  uniqueEligible.sort((a, b) => b.absoluteReturnPct - a.absoluteReturnPct || a.asset.localeCompare(b.asset));
  excluded.sort((a, b) => String(a.asset).localeCompare(String(b.asset)));
  const selected = uniqueEligible.slice(0, cfg.topN);
  const selection = {
    methodology: "point-in-time-absolute-movers-v1",
    asOfMs: decisionMs,
    validUntilMs: decisionMs + cfg.rebalanceHours * MS_HOUR,
    lookbackStartMs: cutoffMs,
    topN: cfg.topN,
    accepted: selected.length === cfg.topN,
    eligibleCount: uniqueEligible.length,
    rejectionReason: selected.length === cfg.topN ? null : "moins_de_movers_eligibles_que_topN",
    selected,
    excluded,
  };
  return { ...selection, snapshotSha256: sha256(selection) };
}

function quantile(sorted, probability) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/* Robust, past-only funding forecast: winsorised EWMA shrunk by observed sign
   persistence. It is intentionally conservative, not a profitability claim. */
function robustFundingForecast(leg, asOfMs, economicsConfig) {
  if (leg?.kind !== "perp") return {
    valid: true, ratePerInterval: 0, intervalHours: 0, samples: 0, signPersistence: 1,
  };
  const lookbackStart = asOfMs - economicsConfig.fundingLookbackDays * MS_DAY;
  const samples = (Array.isArray(leg.fundingHistory) ? leg.fundingHistory : [])
    .map((sample) => ({
      timestampMs: finite(sample?.timestampMs ?? sample?.ts),
      rate: finite(sample?.rate ?? sample?.fundingRate),
    }))
    .filter((sample) => Number.isFinite(sample.timestampMs) && Number.isFinite(sample.rate)
      && sample.timestampMs >= lookbackStart && sample.timestampMs <= asOfMs)
    .sort((a, b) => a.timestampMs - b.timestampMs);
  const intervalHours = finite(leg.fundingIntervalHours);
  if (samples.length < economicsConfig.minFundingSamples || !(intervalHours > 0 && intervalHours <= 24)) {
    return { valid: false, ratePerInterval: 0, intervalHours: intervalHours || 0, samples: samples.length, signPersistence: 0 };
  }
  if (asOfMs - samples.at(-1).timestampMs > economicsConfig.maxFundingAgeHours * MS_HOUR) {
    return {
      valid: false,
      stale: true,
      ratePerInterval: 0,
      intervalHours,
      samples: samples.length,
      signPersistence: 0,
      latestTimestampMs: samples.at(-1).timestampMs,
    };
  }
  if (samples.some((sample) => Math.abs(sample.rate) > economicsConfig.maxAbsFundingRatePerInterval)) {
    return {
      valid: false,
      outOfRange: true,
      ratePerInterval: 0,
      intervalHours,
      samples: samples.length,
      signPersistence: 0,
      latestTimestampMs: samples.at(-1).timestampMs,
    };
  }
  const rates = samples.map((sample) => sample.rate).sort((a, b) => a - b);
  const lower = quantile(rates, economicsConfig.fundingWinsorQuantile);
  const upper = quantile(rates, 1 - economicsConfig.fundingWinsorQuantile);
  const decay = Math.exp(Math.log(0.5) / economicsConfig.fundingHalfLifeSamples);
  let numerator = 0;
  let denominator = 0;
  let weight = 1;
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    numerator += clamp(samples[i].rate, lower, upper) * weight;
    denominator += weight;
    weight *= decay;
  }
  const ewma = numerator / denominator;
  const sign = Math.sign(ewma);
  const sameSign = sign === 0 ? 0 : samples.filter((sample) => Math.sign(sample.rate) === sign).length;
  const signPersistence = samples.length ? sameSign / samples.length : 0;
  const shrink = Math.max(economicsConfig.fundingPersistenceFloor, signPersistence);
  return {
    valid: true,
    ratePerInterval: ewma * shrink,
    rawEwma: ewma,
    intervalHours,
    samples: samples.length,
    signPersistence,
    latestTimestampMs: samples.at(-1).timestampMs,
  };
}

function oneWayExecutionCostBps(leg) {
  const feeBps = Math.max(0, finite(leg?.takerFeeBps, Infinity));
  const slippageBps = Math.max(0, finite(leg?.slippageBps, Infinity));
  const impactBps = Math.max(0, finite(leg?.impactBps, Infinity));
  const halfSpreadBps = quotedSpreadBps(leg) / 2;
  return feeBps + halfSpreadBps + slippageBps + impactBps;
}

function legMid(leg) {
  const bid = finite(leg?.bid);
  const ask = finite(leg?.ask);
  return bid > 0 && ask >= bid ? (bid + ask) / 2 : finite(leg?.markPrice ?? leg?.price);
}

function carryReceivedBps(forecast, side, horizonHours) {
  if (!forecast.valid || !forecast.intervalHours) return 0;
  const sideSign = side === "long" ? 1 : -1;
  return -sideSign * forecast.ratePerInterval * (horizonHours / forecast.intervalHours) * 10000;
}

function financingCostBps(leg, side, horizonHours, economicsConfig) {
  if (leg.kind !== "spot") return 0;
  const years = horizonHours / (24 * 365.25);
  if (side === "short") return Math.max(0, finite(leg.borrowApr, Infinity)) * years * 10000;
  return economicsConfig.capitalChargeApr * years * 10000;
}

function legCanTakeSide(leg, side) {
  if (leg?.active !== true) return false;
  if (side === "long") return leg.canLong !== false;
  if (leg.kind === "perp") return leg.canShort !== false;
  return leg.canShort === true && finite(leg.borrowAvailableUsd, 0) > 0;
}

function candidateIdentifier(asset, longLeg, shortLeg, configHash) {
  const route = [longLeg.venue, longLeg.instrumentId, shortLeg.venue, shortLeg.instrumentId].join(":");
  return `${STRATEGY_FAMILY}:${asset}:${route}:${configHash.slice(0, 16)}`;
}

function scoreCarryOrientation({ asset, longLeg, shortLeg, asOfMs, config }) {
  const cfg = mergeConfig(config);
  const reasons = [];
  const normalizedAsset = String(asset || "").trim().toUpperCase();
  if (!normalizedAsset) reasons.push("asset_absent");
  if (!legCanTakeSide(longLeg, "long") || !legCanTakeSide(shortLeg, "short")) reasons.push("cote_non_empruntable");
  if (longLeg.kind === "spot" && shortLeg.kind === "spot") reasons.push("deux_spots");
  if (String(longLeg.instrumentId) === String(shortLeg.instrumentId)) reasons.push("meme_instrument");
  if (!String(longLeg.instrumentId || "").trim() || !String(shortLeg.instrumentId || "").trim()) reasons.push("instrument_absent");
  if (!String(longLeg.venue || "").trim() || !String(shortLeg.venue || "").trim()) reasons.push("venue_absente");
  if (String(longLeg.asset || "").toUpperCase() !== normalizedAsset
    || String(shortLeg.asset || "").toUpperCase() !== normalizedAsset) reasons.push("sous_jacent_different");
  for (const [name, leg] of [["long", longLeg], ["short", shortLeg]]) {
    const quoteTime = finite(leg.observedAtMs ?? leg.quoteTimeMs);
    if (!quoteAgeOk(quoteTime, asOfMs, cfg.universe.maxQuoteAgeMs)) reasons.push(`${name}_quote_perimee`);
    if (!(legMid(leg) > 0) || !Number.isFinite(oneWayExecutionCostBps(leg))) reasons.push(`${name}_cout_incomplet`);
    if (!quoteAgeOk(finite(leg.feeObservedAtMs), asOfMs, cfg.economics.maxFeeAgeHours * MS_HOUR)) reasons.push(`${name}_frais_perimes`);
    if (finite(leg.volume24hUsd, -1) < cfg.universe.minVolume24hUsd) reasons.push(`${name}_volume_insuffisant`);
    if (finite(leg.bookDepthUsd, -1) < cfg.universe.minBookDepthUsd) reasons.push(`${name}_profondeur_insuffisante`);
    if (leg.kind === "perp" && finite(leg.openInterestUsd, -1) < cfg.universe.minOpenInterestUsd) reasons.push(`${name}_open_interest_insuffisant`);
  }
  const longPrice = legMid(longLeg);
  const shortPrice = legMid(shortLeg);
  const basisBps = longPrice > 0 && shortPrice > 0 ? Math.log(shortPrice / longPrice) * 10000 : Infinity;
  if (Math.abs(basisBps) > cfg.economics.maxAbsEntryBasisBps) reasons.push("basis_excessive");
  const longBasisVol = finite(longLeg.basisVolAnnualized);
  const shortBasisVol = finite(shortLeg.basisVolAnnualized);
  const basisVol = longBasisVol === null || shortBasisVol === null ? null : Math.max(longBasisVol, shortBasisVol);
  if (basisVol === null) reasons.push("volatilite_basis_absente");
  else if (basisVol > cfg.economics.maxBasisVolAnnualized) reasons.push("volatilite_basis_excessive");
  const longCorrelation = finite(longLeg.priceCorrelation);
  const shortCorrelation = finite(shortLeg.priceCorrelation);
  const correlation = longCorrelation === null || shortCorrelation === null ? null : Math.min(longCorrelation, shortCorrelation);
  if (correlation === null) reasons.push("correlation_absente");
  else if (correlation < cfg.economics.minPriceCorrelation) reasons.push("correlation_insuffisante");

  const longFunding = robustFundingForecast(longLeg, asOfMs, cfg.economics);
  const shortFunding = robustFundingForecast(shortLeg, asOfMs, cfg.economics);
  if (!longFunding.valid) reasons.push("funding_long_insuffisant");
  if (!shortFunding.valid) reasons.push("funding_short_insuffisant");
  const longFundingBps = carryReceivedBps(longFunding, "long", cfg.economics.horizonHours);
  const shortFundingBps = carryReceivedBps(shortFunding, "short", cfg.economics.horizonHours);
  const fundingBps = longFundingBps + shortFundingBps;
  const financingBps = financingCostBps(longLeg, "long", cfg.economics.horizonHours, cfg.economics)
    + financingCostBps(shortLeg, "short", cfg.economics.horizonHours, cfg.economics);
  const executionCostBps = 2 * (oneWayExecutionCostBps(longLeg) + oneWayExecutionCostBps(shortLeg));
  const basisForecastBps = basisBps * cfg.economics.basisMeanReversionFraction;
  const grossEdgeBps = fundingBps + basisForecastBps;
  const netEdgeBps = grossEdgeBps - financingBps - executionCostBps;
  const stressedFundingBps = (longFundingBps >= 0
    ? longFundingBps * cfg.economics.fundingRetentionStress
    : longFundingBps * cfg.economics.adverseFundingMultiplier)
    + (shortFundingBps >= 0
      ? shortFundingBps * cfg.economics.fundingRetentionStress
      : shortFundingBps * cfg.economics.adverseFundingMultiplier);
  const stressedBasisBps = basisForecastBps >= 0
    ? basisForecastBps * cfg.economics.basisRetentionStress
    : basisForecastBps * cfg.economics.adverseFundingMultiplier;
  const stressedEdgeBps = stressedFundingBps + stressedBasisBps - financingBps - executionCostBps;
  if (netEdgeBps < cfg.economics.minNetEdgeBps) reasons.push("edge_net_insuffisant");
  if (stressedEdgeBps < cfg.economics.minStressedEdgeBps) reasons.push("edge_stresse_insuffisant");

  const configHash = strategyConfigSha256(cfg);
  const id = candidateIdentifier(normalizedAsset, longLeg, shortLeg, configHash);
  return {
    id,
    strategyFamily: STRATEGY_FAMILY,
    configSha256: configHash,
    asset: normalizedAsset,
    asOfMs,
    horizonHours: cfg.economics.horizonHours,
    eligible: reasons.length === 0,
    reasons: [...new Set(reasons)].sort(),
    longLegId: longLeg.instrumentId,
    shortLegId: shortLeg.instrumentId,
    longVenue: longLeg.venue,
    shortVenue: shortLeg.venue,
    basisBps,
    fundingBps,
    basisForecastBps,
    financingBps,
    executionCostBps,
    grossEdgeBps,
    netEdgeBps,
    stressedEdgeBps,
    fundingForecast: { long: longFunding, short: shortFunding },
  };
}

function enumerateCarryCandidates({ asset, legs, asOfMs, config = {} }) {
  if (!Array.isArray(legs)) return [];
  const out = [];
  for (let i = 0; i < legs.length; i += 1) {
    for (let j = i + 1; j < legs.length; j += 1) {
      const a = legs[i];
      const b = legs[j];
      if (a.kind === "spot" && b.kind === "spot") continue;
      if (a.kind === b.kind && a.venue === b.venue) continue;
      out.push(scoreCarryOrientation({ asset, longLeg: a, shortLeg: b, asOfMs, config }));
      out.push(scoreCarryOrientation({ asset, longLeg: b, shortLeg: a, asOfMs, config }));
    }
  }
  return out.sort((a, b) => b.stressedEdgeBps - a.stressedEdgeBps
    || b.netEdgeBps - a.netEdgeBps || a.id.localeCompare(b.id));
}

function legOrderUnitBase(leg) {
  if (leg.kind === "spot") return finite(leg.baseUnitsPerOrderUnit, 1);
  return finite(leg.contractValueBase);
}

function floorToStep(value, step) {
  if (!(value > 0) || !(step > 0)) return 0;
  return Math.floor((value + Number.EPSILON) / step) * step;
}

function sizeDeltaNeutral({ opportunity, legs, equityUsd, portfolio = {}, config = {} }) {
  const cfg = mergeConfig(config);
  const byId = new Map((legs || []).map((leg) => [leg.instrumentId, leg]));
  const longLeg = byId.get(opportunity?.longLegId);
  const shortLeg = byId.get(opportunity?.shortLegId);
  const reasons = [];
  const equity = finite(equityUsd, 0);
  if (!(equity > 0)) reasons.push("equity_invalide");
  if (!opportunity?.eligible) reasons.push("opportunite_ineligible");
  if (!longLeg || !shortLeg) reasons.push("jambe_absente");
  if (byId.size !== (legs || []).length) reasons.push("identifiant_jambe_duplique");
  if (reasons.length) return { allowed: false, reasons };

  const asset = opportunity.asset;
  const portfolioAuthoritative = portfolio.authoritative === true;
  if (portfolioAuthoritative) {
    const nonNegative = [portfolio.grossNotionalUsd, portfolio.collateralUsedUsd, portfolio.assetGrossNotionalUsd?.[asset]];
    const assetDelta = finite(portfolio.assetNetDeltaUsd?.[asset]);
    const venueGross = [...new Set([longLeg.venue, shortLeg.venue])]
      .map((venue) => finite(portfolio.venueGrossNotionalUsd?.[venue]));
    if (nonNegative.some((value) => finite(value) === null || finite(value) < 0)
      || assetDelta === null || venueGross.some((value) => value === null || value < 0)) {
      reasons.push("portefeuille_autoritaire_incomplet");
    }
  }
  const currentGross = Math.max(0, finite(portfolio.grossNotionalUsd, 0));
  const currentCollateral = Math.max(0, finite(portfolio.collateralUsedUsd, 0));
  const currentAssetGross = Math.max(0, finite(portfolio.assetGrossNotionalUsd?.[asset], 0));
  const existingDelta = Math.abs(finite(portfolio.assetNetDeltaUsd?.[asset], 0));
  if (existingDelta > equity * cfg.risk.maxPreExistingDeltaPctEquity) reasons.push("delta_preexistant_excessif");

  const caps = [
    equity * cfg.risk.maxPairNotionalPctEquity,
    Math.max(0, equity * cfg.risk.maxGrossNotionalPctEquity - currentGross) / 2,
    Math.max(0, equity * cfg.risk.maxAssetGrossPctEquity - currentAssetGross) / 2,
  ];
  for (const leg of [longLeg, shortLeg]) {
    caps.push(Math.max(0, finite(leg.bookDepthUsd, 0)) * cfg.risk.maxBookParticipationPct);
    caps.push(Math.max(0, finite(leg.volume24hUsd, 0)) * cfg.risk.maxDailyVolumeParticipationPct);
    if (leg.kind === "perp") caps.push(Math.max(0, finite(leg.openInterestUsd, 0)) * cfg.risk.maxOpenInterestParticipationPct);
  }
  const venueCounts = new Map();
  for (const leg of [longLeg, shortLeg]) venueCounts.set(leg.venue, (venueCounts.get(leg.venue) || 0) + 1);
  for (const [venue, legsAtVenue] of venueCounts) {
    const used = Math.max(0, finite(portfolio.venueGrossNotionalUsd?.[venue], 0));
    caps.push(Math.max(0, equity * cfg.risk.maxVenueGrossPctEquity - used) / legsAtVenue);
  }
  const longMaxLeverage = finite(longLeg.maxLeverage);
  const shortMaxLeverage = finite(shortLeg.maxLeverage);
  if (!(longMaxLeverage >= 1) || !(shortMaxLeverage >= 1)) reasons.push("levier_jambe_invalide");
  const leverage = Math.min(cfg.risk.maxLeverage,
    longMaxLeverage >= 1 ? longMaxLeverage : 1, shortMaxLeverage >= 1 ? shortMaxLeverage : 1);
  const collateralFactor = (longLeg.kind === "spot" ? 1 : 1 / leverage)
    + (shortLeg.kind === "spot" ? 1 : 1 / leverage);
  caps.push(Math.max(0, equity * cfg.risk.maxCollateralPctEquity - currentCollateral) / collateralFactor);
  if (shortLeg.kind === "spot") caps.push(Math.max(0, finite(shortLeg.borrowAvailableUsd, 0)));
  const requestedMatchedNotionalUsd = Math.min(...caps);
  const referencePrice = (legMid(longLeg) + legMid(shortLeg)) / 2;
  const targetBase = requestedMatchedNotionalUsd / referencePrice;
  const longUnitBase = legOrderUnitBase(longLeg);
  const shortUnitBase = legOrderUnitBase(shortLeg);
  const longLot = finite(longLeg.lotSize, 0);
  const shortLot = finite(shortLeg.lotSize, 0);
  if (!(longUnitBase > 0 && shortUnitBase > 0 && longLot > 0 && shortLot > 0)) {
    return { allowed: false, reasons: [...reasons, "metadata_lot_incomplete"] };
  }
  let longOrderUnits = floorToStep(targetBase / longUnitBase, longLot);
  let shortOrderUnits = floorToStep(targetBase / shortUnitBase, shortLot);
  /* Snap both legs a second time to the smaller achieved base inventory.
     This lets a fine-grained spot lot exactly follow a coarser contract lot
     instead of leaving a needless residual delta. */
  const commonTargetBase = Math.min(longOrderUnits * longUnitBase, shortOrderUnits * shortUnitBase);
  longOrderUnits = floorToStep(commonTargetBase / longUnitBase, longLot);
  shortOrderUnits = floorToStep(commonTargetBase / shortUnitBase, shortLot);
  const longBase = longOrderUnits * longUnitBase;
  const shortBase = shortOrderUnits * shortUnitBase;
  const matchedBase = Math.min(longBase, shortBase);
  const matchedNotionalUsd = matchedBase * referencePrice;
  const deltaMismatchBps = matchedBase > 0 ? Math.abs(longBase - shortBase) / matchedBase * 10000 : Infinity;
  if (matchedNotionalUsd < cfg.risk.minMatchedNotionalUsd) reasons.push("notionnel_insuffisant");
  if (deltaMismatchBps > cfg.risk.maxDeltaMismatchBps) reasons.push("arrondi_non_delta_neutre");
  const longNotionalUsd = longBase * legMid(longLeg);
  const shortNotionalUsd = shortBase * legMid(shortLeg);
  const estimatedMarginUsd = (longLeg.kind === "spot" ? longNotionalUsd : longNotionalUsd / leverage)
    + (shortLeg.kind === "spot" ? shortNotionalUsd : shortNotionalUsd / leverage);
  return {
    allowed: reasons.length === 0,
    reasons: [...new Set(reasons)].sort(),
    portfolioAuthoritative,
    requestedMatchedNotionalUsd,
    matchedNotionalUsd,
    grossNotionalUsd: longNotionalUsd + shortNotionalUsd,
    leverage,
    estimatedMarginUsd,
    long: { instrumentId: longLeg.instrumentId, side: "buy", orderUnits: longOrderUnits, baseUnits: longBase },
    short: { instrumentId: shortLeg.instrumentId, side: "sell", orderUnits: shortOrderUnits, baseUnits: shortBase },
    deltaBaseUnits: longBase - shortBase,
    deltaMismatchBps,
    bindingCapUsd: requestedMatchedNotionalUsd,
  };
}

/* A live proposal needs both the global signed evidence gate and an exact
   approved-roster entry. A caller cannot authorize a merely similar config. */
function authorizeCarryCandidate({ opportunity, approvedRoster, liveGate }) {
  const reasons = [];
  if (liveGate?.allowed !== true) reasons.push("gate_live_refusee");
  if (!approvedRoster || liveGate?.rosterSha256 !== sha256(approvedRoster)) reasons.push("roster_non_lie_a_la_preuve");
  const approved = approvedRoster?.perles?.[opportunity?.id];
  if (!approved || typeof approved !== "object") reasons.push("candidat_absent_roster_signe");
  else {
    if (approved.strategyFamily !== STRATEGY_FAMILY) reasons.push("famille_roster_differente");
    if (approved.configSha256 !== opportunity.configSha256) reasons.push("config_roster_differente");
    if (approved.longLegId !== opportunity.longLegId || approved.shortLegId !== opportunity.shortLegId) {
      reasons.push("jambes_roster_differentes");
    }
    if (approved.asset !== opportunity.asset) reasons.push("asset_roster_different");
  }
  return { allowed: reasons.length === 0, reasons };
}

function createOrchestratorProposal({ opportunity, sizing, approvedRoster, liveGate, asOfMs }) {
  const authorization = authorizeCarryCandidate({ opportunity, approvedRoster, liveGate });
  const timeConsistent = finite(asOfMs) !== null && finite(asOfMs) === finite(opportunity?.asOfMs);
  const portfolioReady = sizing?.portfolioAuthoritative === true;
  const executorReady = ATOMIC_EXECUTOR_IMPLEMENTED === true;
  const economicallyReady = opportunity?.eligible === true && sizing?.allowed === true;
  const ready = economicallyReady && authorization.allowed && timeConsistent && portfolioReady && executorReady;
  const reasons = [
    ...(opportunity?.eligible ? [] : opportunity?.reasons || ["opportunite_ineligible"]),
    ...(sizing?.allowed ? [] : sizing?.reasons || ["sizing_invalide"]),
    ...authorization.reasons,
    ...(timeConsistent ? [] : ["cutoff_opportunite_different"]),
    ...(portfolioReady ? [] : ["portefeuille_non_autoritaire"]),
    ...(executorReady ? [] : ["executeur_atomique_absent"]),
  ];
  return {
    type: "HERMES_ATOMIC_CARRY_PAIR_V1",
    strategyId: opportunity?.id || null,
    strategyFamily: STRATEGY_FAMILY,
    generatedAtMs: finite(asOfMs),
    status: ready ? "READY_FOR_ORCHESTRATOR" : economicallyReady ? "SHADOW_ONLY" : "RESEARCH_ONLY",
    authorizedForLive: ready,
    reasons: [...new Set(reasons)].sort(),
    atomicity: {
      simultaneousLegsRequired: true,
      cancelSiblingOnReject: true,
      flattenFilledLegOnSiblingFailure: true,
      maxUnhedgedMs: 2000,
    },
    legs: ready ? [sizing?.long, sizing?.short].filter(Boolean) : [],
    researchLegs: sizing?.allowed ? [sizing.long, sizing.short] : [],
    expectedEconomics: opportunity ? {
      netEdgeBps: opportunity.netEdgeBps,
      stressedEdgeBps: opportunity.stressedEdgeBps,
      horizonHours: opportunity.horizonHours,
    } : null,
  };
}

function generateCarryConfigurationSpace({ baseConfig = {}, grid = {} } = {}) {
  const base = mergeConfig(baseConfig);
  const horizons = [...new Set(grid.horizonHours || [8, 24, 72])].map(Number).sort((a, b) => a - b);
  const fundingRetentions = [...new Set(grid.fundingRetentionStress || [0.25, 0.35, 0.50])].map(Number).sort((a, b) => a - b);
  const basisFractions = [...new Set(grid.basisMeanReversionFraction || [0, 0.10, 0.20])].map(Number).sort((a, b) => a - b);
  const maximum = Number.isInteger(grid.maxCandidates) ? grid.maxCandidates : 27;
  requireRange(maximum, 1, 100, "grid.maxCandidates", true);
  const candidates = [];
  for (const horizonHours of horizons) {
    for (const fundingRetentionStress of fundingRetentions) {
      for (const basisMeanReversionFraction of basisFractions) {
        const config = mergeConfig({
          ...base,
          economics: { ...base.economics, horizonHours, fundingRetentionStress, basisMeanReversionFraction },
        });
        candidates.push({ id: `carry-config-${strategyConfigSha256(config).slice(0, 16)}`, configSha256: strategyConfigSha256(config), config });
      }
    }
  }
  const unique = [...new Map(candidates.map((candidate) => [candidate.configSha256, candidate])).values()]
    .sort((a, b) => a.id.localeCompare(b.id));
  if (unique.length > maximum) throw new Error(`espace carry trop large: ${unique.length} > ${maximum}`);
  return unique;
}

function generateAndScoreCarryCandidates({ assets, marketsByAsset, asOfMs, equityUsd, portfolio = {}, config = {}, approvedRoster, liveGate }) {
  const universe = selectPointInTimeMovers({ assets, asOfMs, config });
  const results = [];
  if (!universe.accepted) return { universe, candidates: results };
  for (const selected of universe.selected) {
    const allowedLegIds = new Set(selected.eligibleLegIds);
    const legs = (marketsByAsset?.[selected.asset] || [])
      .filter((leg) => allowedLegIds.has(leg.instrumentId));
    for (const opportunity of enumerateCarryCandidates({ asset: selected.asset, legs, asOfMs, config })) {
      const sizing = sizeDeltaNeutral({ opportunity, legs, equityUsd, portfolio, config });
      const proposal = createOrchestratorProposal({ opportunity, sizing, approvedRoster, liveGate, asOfMs });
      results.push({ mover: selected, opportunity, sizing, proposal });
    }
  }
  results.sort((a, b) => Number(b.opportunity.eligible) - Number(a.opportunity.eligible)
    || b.opportunity.stressedEdgeBps - a.opportunity.stressedEdgeBps
    || a.opportunity.id.localeCompare(b.opportunity.id));
  return { universe, candidates: results };
}

function legSnapshot(snapshot, side) {
  return side === "long" ? snapshot.long : snapshot.short;
}

function historicalOneWayCostBps(leg) {
  if (!leg) return Infinity;
  const fee = Math.max(0, finite(leg.takerFeeBps, Infinity));
  const spread = Math.max(0, finite(leg.spreadBps, Infinity)) / 2;
  const slip = Math.max(0, finite(leg.slippageBps, Infinity));
  const impact = Math.max(0, finite(leg.impactBps, Infinity));
  return fee + spread + slip + impact;
}

/*
 * Diagnostic of one static pair over trailing 1/2/3-year windows ending at
 * the same cutoff. It is not the confirmatory Top-30 portfolio backtest, which
 * must replay point-in-time universe selection and synchronized allocation.
 * No observation after cutoff participates. Sampling density, both endpoints
 * and the largest internal gap are validated before any PnL is reported.
 */
function evaluateCarryHorizons({ observations, cutoffMs, horizonsYears = [1, 2, 3], config = {} }) {
  const cfg = mergeConfig(config);
  const sampling = cfg.backtest;
  const cutoff = finite(cutoffMs);
  if (!Number.isFinite(cutoff)) throw new Error("cutoffMs invalide");
  const clean = (Array.isArray(observations) ? observations : [])
    .map((row) => ({ ...row, timestampMs: finite(row?.timestampMs ?? row?.ts) }))
    .filter((row) => Number.isFinite(row.timestampMs) && row.timestampMs <= cutoff
      && finite(row?.long?.price, 0) > 0 && finite(row?.short?.price, 0) > 0)
    .sort((a, b) => a.timestampMs - b.timestampMs);
  const dataSha256 = sha256(clean);

  return [...new Set(horizonsYears.map(Number))].sort((a, b) => a - b).map((years) => {
    requireRange(years, 0.01, 20, "horizonsYears");
    const targetStart = cutoff - years * MS_YEAR;
    const rows = clean.filter((row) => row.timestampMs >= targetStart);
    const first = rows[0];
    const last = rows.at(-1);
    const windowDurationMs = years * MS_YEAR;
    const coverage = first && last ? (last.timestampMs - first.timestampMs) / windowDurationMs : 0;
    const startGapMs = first ? first.timestampMs - targetStart : null;
    const endGapMs = last ? cutoff - last.timestampMs : null;
    const gaps = rows.slice(1).map((row, index) => row.timestampMs - rows[index].timestampMs);
    const maxObservedGapMs = gaps.length ? gaps.reduce((maximum, gap) => Math.max(maximum, gap), 0) : null;
    const expectedObservations = Math.floor(windowDurationMs / sampling.expectedIntervalMs) + 1;
    const densityRatio = expectedObservations > 0 ? Math.min(1, rows.length / expectedObservations) : 0;
    const diagnostic = {
      diagnosticType: "STATIC_PAIR_CARRY_DIAGNOSTIC_V1",
      confirmatoryPortfolioBacktest: false,
      portfolioScope: "one_static_pair",
      years,
      cutoffMs: cutoff,
      targetStartTimestampMs: targetStart,
      dataSha256,
      samplingContract: {
        version: sampling.samplingContractVersion,
        expectedIntervalMs: sampling.expectedIntervalMs,
        maxGapMs: sampling.maxGapMs,
        maxEndpointGapMs: sampling.maxEndpointGapMs,
        minimumCoverageRatio: sampling.minimumCoverageRatio,
        minimumDensityRatio: sampling.minimumDensityRatio,
      },
      startTimestampMs: first?.timestampMs ?? null,
      endTimestampMs: last?.timestampMs ?? null,
      startGapMs,
      endGapMs,
      maxObservedGapMs,
      expectedObservations,
      observations: rows.length,
      coverageRatio: coverage,
      densityRatio,
    };
    if (!first || !last || rows.length < 2) {
      return { ...diagnostic, valid: false, reasons: ["historique_insuffisant"] };
    }
    const dataReasons = [];
    if (rows.some((row, index) => index > 0 && row.timestampMs <= rows[index - 1].timestampMs)) dataReasons.push("timestamps_non_strictement_croissants");
    if (startGapMs > sampling.maxEndpointGapMs) dataReasons.push("endpoint_debut_trop_eloigne");
    if (endGapMs > sampling.maxEndpointGapMs) dataReasons.push("endpoint_fin_trop_eloigne");
    if (coverage < sampling.minimumCoverageRatio) dataReasons.push("couverture_inferieure_99pct");
    if (densityRatio < sampling.minimumDensityRatio) dataReasons.push("densite_echantillonnage_insuffisante");
    if (maxObservedGapMs > sampling.maxGapMs) dataReasons.push("trou_interne_excessif");
    for (let i = 1; i < rows.length; i += 1) {
      for (const side of ["long", "short"]) {
        const leg = legSnapshot(rows[i], side);
        if (leg.kind === "perp" && finite(leg.fundingRatePaid) === null) dataReasons.push(`funding_${side}_manquant`);
        if (leg.kind === "perp" && Math.abs(finite(leg.fundingRatePaid, 0)) > cfg.economics.maxAbsFundingRatePerInterval) {
          dataReasons.push(`funding_${side}_hors_borne`);
        }
      }
      if (rows[i - 1].short.kind === "spot" && finite(rows[i - 1].short.borrowApr) === null) dataReasons.push("emprunt_short_manquant");
    }
    const entryCostBps = historicalOneWayCostBps(first.long) + historicalOneWayCostBps(first.short);
    const exitCostBps = historicalOneWayCostBps(last.long) + historicalOneWayCostBps(last.short);
    if (!Number.isFinite(entryCostBps) || !Number.isFinite(exitCostBps)) dataReasons.push("cout_execution_manquant");
    if (dataReasons.length) {
      return {
        ...diagnostic,
        valid: false,
        reasons: [...new Set(dataReasons)].sort(),
      };
    }
    const referencePrice = (first.long.price + first.short.price) / 2;
    const baseUnits = 1 / referencePrice;
    let cumulative = 0;
    let peak = 0;
    let maxDrawdown = 0;
    let fundingReturn = 0;
    let financingReturn = 0;
    let priceReturn = 0;
    let profitableIntervals = 0;
    const entryCost = entryCostBps / 10000;
    const exitCost = exitCostBps / 10000;
    cumulative -= entryCost;
    peak = Math.max(peak, cumulative);

    for (let i = 1; i < rows.length; i += 1) {
      const previous = rows[i - 1];
      const current = rows[i];
      const deltaPrice = baseUnits * ((current.long.price - previous.long.price) - (current.short.price - previous.short.price));
      const longFundingRate = finite(current.long.fundingRatePaid, 0);
      const shortFundingRate = finite(current.short.fundingRatePaid, 0);
      const longFunding = current.long.kind === "perp" ? -longFundingRate * baseUnits * current.long.price : 0;
      const shortFunding = current.short.kind === "perp" ? shortFundingRate * baseUnits * current.short.price : 0;
      const dtYears = Math.max(0, current.timestampMs - previous.timestampMs) / MS_YEAR;
      const shortBorrow = previous.short.kind === "spot" ? Math.max(0, finite(previous.short.borrowApr, 0)) * dtYears * baseUnits * previous.short.price : 0;
      const longCapital = previous.long.kind === "spot" ? cfg.economics.capitalChargeApr * dtYears * baseUnits * previous.long.price : 0;
      const interval = deltaPrice + longFunding + shortFunding - shortBorrow - longCapital;
      priceReturn += deltaPrice;
      fundingReturn += longFunding + shortFunding;
      financingReturn += shortBorrow + longCapital;
      cumulative += interval;
      if (interval > 0) profitableIntervals += 1;
      peak = Math.max(peak, cumulative);
      maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
    }
    cumulative -= exitCost;
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
    const durationYears = (last.timestampMs - first.timestampMs) / MS_YEAR;
    return {
      ...diagnostic,
      valid: true,
      reasons: [],
      netReturnBps: cumulative * 10000,
      annualizedNetBps: durationYears > 0 ? cumulative / durationYears * 10000 : null,
      priceConvergenceBps: priceReturn * 10000,
      fundingBps: fundingReturn * 10000,
      financingBps: financingReturn * 10000,
      executionCostBps: (entryCost + exitCost) * 10000,
      maxDrawdownBps: maxDrawdown * 10000,
      profitableIntervalRate: profitableIntervals / (rows.length - 1),
    };
  });
}

function evaluateCarryExit({ position, market, nowMs, config = {} }) {
  const cfg = mergeConfig(config).exit;
  const reasons = [];
  const emergency = [];
  const now = finite(nowMs);
  if (!Number.isFinite(now)) throw new Error("nowMs invalide");
  if (!position || !market) return { action: "EXIT", urgency: "emergency", reasons: ["etat_absent"] };
  const openedAtMs = finite(position.openedAtMs);
  const entryBasisBps = finite(position.entryBasisBps);
  const unrealizedPnlBps = finite(position.unrealizedPnlBps);
  if (openedAtMs === null || openedAtMs > now) emergency.push("date_ouverture_invalide");
  if (entryBasisBps === null) emergency.push("basis_entree_absente");
  if (unrealizedPnlBps === null) emergency.push("pnl_absent");
  for (const [side, leg] of [["long", market.long], ["short", market.short]]) {
    const observedAtMs = finite(leg?.observedAtMs ?? leg?.quoteTimeMs);
    if (!quoteAgeOk(observedAtMs, now, cfg.maxQuoteAgeMs)) emergency.push(`${side}_quote_perimee`);
    if (leg?.venueHealthy !== true) emergency.push(`${side}_venue_degradee`);
    if (finite(leg?.spreadBps, Infinity) > cfg.maxSpreadBps) reasons.push(`${side}_spread_excessif`);
    if (finite(leg?.bookDepthUsd, -1) < cfg.minBookDepthUsd) reasons.push(`${side}_profondeur_insuffisante`);
  }
  if (position.shortKind === "spot" && market.short?.borrowAvailable !== true) emergency.push("emprunt_rappele");
  const basisBps = finite(market.basisBps, Infinity);
  if (Math.abs(basisBps) <= cfg.closeBasisBps) reasons.push("basis_convergee");
  if (entryBasisBps !== null && Math.abs(basisBps) - Math.abs(entryBasisBps) >= cfg.maxBasisWideningBps) emergency.push("basis_divergee");
  const deltaDriftBps = Math.abs(finite(market.deltaDriftBps, Infinity));
  if (deltaDriftBps >= cfg.emergencyDeltaDriftBps) emergency.push("delta_critique");
  else if (deltaDriftBps >= cfg.maxDeltaDriftBps) reasons.push("delta_a_rebalancer");
  if (unrealizedPnlBps !== null && unrealizedPnlBps <= -cfg.maxLossBps) emergency.push("perte_maximale");
  if (openedAtMs !== null && now - openedAtMs >= cfg.maxHoldingHours * MS_HOUR) reasons.push("duree_maximale");
  if (finite(market.remainingNetEdgeBps, -Infinity) <= cfg.minRemainingEdgeBps) reasons.push("carry_epuise");
  if (finite(position.adverseFundingIntervals, 0) >= cfg.adverseFundingIntervals) reasons.push("funding_adverse_persistant");
  if (emergency.length) return { action: "EXIT", urgency: "emergency", reasons: [...new Set(emergency.concat(reasons))].sort() };
  const unique = [...new Set(reasons)].sort();
  if (unique.length === 1 && unique[0] === "delta_a_rebalancer") return { action: "REBALANCE", urgency: "normal", reasons: unique };
  if (unique.length) return { action: "EXIT", urgency: "normal", reasons: unique };
  return { action: "HOLD", urgency: "none", reasons: [] };
}

module.exports = {
  STRATEGY_FAMILY,
  ATOMIC_EXECUTOR_IMPLEMENTED,
  DEFAULT_CONFIG,
  mergeConfig,
  validateConfig,
  stableStringify,
  strategyConfigSha256,
  carryRosterSha256: sha256,
  selectPointInTimeMovers,
  robustFundingForecast,
  scoreCarryOrientation,
  enumerateCarryCandidates,
  sizeDeltaNeutral,
  authorizeCarryCandidate,
  createOrchestratorProposal,
  generateCarryConfigurationSpace,
  generateAndScoreCarryCandidates,
  evaluateCarryHorizons,
  evaluateCarryExit,
};
