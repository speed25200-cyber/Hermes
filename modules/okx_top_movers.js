"use strict";

/*
 * Deterministic current OKX universe selector.
 *
 * The selector is deliberately pure.  The caller supplies one timestamped
 * exchange snapshot and is responsible for persisting it before any signal
 * is evaluated.  Top movers define the investable universe; they are never a
 * trading signal on their own.
 */

const crypto = require("node:crypto");

const DAY_MS = 86_400_000;

const DEFAULT_CONFIG = Object.freeze({
  topN: 30,
  quoteCurrency: "USDT",
  instrumentCategory: "1",
  minListingAgeDays: 90,
  minTimeToDelistDays: 7,
  minQuoteVolumeUsd: 5_000_000,
  maxSpreadBps: 15,
  maxTickerAgeMs: 10 * 60_000,
  requiredInstrumentState: "live",
  requiredRuleType: "normal",
  requireSpotHedge: true,
});

function finite(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256Canonical(value) {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function mergeConfig(input = {}) {
  const config = { ...DEFAULT_CONFIG, ...(input || {}) };
  if (!Number.isInteger(Number(config.topN)) || Number(config.topN) !== 30) throw new Error("topN doit etre exactement 30");
  if (!(Number(config.minListingAgeDays) >= 0)) throw new Error("minListingAgeDays invalide");
  if (!(Number(config.minTimeToDelistDays) >= 0)) throw new Error("minTimeToDelistDays invalide");
  if (!(Number(config.minQuoteVolumeUsd) >= 0)) throw new Error("minQuoteVolumeUsd invalide");
  if (!(Number(config.maxSpreadBps) > 0)) throw new Error("maxSpreadBps invalide");
  if (!(Number(config.maxTickerAgeMs) > 0)) throw new Error("maxTickerAgeMs invalide");
  return config;
}

function byInstrument(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.instId || "").trim();
    if (!id) continue;
    if (map.has(id)) throw new Error(`instrument duplique dans le snapshot: ${id}`);
    map.set(id, row);
  }
  return map;
}

function canonicalSourceRows(rows) {
  return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
    const byId = String(a?.instId || "").localeCompare(String(b?.instId || ""));
    return byId || canonicalJson(a).localeCompare(canonicalJson(b));
  });
}

function spreadBps(ticker) {
  const bid = finite(ticker?.bidPx);
  const ask = finite(ticker?.askPx);
  if (!(bid > 0) || !(ask >= bid)) return null;
  return (ask - bid) / ((ask + bid) / 2) * 10_000;
}

function quoteVolumeUsd(ticker, last) {
  const explicit = finite(ticker?.quoteVolume24hUsd);
  if (explicit !== null) return explicit;
  const baseVolume = finite(ticker?.volCcy24h);
  return baseVolume !== null && last > 0 ? baseVolume * last : null;
}

function isUniverseSnapshotFresh({ asOfMs, validUntilMs, nowMs = Date.now() } = {}) {
  const asOf = finite(asOfMs);
  const until = finite(validUntilMs);
  const now = finite(nowMs);
  return asOf !== null && until !== null && now !== null
    && asOf > 0 && until > asOf && now >= asOf && now <= until;
}

function selectOkxTopMovers({ swapTickers, swapInstruments, spotInstruments, asOfMs, config: inputConfig = {} }) {
  const config = mergeConfig(inputConfig);
  const decisionTs = finite(asOfMs);
  if (!Number.isFinite(decisionTs)) throw new Error("asOfMs invalide");
  const instrumentMap = byInstrument(swapInstruments);
  byInstrument(swapTickers);
  byInstrument(spotInstruments);
  const liveSpots = new Set((Array.isArray(spotInstruments) ? spotInstruments : [])
    .filter((row) => String(row?.state || "").toLowerCase() === String(config.requiredInstrumentState).toLowerCase())
    .filter((row) => String(row?.ruleType || "").toLowerCase() === String(config.requiredRuleType).toLowerCase())
    .filter((row) => String(row?.instCategory || "") === String(config.instrumentCategory))
    .filter((row) => String(row?.quoteCcy || "").toUpperCase() === String(config.quoteCurrency).toUpperCase())
    .map((row) => String(row.instId || ""))
    .filter(Boolean));
  const eligible = [];
  const excluded = [];

  for (const ticker of Array.isArray(swapTickers) ? swapTickers : []) {
    const instId = String(ticker?.instId || "").trim();
    const reasons = [];
    const expectedSuffix = `-${String(config.quoteCurrency).toUpperCase()}-SWAP`;
    if (!instId.endsWith(expectedSuffix)) reasons.push("mauvaise_cotation");
    const instrument = instrumentMap.get(instId);
    if (!instrument) reasons.push("instrument_absent");
    if (instrument && String(instrument.state || "").toLowerCase()
        !== String(config.requiredInstrumentState).toLowerCase()) reasons.push("instrument_non_live");
    if (String(instrument?.ruleType || "").toLowerCase()
        !== String(config.requiredRuleType).toLowerCase()) reasons.push("regle_non_normale");
    if (String(instrument?.instCategory || "") !== String(config.instrumentCategory)) reasons.push("categorie_non_crypto");
    if (String(instrument?.settleCcy || "").toUpperCase() !== String(config.quoteCurrency).toUpperCase()) {
      reasons.push("mauvaise_devise_reglement");
    }

    const listedAt = finite(instrument?.listTime);
    if (!(listedAt !== null && listedAt <= decisionTs - Number(config.minListingAgeDays) * DAY_MS)) {
      reasons.push("anciennete_insuffisante");
    }
    const delistAt = finite(instrument?.expTime);
    if (delistAt !== null && delistAt > 0
        && delistAt < decisionTs + Number(config.minTimeToDelistDays) * DAY_MS) {
      reasons.push("radiation_trop_proche");
    }
    const observedAt = finite(ticker?.ts);
    if (!(observedAt !== null && observedAt <= decisionTs && decisionTs - observedAt <= Number(config.maxTickerAgeMs))) {
      reasons.push("ticker_perime_ou_futur");
    }
    const last = finite(ticker?.last);
    const open24h = finite(ticker?.open24h);
    if (!(last > 0 && open24h > 0)) reasons.push("prix_24h_absent");
    const volumeUsd = quoteVolumeUsd(ticker, last);
    if (!(volumeUsd !== null && volumeUsd >= Number(config.minQuoteVolumeUsd))) reasons.push("volume_insuffisant");
    const spread = spreadBps(ticker);
    if (!(spread !== null && spread <= Number(config.maxSpreadBps))) reasons.push("spread_invalide_ou_excessif");
    const spotInstId = instId.endsWith("-SWAP") ? instId.slice(0, -5) : "";
    if (config.requireSpotHedge !== false && !liveSpots.has(spotInstId)) reasons.push("spot_couverture_absent");

    if (reasons.length) {
      excluded.push({ instId: instId || null, reasons: [...new Set(reasons)].sort() });
      continue;
    }
    const logReturn24h = Math.log(last / open24h);
    eligible.push({
      instId,
      spotInstId,
      observedAt,
      listTime: listedAt,
      last,
      open24h,
      logReturn24h,
      absoluteLogReturn24h: Math.abs(logReturn24h),
      direction: logReturn24h > 0 ? "up" : logReturn24h < 0 ? "down" : "flat",
      quoteVolume24hUsd: volumeUsd,
      spreadBps: spread,
    });
  }

  eligible.sort((a, b) => b.absoluteLogReturn24h - a.absoluteLogReturn24h
    || b.quoteVolume24hUsd - a.quoteVolume24hUsd || a.instId.localeCompare(b.instId));
  excluded.sort((a, b) => String(a.instId).localeCompare(String(b.instId)));
  const selected = eligible.slice(0, Number(config.topN));
  const accepted = selected.length === Number(config.topN);
  const sourceManifest = {
    swapTickersCount: Array.isArray(swapTickers) ? swapTickers.length : 0,
    swapInstrumentsCount: Array.isArray(swapInstruments) ? swapInstruments.length : 0,
    spotInstrumentsCount: Array.isArray(spotInstruments) ? spotInstruments.length : 0,
    swapTickersSha256: sha256Canonical(canonicalSourceRows(swapTickers)),
    swapInstrumentsSha256: sha256Canonical(canonicalSourceRows(swapInstruments)),
    spotInstrumentsSha256: sha256Canonical(canonicalSourceRows(spotInstruments)),
  };
  const snapshot = {
    schemaVersion: 1,
    methodology: "okx-point-in-time-top30-absolute-log-return-24h-v1",
    asOf: new Date(decisionTs).toISOString(),
    asOfMs: decisionTs,
    accepted,
    requiredCount: Number(config.topN),
    eligibleCount: eligible.length,
    selected,
    policy: config,
    sourceManifest,
  };
  return {
    ...snapshot,
    rejectionReason: accepted ? null : "moins_de_30_instruments_eligibles",
    excluded,
    snapshotSha256: sha256Canonical(snapshot),
  };
}

module.exports = {
  DEFAULT_CONFIG,
  canonicalJson,
  sha256Canonical,
  isUniverseSnapshotFresh,
  selectOkxTopMovers,
};
