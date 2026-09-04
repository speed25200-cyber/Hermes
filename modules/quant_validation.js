"use strict";

/*
 * Quantitative evidence compiler for Hermes.
 *
 * This module deliberately has no filesystem, clock, network or exchange side
 * effects. Discovery code may feed it a run record, but cannot ask it to make
 * a strategy live. The output is an unsigned, deterministic research artifact
 * that the separate live gate may later verify and sign through an independent
 * approval path.
 */

const crypto = require("crypto");
const {
  executableStrategyIdentity,
  candidateId: executableCandidateId,
} = require("./autopilot.js");

const DAY_MS = 86_400_000;
const REQUIRED_HORIZONS_DAYS = Object.freeze([365, 730, 1095]);
const QUANT_EXECUTION_SIGNATURE_DOMAIN = "hermes-quant-execution-attribution-v1";
const QUANT_PROCESS_SIGNATURE_DOMAIN = "hermes-quant-process-replay-v1";
const QUANT_CYCLE_LEDGER_SIGNATURE_DOMAIN = "hermes-quant-cycle-ledger-v1";
const CYCLE_LEDGER_HASH_CHAIN_DOMAIN = "hermes-quant-cycle-ledger-hash-chain-v1";
const COMPILER_ISSUED_EVIDENCE = new WeakMap();

const DEFAULT_POLICY = deepFreeze({
  schemaVersion: 1,
  requiredHorizonsDays: [...REQUIRED_HORIZONS_DAYS],
  universe: {
    venue: "OKX",
    instrumentType: "SWAP",
    quoteCurrency: "USDT",
    topN: 30,
    rankingMetric: "absolute-log-return",
    rankingWindowMs: DAY_MS,
    liquidityWindowMs: DAY_MS,
    minQuoteVolume: 5_000_000,
    maxSpreadBps: 15,
    minimumEligible: 30,
    rebalanceMs: 60 * 60_000,
    barMs: 5 * 60_000,
    maxEndpointStalenessMs: 10 * 60_000,
    minimumListingAgeMs: 90 * DAY_MS,
    minimumTimeToDelistMs: 7 * DAY_MS,
    requiredInstrumentCategory: "1",
    requiredInstrumentState: "live",
    requiredRuleType: "normal",
    requireSpotHedge: true,
    minRosterCoverageRate: 1,
  },
  walkForward: {
    minimumTrainingMs: 180 * DAY_MS,
    outerTestMs: 30 * DAY_MS,
    outerStepMs: 30 * DAY_MS,
    innerMinimumTrainingMs: 90 * DAY_MS,
    innerValidationMs: 30 * DAY_MS,
    innerStepMs: 30 * DAY_MS,
    labelHorizonMs: 7 * DAY_MS,
    purgeMs: 7 * DAY_MS,
    embargoMs: 7 * DAY_MS,
  },
  costs: {
    requiredGrossPnlBasis: "fill-to-fill",
    makerFeeRate: 0.0002,
    takerFeeRate: 0.0005,
    fallbackHalfSpreadBps: 1,
    fallbackSlippageBps: 2,
    fallbackImpactBps: 1,
    fallbackLatencyBps: 1,
    fallbackFundingCostQuote: 0,
    fallbackBorrowCostQuote: 0,
    fallbackRejectionCostQuote: 0,
    fallbackLiquidationCostQuote: 0,
    maxFeeSnapshotStalenessMs: 31 * DAY_MS,
    stressMultiplier: 2,
    requireObservedSpread: true,
    requireObservedLiquidity: true,
    requireObservedSlippage: true,
    requireObservedImpact: true,
    requireObservedLatency: true,
    requireObservedFunding: true,
    requireObservedBorrow: true,
    requireObservedLiquidation: true,
    requireObservedPartialFills: true,
    requireObservedRejections: true,
  },
  statistics: {
    nullReplications: 9999,
    bootstrapReplications: 9999,
    spaBootstrapReplications: 9999,
    realityCheckReplications: 9999,
    blockLength: 12,
    blockLengthSensitivity: [6, 12, 24, 48],
    cscvSlices: 8,
    minModelMatrixCoverageRate: 1,
    familywiseAlpha: 0.01,
    netConfidence: 0.99,
    costStressConfidence: 0.95,
    multipleTestingMethod: "bonferroni-upper-bound-over-complete-trial-ledger",
  },
  gates: {
    minimumTradesPerHorizon: 1500,
    minimumProfitableFoldRate: 0.70,
    maximumProfitConcentration: 0.10,
    maximumDrawdownPct: 0.10,
    minimumProfitFactor: 1.10,
    maximumPbo: 0.10,
    minimumDeflatedSharpeProbability: 0.99,
    maximumSpaPValue: 0.01,
    maximumRealityCheckPValue: 0.01,
    maximumTop5ProfitConcentration: 0.50,
    maximumBasketProfitConcentration: 0.25,
    maximumYearProfitConcentrationByHorizon: { 365: 1, 730: 0.75, 1095: 0.60 },
    minimumEffectiveTradingDayRate: 0.23,
    minimumIndependentBasketsPerYear: 34,
    requireNetLower99AboveZero: true,
    requireCostStressLower95AboveZero: true,
  },
  lifecycle: {
    minimumShadowDays: 90,
    minimumShadowTrades: 100,
    requireVerifiedEvidenceSignatureForEligibility: true,
    requireVerifiedApprovalSignatureForEligibility: true,
  },
  attestations: {
    executionAndProcess: {
      publicKeySpkiSha256: "UNCONFIGURED",
      executionSignatureDomain: QUANT_EXECUTION_SIGNATURE_DOMAIN,
      processSignatureDomain: QUANT_PROCESS_SIGNATURE_DOMAIN,
    },
    cycleLedger: {
      publicKeySpkiSha256: "UNCONFIGURED",
      signatureDomain: QUANT_CYCLE_LEDGER_SIGNATURE_DOMAIN,
      hashChainDomain: CYCLE_LEDGER_HASH_CHAIN_DOMAIN,
    },
  },
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function mergePolicy(input = {}) {
  const groups = ["universe", "walkForward", "costs", "statistics", "gates", "lifecycle"];
  const out = { ...DEFAULT_POLICY, ...input };
  for (const group of groups) out[group] = { ...DEFAULT_POLICY[group], ...(input[group] || {}) };
  out.attestations = {
    executionAndProcess: {
      ...DEFAULT_POLICY.attestations.executionAndProcess,
      ...(input.attestations?.executionAndProcess || {}),
    },
    cycleLedger: {
      ...DEFAULT_POLICY.attestations.cycleLedger,
      ...(input.attestations?.cycleLedger || {}),
    },
  };
  out.requiredHorizonsDays = [...(input.requiredHorizonsDays || DEFAULT_POLICY.requiredHorizonsDays)]
    .map(Number).sort((a, b) => a - b);
  validatePolicy(out);
  return deepFreeze(out);
}

function positiveFinite(value, name) {
  let number;
  try { number = finiteNumber(value, name); } catch { throw new Error(`politique quantitative invalide: ${name}`); }
  if (number <= 0) throw new Error(`politique quantitative invalide: ${name}`);
  return number;
}

function validatePolicy(policy) {
  const required = policy.requiredHorizonsDays;
  if (required.length !== REQUIRED_HORIZONS_DAYS.length
      || required.some((value, index) => value !== REQUIRED_HORIZONS_DAYS[index])) {
    throw new Error("les horizons 365/730/1095 jours sont obligatoires");
  }
  if (String(policy.universe.venue).toUpperCase() !== "OKX") throw new Error("la preuve doit utiliser des donnees OKX");
  if (policy.universe.rankingMetric !== "absolute-log-return") throw new Error("le classement doit etre absolute-log-return");
  if (Number(policy.universe.topN) !== 30 || Number(policy.universe.minimumEligible) < 30) {
    throw new Error("l'univers confirmatoire doit reconstruire les 30 movers point-in-time");
  }
  for (const [group, keys] of Object.entries({
    universe: ["rankingWindowMs", "liquidityWindowMs", "rebalanceMs", "barMs", "maxEndpointStalenessMs",
      "minimumListingAgeMs", "minimumTimeToDelistMs", "maxSpreadBps"],
    walkForward: ["minimumTrainingMs", "outerTestMs", "outerStepMs", "innerMinimumTrainingMs",
      "innerValidationMs", "innerStepMs", "labelHorizonMs", "purgeMs", "embargoMs"],
    statistics: ["nullReplications", "bootstrapReplications", "spaBootstrapReplications",
      "realityCheckReplications", "blockLength", "cscvSlices"],
  })) for (const key of keys) positiveFinite(policy[group][key], `${group}.${key}`);
  if (policy.walkForward.purgeMs < policy.walkForward.labelHorizonMs
      || policy.walkForward.embargoMs < policy.walkForward.labelHorizonMs) {
    throw new Error("purge et embargo doivent etre au moins egaux a l'horizon des labels");
  }
  if (Number(policy.statistics.nullReplications) < 9999) throw new Error("9999 permutations nulles au minimum");
  if (Number(policy.statistics.bootstrapReplications) < 9999) throw new Error("9999 bootstraps au minimum");
  if (Number(policy.statistics.spaBootstrapReplications) < 9999
      || Number(policy.statistics.realityCheckReplications) < 9999) throw new Error("9999 bootstraps SPA/Reality Check au minimum");
  if (!Number.isInteger(Number(policy.statistics.cscvSlices)) || policy.statistics.cscvSlices < 4
      || policy.statistics.cscvSlices % 2 !== 0) throw new Error("CSCV exige un nombre pair de tranches, au moins quatre");
  for (const [name, value] of [["familywiseAlpha", policy.statistics.familywiseAlpha],
    ["netConfidence", policy.statistics.netConfidence], ["costStressConfidence", policy.statistics.costStressConfidence]]) {
    if (!(Number(value) > 0 && Number(value) < 1)) throw new Error(`politique quantitative invalide: statistics.${name}`);
  }
  if (!(Number(policy.universe.minRosterCoverageRate) > 0 && Number(policy.universe.minRosterCoverageRate) <= 1)) {
    throw new Error("politique quantitative invalide: universe.minRosterCoverageRate");
  }
  if (Number(policy.statistics.minModelMatrixCoverageRate) !== 1) {
    throw new Error("la matrice quotidienne de tous les modeles exige une couverture exacte de 100%");
  }
  for (const key of ["makerFeeRate", "takerFeeRate", "fallbackHalfSpreadBps", "fallbackSlippageBps",
    "fallbackImpactBps", "fallbackLatencyBps", "fallbackBorrowCostQuote", "fallbackRejectionCostQuote",
    "fallbackLiquidationCostQuote"]) {
    if (!isStrictFiniteNumber(policy.costs[key]) || Number(policy.costs[key]) < 0) {
      throw new Error(`politique quantitative invalide: costs.${key}`);
    }
  }
  positiveFinite(policy.costs.maxFeeSnapshotStalenessMs, "costs.maxFeeSnapshotStalenessMs");
  if (!(Number(policy.costs.stressMultiplier) >= 1)) throw new Error("politique quantitative invalide: costs.stressMultiplier");
  if (policy.costs.requiredGrossPnlBasis !== "fill-to-fill") {
    throw new Error("la base de PnL brute obligatoire est fill-to-fill");
  }
  const blockSensitivity = policy.statistics.blockLengthSensitivity;
  if (!Array.isArray(blockSensitivity)
      || blockSensitivity.length !== 4
      || blockSensitivity.some((value, index) => value !== [6, 12, 24, 48][index])) {
    throw new Error("la sensibilite preinscrite des blocs doit etre exactement 6/12/24/48");
  }
  const executionTrust = policy.attestations?.executionAndProcess || {};
  const cycleTrust = policy.attestations?.cycleLedger || {};
  if (executionTrust.executionSignatureDomain !== QUANT_EXECUTION_SIGNATURE_DOMAIN
      || executionTrust.processSignatureDomain !== QUANT_PROCESS_SIGNATURE_DOMAIN
      || cycleTrust.signatureDomain !== QUANT_CYCLE_LEDGER_SIGNATURE_DOMAIN
      || cycleTrust.hashChainDomain !== CYCLE_LEDGER_HASH_CHAIN_DOMAIN) {
    throw new Error("les domaines d'attestation quantitative sont immuables");
  }
  const anchorPattern = /^(?:UNCONFIGURED|[a-f0-9]{64})$/;
  for (const [name, value] of [["executionAndProcess", executionTrust.publicKeySpkiSha256],
    ["cycleLedger", cycleTrust.publicKeySpkiSha256]]) {
    if (!anchorPattern.test(String(value || ""))) {
      throw new Error(`politique quantitative invalide: attestations.${name}.publicKeySpkiSha256`);
    }
  }
  if (/^[a-f0-9]{64}$/.test(String(executionTrust.publicKeySpkiSha256 || ""))
      && executionTrust.publicKeySpkiSha256 === cycleTrust.publicKeySpkiSha256) {
    throw new Error("les autorites execution/processus et cycle ledger doivent etre distinctes");
  }
  return policy;
}

function auditExecutionUniverseParity(quantPolicyInput, executionPolicy) {
  const quant = mergePolicy(quantPolicyInput).universe;
  const live = executionPolicy?.universe;
  const mismatches = [];
  if (!live || Number(executionPolicy?.schemaVersion) !== 1) {
    mismatches.push("execution_policy_absente_ou_schema_invalide");
  } else {
    const compare = (name, left, right) => { if (left !== right) mismatches.push(name); };
    const numeric = (value, name) => {
      try { return finiteNumber(value, `executionPolicy.universe.${name}`); }
      catch { mismatches.push(`${name}_absent_ou_invalide`); return NaN; }
    };
    compare("venue", String(live.venue || "").toUpperCase(), String(quant.venue).toUpperCase());
    compare("instrumentType", String(live.instrumentType || "").toUpperCase(), String(quant.instrumentType).toUpperCase());
    compare("quoteCurrency", String(live.quoteCurrency || "").toUpperCase(), String(quant.quoteCurrency).toUpperCase());
    compare("instrumentCategory", String(live.instrumentCategory ?? ""), String(quant.requiredInstrumentCategory));
    compare("rankingContract", String(live.ranking || ""), "absolute-return-24h");
    compare("rankingMetric", String(live.rankingMetric || ""), String(quant.rankingMetric));
    compare("topN", numeric(live.topN, "topN"), Number(quant.topN));
    compare("rankingWindow", numeric(live.rankingWindowHours, "rankingWindowHours") * 3_600_000,
      Number(quant.rankingWindowMs));
    compare("liquidityWindow", numeric(live.rankingWindowHours, "rankingWindowHours") * 3_600_000,
      Number(quant.liquidityWindowMs));
    compare("minQuoteVolume", numeric(live.minQuoteVolumeUsd, "minQuoteVolumeUsd"), Number(quant.minQuoteVolume));
    compare("maxSpread", numeric(live.maxSpreadBps, "maxSpreadBps"), Number(quant.maxSpreadBps));
    compare("refresh", numeric(live.refreshMinutes, "refreshMinutes") * 60_000, Number(quant.rebalanceMs));
    compare("bar", numeric(live.barMinutes, "barMinutes") * 60_000, Number(quant.barMs));
    compare("staleness", numeric(live.maxTickerAgeMs, "maxTickerAgeMs"), Number(quant.maxEndpointStalenessMs));
    compare("listing", numeric(live.minListingDays, "minListingDays") * DAY_MS, Number(quant.minimumListingAgeMs));
    compare("delist", numeric(live.minTimeToDelistDays, "minTimeToDelistDays") * DAY_MS,
      Number(quant.minimumTimeToDelistMs));
    compare("state", String(live.requiredInstrumentState || "").toLowerCase(), String(quant.requiredInstrumentState).toLowerCase());
    compare("ruleType", String(live.requiredRuleType || "").toLowerCase(), String(quant.requiredRuleType).toLowerCase());
    compare("requireLiveState", live.requireLiveState === true, true);
    compare("requireSpotHedge", live.requireSpotHedgeForCarry === true, quant.requireSpotHedge === true);
    compare("pointInTime", live.pointInTimeSnapshotsRequired === true, true);
  }
  const body = {
    schemaVersion: 1,
    quantUniverseSha256: sha256Canonical(quant),
    executionUniverseSha256: (() => {
      try { return sha256Canonical(live || null); }
      catch { mismatches.push("execution_policy_non_canonique"); return null; }
    })(),
    mismatches: [...new Set(mismatches)].sort(),
  };
  return { ...body, verified: body.mismatches.length === 0, paritySha256: sha256Canonical(body) };
}

function canonicalJson(value) {
  const seen = new Set();
  const encode = (item) => {
    if (item === null) return "null";
    if (typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error("un artefact canonique ne peut contenir NaN ou Infinity");
      return JSON.stringify(Object.is(item, -0) ? 0 : item);
    }
    if (Array.isArray(item)) return `[${item.map(encode).join(",")}]`;
    if (typeof item !== "object" || item instanceof Date || Buffer.isBuffer(item)) {
      throw new Error("type non canonique dans l'artefact");
    }
    if (seen.has(item)) throw new Error("cycle dans l'artefact");
    seen.add(item);
    const entries = Object.keys(item).sort().map((key) => {
      if (item[key] === undefined) throw new Error(`valeur undefined dans l'artefact: ${key}`);
      return `${JSON.stringify(key)}:${encode(item[key])}`;
    });
    seen.delete(item);
    return `{${entries.join(",")}}`;
  };
  return encode(value);
}

function sha256Canonical(value) {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function publicKeySpkiSha256(publicKey) {
  try {
    if (!publicKey) return null;
    if (publicKey?.type && publicKey.type !== "public") return null;
    const text = Buffer.isBuffer(publicKey) ? publicKey.toString("utf8")
      : typeof publicKey === "string" ? publicKey : null;
    if (text != null && /BEGIN [^\r\n]*PRIVATE KEY/.test(text)) return null;
    const key = publicKey?.type === "public" ? publicKey : crypto.createPublicKey(publicKey);
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") return null;
    const der = key.export({ type: "spki", format: "der" });
    return crypto.createHash("sha256").update(der).digest("hex");
  } catch {
    return null;
  }
}

function auditAttestationTrust({ publicKey, policySpkiSha256, externalSpkiSha256, role }) {
  const reasons = [];
  const prefix = String(role || "attestation");
  const actualSpkiSha256 = publicKeySpkiSha256(publicKey);
  const policyAnchor = String(policySpkiSha256 || "").toLowerCase();
  const externalAnchor = String(externalSpkiSha256 || "").toLowerCase();
  if (!actualSpkiSha256) reasons.push(`${prefix}_cle_publique_ed25519_absente_ou_invalide`);
  if (!/^[a-f0-9]{64}$/.test(policyAnchor)) reasons.push(`${prefix}_ancre_policy_non_configuree`);
  if (!/^[a-f0-9]{64}$/.test(externalAnchor)) reasons.push(`${prefix}_ancre_externe_non_configuree`);
  if (actualSpkiSha256 && /^[a-f0-9]{64}$/.test(policyAnchor) && actualSpkiSha256 !== policyAnchor) {
    reasons.push(`${prefix}_cle_ne_correspond_pas_policy`);
  }
  if (actualSpkiSha256 && /^[a-f0-9]{64}$/.test(externalAnchor) && actualSpkiSha256 !== externalAnchor) {
    reasons.push(`${prefix}_cle_ne_correspond_pas_ancre_externe`);
  }
  if (/^[a-f0-9]{64}$/.test(policyAnchor) && /^[a-f0-9]{64}$/.test(externalAnchor)
      && policyAnchor !== externalAnchor) reasons.push(`${prefix}_ancres_incoherentes`);
  let keyObject = null;
  if (!reasons.length) {
    try { keyObject = publicKey?.type === "public" ? publicKey : crypto.createPublicKey(publicKey); } catch {}
  }
  return {
    verified: reasons.length === 0 && keyObject?.asymmetricKeyType === "ed25519",
    reasons: [...new Set(reasons)].sort(),
    actualSpkiSha256,
    policySpkiSha256: /^[a-f0-9]{64}$/.test(policyAnchor) ? policyAnchor : null,
    externalSpkiSha256: /^[a-f0-9]{64}$/.test(externalAnchor) ? externalAnchor : null,
    keyObject,
  };
}

function publicTrustAudit(trust) {
  return {
    verified: trust?.verified === true,
    reasons: [...(trust?.reasons || [])],
    actualSpkiSha256: trust?.actualSpkiSha256 || null,
    policySpkiSha256: trust?.policySpkiSha256 || null,
    externalSpkiSha256: trust?.externalSpkiSha256 || null,
  };
}

function unsignedAttestationBody(attestation) {
  if (!attestation || typeof attestation !== "object" || Array.isArray(attestation)) return null;
  const body = { ...attestation };
  delete body.signature;
  return body;
}

function quantAttestationSigningPayload(domain, attestation) {
  const body = unsignedAttestationBody(attestation);
  if (!body) throw new Error("attestation quantitative absente ou invalide");
  return `${domain}\0${canonicalJson(body)}`;
}

function strictBase64Signature(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(value)) return null;
  try {
    const signature = Buffer.from(value, "base64");
    return signature.length === 64 && signature.toString("base64") === value ? signature : null;
  } catch {
    return null;
  }
}

function verifyExactAttestation({ attestation, expectedBody, domain, trust, role }) {
  const reasons = [...(trust?.reasons || [])];
  const prefix = String(role || "attestation");
  const providedBody = unsignedAttestationBody(attestation);
  if (!providedBody) reasons.push(`${prefix}_absente`);
  else {
    try {
      if (canonicalJson(providedBody) !== canonicalJson(expectedBody)) reasons.push(`${prefix}_payload_incoherent`);
    } catch {
      reasons.push(`${prefix}_payload_non_canonique`);
    }
  }
  const signature = strictBase64Signature(attestation?.signature);
  if (!signature) reasons.push(`${prefix}_signature_absente_ou_invalide`);
  let signatureVerified = false;
  if (!reasons.length && trust?.verified && providedBody && signature) {
    try {
      signatureVerified = crypto.verify(null,
        Buffer.from(quantAttestationSigningPayload(domain, attestation), "utf8"), trust.keyObject, signature);
    } catch {}
    if (!signatureVerified) reasons.push(`${prefix}_signature_non_verifiee`);
  }
  const body = {
    schemaVersion: 1,
    domain,
    expectedPayloadSha256: sha256Canonical(expectedBody),
    providedPayloadSha256: providedBody ? (() => {
      try { return sha256Canonical(providedBody); } catch { return null; }
    })() : null,
    publicKeyTrust: publicTrustAudit(trust),
    signatureVerified,
    attestation: attestation && typeof attestation === "object" ? attestation : null,
  };
  return { ...body, verified: reasons.length === 0 && signatureVerified,
    reasons: [...new Set(reasons)].sort(), attestationAuditSha256: sha256Canonical(body) };
}

function isStrictFiniteNumber(value) {
  if (value === null || value === undefined || typeof value === "boolean") return false;
  if (typeof value === "string" && value.trim() === "") return false;
  if (typeof value !== "number" && typeof value !== "string") return false;
  return Number.isFinite(Number(value));
}

function finiteNumber(value, name) {
  if (!isStrictFiniteNumber(value)) throw new Error(`${name} doit etre un nombre fini explicite`);
  const number = Number(value);
  return number;
}

function timestamp(value, name) {
  if (value === null || value === undefined || typeof value === "boolean"
      || (typeof value === "string" && value.trim() === "")) {
    throw new Error(`${name} est une date invalide`);
  }
  if (typeof value !== "number" && typeof value !== "string") throw new Error(`${name} est une date invalide`);
  const number = typeof value === "string" ? Date.parse(value) : value;
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} est une date invalide`);
  return Math.trunc(number);
}

function normaliseMarketRow(row, barMs) {
  const array = Array.isArray(row);
  if (!array && row?.availableAt == null) throw new Error("market.availableAt explicite est obligatoire");
  const ts = timestamp(array ? row[0] : row?.ts, "market.ts");
  const close = finiteNumber(array ? row[4] : row?.close, "market.close");
  const quoteVolume = finiteNumber(array ? row[7] : row?.quoteVolume, "market.quoteVolume");
  const availableAt = timestamp(array ? ts + barMs : (row.availableAt ?? ts + barMs), "market.availableAt");
  const confirmed = array ? row[8] === "1" || row[8] === 1 || row[8] === true : row.confirmed === true;
  const hasSpread = !array && Object.prototype.hasOwnProperty.call(row, "spreadBps");
  const spreadBps = hasSpread ? finiteNumber(row.spreadBps, "market.spreadBps") : null;
  const spreadAvailableAt = hasSpread ? timestamp(row.spreadAvailableAt, "market.spreadAvailableAt") : null;
  if (!(close > 0) || quoteVolume < 0) throw new Error("prix ou volume de marche invalide");
  if (spreadBps != null && spreadBps < 0) throw new Error("spread de marche negatif");
  if (availableAt < ts) throw new Error("une observation ne peut etre disponible avant son horodatage");
  return { ts, availableAt, close, quoteVolume, confirmed, spreadBps, spreadAvailableAt };
}

function preparePointInTimeSeries(seriesByInstrument, options = {}) {
  const barMs = positiveFinite(options.barMs || DEFAULT_POLICY.universe.barMs, "barMs");
  const instruments = {};
  let unconfirmedRowsExcluded = 0;
  for (const instId of Object.keys(seriesByInstrument || {}).sort()) {
    const input = seriesByInstrument[instId];
    if (!Array.isArray(input)) throw new Error(`serie invalide: ${instId}`);
    const normalised = input.map((row) => normaliseMarketRow(row, barMs));
    unconfirmedRowsExcluded += normalised.filter((row) => !row.confirmed).length;
    const rows = normalised.filter((row) => row.confirmed)
      .sort((a, b) => a.availableAt - b.availableAt || a.ts - b.ts);
    for (let index = 1; index < rows.length; index++) {
      if (rows[index].availableAt === rows[index - 1].availableAt) {
        throw new Error(`observations dupliquees au meme availableAt: ${instId}`);
      }
    }
    const prefixQuoteVolume = new Float64Array(rows.length + 1);
    const contiguousBarCount = new Uint32Array(rows.length);
    for (let index = 0; index < rows.length; index++) {
      prefixQuoteVolume[index + 1] = prefixQuoteVolume[index] + rows[index].quoteVolume;
      contiguousBarCount[index] = index > 0 && rows[index].ts - rows[index - 1].ts === barMs
        ? contiguousBarCount[index - 1] + 1 : 1;
    }
    instruments[instId] = { rows, prefixQuoteVolume, contiguousBarCount };
  }
  return { schemaVersion: 1, barMs, unconfirmedRowsExcluded, instruments };
}

function normaliseMasterEvent(event) {
  if (!event || typeof event !== "object" || !event.instId) throw new Error("evenement instrument master invalide");
  const nullableTimestamp = (value, name) => value == null ? null : timestamp(value, name);
  const out = {
    instId: String(event.instId).toUpperCase(),
    availableAt: timestamp(event.availableAt, "instrumentMaster.availableAt"),
    effectiveFrom: timestamp(event.effectiveFrom, "instrumentMaster.effectiveFrom"),
    effectiveTo: nullableTimestamp(event.effectiveTo, "instrumentMaster.effectiveTo"),
    instType: String(event.instType || "").toUpperCase(),
    instCategory: String(event.instCategory ?? ""),
    state: String(event.state || "").toLowerCase(),
    ruleType: String(event.ruleType || "").toLowerCase(),
    listTime: timestamp(event.listTime, "instrumentMaster.listTime"),
    delistTime: nullableTimestamp(event.delistTime, "instrumentMaster.delistTime"),
    spotInstId: event.spotInstId ? String(event.spotInstId).toUpperCase() : null,
  };
  if (out.listTime > out.effectiveFrom || (out.effectiveTo != null && out.effectiveTo <= out.effectiveFrom)) {
    throw new Error(`chronologie instrument master invalide: ${out.instId}`);
  }
  return out;
}

function preparePointInTimeInstrumentMaster(input) {
  const events = (input?.events || []).map(normaliseMasterEvent)
    .sort((a, b) => a.instId.localeCompare(b.instId) || a.availableAt - b.availableAt || a.effectiveFrom - b.effectiveFrom);
  const byInstrument = {};
  for (const event of events) (byInstrument[event.instId] ||= []).push(event);
  const source = {
    venue: String(input?.source?.venue || "").toUpperCase(),
    datasetId: String(input?.source?.datasetId || ""),
    retrievalBatchId: String(input?.source?.retrievalBatchId || ""),
    endpoint: String(input?.source?.endpoint || ""),
  };
  return {
    schemaVersion: 1,
    source,
    includesAllHistoricalInstruments: input?.includesAllHistoricalInstruments === true,
    events,
    byInstrument,
  };
}

function masterSnapshotAt(master, instId, selectionTs) {
  const candidates = master?.byInstrument?.[String(instId).toUpperCase()] || [];
  let selected = null;
  for (const event of candidates) {
    if (event.availableAt <= selectionTs && event.effectiveFrom <= selectionTs
        && (!selected || event.availableAt > selected.availableAt
          || (event.availableAt === selected.availableAt && event.effectiveFrom > selected.effectiveFrom))) selected = event;
  }
  return selected;
}

function instrumentEligibilityAt(master, instId, selectionValue, universeInput = {}) {
  const universe = { ...DEFAULT_POLICY.universe, ...universeInput };
  const selectionTs = timestamp(selectionValue, "instrumentEligibility.selectionTs");
  const reasons = [];
  if (!master || master.source?.venue !== "OKX") return { eligible: false, reasons: ["instrument_master_absent_ou_non_okx"] };
  const swap = masterSnapshotAt(master, instId, selectionTs);
  const inspect = (snapshot, expectedType, prefix) => {
    if (!snapshot) { reasons.push(`${prefix}_master_absent`); return; }
    if (snapshot.availableAt > selectionTs) reasons.push(`${prefix}_master_futur`);
    if (snapshot.instType !== expectedType) reasons.push(`${prefix}_type_invalide`);
    if (snapshot.instCategory !== String(universe.requiredInstrumentCategory)) reasons.push(`${prefix}_categorie_invalide`);
    if (snapshot.state !== String(universe.requiredInstrumentState).toLowerCase()) reasons.push(`${prefix}_non_live`);
    if (snapshot.ruleType !== String(universe.requiredRuleType).toLowerCase()) reasons.push(`${prefix}_regle_invalide`);
    if (snapshot.effectiveTo != null && snapshot.effectiveTo <= selectionTs) reasons.push(`${prefix}_intervalle_termine`);
    if (selectionTs - snapshot.listTime < Number(universe.minimumListingAgeMs)) reasons.push(`${prefix}_listing_trop_recent`);
    if (snapshot.delistTime != null && snapshot.delistTime - selectionTs < Number(universe.minimumTimeToDelistMs)) {
      reasons.push(`${prefix}_delist_imminent_ou_passe`);
    }
  };
  inspect(swap, "SWAP", "swap");
  let spot = null;
  if (swap && universe.requireSpotHedge) {
    if (!swap.spotInstId) reasons.push("spot_hedge_non_reference");
    else { spot = masterSnapshotAt(master, swap.spotInstId, selectionTs); inspect(spot, "SPOT", "spot"); }
  }
  return {
    eligible: reasons.length === 0,
    reasons: [...new Set(reasons)],
    swap,
    spot,
    spotInstId: swap?.spotInstId || null,
    inputMaxAvailableAt: Math.max(swap?.availableAt || 0, spot?.availableAt || 0),
  };
}

function auditInstrumentMasterMarketCoverage(master, prepared, cutoffValue, universeInput = {}) {
  const cutoffTs = timestamp(cutoffValue, "instrumentMasterCoverage.cutoffTs");
  const universe = { ...DEFAULT_POLICY.universe, ...universeInput };
  const reasons = [];
  if (!prepared?.instruments || typeof prepared.instruments !== "object") {
    return {
      verified: false,
      reasons: ["instrument_master_market_series_non_verifiees"],
      historicallyAdmissibleSwaps: [],
      marketSeriesSwaps: [],
      missingMarketSeries: [],
      marketSeriesWithoutMaster: [],
      missingSpotMaster: [],
      delistedSwaps: [],
      delistedWithoutLiveHistory: [],
      coverageSha256: sha256Canonical({ cutoffTs, missingPrepared: true }),
    };
  }
  const marketSeriesSwaps = Object.keys(prepared.instruments)
    .filter((instId) => instId.toUpperCase().endsWith("-SWAP")
      && (prepared.instruments[instId]?.rows || []).some((row) => row.availableAt < cutoffTs))
    .map((instId) => instId.toUpperCase()).sort();
  const marketSet = new Set(marketSeriesSwaps);
  const historical = new Set();
  const missingSpotMaster = [];
  for (const event of master?.events || []) {
    if (event.availableAt >= cutoffTs || event.instType !== "SWAP" || event.state !== "live"
        || event.instCategory !== String(universe.requiredInstrumentCategory)
        || event.ruleType !== String(universe.requiredRuleType).toLowerCase()) continue;
    const admissibleStart = Math.max(event.effectiveFrom, event.listTime + Number(universe.minimumListingAgeMs));
    const admissibleEnd = Math.min(cutoffTs, event.effectiveTo ?? cutoffTs, event.delistTime ?? cutoffTs);
    if (!(admissibleStart < admissibleEnd)) continue;
    historical.add(event.instId);
    if (universe.requireSpotHedge) {
      const spotEvents = master?.byInstrument?.[event.spotInstId] || [];
      const hasSpotInterval = Boolean(event.spotInstId) && spotEvents.some((spot) =>
        spot.instType === "SPOT" && spot.state === "live"
        && spot.instCategory === String(universe.requiredInstrumentCategory)
        && spot.ruleType === String(universe.requiredRuleType).toLowerCase()
        && spot.availableAt <= admissibleStart && spot.effectiveFrom <= admissibleStart
        && (spot.effectiveTo == null || spot.effectiveTo > admissibleStart));
      if (!hasSpotInterval) missingSpotMaster.push(event.instId);
    }
  }
  const historicallyAdmissibleSwaps = [...historical].sort();
  const missingMarketSeries = historicallyAdmissibleSwaps.filter((instId) => !marketSet.has(instId));
  const masterSwapSet = new Set((master?.events || [])
    .filter((event) => event.availableAt < cutoffTs && event.instType === "SWAP")
    .map((event) => event.instId));
  const marketSeriesWithoutMaster = marketSeriesSwaps.filter((instId) => !masterSwapSet.has(instId));
  const delistedSwaps = [...new Set((master?.events || [])
    .filter((event) => event.availableAt < cutoffTs && event.instType === "SWAP"
      && (event.state !== "live" || (event.delistTime != null && event.delistTime < cutoffTs)))
    .map((event) => event.instId))].sort();
  const delistedWithoutLiveHistory = delistedSwaps.filter((instId) =>
    !(master?.events || []).some((event) => event.instId === instId && event.instType === "SWAP"
      && event.state === "live" && event.availableAt < cutoffTs));
  if (missingMarketSeries.length) reasons.push("instrument_master_swap_sans_market_series");
  if (marketSeriesWithoutMaster.length) reasons.push("market_series_swap_sans_instrument_master");
  if (missingSpotMaster.length) reasons.push("instrument_master_swap_sans_spot_historique");
  if (delistedWithoutLiveHistory.length) reasons.push("instrument_master_deliste_sans_intervalle_live");
  const body = {
    cutoffTs,
    historicallyAdmissibleSwaps,
    marketSeriesSwaps,
    missingMarketSeries,
    marketSeriesWithoutMaster,
    missingSpotMaster: [...new Set(missingSpotMaster)].sort(),
    delistedSwaps,
    delistedWithoutLiveHistory,
  };
  return { ...body, verified: reasons.length === 0, reasons, coverageSha256: sha256Canonical(body) };
}

function createInstrumentMasterManifest(master, cutoffValue, prepared, universeInput = {}, options = {}) {
  const cutoffTs = timestamp(cutoffValue, "instrumentMaster.cutoffTs");
  const events = (master?.events || []).filter((event) => event.availableAt < cutoffTs);
  const reasons = [];
  if (master?.source?.venue !== "OKX") reasons.push("instrument_master_source_non_okx");
  if (!master?.source?.datasetId || !master?.source?.retrievalBatchId || !master?.source?.endpoint) {
    reasons.push("instrument_master_provenance_incomplete");
  }
  if (master?.includesAllHistoricalInstruments !== true) reasons.push("instrument_master_univers_historique_incomplet");
  if (options.inventoryAuthenticated !== true) reasons.push("instrument_master_inventaire_okx_non_authentifie");
  if (!events.length) reasons.push("instrument_master_vide");
  const marketCoverage = auditInstrumentMasterMarketCoverage(master, prepared, cutoffTs, universeInput);
  reasons.push(...marketCoverage.reasons);
  const includesDelisted = marketCoverage.delistedSwaps.length > 0
    && marketCoverage.delistedWithoutLiveHistory.length === 0
    && marketCoverage.delistedSwaps.every((instId) => marketCoverage.marketSeriesSwaps.includes(instId));
  if (!includesDelisted) reasons.push("instrument_master_sans_delistes");
  const body = {
    schemaVersion: 1,
    source: master?.source || { venue: "", datasetId: "", retrievalBatchId: "", endpoint: "" },
    cutoffTs,
    includesAllHistoricalInstruments: master?.includesAllHistoricalInstruments === true,
    includesDelisted,
    events: events.length,
    instruments: new Set(events.map((event) => event.instId)).size,
    eventsSha256: sha256Canonical(events),
    inventoryAuthenticated: options.inventoryAuthenticated === true,
    marketCoverage,
  };
  return { ...body, verified: reasons.length === 0, reasons, instrumentMasterSha256: sha256Canonical(body) };
}

function lastIndexAtOrBefore(rows, value) {
  let low = 0, high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rows[middle].availableAt <= value) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

function firstIndexAfter(rows, value) {
  let low = 0, high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rows[middle].availableAt <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function buildPointInTimeTopMovers(prepared, selectionTime, universeInput = {}, instrumentMaster) {
  const universe = { ...DEFAULT_POLICY.universe, ...universeInput };
  const selectionTs = timestamp(selectionTime, "selectionTs");
  if (Number(universe.topN) !== 30) throw new Error("topN doit rester egal a 30");
  const rankingWindowMs = positiveFinite(universe.rankingWindowMs, "rankingWindowMs");
  const barMs = positiveFinite(universe.barMs, "barMs");
  if (rankingWindowMs % barMs !== 0) throw new Error("rankingWindowMs doit etre un multiple exact de barMs");
  const targetStart = selectionTs - rankingWindowMs;
  const liquidityStart = selectionTs - positiveFinite(universe.liquidityWindowMs, "liquidityWindowMs");
  const maximumStaleness = positiveFinite(universe.maxEndpointStalenessMs, "maxEndpointStalenessMs");
  const eligible = [];
  const rejected = [];
  let eligibleMarketSeriesIncomplete = false;

  for (const instId of Object.keys(prepared?.instruments || {}).sort()) {
    const suffix = `-${String(universe.quoteCurrency || "USDT").toUpperCase()}-${String(universe.instrumentType || "SWAP").toUpperCase()}`;
    if (!instId.toUpperCase().endsWith(suffix)) { rejected.push({ instId, reason: "instrument_scope_mismatch" }); continue; }
    const masterEligibility = instrumentEligibilityAt(instrumentMaster, instId, selectionTs, universe);
    if (!masterEligibility.eligible) {
      rejected.push({ instId, reason: masterEligibility.reasons.join("+") });
      continue;
    }
    const item = prepared.instruments[instId];
    const rows = item.rows;
    const endIndex = lastIndexAtOrBefore(rows, selectionTs);
    const startIndex = lastIndexAtOrBefore(rows, targetStart);
    if (endIndex < 0 || startIndex < 0) {
      eligibleMarketSeriesIncomplete = true;
      rejected.push({ instId, reason: "ranking_history_missing" });
      continue;
    }
    const start = rows[startIndex], end = rows[endIndex];
    if (selectionTs - end.availableAt > maximumStaleness) {
      eligibleMarketSeriesIncomplete = true;
      rejected.push({ instId, reason: "ranking_endpoint_stale" });
      continue;
    }
    if (targetStart - start.availableAt > maximumStaleness) {
      eligibleMarketSeriesIncomplete = true;
      rejected.push({ instId, reason: "ranking_start_stale" });
      continue;
    }
    const expectedBars = rankingWindowMs / barMs + 1;
    const exactBarGrid = endIndex - startIndex + 1 === expectedBars
      && end.ts - start.ts === rankingWindowMs
      && Number(item.contiguousBarCount?.[endIndex] || 0) >= expectedBars;
    if (!exactBarGrid || Number(prepared?.barMs) !== barMs) {
      eligibleMarketSeriesIncomplete = true;
      rejected.push({ instId, reason: "ranking_bar_grid_incomplete" });
      continue;
    }
    if (end.spreadBps == null || end.spreadAvailableAt == null) {
      rejected.push({ instId, reason: "spread_observe_absent" }); continue;
    }
    if (end.spreadAvailableAt > selectionTs) { rejected.push({ instId, reason: "spread_observe_futur" }); continue; }
    if (selectionTs - end.spreadAvailableAt > maximumStaleness) {
      rejected.push({ instId, reason: "spread_observe_stale" }); continue;
    }
    if (end.spreadBps > Number(universe.maxSpreadBps)) {
      rejected.push({ instId, reason: "spread_superieur_au_plafond" }); continue;
    }
    const liquidityIndex = firstIndexAfter(rows, liquidityStart);
    const quoteVolume = item.prefixQuoteVolume[endIndex + 1] - item.prefixQuoteVolume[liquidityIndex];
    if (quoteVolume < Number(universe.minQuoteVolume || 0)) { rejected.push({ instId, reason: "liquidity_below_floor" }); continue; }
    if (universe.rankingMetric !== "absolute-log-return") throw new Error("rankingMetric non supporte");
    const move = Math.log(end.close / start.close);
    const score = Math.abs(move);
    eligible.push({
      instId,
      score,
      move,
      quoteVolume,
      rankingStartAvailableAt: start.availableAt,
      rankingEndAvailableAt: end.availableAt,
      instrumentMasterMaxAvailableAt: masterEligibility.inputMaxAvailableAt,
      spreadBps: end.spreadBps,
      spreadAvailableAt: end.spreadAvailableAt,
      spotInstId: masterEligibility.spotInstId,
      inputMaxAvailableAt: Math.max(end.availableAt, end.spreadAvailableAt, masterEligibility.inputMaxAvailableAt),
    });
  }
  eligible.sort((a, b) => b.score - a.score || b.quoteVolume - a.quoteVolume || a.instId.localeCompare(b.instId));
  const required = Math.max(Number(universe.topN), Number(universe.minimumEligible));
  const accepted = eligible.length >= required && !eligibleMarketSeriesIncomplete;
  const constituents = accepted ? eligible.slice(0, Number(universe.topN)) : [];
  const body = {
    schemaVersion: 1,
    venue: String(universe.venue).toUpperCase(),
    selectionTs,
    topN: Number(universe.topN),
    rankingMetric: universe.rankingMetric,
    rankingWindowMs: Number(universe.rankingWindowMs),
    liquidityWindowMs: Number(universe.liquidityWindowMs),
    minQuoteVolume: Number(universe.minQuoteVolume),
    maxSpreadBps: Number(universe.maxSpreadBps),
    eligibleCount: eligible.length,
    constituents,
  };
  return {
    ...body,
    accepted,
    reasons: accepted ? [] : [
      ...(eligible.length < required ? ["moins_de_30_instruments_eligibles"] : []),
      ...(eligibleMarketSeriesIncomplete ? ["serie_marche_eligible_incomplete"] : []),
    ],
    rejected,
    rosterSha256: sha256Canonical(body),
  };
}

function verifyRosterPointInTime(roster, expectedSelectionTs) {
  const reasons = [];
  const selectionTs = timestamp(expectedSelectionTs ?? roster?.selectionTs, "selectionTs");
  if (!roster || roster.accepted !== true) reasons.push("roster_non_accepte");
  if (Number(roster?.selectionTs) !== selectionTs) reasons.push("roster_mauvaise_date");
  if (Number(roster?.topN) !== 30 || roster?.constituents?.length !== 30) reasons.push("roster_pas_top30");
  const ids = new Set();
  for (const item of roster?.constituents || []) {
    if (ids.has(item.instId)) reasons.push("roster_instrument_duplique");
    ids.add(item.instId);
    for (const name of ["rankingStartAvailableAt", "rankingEndAvailableAt", "inputMaxAvailableAt"]) {
      if (!Number.isFinite(Number(item[name])) || Number(item[name]) > selectionTs) reasons.push("roster_utilise_le_futur");
    }
  }
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)] };
}

function rosterSelectionTimes(startValue, endValue, rebalanceMs) {
  const startTs = timestamp(startValue, "roster.startTs");
  const endTs = timestamp(endValue, "roster.endTs");
  const step = positiveFinite(rebalanceMs, "rebalanceMs");
  if (endTs <= startTs) throw new Error("intervalle de roster vide");
  const times = [];
  for (let value = startTs; value < endTs; value += step) times.push(value);
  return times;
}

function buildRosterSchedule(prepared, startTs, endTs, universe = {}, instrumentMaster) {
  return auditRosterSchedule(prepared, startTs, endTs, universe, instrumentMaster, { retainRosters: true });
}

function auditRosterSchedule(prepared, startTs, endTs, universe = {}, instrumentMaster, options = {}) {
  const cfg = { ...DEFAULT_POLICY.universe, ...universe };
  const times = rosterSelectionTimes(startTs, endTs, cfg.rebalanceMs);
  const rosters = [];
  const digest = crypto.createHash("sha256");
  let acceptedCount = 0, futureViolation = false;
  for (const value of times) {
    const roster = buildPointInTimeTopMovers(prepared, value, cfg, instrumentMaster);
    const check = verifyRosterPointInTime(roster);
    if (roster.accepted && check.valid) acceptedCount++;
    if (check.reasons.includes("roster_utilise_le_futur")) futureViolation = true;
    digest.update(canonicalJson({ selectionTs: roster.selectionTs, accepted: roster.accepted,
      reasons: roster.reasons, rosterSha256: roster.rosterSha256 }));
    digest.update("\n");
    if (options.retainRosters) rosters.push(roster);
  }
  const coverageRate = times.length ? acceptedCount / times.length : 0;
  const reasons = [];
  if (coverageRate < Number(cfg.minRosterCoverageRate)) reasons.push("couverture_roster_insuffisante");
  if (futureViolation) reasons.push("roster_utilise_le_futur");
  return {
    startTs, endTs, expectedCount: times.length, acceptedCount, coverageRate, reasons,
    rosterScheduleSha256: digest.digest("hex"), rosters,
  };
}

function createDataManifest({ prepared, instrumentMaster, source, cutoffTs, universePolicy,
  historicalArtifacts = [], feeScheduleManifest = null, executionDatasetManifest = null,
  cycleLedgerManifest = null, executionUniverseParity = null, processAttestationAudit = null }) {
  const cutoff = timestamp(cutoffTs, "cutoffTs");
  const venue = String(source?.venue || "").toUpperCase();
  const reasons = [];
  if (venue !== "OKX") reasons.push("source_non_okx");
  const instrumentMasterManifest = createInstrumentMasterManifest(instrumentMaster, cutoff, prepared, universePolicy, {
    inventoryAuthenticated: processAttestationAudit?.verified === true,
  });
  reasons.push(...instrumentMasterManifest.reasons);
  const instruments = [];
  let totalRows = 0, excludedFutureRows = 0;
  for (const instId of Object.keys(prepared?.instruments || {}).sort()) {
    const all = prepared.instruments[instId].rows;
    const rows = all.filter((row) => row.availableAt < cutoff);
    excludedFutureRows += all.length - rows.length;
    totalRows += rows.length;
    instruments.push({
      instId,
      rows: rows.length,
      firstTs: rows.length ? rows[0].ts : null,
      firstAvailableAt: rows.length ? rows[0].availableAt : null,
      lastTs: rows.length ? rows[rows.length - 1].ts : null,
      lastAvailableAt: rows.length ? rows[rows.length - 1].availableAt : null,
      sha256: sha256Canonical(rows),
    });
  }
  const body = {
    schemaVersion: 1,
    source: {
      venue,
      datasetId: String(source?.datasetId || ""),
      retrievalBatchId: String(source?.retrievalBatchId || ""),
      endpoint: String(source?.endpoint || ""),
    },
    cutoffTs: cutoff,
    cutoffExclusive: true,
    barMs: prepared.barMs,
    confirmedDataOnly: true,
    unconfirmedRowsExcluded: Number(prepared.unconfirmedRowsExcluded || 0),
    totalRows,
    excludedFutureRows,
    universePolicy: {
      topN: Number(universePolicy.topN),
      rankingMetric: universePolicy.rankingMetric,
      rankingWindowMs: Number(universePolicy.rankingWindowMs),
      liquidityWindowMs: Number(universePolicy.liquidityWindowMs),
      minQuoteVolume: Number(universePolicy.minQuoteVolume),
      maxSpreadBps: Number(universePolicy.maxSpreadBps),
      minimumEligible: Number(universePolicy.minimumEligible),
      rebalanceMs: Number(universePolicy.rebalanceMs),
    },
    instruments,
    instrumentMaster: instrumentMasterManifest,
    feeSchedule: feeScheduleManifest,
    executionDataset: executionDatasetManifest,
    cycleLedger: cycleLedgerManifest,
    executionUniverseParity,
    processAttestation: processAttestationAudit,
    historicalArtifacts: [...historicalArtifacts].sort((a, b) => String(a.id).localeCompare(String(b.id))),
  };
  if (!body.source.datasetId || !body.source.retrievalBatchId || !body.source.endpoint) reasons.push("provenance_source_incomplete");
  if (feeScheduleManifest?.verified !== true) reasons.push("fee_schedule_non_verifie");
  if (executionDatasetManifest?.verified !== true) reasons.push("execution_dataset_non_verifie");
  if (cycleLedgerManifest?.valid !== true) reasons.push("cycle_ledger_non_verifie");
  if (executionUniverseParity?.verified !== true) reasons.push("politique_univers_execution_divergente");
  return { ...body, verified: reasons.length === 0, reasons, manifestSha256: sha256Canonical(body) };
}

function feeSnapshotBody(snapshot) {
  return {
    schemaVersion: 1,
    source: {
      venue: String(snapshot?.source?.venue || "").toUpperCase(),
      endpoint: String(snapshot?.source?.endpoint || ""),
      datasetId: String(snapshot?.source?.datasetId || ""),
      retrievalBatchId: String(snapshot?.source?.retrievalBatchId || ""),
      sourceArtifactSha256: String(snapshot?.source?.sourceArtifactSha256 || "").toLowerCase(),
    },
    accountTier: String(snapshot?.accountTier || ""),
    instrumentType: String(snapshot?.instrumentType || "").toUpperCase(),
    availableAt: timestamp(snapshot?.availableAt, "feeSnapshot.availableAt"),
    makerFeeRate: finiteNumber(snapshot?.makerFeeRate, "feeSnapshot.makerFeeRate"),
    takerFeeRate: finiteNumber(snapshot?.takerFeeRate, "feeSnapshot.takerFeeRate"),
  };
}

function prepareFeeSchedule(input, cutoffValue) {
  const cutoffTs = timestamp(cutoffValue, "feeSchedule.cutoffTs");
  const reasons = [];
  const snapshots = [];
  const hashes = new Set();
  for (const raw of input || []) {
    const body = feeSnapshotBody(raw);
    const snapshotSha256 = sha256Canonical(body);
    if (String(raw?.snapshotSha256 || "").toLowerCase() !== snapshotSha256) reasons.push("fee_snapshot_hash_invalide");
    if (body.source.venue !== "OKX" || !body.source.endpoint.endsWith("/account/trade-fee")) {
      reasons.push("fee_snapshot_provenance_non_okx");
    }
    if (!body.source.datasetId || !body.source.retrievalBatchId
        || !/^[a-f0-9]{64}$/.test(body.source.sourceArtifactSha256)) reasons.push("fee_snapshot_provenance_incomplete");
    if (!body.accountTier || body.instrumentType !== "SWAP") reasons.push("fee_snapshot_tier_ou_type_invalide");
    if (body.availableAt >= cutoffTs) reasons.push("fee_snapshot_futur");
    if (body.makerFeeRate < -0.01 || body.takerFeeRate < -0.01
        || body.makerFeeRate > 0.01 || body.takerFeeRate > 0.01) reasons.push("fee_snapshot_taux_hors_borne");
    if (hashes.has(snapshotSha256)) reasons.push("fee_snapshot_duplique");
    hashes.add(snapshotSha256);
    snapshots.push({ ...body, snapshotSha256 });
  }
  if (!snapshots.length) reasons.push("fee_schedule_absent");
  snapshots.sort((a, b) => a.availableAt - b.availableAt || a.snapshotSha256.localeCompare(b.snapshotSha256));
  const body = { schemaVersion: 1, cutoffTs, snapshots };
  return { ...body, verified: reasons.length === 0, reasons: [...new Set(reasons)].sort(),
    feeScheduleSha256: sha256Canonical(body) };
}

function executionFillBody(fill) {
  return {
    fillId: String(fill?.fillId || "").trim(),
    instId: String(fill?.instId || "").toUpperCase(),
    ts: timestamp(fill?.ts, "executionFill.ts"),
    availableAt: timestamp(fill?.availableAt, "executionFill.availableAt"),
    side: String(fill?.side || "").toLowerCase(),
    liquidity: String(fill?.liquidity || "").toLowerCase(),
    price: finiteNumber(fill?.price, "executionFill.price"),
    quantity: finiteNumber(fill?.quantity, "executionFill.quantity"),
    contractValue: finiteNumber(fill?.contractValue, "executionFill.contractValue"),
  };
}

function createExecutionAttributionManifest(runRecord, executionDatasetBody) {
  const reasons = [];
  const attributions = [];
  const attributedFillIds = new Set();
  for (const horizon of runRecord?.horizons || []) {
    const horizonDays = Number(horizon?.days);
    if (!Number.isInteger(horizonDays) || !REQUIRED_HORIZONS_DAYS.includes(horizonDays)) {
      reasons.push("execution_attribution_horizon_invalide");
    }
    for (const fold of horizon?.folds || []) {
      const foldId = String(fold?.id || "").trim();
      const strategy = {
        id: String(fold?.strategy?.id || "").trim(),
        version: String(fold?.strategy?.version || "").trim(),
        configSha256: String(fold?.strategy?.configSha256 || "").toLowerCase(),
      };
      if (!foldId || !strategy.id || !strategy.version || !/^[a-f0-9]{64}$/.test(strategy.configSha256)) {
        reasons.push("execution_attribution_fold_ou_strategie_invalide");
      }
      const hypothesesEvaluated = (fold?.hypothesesEvaluated || []).map(String).map((item) => item.trim()).sort();
      if (!hypothesesEvaluated.length || hypothesesEvaluated.some((item) => !item)) {
        reasons.push("execution_attribution_hypotheses_invalides");
      }
      for (const trade of fold?.trades || []) {
        const tradeId = String(trade?.tradeId || "").trim();
        const instId = String(trade?.instId || "").toUpperCase();
        if (!tradeId || !instId) reasons.push("execution_attribution_trade_invalide");
        for (const [role, ids] of [["entry", trade?.entryFillIds], ["exit", trade?.exitFillIds]]) {
          if (!Array.isArray(ids) || !ids.length) {
            reasons.push("execution_attribution_fills_absents");
            continue;
          }
          ids.forEach((rawFillId, position) => {
            const fillId = String(rawFillId || "").trim();
            if (!fillId || attributedFillIds.has(fillId)) reasons.push("execution_attribution_fill_duplique");
            attributedFillIds.add(fillId);
            attributions.push({
              fillId,
              role,
              position,
              horizonDays,
              foldId,
              tradeId,
              instId,
              strategy,
              hypothesesEvaluatedSha256: sha256Canonical(hypothesesEvaluated),
            });
          });
        }
      }
    }
  }
  attributions.sort((a, b) => a.fillId.localeCompare(b.fillId) || a.role.localeCompare(b.role)
    || a.horizonDays - b.horizonDays || a.foldId.localeCompare(b.foldId));
  const datasetFillIds = (executionDatasetBody?.fills || []).map((fill) => fill.fillId).sort();
  const attributedIds = [...attributedFillIds].sort();
  if (datasetFillIds.length !== attributedIds.length
      || datasetFillIds.some((fillId, index) => fillId !== attributedIds[index])) {
    reasons.push("execution_attribution_non_exhaustive");
  }
  const body = {
    schemaVersion: 1,
    runId: String(runRecord?.runId || ""),
    candidateId: String(runRecord?.candidateId || "").toLowerCase(),
    cutoffTs: executionDatasetBody?.cutoffTs ?? null,
    executionDatasetSha256: executionDatasetBody?.executionDatasetSha256 || null,
    fillCount: datasetFillIds.length,
    attributionCount: attributions.length,
    attributions,
  };
  if (!body.runId) reasons.push("execution_attribution_run_id_absent");
  if (!/^[a-f0-9]{64}$/.test(body.candidateId)) reasons.push("execution_attribution_candidate_id_absent");
  return { ...body, verified: reasons.length === 0, reasons: [...new Set(reasons)].sort(),
    attributionManifestSha256: sha256Canonical(body) };
}

function expectedExecutionAttestationBody({ runRecord, executionDataset, attributionManifest, publicKeySpkiSha256 }) {
  return {
    schemaVersion: 1,
    artifactType: "hermes-quant-execution-attribution-attestation",
    runId: String(runRecord?.runId || ""),
    candidateId: String(runRecord?.candidateId || "").toLowerCase(),
    cutoffTs: executionDataset.cutoffTs,
    executionDatasetSha256: executionDataset.executionDatasetSha256,
    executionSourceSha256: sha256Canonical(executionDataset.source),
    attributionManifestSha256: attributionManifest.attributionManifestSha256,
    fillCount: executionDataset.fills.length,
    publicKeySpkiSha256: publicKeySpkiSha256 || null,
  };
}

function prepareExecutionDataset(input, cutoffValue, options = {}) {
  const cutoffTs = timestamp(cutoffValue, "executionDataset.cutoffTs");
  const source = {
    venue: String(input?.source?.venue || "").toUpperCase(),
    endpoint: String(input?.source?.endpoint || ""),
    datasetId: String(input?.source?.datasetId || ""),
    retrievalBatchId: String(input?.source?.retrievalBatchId || ""),
    sourceArtifactSha256: String(input?.source?.sourceArtifactSha256 || "").toLowerCase(),
  };
  const reasons = [];
  if (source.venue !== "OKX" || !source.endpoint.endsWith("/trade/fills-history")) {
    reasons.push("execution_dataset_provenance_non_okx");
  }
  if (!source.datasetId || !source.retrievalBatchId || !/^[a-f0-9]{64}$/.test(source.sourceArtifactSha256)) {
    reasons.push("execution_dataset_provenance_incomplete");
  }
  const ids = new Set();
  const fills = (input?.fills || []).map((raw) => {
    const fill = executionFillBody(raw);
    if (!fill.fillId || ids.has(fill.fillId)) reasons.push("execution_fill_id_invalide_ou_duplique");
    ids.add(fill.fillId);
    if (!fill.instId || !(fill.price > 0) || !(fill.quantity > 0) || !(fill.contractValue > 0)) {
      reasons.push("execution_fill_valeurs_invalides");
    }
    if (!["buy", "sell"].includes(fill.side) || !["maker", "taker"].includes(fill.liquidity)) {
      reasons.push("execution_fill_side_ou_liquidite_invalide");
    }
    if (fill.availableAt < fill.ts || fill.availableAt >= cutoffTs) reasons.push("execution_fill_disponibilite_invalide");
    return fill;
  }).sort((a, b) => a.ts - b.ts || a.fillId.localeCompare(b.fillId));
  if (!fills.length) reasons.push("execution_dataset_vide");
  const body = { schemaVersion: 1, source, cutoffTs, fills };
  const executionDatasetSha256 = sha256Canonical(body);
  if (String(input?.executionDatasetSha256 || "").toLowerCase() !== executionDatasetSha256) {
    reasons.push("execution_dataset_hash_invalide");
  }
  const dataset = { ...body, executionDatasetSha256 };
  const attributionManifest = createExecutionAttributionManifest(options.runRecord, dataset);
  reasons.push(...attributionManifest.reasons);
  const expectedAttestation = expectedExecutionAttestationBody({
    runRecord: options.runRecord,
    executionDataset: dataset,
    attributionManifest,
    publicKeySpkiSha256: options.trust?.actualSpkiSha256 || null,
  });
  const attestationAudit = verifyExactAttestation({
    attestation: input?.attestation,
    expectedBody: expectedAttestation,
    domain: QUANT_EXECUTION_SIGNATURE_DOMAIN,
    trust: options.trust,
    role: "execution_attestation",
  });
  reasons.push(...attestationAudit.reasons);
  return {
    ...dataset,
    attributionManifest,
    attestationAudit,
    expectedAttestation,
    verified: reasons.length === 0,
    reasons: [...new Set(reasons)].sort(),
  };
}

function replayTradeFromExecutionDataset(trade, executionDataset) {
  const byId = new Map((executionDataset?.fills || []).map((fill) => [fill.fillId, fill]));
  const entryIds = Array.isArray(trade?.entryFillIds) ? trade.entryFillIds.map((id) => String(id).trim()) : [];
  const exitIds = Array.isArray(trade?.exitFillIds) ? trade.exitFillIds.map((id) => String(id).trim()) : [];
  if (!entryIds.length || !exitIds.length || [...entryIds, ...exitIds].some((id) => !id)
      || new Set([...entryIds, ...exitIds]).size !== entryIds.length + exitIds.length) {
    throw new Error("references de fills absentes ou dupliquees");
  }
  const entry = entryIds.map((id) => byId.get(id));
  const exit = exitIds.map((id) => byId.get(id));
  if ([...entry, ...exit].some((fill) => !fill)) throw new Error("fill reference absent du dataset prepare");
  const instId = String(trade?.instId || "").toUpperCase();
  if ([...entry, ...exit].some((fill) => fill.instId !== instId)) throw new Error("fill rattache au mauvais instrument");
  const side = String(trade?.side || "").toLowerCase();
  const expectedEntrySide = side === "long" ? "buy" : side === "short" ? "sell" : "";
  const expectedExitSide = side === "long" ? "sell" : side === "short" ? "buy" : "";
  if (!expectedEntrySide || entry.some((fill) => fill.side !== expectedEntrySide)
      || exit.some((fill) => fill.side !== expectedExitSide)) throw new Error("sens des fills incoherent avec le trade");
  const entryUnits = entry.reduce((sum, fill) => sum + fill.quantity * fill.contractValue, 0);
  const exitUnits = exit.reduce((sum, fill) => sum + fill.quantity * fill.contractValue, 0);
  if (Math.abs(entryUnits - exitUnits) > Math.max(1e-10, entryUnits * 1e-9)) throw new Error("quantites entry/exit non reconciliees");
  const entryNotionalQuote = entry.reduce((sum, fill) => sum + fill.price * fill.quantity * fill.contractValue, 0);
  const exitNotionalQuote = exit.reduce((sum, fill) => sum + fill.price * fill.quantity * fill.contractValue, 0);
  const grossPnlQuote = side === "long" ? exitNotionalQuote - entryNotionalQuote : entryNotionalQuote - exitNotionalQuote;
  const entryTs = Math.max(...entry.map((fill) => fill.ts));
  const exitTs = Math.max(...exit.map((fill) => fill.ts));
  if (timestamp(trade.entryTs, "trade.entryTs") !== entryTs || timestamp(trade.exitTs, "trade.exitTs") !== exitTs) {
    throw new Error("horodatages du trade non reconcilies avec les fills");
  }
  const oneLiquidity = (fills, leg) => {
    const values = [...new Set(fills.map((fill) => fill.liquidity))];
    if (values.length !== 1) throw new Error(`liquidite ${leg} mixte non supportee sans ventilation de frais`);
    return values[0];
  };
  const entryLiquidity = oneLiquidity(entry, "entry"), exitLiquidity = oneLiquidity(exit, "exit");
  return {
    entryNotionalQuote,
    exitNotionalQuote,
    grossPnlQuote,
    grossPnlBasis: "fill-to-fill",
    entryLiquidity,
    exitLiquidity,
    filledQty: entry.reduce((sum, fill) => sum + fill.quantity, 0),
    entryFillIds: entryIds,
    exitFillIds: exitIds,
    replaySha256: sha256Canonical({ instId, side, entry, exit }),
  };
}

function requiredDataStart(cutoffTs, horizonDays, policyInput = {}) {
  const policy = mergePolicy(policyInput);
  const evaluationStartTs = timestamp(cutoffTs, "cutoffTs") - Number(horizonDays) * DAY_MS;
  const gap = Math.max(policy.walkForward.purgeMs, policy.walkForward.embargoMs, policy.walkForward.labelHorizonMs);
  return evaluationStartTs - policy.walkForward.minimumTrainingMs - gap - policy.universe.rankingWindowMs;
}

function assessMinimumDataCoverage(manifest, cutoffTs, horizonDays, policyInput = {}) {
  const policy = mergePolicy(policyInput);
  const cutoff = timestamp(cutoffTs, "cutoffTs");
  const requiredStartTs = requiredDataStart(cutoff, horizonDays, policy);
  const eligible = (manifest?.instruments || []).filter((instrument) =>
    Number.isFinite(instrument.firstAvailableAt)
    && instrument.firstAvailableAt <= requiredStartTs + policy.universe.maxEndpointStalenessMs
    && Number.isFinite(instrument.lastAvailableAt)
    && instrument.lastAvailableAt >= cutoff - policy.universe.maxEndpointStalenessMs);
  const required = Math.max(policy.universe.topN, policy.universe.minimumEligible);
  return {
    horizonDays: Number(horizonDays),
    requiredStartTs,
    cutoffTs: cutoff,
    eligibleInstruments: eligible.length,
    requiredInstruments: required,
    sufficient: eligible.length >= required,
    reasons: eligible.length >= required ? [] : ["historique_minimum_insuffisant"],
  };
}

function buildNestedPurgedWalkForward({ evaluationStartTs, endTs, historyStartTs, walkForward = {} }) {
  const cfg = { ...DEFAULT_POLICY.walkForward, ...walkForward };
  const evaluationStart = timestamp(evaluationStartTs, "evaluationStartTs");
  const end = timestamp(endTs, "endTs");
  const historyStart = timestamp(historyStartTs, "historyStartTs");
  const gap = Math.max(Number(cfg.purgeMs), Number(cfg.embargoMs), Number(cfg.labelHorizonMs));
  if (cfg.purgeMs < cfg.labelHorizonMs || cfg.embargoMs < cfg.labelHorizonMs) {
    throw new Error("purge/embargo inferieur a l'horizon des labels");
  }
  if (evaluationStart - gap - historyStart < cfg.minimumTrainingMs) throw new Error("historique d'apprentissage insuffisant avant l'horizon OOS");
  if (end <= evaluationStart) throw new Error("horizon OOS vide");
  const folds = [];
  let ordinal = 0;
  for (let testStart = evaluationStart; testStart < end; testStart += cfg.outerStepMs) {
    const testEnd = Math.min(end, testStart + cfg.outerTestMs);
    const trainEnd = testStart - gap;
    const innerFolds = [];
    for (let validationStart = historyStart + cfg.innerMinimumTrainingMs + gap;
      validationStart < trainEnd; validationStart += cfg.innerStepMs) {
      const validationEnd = Math.min(trainEnd, validationStart + cfg.innerValidationMs);
      innerFolds.push({
        train: { startTs: historyStart, endTsExclusive: validationStart - gap },
        validation: { startTs: validationStart, endTsExclusive: validationEnd },
        purgeMs: Number(cfg.purgeMs), embargoMs: Number(cfg.embargoMs), labelHorizonMs: Number(cfg.labelHorizonMs),
      });
    }
    if (!innerFolds.length) throw new Error("aucun fold interne disponible: apprentissage imbrique insuffisant");
    folds.push({
      id: `wf-${String(ordinal++).padStart(3, "0")}`,
      train: { startTs: historyStart, endTsExclusive: trainEnd },
      test: { startTs: testStart, endTsExclusive: testEnd },
      innerFolds,
      purgeMs: Number(cfg.purgeMs), embargoMs: Number(cfg.embargoMs), labelHorizonMs: Number(cfg.labelHorizonMs),
    });
  }
  return folds;
}

function verifyPurgedFold(fold) {
  const reasons = [];
  const gap = Math.max(Number(fold?.purgeMs), Number(fold?.embargoMs), Number(fold?.labelHorizonMs));
  if (!(fold?.purgeMs >= fold?.labelHorizonMs)) reasons.push("purge_trop_courte");
  if (!(fold?.embargoMs >= fold?.labelHorizonMs)) reasons.push("embargo_trop_court");
  if (!(fold?.train?.endTsExclusive + gap <= fold?.test?.startTs)) reasons.push("fuite_train_test");
  for (const inner of fold?.innerFolds || []) {
    const innerGap = Math.max(Number(inner.purgeMs), Number(inner.embargoMs), Number(inner.labelHorizonMs));
    if (!(inner.train.endTsExclusive + innerGap <= inner.validation.startTs)) reasons.push("fuite_fold_interne");
    if (!(inner.validation.endTsExclusive <= fold.train.endTsExclusive)) reasons.push("validation_interne_voit_test_externe");
  }
  if (!(fold?.innerFolds?.length > 0)) reasons.push("walk_forward_non_imbrique");
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)] };
}

function applyCompleteCosts(trade, costInput = {}, stress = false) {
  const costs = { ...DEFAULT_POLICY.costs, ...costInput };
  if (costs.requiredGrossPnlBasis !== "fill-to-fill"
      || trade?.grossPnlBasis !== costs.requiredGrossPnlBasis) {
    throw new Error("base PnL brute absente ou ambigue: fill-to-fill obligatoire");
  }
  const multiplier = stress ? finiteNumber(costs.stressMultiplier, "costs.stressMultiplier") : 1;
  const entryNotional = finiteNumber(trade.entryNotionalQuote, "trade.entryNotionalQuote");
  const exitNotional = finiteNumber(trade.exitNotionalQuote, "trade.exitNotionalQuote");
  if (!(entryNotional > 0) || !(exitNotional > 0)) throw new Error("les notionnels executes doivent etre strictement positifs");
  const grossPnl = finiteNumber(trade.grossPnlQuote, "trade.grossPnlQuote");
  const liquidityValues = [String(trade.entryLiquidity || "").toLowerCase(), String(trade.exitLiquidity || "").toLowerCase()];
  const makerFeeRate = finiteNumber(costs.makerFeeRate, "costs.makerFeeRate");
  const takerFeeRate = finiteNumber(costs.takerFeeRate, "costs.takerFeeRate");
  const rate = (liquidity) => liquidity === "maker" ? makerFeeRate : takerFeeRate;
  const fee = entryNotional * rate(liquidityValues[0]) + exitNotional * rate(liquidityValues[1]);
  const optionalObserved = (name, fallback) => {
    if (trade[name] === undefined) return { observed: false, value: finiteNumber(fallback, `costs.${name}.fallback`) };
    return { observed: true, value: finiteNumber(trade[name], `trade.${name}`) };
  };
  const entrySpread = optionalObserved("entryHalfSpreadBps", costs.fallbackHalfSpreadBps);
  const exitSpread = optionalObserved("exitHalfSpreadBps", costs.fallbackHalfSpreadBps);
  const entrySlippage = optionalObserved("entrySlippageBps", costs.fallbackSlippageBps);
  const exitSlippage = optionalObserved("exitSlippageBps", costs.fallbackSlippageBps);
  const entryImpact = optionalObserved("entryImpactBps", costs.fallbackImpactBps);
  const exitImpact = optionalObserved("exitImpactBps", costs.fallbackImpactBps);
  const entryLatency = optionalObserved("entryLatencyBps", costs.fallbackLatencyBps);
  const exitLatency = optionalObserved("exitLatencyBps", costs.fallbackLatencyBps);
  const fundingValue = optionalObserved("fundingCostQuote", costs.fallbackFundingCostQuote);
  const borrowValue = optionalObserved("borrowCostQuote", costs.fallbackBorrowCostQuote);
  const rejectionValue = optionalObserved("rejectionCostQuote", costs.fallbackRejectionCostQuote);
  const liquidationValue = optionalObserved("liquidationCostQuote", costs.fallbackLiquidationCostQuote);
  if (trade.requestedQty !== undefined && !isStrictFiniteNumber(trade.requestedQty)) {
    throw new Error("trade.requestedQty doit etre un nombre fini explicite");
  }
  if (trade.filledQty !== undefined && !isStrictFiniteNumber(trade.filledQty)) {
    throw new Error("trade.filledQty doit etre un nombre fini explicite");
  }
  const observed = {
    liquidity: liquidityValues.every((value) => value === "maker" || value === "taker"),
    spread: entrySpread.observed && exitSpread.observed,
    slippage: entrySlippage.observed && exitSlippage.observed,
    impact: entryImpact.observed && exitImpact.observed,
    latency: entryLatency.observed && exitLatency.observed,
    funding: fundingValue.observed,
    borrow: borrowValue.observed,
    liquidation: liquidationValue.observed,
    partialFills: trade.requestedQty !== undefined && trade.filledQty !== undefined,
    rejections: typeof trade.rejected === "boolean" && rejectionValue.observed,
  };
  const legCost = (entry, exit, entryName, exitName) => {
    if (entry < 0 || exit < 0) throw new Error(`${entryName}/${exitName} ne peut etre negatif`);
    return (entryNotional * entry + exitNotional * exit) / 10_000;
  };
  const spread = legCost(entrySpread.value, exitSpread.value, "entryHalfSpreadBps", "exitHalfSpreadBps");
  const slippage = legCost(entrySlippage.value, exitSlippage.value, "entrySlippageBps", "exitSlippageBps");
  const impact = legCost(entryImpact.value, exitImpact.value, "entryImpactBps", "exitImpactBps");
  const latency = legCost(entryLatency.value, exitLatency.value, "entryLatencyBps", "exitLatencyBps");
  const funding = fundingValue.value, borrow = borrowValue.value;
  const rejection = rejectionValue.value, liquidation = liquidationValue.value;
  for (const [name, value] of [["borrow", borrow], ["rejection", rejection], ["liquidation", liquidation]]) {
    if (value < 0) throw new Error(`cout ${name} negatif interdit`);
  }
  if (observed.partialFills) {
    const requested = Number(trade.requestedQty), filled = Number(trade.filledQty);
    if (!(requested > 0) || filled < 0 || filled > requested) throw new Error("quantites de remplissage incoherentes");
  }
  const adverse = (value) => stress ? (value >= 0 ? value * multiplier : value / multiplier) : value;
  const embeddedExecutionFriction = { spread, slippage, impact, latency };
  const executionStressDelta = stress ? multiplier - 1 : 0;
  const breakdown = {
    fee: adverse(fee),
    /* grossPnl is reconstructed from actual fill prices.  Observed execution
       friction is already embedded and must not be paid twice.  Stress only
       debits the adverse counterfactual increment above those actual fills. */
    spread: spread * executionStressDelta,
    slippage: slippage * executionStressDelta,
    impact: impact * executionStressDelta,
    latency: latency * executionStressDelta,
    funding: adverse(funding), borrow: adverse(borrow),
    rejection: adverse(rejection), liquidation: adverse(liquidation),
  };
  const totalCostQuote = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  const riskCapitalQuote = positiveFinite(trade.riskCapitalQuote, "trade.riskCapitalQuote");
  return {
    grossPnlQuote: grossPnl,
    totalCostQuote,
    netPnlQuote: grossPnl - totalCostQuote,
    netReturn: (grossPnl - totalCostQuote) / riskCapitalQuote,
    grossPnlBasis: "fill-to-fill",
    executionFrictionTreatment: stress
      ? "embedded-in-fills-plus-counterfactual-delta"
      : "embedded-in-fills-not-resubtracted",
    embeddedExecutionFrictionQuote: {
      ...embeddedExecutionFriction,
      total: Object.values(embeddedExecutionFriction).reduce((sum, value) => sum + value, 0),
    },
    executionStressMultiplier: multiplier,
    breakdown,
    observed,
  };
}

function missingCostObservations(result, costsInput = {}) {
  const costs = { ...DEFAULT_POLICY.costs, ...costsInput };
  const names = {
    requireObservedLiquidity: "liquidity", requireObservedSpread: "spread",
    requireObservedSlippage: "slippage", requireObservedImpact: "impact",
    requireObservedLatency: "latency", requireObservedFunding: "funding",
    requireObservedBorrow: "borrow", requireObservedLiquidation: "liquidation",
    requireObservedPartialFills: "partialFills", requireObservedRejections: "rejections",
  };
  return Object.entries(names).filter(([flag, key]) => costs[flag] && !result.observed[key]).map(([, key]) => key);
}

function seededRandom(seed) {
  const digest = crypto.createHash("sha256").update(String(seed)).digest();
  let state = digest.readUInt32LE(0) || 0x9e3779b9;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5; state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }

function quantile(sorted, probability) {
  if (!sorted.length) return null;
  const position = Math.max(0, Math.min(1, probability)) * (sorted.length - 1);
  const low = Math.floor(position), high = Math.ceil(position), weight = position - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

function movingBlockBootstrapCI(valuesInput, options = {}) {
  const values = valuesInput.map((value) => finiteNumber(value, "bootstrap.value"));
  if (!values.length) return {
    mean: 0, lower: null, upper: null, oneSidedLower: null,
    oneSidedLower95: null, oneSidedLower99: null,
    confidence: Number(options.confidence || 0.99), replications: 0,
  };
  const replications = Math.trunc(positiveFinite(options.replications || 9999, "bootstrap.replications"));
  const blockLength = Math.min(values.length, Math.trunc(positiveFinite(options.blockLength || 12, "bootstrap.blockLength")));
  const random = seededRandom(options.seed || "hermes-bootstrap");
  const estimates = new Array(replications);
  for (let draw = 0; draw < replications; draw++) {
    let sum = 0, count = 0;
    while (count < values.length) {
      const start = Math.floor(random() * values.length);
      for (let offset = 0; offset < blockLength && count < values.length; offset++, count++) {
        sum += values[(start + offset) % values.length];
      }
    }
    estimates[draw] = sum / values.length;
  }
  estimates.sort((a, b) => a - b);
  const confidence = Number(options.confidence || 0.99), alpha = 1 - confidence;
  return {
    mean: mean(values), lower: quantile(estimates, alpha / 2), upper: quantile(estimates, 1 - alpha / 2),
    oneSidedLower: quantile(estimates, alpha),
    oneSidedLower95: quantile(estimates, 0.05),
    oneSidedLower99: quantile(estimates, 0.01),
    confidence, replications,
  };
}

function clusteredBasketBootstrapCI(tradesInput, options = {}) {
  const groups = new Map();
  for (const trade of tradesInput) {
    const key = String(trade.basketId || "missing");
    const group = groups.get(key) || { key, startTs: Number(trade.entryTs), sum: 0, count: 0 };
    group.startTs = Math.min(group.startTs, Number(trade.entryTs));
    group.sum += finiteNumber(trade.netReturn, "clusteredBootstrap.netReturn");
    group.count++;
    groups.set(key, group);
  }
  const ordered = [...groups.values()].sort((a, b) => a.startTs - b.startTs || a.key.localeCompare(b.key));
  const confidence = Number(options.confidence || 0.99);
  if (!ordered.length) return {
    mean: 0, lower: null, upper: null, oneSidedLower: null,
    oneSidedLower95: null, oneSidedLower99: null, confidence, replications: 0, clusters: 0,
  };
  const replications = Math.trunc(positiveFinite(options.replications || 9999, "clusteredBootstrap.replications"));
  const blockLength = Math.min(ordered.length, Math.trunc(positiveFinite(options.blockLength || 12, "clusteredBootstrap.blockLength")));
  const random = seededRandom(options.seed || "hermes-clustered-bootstrap");
  const estimates = new Array(replications);
  for (let draw = 0; draw < replications; draw++) {
    let total = 0, trades = 0, sampledClusters = 0;
    while (sampledClusters < ordered.length) {
      const start = Math.floor(random() * ordered.length);
      for (let offset = 0; offset < blockLength && sampledClusters < ordered.length; offset++, sampledClusters++) {
        const group = ordered[(start + offset) % ordered.length];
        total += group.sum; trades += group.count;
      }
    }
    estimates[draw] = total / trades;
  }
  estimates.sort((a, b) => a - b);
  const alpha = 1 - confidence;
  const observedTotal = ordered.reduce((sum, group) => sum + group.sum, 0);
  const observedTrades = ordered.reduce((sum, group) => sum + group.count, 0);
  return {
    mean: observedTotal / observedTrades,
    lower: quantile(estimates, alpha / 2),
    upper: quantile(estimates, 1 - alpha / 2),
    oneSidedLower: quantile(estimates, alpha),
    oneSidedLower95: quantile(estimates, 0.05),
    oneSidedLower99: quantile(estimates, 0.01),
    confidence,
    replications,
    clusters: ordered.length,
  };
}

/*
 * Portfolio evidence must not average percentages computed on unrelated risk
 * capitals.  This variant resamples the same temporal baskets, but its
 * statistic is quote PnL per trade divided by the one shared initial equity.
 * It is therefore additive and reconciles exactly with the equity ledger.
 */
function clusteredBasketPnlBootstrapCI(tradesInput, options = {}) {
  const initialEquity = positiveFinite(options.initialEquity, "clusteredPnlBootstrap.initialEquity");
  const groups = new Map();
  for (const trade of tradesInput) {
    const key = String(trade.basketId || "missing");
    const group = groups.get(key) || { key, startTs: Number(trade.entryTs), pnlQuote: 0, count: 0 };
    group.startTs = Math.min(group.startTs, Number(trade.entryTs));
    group.pnlQuote += finiteNumber(trade.netPnlQuote, "clusteredPnlBootstrap.netPnlQuote");
    group.count++;
    groups.set(key, group);
  }
  const ordered = [...groups.values()].sort((a, b) => a.startTs - b.startTs || a.key.localeCompare(b.key));
  const confidence = Number(options.confidence || 0.99);
  if (!ordered.length) return {
    mean: 0, lower: null, upper: null, oneSidedLower: null,
    oneSidedLower95: null, oneSidedLower99: null, confidence, replications: 0, clusters: 0,
    initialEquity, statistic: "mean-net-pnl-quote-per-trade-over-initial-equity",
  };
  const replications = Math.trunc(positiveFinite(options.replications || 9999, "clusteredPnlBootstrap.replications"));
  const blockLength = Math.min(ordered.length,
    Math.trunc(positiveFinite(options.blockLength || 12, "clusteredPnlBootstrap.blockLength")));
  const random = seededRandom(options.seed || "hermes-clustered-pnl-bootstrap");
  const estimates = new Array(replications);
  for (let draw = 0; draw < replications; draw++) {
    let pnlQuote = 0, trades = 0, sampledClusters = 0;
    while (sampledClusters < ordered.length) {
      const start = Math.floor(random() * ordered.length);
      for (let offset = 0; offset < blockLength && sampledClusters < ordered.length; offset++, sampledClusters++) {
        const group = ordered[(start + offset) % ordered.length];
        pnlQuote += group.pnlQuote;
        trades += group.count;
      }
    }
    estimates[draw] = (pnlQuote / trades) / initialEquity;
  }
  estimates.sort((a, b) => a - b);
  const alpha = 1 - confidence;
  const observedPnl = ordered.reduce((sum, group) => sum + group.pnlQuote, 0);
  const observedTrades = ordered.reduce((sum, group) => sum + group.count, 0);
  return {
    mean: (observedPnl / observedTrades) / initialEquity,
    lower: quantile(estimates, alpha / 2),
    upper: quantile(estimates, 1 - alpha / 2),
    oneSidedLower: quantile(estimates, alpha),
    oneSidedLower95: quantile(estimates, 0.05),
    oneSidedLower99: quantile(estimates, 0.01),
    confidence,
    replications,
    clusters: ordered.length,
    initialEquity,
    statistic: "mean-net-pnl-quote-per-trade-over-initial-equity",
  };
}

function clusteredBasketPnlBootstrapSensitivity(tradesInput, options = {}) {
  const blockLengths = (options.blockLengths || []).map((value) =>
    Math.trunc(positiveFinite(value, "clusteredPnlBootstrapSensitivity.blockLength")));
  if (!blockLengths.length || new Set(blockLengths).size !== blockLengths.length) {
    throw new Error("sensibilite bootstrap: longueurs de bloc absentes ou dupliquees");
  }
  const runs = blockLengths.map((blockLength) => ({
    blockLength,
    result: clusteredBasketPnlBootstrapCI(tradesInput, {
      ...options,
      blockLength,
      seed: `${options.seed || "hermes-clustered-pnl-bootstrap"}:block-${blockLength}`,
    }),
  }));
  const finiteMinimum = (key) => {
    const values = runs.map((run) => run.result[key]).filter(Number.isFinite);
    return values.length ? Math.min(...values) : null;
  };
  const finiteMaximum = (key) => {
    const values = runs.map((run) => run.result[key]).filter(Number.isFinite);
    return values.length ? Math.max(...values) : null;
  };
  const selected = runs.reduce((worst, run) => {
    if (!Number.isFinite(run.result.oneSidedLower)) return worst;
    if (!worst || run.result.oneSidedLower < worst.result.oneSidedLower) return run;
    return worst;
  }, null);
  return {
    mean: runs[0].result.mean,
    lower: finiteMinimum("lower"),
    upper: finiteMaximum("upper"),
    oneSidedLower: finiteMinimum("oneSidedLower"),
    oneSidedLower95: finiteMinimum("oneSidedLower95"),
    oneSidedLower99: finiteMinimum("oneSidedLower99"),
    confidence: Number(options.confidence || 0.99),
    replications: runs[0].result.replications,
    replicationsPerBlockLength: runs[0].result.replications,
    totalReplications: runs.reduce((sum, run) => sum + run.result.replications, 0),
    clusters: runs[0].result.clusters,
    initialEquity: runs[0].result.initialEquity,
    statistic: runs[0].result.statistic,
    selectedWorstBlockLength: selected?.blockLength ?? null,
    blockLengths,
    sensitivity: runs.map((run) => ({ blockLength: run.blockLength,
      oneSidedLower: run.result.oneSidedLower,
      oneSidedLower95: run.result.oneSidedLower95,
      oneSidedLower99: run.result.oneSidedLower99 })),
    method: "worst-bound-over-preregistered-block-lengths",
  };
}

function blockSignPermutationTest(valuesInput, options = {}) {
  const values = valuesInput.map((value) => finiteNumber(value, "permutation.value"));
  const blockLength = Math.min(Math.max(1, Math.trunc(Number(options.blockLength || 12))), Math.max(1, values.length));
  const blocks = [];
  for (let index = 0; index < values.length; index += blockLength) blocks.push(values.slice(index, index + blockLength));
  const observed = mean(values);
  const requested = Math.trunc(positiveFinite(options.replications || 9999, "permutation.replications"));
  const exactCount = blocks.length <= 20 ? 2 ** blocks.length : Infinity;
  let extreme = 0, replications = 0, exact = false;
  if (exactCount <= requested) {
    exact = true; replications = exactCount;
    for (let mask = 0; mask < exactCount; mask++) {
      let sum = 0;
      for (let block = 0; block < blocks.length; block++) {
        const sign = mask & (2 ** block) ? 1 : -1;
        for (const value of blocks[block]) sum += sign * value;
      }
      if (sum / values.length >= observed - Number.EPSILON) extreme++;
    }
  } else {
    const random = seededRandom(options.seed || "hermes-permutation");
    replications = requested;
    for (let draw = 0; draw < requested; draw++) {
      let sum = 0;
      for (const block of blocks) {
        const sign = random() < 0.5 ? -1 : 1;
        for (const value of block) sum += sign * value;
      }
      if (sum / values.length >= observed - Number.EPSILON) extreme++;
    }
  }
  return { observed, extreme, replications, exact, pValue: exact ? extreme / replications : (extreme + 1) / (replications + 1) };
}

function empiricalExactPValue(observedInput, nullStatisticsInput) {
  const observed = finiteNumber(observedInput, "observedStatistic");
  const nullStatistics = nullStatisticsInput.map((value) => finiteNumber(value, "nullStatistic"));
  const extreme = nullStatistics.filter((value) => value >= observed - Number.EPSILON).length;
  return { observed, extreme, replications: nullStatistics.length, pValue: (extreme + 1) / (nullStatistics.length + 1) };
}

function holmBonferroni(hypotheses, alpha = 0.01) {
  const ordered = hypotheses.map((item) => ({ id: String(item.id), pValue: finiteNumber(item.pValue, "pValue") }))
    .sort((a, b) => a.pValue - b.pValue || a.id.localeCompare(b.id));
  let running = 0;
  const adjusted = ordered.map((item, index) => {
    running = Math.max(running, Math.min(1, item.pValue * (ordered.length - index)));
    return { ...item, adjustedPValue: running, rejected: running <= alpha };
  });
  return adjusted.sort((a, b) => a.id.localeCompare(b.id));
}

function sampleMoments(valuesInput) {
  const values = valuesInput.map((value) => finiteNumber(value, "moment.value"));
  const n = values.length, average = mean(values);
  if (n < 2) return { n, mean: average, standardDeviation: 0, skewness: 0, kurtosis: 3 };
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (n - 1);
  const standardDeviation = Math.sqrt(Math.max(0, variance));
  if (!(standardDeviation > 0)) return { n, mean: average, standardDeviation: 0, skewness: 0, kurtosis: 3 };
  const standardized = values.map((value) => (value - average) / standardDeviation);
  return {
    n,
    mean: average,
    standardDeviation,
    skewness: standardized.reduce((sum, value) => sum + value ** 3, 0) / n,
    kurtosis: standardized.reduce((sum, value) => sum + value ** 4, 0) / n,
  };
}

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

/* Peter J. Acklam's rational approximation. Accuracy is ample for the
   deflated-Sharpe threshold and avoids a statistics runtime dependency. */
function inverseNormalCdf(probability) {
  const p = Number(probability);
  if (!(p > 0 && p < 1)) throw new Error("probabilite normale hors de (0,1)");
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969,
    138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887,
    66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184,
    -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const low = 0.02425, high = 1 - low;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > high) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function effectiveSampleSizePositiveAutocorrelation(values, blockLengthInput) {
  const n = values.length;
  if (n < 3) return { effectiveObservations: n, varianceInflation: 1, positiveAutocorrelations: [] };
  const blockLength = Math.min(n, Math.max(1, Math.trunc(Number(blockLengthInput || 1))));
  const average = mean(values);
  const denominator = values.reduce((sum, value) => sum + (value - average) ** 2, 0);
  if (!(denominator > 0) || blockLength <= 1) {
    return { effectiveObservations: n, varianceInflation: 1, positiveAutocorrelations: [] };
  }
  let varianceInflation = 1;
  const positiveAutocorrelations = [];
  for (let lag = 1; lag < blockLength; lag++) {
    let numerator = 0;
    for (let index = lag; index < n; index++) {
      numerator += (values[index] - average) * (values[index - lag] - average);
    }
    const correlation = Math.max(0, Math.min(1, numerator / denominator));
    positiveAutocorrelations.push(correlation);
    varianceInflation += 2 * (1 - lag / blockLength) * correlation;
  }
  return {
    effectiveObservations: Math.max(2, Math.min(n, n / varianceInflation)),
    varianceInflation,
    positiveAutocorrelations,
  };
}

function deflatedSharpeProbability(returnsInput, options = {}) {
  const returns = returnsInput.map((value) => finiteNumber(value, "deflatedSharpe.return"));
  const moments = sampleMoments(returns);
  const trials = Math.max(1, Math.trunc(positiveFinite(options.trials || 1, "deflatedSharpe.trials")));
  const trialSharpeRatios = (options.trialSharpeRatios || [])
    .map((value) => finiteNumber(value, "deflatedSharpe.trialSharpeRatio"));
  const completeTrialDistribution = trials === 1
    ? trialSharpeRatios.length === 1
    : trialSharpeRatios.length === trials && trialSharpeRatios.length >= 2;
  const dependence = effectiveSampleSizePositiveAutocorrelation(returns, options.blockLength || 1);
  if (moments.n < 3 || !(moments.standardDeviation > 0) || !completeTrialDistribution) {
    return {
      valid: false,
      probability: 0,
      statistic: null,
      sharpe: moments.standardDeviation > 0 ? moments.mean / moments.standardDeviation : 0,
      expectedMaximumSharpe: null,
      trials,
      trialSharpeObservations: trialSharpeRatios.length,
      observations: moments.n,
      effectiveObservations: dependence.effectiveObservations,
      varianceInflation: dependence.varianceInflation,
      reason: !completeTrialDistribution ? "distribution_sharpe_famille_incomplete" : "serie_sharpe_insuffisante",
    };
  }
  const sharpe = moments.mean / moments.standardDeviation;
  const trialAverage = mean(trialSharpeRatios);
  const crossTrialVariance = trials > 1
    ? trialSharpeRatios.reduce((sum, value) => sum + (value - trialAverage) ** 2, 0) / (trials - 1)
    : 0;
  const nullSharpeScale = 1 / Math.sqrt(Math.max(1, dependence.effectiveObservations - 1));
  /* Never let an unusually homogeneous trial set make the deflation smaller
     than the serial-dependence-aware null sampling scale. */
  const sharpeDispersion = trials === 1 ? 0 : Math.max(Math.sqrt(crossTrialVariance), nullSharpeScale);
  const eulerGamma = 0.5772156649015329;
  const expectedMaximumSharpe = trials === 1 ? 0 : sharpeDispersion * (
    (1 - eulerGamma) * inverseNormalCdf(1 - 1 / trials)
    + eulerGamma * inverseNormalCdf(1 - 1 / (trials * Math.E))
  );
  const varianceTerm = Math.max(Number.EPSILON,
    1 - moments.skewness * sharpe + ((moments.kurtosis - 1) / 4) * sharpe * sharpe);
  const statistic = (sharpe - expectedMaximumSharpe)
    * Math.sqrt(Math.max(1, dependence.effectiveObservations - 1)) / Math.sqrt(varianceTerm);
  return {
    valid: true,
    probability: normalCdf(statistic),
    statistic,
    sharpe,
    expectedMaximumSharpe,
    sharpeDispersion,
    crossTrialSharpeStandardDeviation: Math.sqrt(crossTrialVariance),
    nullSharpeScale,
    trials,
    trialSharpeObservations: trialSharpeRatios.length,
    observations: moments.n,
    effectiveObservations: dependence.effectiveObservations,
    varianceInflation: dependence.varianceInflation,
    positiveAutocorrelations: dependence.positiveAutocorrelations,
    skewness: moments.skewness,
    kurtosis: moments.kurtosis,
  };
}

function combinations(size, selected) {
  const out = [];
  const visit = (start, choice) => {
    if (choice.length === selected) { out.push([...choice]); return; }
    for (let index = start; index <= size - (selected - choice.length); index++) {
      choice.push(index); visit(index + 1, choice); choice.pop();
    }
  };
  visit(0, []);
  return out;
}

function probabilityBacktestOverfitting(matrixInput, options = {}) {
  const matrix = matrixInput.map((row) => row.map((value) => finiteNumber(value, "cscv.return")));
  const columns = matrix[0]?.length || 0;
  if (columns < 2 || matrix.some((row) => row.length !== columns)) throw new Error("CSCV exige une matrice rectangulaire avec plusieurs modeles");
  const slices = Math.trunc(positiveFinite(options.slices || 8, "cscv.slices"));
  if (slices < 4 || slices % 2 || matrix.length < slices) throw new Error("CSCV exige assez de lignes pour un nombre pair de tranches");
  const splitChoices = combinations(slices, slices / 2);
  if (splitChoices.length > Number(options.maxCombinations || 20_000)) throw new Error("trop de combinaisons CSCV");
  const sliceRows = Array.from({ length: slices }, (_, slice) => {
    const start = Math.floor(slice * matrix.length / slices), end = Math.floor((slice + 1) * matrix.length / slices);
    return Array.from({ length: end - start }, (__, offset) => start + offset);
  });
  const logits = [], winners = new Array(columns).fill(0);
  for (const trainingSlices of splitChoices) {
    const inSet = new Set(trainingSlices);
    const trainRows = trainingSlices.flatMap((slice) => sliceRows[slice]);
    const testRows = Array.from({ length: slices }, (_, index) => index).filter((index) => !inSet.has(index))
      .flatMap((slice) => sliceRows[slice]);
    const averages = (indices) => Array.from({ length: columns }, (_, column) =>
      mean(indices.map((row) => matrix[row][column])));
    const train = averages(trainRows), test = averages(testRows);
    const winner = train.reduce((best, value, index) => value > train[best] ? index : best, 0);
    winners[winner]++;
    const less = test.filter((value) => value < test[winner]).length;
    const equal = test.filter((value) => value === test[winner]).length;
    const averageRank = less + (equal + 1) / 2;
    const relativeRank = averageRank / (columns + 1);
    logits.push(Math.log(relativeRank / (1 - relativeRank)));
  }
  return {
    pbo: logits.filter((value) => value <= 0).length / logits.length,
    combinations: logits.length,
    slices,
    models: columns,
    medianLogit: quantile([...logits].sort((a, b) => a - b), 0.5),
    winnerCounts: winners,
  };
}

function matrixBootstrapPValues(matrixInput, options = {}) {
  const matrix = matrixInput.map((row) => row.map((value) => finiteNumber(value, "spa.return")));
  const columns = matrix[0]?.length || 0, rows = matrix.length;
  if (rows < 2 || columns < 2 || matrix.some((row) => row.length !== columns)) throw new Error("SPA exige une matrice rectangulaire");
  const averages = Array.from({ length: columns }, (_, column) => mean(matrix.map((row) => row[column])));
  const blockLength = Math.min(rows, Math.trunc(positiveFinite(options.blockLength || 12, "matrix.blockLength")));
  const standardErrors = Array.from({ length: columns }, (_, column) => {
    const centered = matrix.map((row) => row[column] - averages[column]);
    let longRunVariance = centered.reduce((sum, value) => sum + value * value, 0) / rows;
    for (let lag = 1; lag < blockLength; lag++) {
      let covariance = 0;
      for (let index = lag; index < rows; index++) covariance += centered[index] * centered[index - lag];
      covariance /= rows;
      longRunVariance += 2 * (1 - lag / blockLength) * covariance;
    }
    return Math.max(1e-12, Math.sqrt(Math.max(Number.EPSILON, longRunVariance) / rows));
  });
  const studentizedMeans = averages.map((value, index) => value / standardErrors[index]);
  const observedSpa = Math.max(0, ...studentizedMeans);
  const observedReality = Math.max(0, ...averages);
  const hansenThreshold = -Math.sqrt(2 * Math.log(Math.log(Math.max(3, rows))));
  const lowerNullMeans = averages.map((value) => Math.min(value, 0));
  const consistentNullMeans = averages.map((value, column) =>
    studentizedMeans[column] < hansenThreshold ? value : 0);
  const upperNullMeans = new Array(columns).fill(0);
  const spaReplications = Math.trunc(positiveFinite(options.spaReplications || 9999, "spa.replications"));
  const realityReplications = Math.trunc(positiveFinite(options.realityReplications || 9999, "reality.replications"));
  const totalReplications = Math.max(spaReplications, realityReplications);
  const random = seededRandom(options.seed || "hermes-spa-reality");
  const circularPrefix = Array.from({ length: columns }, () => new Float64Array(rows + blockLength + 1));
  for (let index = 0; index < rows + blockLength; index++) {
    const row = matrix[index % rows];
    for (let column = 0; column < columns; column++) {
      circularPrefix[column][index + 1] = circularPrefix[column][index] + row[column];
    }
  }
  let lowerExtreme = 0, consistentExtreme = 0, upperExtreme = 0, realityExtreme = 0;
  for (let draw = 0; draw < totalReplications; draw++) {
    const sums = new Array(columns).fill(0);
    let count = 0;
    while (count < rows) {
      const start = Math.floor(random() * rows);
      const take = Math.min(blockLength, rows - count);
      for (let column = 0; column < columns; column++) {
        sums[column] += circularPrefix[column][start + take] - circularPrefix[column][start];
      }
      count += take;
    }
    const bootMeans = sums.map((sum) => sum / rows);
    const innovations = bootMeans.map((value, column) => value - averages[column]);
    if (draw < spaReplications) {
      const statistic = (nullMeans) => Math.max(0, ...innovations.map((value, column) =>
        (value + nullMeans[column]) / standardErrors[column]));
      if (statistic(lowerNullMeans) >= observedSpa - Number.EPSILON) lowerExtreme++;
      if (statistic(consistentNullMeans) >= observedSpa - Number.EPSILON) consistentExtreme++;
      if (statistic(upperNullMeans) >= observedSpa - Number.EPSILON) upperExtreme++;
    }
    if (draw < realityReplications) {
      const statistic = Math.max(0, ...innovations);
      if (statistic >= observedReality - Number.EPSILON) realityExtreme++;
    }
  }
  const monteCarloPValue = (extreme, replications) => (extreme + 1) / (replications + 1);
  return {
    hansenSpa: {
      observedStatistic: observedSpa,
      replications: spaReplications,
      /* The live gate deliberately consumes Hansen's conservative upper
         p-value.  The consistent and lower variants remain diagnostic. */
      pValue: monteCarloPValue(upperExtreme, spaReplications),
      upperPValue: monteCarloPValue(upperExtreme, spaReplications),
      consistentPValue: monteCarloPValue(consistentExtreme, spaReplications),
      lowerPValue: monteCarloPValue(lowerExtreme, spaReplications),
      recenteringThreshold: hansenThreshold,
      method: "hansen-spa-studentized-upper-bound-fixed-moving-block-bootstrap",
    },
    whiteRealityCheck: {
      observedStatistic: observedReality,
      replications: realityReplications,
      pValue: monteCarloPValue(realityExtreme, realityReplications),
      method: "white-reality-check-centered-fixed-moving-block-bootstrap",
    },
  };
}

function matrixBootstrapSensitivity(matrixInput, options = {}) {
  const blockLengths = (options.blockLengths || []).map((value) =>
    Math.trunc(positiveFinite(value, "matrixBootstrapSensitivity.blockLength")));
  if (!blockLengths.length || new Set(blockLengths).size !== blockLengths.length) {
    throw new Error("sensibilite SPA/Reality Check: longueurs de bloc absentes ou dupliquees");
  }
  const runs = blockLengths.map((blockLength) => ({
    blockLength,
    result: matrixBootstrapPValues(matrixInput, {
      ...options,
      blockLength,
      seed: `${options.seed || "hermes-spa-reality"}:block-${blockLength}`,
    }),
  }));
  const worstSpa = runs.reduce((worst, run) =>
    !worst || run.result.hansenSpa.upperPValue > worst.result.hansenSpa.upperPValue ? run : worst, null);
  const worstReality = runs.reduce((worst, run) =>
    !worst || run.result.whiteRealityCheck.pValue > worst.result.whiteRealityCheck.pValue ? run : worst, null);
  const maximum = (selector) => Math.max(...runs.map(selector));
  const sensitivity = runs.map((run) => ({
    blockLength: run.blockLength,
    hansenSpaUpperPValue: run.result.hansenSpa.upperPValue,
    hansenSpaConsistentPValue: run.result.hansenSpa.consistentPValue,
    hansenSpaLowerPValue: run.result.hansenSpa.lowerPValue,
    whiteRealityCheckPValue: run.result.whiteRealityCheck.pValue,
  }));
  return {
    hansenSpa: {
      ...worstSpa.result.hansenSpa,
      pValue: maximum((run) => run.result.hansenSpa.upperPValue),
      upperPValue: maximum((run) => run.result.hansenSpa.upperPValue),
      consistentPValue: maximum((run) => run.result.hansenSpa.consistentPValue),
      lowerPValue: maximum((run) => run.result.hansenSpa.lowerPValue),
      selectedWorstBlockLength: worstSpa.blockLength,
      blockLengths,
      sensitivity,
      method: "hansen-spa-upper-bound-worst-over-preregistered-block-lengths",
    },
    whiteRealityCheck: {
      ...worstReality.result.whiteRealityCheck,
      pValue: maximum((run) => run.result.whiteRealityCheck.pValue),
      selectedWorstBlockLength: worstReality.blockLength,
      blockLengths,
      sensitivity,
      method: "white-reality-check-worst-over-preregistered-block-lengths",
    },
  };
}

function normaliseModelReturnMatrix(input, startTs, endTs, minimumCoverageRate) {
  const modelIds = (input?.modelIds || []).map((id) => String(id).trim());
  if (modelIds.length < 2 || modelIds.some((id) => !id) || new Set(modelIds).size !== modelIds.length) {
    throw new Error("identifiants de modeles invalides");
  }
  const rows = (input?.rows || []).map((row) => ({
    ts: timestamp(row.ts, "modelMatrix.ts"),
    returns: (row.returns || []).map((value) => finiteNumber(value, "modelMatrix.return")),
  })).sort((a, b) => a.ts - b.ts);
  if (rows.some((row) => row.ts < startTs || row.ts >= endTs || row.returns.length !== modelIds.length)) {
    throw new Error("matrice de modeles hors horizon ou non rectangulaire");
  }
  if ((endTs - startTs) % DAY_MS !== 0) throw new Error("horizon de matrice non aligne sur des jours entiers");
  const expectedDays = (endTs - startTs) / DAY_MS;
  const coverageRate = rows.length / expectedDays;
  if (Number(minimumCoverageRate) !== 1 || rows.length !== expectedDays
      || rows.some((row, index) => row.ts !== startTs + index * DAY_MS)) {
    throw new Error("la matrice de modeles doit contenir exactement chaque jour, y compris les jours sans trade a zero");
  }
  return {
    modelIds,
    rows,
    matrix: rows.map((row) => row.returns),
    coverageRate,
    matrixSha256: sha256Canonical({ modelIds, rows }),
  };
}

function validateTrialLedger(ledger) {
  const reasons = [];
  if (Number(ledger?.schemaVersion) !== 1) reasons.push("trial_ledger_schema_invalide");
  if (ledger?.complete !== true) reasons.push("historical_trial_ledger_incomplete");
  const ids = new Set();
  let hypothesisCountLowerBound = 0;
  for (const trial of ledger?.trials || []) {
    if (!trial?.id || ids.has(trial.id)) reasons.push("trial_ledger_id_invalide");
    ids.add(trial?.id);
    const count = Number(trial?.knownHypothesisCountLowerBound);
    if (!Number.isInteger(count) || count < 1) reasons.push("trial_ledger_compte_invalide");
    else hypothesisCountLowerBound += count;
    if (!/^[a-f0-9]{64}$/i.test(String(trial?.sourceArtifactSha256 || ""))) reasons.push("trial_ledger_checksum_invalide");
    if (trial?.eligibleAsEvidence !== false) reasons.push("historical_trial_ne_doit_pas_etre_une_preuve");
    if (ledger?.complete === true) {
      if (!Array.isArray(trial.hypotheses) || trial.hypotheses.length !== count) {
        reasons.push("trial_ledger_hypotheses_non_enumerees");
      } else {
        const hypothesisIds = new Set();
        for (const hypothesis of trial.hypotheses) {
          if (!hypothesis?.id || hypothesisIds.has(hypothesis.id)) reasons.push("trial_ledger_hypothese_id_invalide");
          hypothesisIds.add(hypothesis?.id);
          if (!hypothesis?.strategyVersion
              || !/^[a-f0-9]{64}$/i.test(String(hypothesis?.configSha256 || ""))
              || !/^[a-f0-9]{64}$/i.test(String(hypothesis?.universeConfigSha256 || ""))) {
            reasons.push("trial_ledger_parametres_hypothese_incomplets");
          }
        }
      }
    }
  }
  return {
    valid: reasons.length === 0,
    reasons: [...new Set(reasons)],
    hypothesisCountLowerBound,
    ledgerSha256: sha256Canonical(ledger || null),
  };
}

function cycleLedgerUnsignedBody(ledger) {
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) return null;
  const body = { ...ledger };
  delete body.attestation;
  return body;
}

function buildCycleLedgerHashChain(records) {
  const chain = [];
  let previousHash = sha256Canonical({ schemaVersion: 1, domain: CYCLE_LEDGER_HASH_CHAIN_DOMAIN });
  for (let index = 0; index < (records || []).length; index++) {
    const recordSha256 = sha256Canonical(records[index]);
    const linkBody = { schemaVersion: 1, domain: CYCLE_LEDGER_HASH_CHAIN_DOMAIN,
      index, previousHash, recordSha256 };
    const linkHash = sha256Canonical(linkBody);
    chain.push({ ...linkBody, linkHash });
    previousHash = linkHash;
  }
  return {
    schemaVersion: 1,
    domain: CYCLE_LEDGER_HASH_CHAIN_DOMAIN,
    genesisHash: sha256Canonical({ schemaVersion: 1, domain: CYCLE_LEDGER_HASH_CHAIN_DOMAIN }),
    recordCount: (records || []).length,
    headSha256: previousHash,
    chainSha256: sha256Canonical(chain),
    chain,
  };
}

function expectedCycleLedgerAttestationBody({ cycleLedgerSha256, hashChain, cutoffTs,
  hypothesisCount, publicKeySpkiSha256 }) {
  return {
    schemaVersion: 1,
    artifactType: "hermes-quant-cycle-ledger-attestation",
    cutoffTs,
    cycleLedgerSha256,
    recordCount: hashChain.recordCount,
    uniqueHypothesisCount: hypothesisCount,
    hashChainHeadSha256: hashChain.headSha256,
    hashChainSha256: hashChain.chainSha256,
    publicKeySpkiSha256: publicKeySpkiSha256 || null,
  };
}

function validateCycleLedger(ledger, cutoffValue = null, options = {}) {
  const reasons = [];
  if (!ledger || Number(ledger.schemaVersion) !== 1 || !Array.isArray(ledger.records)) {
    return {
      valid: false,
      reasons: ["cycle_ledger_absent_ou_schema_invalide"],
      hypothesisCount: 0,
      records: [],
      cycleLedgerSha256: sha256Canonical(ledger || null),
      attestationAudit: null,
      expectedAttestation: null,
    };
  }
  if (ledger.complete !== true) reasons.push("cycle_ledger_completude_non_attestee");
  let cutoffTs = null;
  try { cutoffTs = timestamp(cutoffValue, "cycleLedger.cutoffTs"); }
  catch { reasons.push("cycle_ledger_cutoff_absent_ou_invalide"); }
  const byKey = new Map();
  for (const record of ledger.records) {
    const runId = String(record?.runId || "").trim();
    const candidateId = String(record?.candidateId || "").trim();
    const key = `${runId}:${candidateId}`;
    if (Number(record?.schemaVersion) !== 1 || !runId || !candidateId
        || !String(record?.family || "").trim() || !String(record?.executionType || "").trim()) {
      reasons.push("cycle_ledger_record_incomplet");
    }
    try {
      const recordedAt = timestamp(record?.recordedAt, "cycleLedger.recordedAt");
      if (cutoffTs !== null && recordedAt >= cutoffTs) reasons.push("cycle_ledger_record_apres_cutoff");
    } catch { reasons.push("cycle_ledger_recorded_at_invalide"); }
    if (!/^[a-f0-9]{64}$/i.test(String(record?.paramsSha256 || ""))
        || !/^[a-f0-9]{64}$/i.test(String(record?.universeSha256 || ""))) {
      reasons.push("cycle_ledger_hash_parametres_invalide");
    }
    if (record?.sourcePriorSha256 != null
        && !/^[a-f0-9]{64}$/i.test(String(record.sourcePriorSha256))) reasons.push("cycle_ledger_source_prior_invalide");
    if (typeof record?.accepted !== "boolean" || !Array.isArray(record?.rejectionReasons)) {
      reasons.push("cycle_ledger_decision_invalide");
    }
    const identityInput = record?.candidateIdentity;
    const candidateIdentity = quantitativeCandidateIdentity(identityInput);
    if (!candidateIdentity) {
      reasons.push("cycle_ledger_identite_candidat_non_recalculable");
    } else {
      const calculatedCandidateId = quantitativeCandidateId(candidateIdentity);
      if (calculatedCandidateId !== candidateId
          || sha256Canonical(candidateIdentity.params) !== String(record?.paramsSha256 || "").toLowerCase()
          || sha256Canonical(candidateIdentity.universe) !== String(record?.universeSha256 || "").toLowerCase()
          || candidateIdentity.family !== String(record?.family || "")
          || candidateIdentity.executionType !== String(record?.executionType || "")) {
        reasons.push("cycle_ledger_identite_candidat_incoherente");
      }
    }
    const normalised = {
      schemaVersion: 1,
      recordedAt: String(record?.recordedAt || ""),
      runId,
      candidateId,
      family: String(record?.family || ""),
      executionType: String(record?.executionType || ""),
      sourcePriorSha256: record?.sourcePriorSha256 == null ? null : String(record.sourcePriorSha256).toLowerCase(),
      paramsSha256: String(record?.paramsSha256 || "").toLowerCase(),
      universeSha256: String(record?.universeSha256 || "").toLowerCase(),
      accepted: record?.accepted === true,
      rejectionReasons: Array.isArray(record?.rejectionReasons) ? record.rejectionReasons.map(String).sort() : [],
      primaryMetrics: record?.primaryMetrics ?? null,
      candidateIdentity,
    };
    if (byKey.has(key) && sha256Canonical(byKey.get(key)) !== sha256Canonical(normalised)) {
      reasons.push("cycle_ledger_doublon_contradictoire");
    } else if (!byKey.has(key)) byKey.set(key, normalised);
  }
  const records = [...byKey.values()].sort((a, b) =>
    a.runId.localeCompare(b.runId) || a.candidateId.localeCompare(b.candidateId));
  if (!records.length) reasons.push("cycle_ledger_vide");
  const unsignedBody = cycleLedgerUnsignedBody(ledger);
  let cycleLedgerSha256 = null;
  let hashChain = null;
  try {
    cycleLedgerSha256 = sha256Canonical(unsignedBody);
    hashChain = buildCycleLedgerHashChain(ledger.records);
  } catch {
    reasons.push("cycle_ledger_non_canonique");
    cycleLedgerSha256 = sha256Canonical(null);
    hashChain = buildCycleLedgerHashChain([]);
  }
  const expectedAttestation = expectedCycleLedgerAttestationBody({
    cycleLedgerSha256,
    hashChain,
    cutoffTs,
    hypothesisCount: records.length,
    publicKeySpkiSha256: options.trust?.actualSpkiSha256 || null,
  });
  const attestationAudit = verifyExactAttestation({
    attestation: ledger.attestation,
    expectedBody: expectedAttestation,
    domain: QUANT_CYCLE_LEDGER_SIGNATURE_DOMAIN,
    trust: options.trust,
    role: "cycle_ledger_attestation",
  });
  reasons.push(...attestationAudit.reasons);
  const body = { schemaVersion: 1, complete: ledger.complete === true, records,
    rawRecordCount: ledger.records.length, hashChainHeadSha256: hashChain.headSha256,
    hashChainSha256: hashChain.chainSha256 };
  return {
    ...body,
    valid: reasons.length === 0,
    reasons: [...new Set(reasons)].sort(),
    hypothesisCount: records.length,
    cycleLedgerSha256,
    hashChain,
    attestationAudit,
    expectedAttestation,
  };
}

function calculatePerformance(trades) {
  const sorted = [...trades].sort((a, b) => a.exitTs - b.exitTs || String(a.tradeId).localeCompare(String(b.tradeId)));
  const returns = sorted.map((trade) => finiteNumber(trade.netReturn, "performance.netReturn"));
  const pnlQuote = sorted.map((trade) => finiteNumber(trade.netPnlQuote, "performance.netPnlQuote"));
  const netPnlQuote = pnlQuote.reduce((sum, value) => sum + value, 0);
  const positives = pnlQuote.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const negatives = -pnlQuote.filter((value) => value < 0).reduce((sum, value) => sum + value, 0);
  let cumulativePnlQuote = 0, peakPnlQuote = 0, maxDrawdownQuote = 0;
  for (const value of pnlQuote) {
    cumulativePnlQuote += value;
    peakPnlQuote = Math.max(peakPnlQuote, cumulativePnlQuote);
    maxDrawdownQuote = Math.max(maxDrawdownQuote, peakPnlQuote - cumulativePnlQuote);
  }
  const byInstrument = new Map();
  for (const trade of sorted) {
    byInstrument.set(trade.instId,
      (byInstrument.get(trade.instId) || 0) + finiteNumber(trade.netPnlQuote, "performance.netPnlQuote"));
  }
  const positiveInstrumentProfit = [...byInstrument.values()].filter((value) => value > 0);
  const positiveInstrumentTotal = positiveInstrumentProfit.reduce((sum, value) => sum + value, 0);
  const concentration = positiveInstrumentTotal > 0 ? Math.max(...positiveInstrumentProfit) / positiveInstrumentTotal : 1;
  return {
    trades: sorted.length,
    netPnlQuote,
    meanPnlQuote: mean(pnlQuote),
    /* Retained as diagnostics only; portfolio gates never aggregate these
       heterogeneous trade-level percentages. */
    netReturnSum: returns.reduce((sum, value) => sum + value, 0),
    meanReturn: mean(returns),
    winRate: sorted.length ? pnlQuote.filter((value) => value > 0).length / sorted.length : 0,
    profitFactor: negatives > 0 ? positives / negatives : (positives > 0 ? null : 0),
    maxDrawdownQuote,
    maxProfitConcentration: concentration,
    returns,
    pnlQuote,
  };
}

function validatePortfolioSimulation(simulation, startValue, endValue, trades) {
  const startTs = timestamp(startValue, "portfolio.startTs"), endTs = timestamp(endValue, "portfolio.endTs");
  const reasons = [];
  if (simulation?.synchronized !== true || simulation?.method !== "event-driven-shared-equity"
      || simulation?.correlationStressIncluded !== true) reasons.push("simulation_portefeuille_non_synchronisee");
  let initialEquity = null, events = [];
  try {
    initialEquity = finiteNumber(simulation?.initialEquity, "portfolio.initialEquity");
    if (!(initialEquity > 0)) reasons.push("portfolio_equity_initiale_invalide");
    events = (simulation?.events || []).map((event) => ({
      ts: timestamp(event?.ts, "portfolio.event.ts"),
      equity: finiteNumber(event?.equity, "portfolio.event.equity"),
      realizedNetPnlQuoteDelta: finiteNumber(event?.realizedNetPnlQuoteDelta, "portfolio.event.realizedNetPnlQuoteDelta"),
      markToMarketPnlQuote: finiteNumber(event?.markToMarketPnlQuote, "portfolio.event.markToMarketPnlQuote"),
      externalCashflowQuote: finiteNumber(event?.externalCashflowQuote, "portfolio.event.externalCashflowQuote"),
      tradeIds: Array.isArray(event?.tradeIds) ? event.tradeIds.map((id) => String(id).trim()) : [],
      markPriceObservationSha256: event?.markPriceObservationSha256 == null
        ? null : String(event.markPriceObservationSha256).toLowerCase(),
    }));
  } catch (error) {
    reasons.push("portfolio_serie_invalide");
  }
  if (events.length < 2) reasons.push("portfolio_serie_insuffisante");
  if (events.some((event, index) => event.equity <= 0 || event.ts < startTs || event.ts > endTs
      || (index > 0 && event.ts <= events[index - 1].ts))) reasons.push("portfolio_evenements_non_ordonnes_ou_hors_horizon");
  if (events[0]?.ts !== startTs || events[events.length - 1]?.ts !== endTs
      || Math.abs((events[0]?.equity ?? NaN) - initialEquity) > 1e-9) reasons.push("portfolio_bornes_non_couvertes");
  if (events[0]?.markToMarketPnlQuote !== 0 || events[events.length - 1]?.markToMarketPnlQuote !== 0) {
    reasons.push("portfolio_mtm_non_nul_aux_bornes");
  }
  const hashBody = { initialEquity, events };
  const returnSeriesSha256 = sha256Canonical(hashBody);
  if (String(simulation?.returnSeriesSha256 || "").toLowerCase() !== returnSeriesSha256) {
    reasons.push("portfolio_hash_serie_invalide");
  }
  const tradeById = new Map(trades.map((trade) => [trade.tradeId, trade]));
  const referencedTradeIds = new Set();
  let priorEquity = initialEquity, priorMtm = 0;
  for (const [index, event] of events.entries()) {
    if (event.externalCashflowQuote !== 0) reasons.push("portfolio_cashflow_externe_interdit");
    if (event.tradeIds.some((id) => !id || referencedTradeIds.has(id) || !tradeById.has(id))) {
      reasons.push("portfolio_trade_reference_absent_ou_duplique");
    }
    const expectedRealized = event.tradeIds.reduce((sum, id) => sum + (tradeById.get(id)?.netPnlQuote || 0), 0);
    if (Math.abs(expectedRealized - event.realizedNetPnlQuoteDelta) > Math.max(1e-8, Math.abs(expectedRealized) * 1e-9)) {
      reasons.push("portfolio_realise_non_reconcilie");
    }
    event.tradeIds.forEach((id) => referencedTradeIds.add(id));
    const expectedEquity = index === 0 ? initialEquity
      : priorEquity + event.realizedNetPnlQuoteDelta + event.externalCashflowQuote
        + event.markToMarketPnlQuote - priorMtm;
    if (Math.abs(event.equity - expectedEquity) > Math.max(1e-8, Math.abs(expectedEquity) * 1e-9)) {
      reasons.push("portfolio_transition_equity_non_reconciliee");
    }
    if (index > 0 && !/^[a-f0-9]{64}$/.test(String(event.markPriceObservationSha256 || ""))) {
      reasons.push("portfolio_mark_raw_non_reference");
    }
    priorEquity = event.equity; priorMtm = event.markToMarketPnlQuote;
  }
  if (referencedTradeIds.size !== trades.length) reasons.push("portfolio_trades_non_reconcilies_individuellement");
  const eventTimes = new Set(events.map((event) => event.ts));
  const coveredExits = trades.filter((trade) => eventTimes.has(trade.exitTs)).length;
  const tradeExitCoverageRate = trades.length ? coveredExits / trades.length : 0;
  if (tradeExitCoverageRate !== 1) reasons.push("portfolio_sorties_trades_non_couvertes");
  const netPnl = trades.reduce((sum, trade) => sum + finiteNumber(trade.netPnlQuote, "portfolio.trade.netPnlQuote"), 0);
  const finalEquity = events[events.length - 1]?.equity;
  const tolerance = Math.max(1e-8, Math.abs(initialEquity + netPnl) * 1e-9);
  if (!Number.isFinite(finalEquity) || Math.abs(finalEquity - (initialEquity + netPnl)) > tolerance) {
    reasons.push("portfolio_pnl_non_reconcilie");
  }
  let peak = initialEquity, maxDrawdownPct = 0;
  for (const event of events) {
    peak = Math.max(peak, event.equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, (peak - event.equity) / peak);
  }
  const dayCount = Math.ceil((endTs - startTs) / DAY_MS);
  const dailyEquity = new Array(dayCount + 1).fill(initialEquity);
  let eventIndex = 0, currentEquity = initialEquity;
  for (let day = 0; day <= dayCount; day++) {
    const boundary = Math.min(endTs, startTs + day * DAY_MS);
    while (eventIndex < events.length && events[eventIndex].ts <= boundary) currentEquity = events[eventIndex++].equity;
    dailyEquity[day] = currentEquity;
  }
  const portfolioDailyReturns = [];
  for (let index = 1; index < dailyEquity.length; index++) {
    portfolioDailyReturns.push(dailyEquity[index - 1] > 0
      ? (dailyEquity[index] - dailyEquity[index - 1]) / dailyEquity[index - 1] : 0);
  }
  return {
    verified: reasons.length === 0,
    reasons: [...new Set(reasons)].sort(),
    returnSeriesSha256,
    events: events.length,
    tradeExitCoverageRate,
    initialEquity,
    finalEquity: Number.isFinite(finalEquity) ? finalEquity : null,
    reconciledNetPnlQuote: netPnl,
    maxDrawdownPct,
    dailyReturns: portfolioDailyReturns,
  };
}

function positiveProfitConcentration(trades, keyFunction) {
  const totals = new Map();
  for (const trade of trades) {
    const key = String(keyFunction(trade));
    totals.set(key, (totals.get(key) || 0) + finiteNumber(trade.netPnlQuote, "concentration.netPnlQuote"));
  }
  const positive = [...totals.entries()].filter(([, value]) => value > 0);
  const positiveTotal = positive.reduce((sum, [, value]) => sum + value, 0);
  const ranked = positive.map(([key, value]) => ({ key, value, share: positiveTotal > 0 ? value / positiveTotal : 1 }))
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  return {
    groups: ranked.length,
    maximumShare: ranked.length ? ranked[0].share : 1,
    top5Share: positiveTotal > 0 ? ranked.slice(0, 5).reduce((sum, item) => sum + item.value, 0) / positiveTotal : 1,
    ranked,
  };
}

function independentBasketCount(trades, separationMs) {
  const grouped = new Map();
  for (const trade of trades) {
    if (!trade.basketId) continue;
    const current = grouped.get(trade.basketId) || { basketId: trade.basketId, startTs: trade.entryTs, endTs: trade.exitTs };
    current.startTs = Math.min(current.startTs, trade.entryTs);
    current.endTs = Math.max(current.endTs, trade.exitTs);
    grouped.set(trade.basketId, current);
  }
  const intervals = [...grouped.values()].sort((a, b) => a.endTs - b.endTs || a.startTs - b.startTs);
  const chosen = [];
  let lastEnd = -Infinity;
  for (const interval of intervals) {
    if (interval.startTs >= lastEnd + separationMs) { chosen.push(interval.basketId); lastEnd = interval.endTs; }
  }
  return { declaredBaskets: intervals.length, independentBaskets: chosen.length, independentBasketIds: chosen };
}

function deriveTemporalBaskets(trades, dependenceWindowValue) {
  const dependenceWindowMs = positiveFinite(dependenceWindowValue, "basket.dependenceWindowMs");
  const ordered = [...trades].sort((a, b) => a.entryTs - b.entryTs || a.exitTs - b.exitTs
    || String(a.tradeId).localeCompare(String(b.tradeId)));
  const assignments = new Map();
  let ordinal = -1, dependentUntil = -Infinity;
  for (const trade of ordered) {
    if (trade.entryTs > dependentUntil) ordinal++;
    dependentUntil = Math.max(dependentUntil, trade.exitTs + dependenceWindowMs);
    assignments.set(trade.tradeId, `derived-temporal-${String(ordinal).padStart(6, "0")}`);
  }
  const rows = ordered.map((trade) => ({ tradeId: trade.tradeId, basketId: assignments.get(trade.tradeId) }));
  return { assignments, rows, dependenceWindowMs, basketDerivationSha256: sha256Canonical(rows) };
}

function dailyReturns(trades, startTs, endTs) {
  const count = Math.ceil((endTs - startTs) / DAY_MS);
  const out = new Array(count).fill(0);
  for (const trade of trades) {
    const index = Math.floor((trade.exitTs - startTs) / DAY_MS);
    if (index >= 0 && index < out.length) out[index] += trade.netReturn;
  }
  return out;
}

function expectedShortfall95(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const count = Math.max(1, Math.ceil(ordered.length * 0.05));
  return Math.abs(mean(ordered.slice(0, count)));
}

function foldCoverageIsContiguous(folds, startTs, endTs) {
  const ordered = [...folds].sort((a, b) => a.test.startTs - b.test.startTs);
  if (!ordered.length || ordered[0].test.startTs !== startTs || ordered[ordered.length - 1].test.endTsExclusive !== endTs) return false;
  return ordered.every((fold, index) => !index || ordered[index - 1].test.endTsExclusive === fold.test.startTs);
}

function quantitativeRunRecordUnsignedBody(runRecord) {
  const body = { ...(runRecord || {}) };
  delete body.quantProcessAttestation;
  if (body.executionDataset && typeof body.executionDataset === "object") {
    body.executionDataset = { ...body.executionDataset };
    delete body.executionDataset.attestation;
  }
  return body;
}

function quantitativeCandidateIdentity(input) {
  try {
    return executableStrategyIdentity(input);
  } catch {
    return null;
  }
}

function quantitativeCandidateId(input) {
  try {
    return executableCandidateId(input);
  } catch {
    return null;
  }
}

function preparedMarketSeriesManifest(prepared, cutoffValue) {
  const cutoffTs = timestamp(cutoffValue, "marketSeriesManifest.cutoffTs");
  const instruments = Object.keys(prepared?.instruments || {}).sort().map((instId) => {
    const rows = prepared.instruments[instId].rows.filter((row) => row.availableAt < cutoffTs);
    return { instId, rows: rows.length, rowsSha256: sha256Canonical(rows) };
  });
  const body = { schemaVersion: 1, cutoffTs, barMs: prepared?.barMs ?? null,
    unconfirmedRowsExcluded: Number(prepared?.unconfirmedRowsExcluded || 0), instruments };
  return { ...body, marketSeriesManifestSha256: sha256Canonical(body) };
}

function instrumentMasterDatasetManifest(instrumentMaster, cutoffValue) {
  const cutoffTs = timestamp(cutoffValue, "instrumentMasterDataset.cutoffTs");
  const events = (instrumentMaster?.events || []).filter((event) => event.availableAt < cutoffTs);
  const body = {
    schemaVersion: 1,
    cutoffTs,
    source: instrumentMaster?.source || null,
    includesAllHistoricalInstruments: instrumentMaster?.includesAllHistoricalInstruments === true,
    events,
  };
  return { ...body, instrumentMasterDatasetSha256: sha256Canonical(body) };
}

function createQuantProcessReplayManifest({ runRecord, prepared, instrumentMaster, policy, trialLedger,
  cycleLedger, executionPolicy, feeSchedule, executionDataset }) {
  const cutoffTs = timestamp(runRecord?.cutoffTs, "quantProcess.cutoffTs");
  const marketSeries = preparedMarketSeriesManifest(prepared, cutoffTs);
  const masterDataset = instrumentMasterDatasetManifest(instrumentMaster, cutoffTs);
  const horizons = (runRecord?.horizons || []).map((horizon) => ({
    days: Number(horizon?.days),
    horizonInputSha256: sha256Canonical(horizon),
  })).sort((a, b) => a.days - b.days || a.horizonInputSha256.localeCompare(b.horizonInputSha256));
  const body = {
    schemaVersion: 1,
    artifactType: "hermes-quant-process-replay-manifest",
    runId: String(runRecord?.runId || ""),
    candidateId: String(runRecord?.candidateId || "").toLowerCase(),
    cutoffTs,
    runRecordSha256: sha256Canonical(quantitativeRunRecordUnsignedBody(runRecord)),
    marketSeriesManifestSha256: marketSeries.marketSeriesManifestSha256,
    instrumentMasterDatasetSha256: masterDataset.instrumentMasterDatasetSha256,
    policySha256: sha256Canonical(policy),
    trialLedgerSha256: sha256Canonical(trialLedger || null),
    cycleLedgerSha256: sha256Canonical(cycleLedgerUnsignedBody(cycleLedger)),
    executionPolicySha256: sha256Canonical(executionPolicy || null),
    feeScheduleSha256: feeSchedule.feeScheduleSha256,
    executionDatasetSha256: executionDataset.executionDatasetSha256,
    attributionManifestSha256: executionDataset.attributionManifest.attributionManifestSha256,
    costAccounting: {
      grossPnlBasis: policy?.costs?.requiredGrossPnlBasis,
      observedExecutionFriction: "embedded-in-fill-prices-diagnostic-only",
      stressedExecutionFriction: "counterfactual-delta-above-observed-only",
      separatelyDebitedCosts: ["fees", "funding", "borrow", "rejections", "liquidation"],
    },
    horizons,
  };
  return { ...body, processReplayManifestSha256: sha256Canonical(body), marketSeries, masterDataset };
}

function expectedQuantProcessAttestationBody({ processReplayManifest, publicKeySpkiSha256 }) {
  return {
    schemaVersion: 1,
    artifactType: "hermes-quant-process-replay-attestation",
    runId: processReplayManifest.runId,
    candidateId: processReplayManifest.candidateId,
    cutoffTs: processReplayManifest.cutoffTs,
    processReplayManifestSha256: processReplayManifest.processReplayManifestSha256,
    claims: {
      instrumentMasterInventoryAuthenticated: true,
      processReplayedFromPreparedData: true,
      costsAndRiskCapitalReplayed: true,
      exclusiveFillToFillCostDecompositionReplayed: true,
      portfolioTransitionsReplayed: true,
      modelAndNullProcessesReplayed: true,
    },
    publicKeySpkiSha256: publicKeySpkiSha256 || null,
  };
}

function auditQuantProcessAttestation({ attestation, processReplayManifest, trust }) {
  const expectedAttestation = expectedQuantProcessAttestationBody({
    processReplayManifest,
    publicKeySpkiSha256: trust?.actualSpkiSha256 || null,
  });
  const audit = verifyExactAttestation({
    attestation,
    expectedBody: expectedAttestation,
    domain: QUANT_PROCESS_SIGNATURE_DOMAIN,
    trust,
    role: "quant_process_attestation",
  });
  return { ...audit, expectedAttestation };
}

function compileQuantitativeEvidence({ runRecord, prepared, instrumentMaster, policy: policyInput = {}, trialLedger,
  cycleLedger, executionPolicy, executionAttestationPublicKey = null,
  expectedExecutionAttestationPublicKeySpkiSha256 = null, cycleLedgerAttestationPublicKey = null,
  expectedCycleLedgerAttestationPublicKeySpkiSha256 = null, expectedQuantPolicySha256 = null }) {
  const policy = mergePolicy(policyInput);
  const cutoffTs = timestamp(runRecord?.cutoffTs, "runRecord.cutoffTs");
  const reasons = [];
  const policySha256 = sha256Canonical(policy);
  const externalPolicyAnchor = String(expectedQuantPolicySha256 || "").toLowerCase();
  const quantPolicyAnchorVerified = /^[a-f0-9]{64}$/.test(externalPolicyAnchor)
    && externalPolicyAnchor === policySha256;
  if (!/^[a-f0-9]{64}$/.test(externalPolicyAnchor)) reasons.push("quant_policy_ancre_externe_non_configuree");
  else if (!quantPolicyAnchorVerified) reasons.push("quant_policy_ne_correspond_pas_ancre_externe");
  const candidateIdentity = quantitativeCandidateIdentity(runRecord?.candidateIdentity);
  const calculatedCandidateId = quantitativeCandidateId(candidateIdentity);
  const declaredCandidateId = String(runRecord?.candidateId || "").toLowerCase();
  if (!candidateIdentity || !candidateIdentity.family || !candidateIdentity.executionType
      || !/^[a-f0-9]{64}$/.test(declaredCandidateId)) reasons.push("run_candidate_identity_absente_ou_invalide");
  else if (calculatedCandidateId !== declaredCandidateId) reasons.push("run_candidate_id_incoherent");
  const executionTrust = auditAttestationTrust({
    publicKey: executionAttestationPublicKey,
    policySpkiSha256: policy.attestations.executionAndProcess.publicKeySpkiSha256,
    externalSpkiSha256: expectedExecutionAttestationPublicKeySpkiSha256,
    role: "execution_process_attestation",
  });
  const cycleTrust = auditAttestationTrust({
    publicKey: cycleLedgerAttestationPublicKey,
    policySpkiSha256: policy.attestations.cycleLedger.publicKeySpkiSha256,
    externalSpkiSha256: expectedCycleLedgerAttestationPublicKeySpkiSha256,
    role: "cycle_ledger_attestation",
  });
  if (executionTrust.actualSpkiSha256 && executionTrust.actualSpkiSha256 === cycleTrust.actualSpkiSha256) {
    for (const trust of [executionTrust, cycleTrust]) {
      trust.reasons = [...new Set([...trust.reasons, "attestation_cles_non_distinctes"])].sort();
      trust.verified = false;
    }
  }
  const ledger = validateTrialLedger(trialLedger);
  reasons.push(...ledger.reasons);
  const cycle = validateCycleLedger(cycleLedger, cutoffTs, { trust: cycleTrust });
  reasons.push(...cycle.reasons);
  const feeSchedule = prepareFeeSchedule(runRecord?.feeSnapshots, cutoffTs);
  reasons.push(...feeSchedule.reasons);
  const executionDataset = prepareExecutionDataset(runRecord?.executionDataset, cutoffTs,
    { runRecord, trust: executionTrust });
  reasons.push(...executionDataset.reasons);
  const universeParity = auditExecutionUniverseParity(policy, executionPolicy);
  if (!universeParity.verified) reasons.push("politique_univers_execution_divergente");
  const processReplayManifest = createQuantProcessReplayManifest({ runRecord, prepared, instrumentMaster, policy,
    trialLedger, cycleLedger, executionPolicy, feeSchedule, executionDataset });
  const processAttestation = auditQuantProcessAttestation({
    attestation: runRecord?.quantProcessAttestation,
    processReplayManifest,
    trust: executionTrust,
  });
  reasons.push(...processAttestation.reasons);
  const manifest = createDataManifest({
    prepared,
    instrumentMaster,
    source: runRecord.source,
    cutoffTs,
    universePolicy: policy.universe,
    historicalArtifacts: (trialLedger?.trials || []).map((trial) => ({ id: trial.id, sha256: trial.sourceArtifactSha256 })),
    feeScheduleManifest: feeSchedule,
    executionDatasetManifest: executionDataset,
    cycleLedgerManifest: cycle,
    executionUniverseParity: universeParity,
    processAttestationAudit: processAttestation,
  });
  reasons.push(...manifest.reasons);
  const horizonReports = [];
  const selectedUniverseHash = sha256Canonical(policy.universe);
  const allHypotheses = new Set();
  const universeHypotheses = runRecord.universeHypothesesEvaluated || [];
  if (!universeHypotheses.length) reasons.push("famille_hypotheses_univers_absente");
  let selectedUniverseEnumerated = false;
  for (const hypothesis of universeHypotheses) {
    const configHash = hypothesis?.config ? sha256Canonical(hypothesis.config) : "";
    if (!hypothesis?.id || hypothesis?.configSha256 !== configHash) reasons.push("hypothese_univers_invalide");
    else allHypotheses.add(`universe:${hypothesis.id}:${configHash}`);
    if (configHash === selectedUniverseHash) selectedUniverseEnumerated = true;
  }
  if (!selectedUniverseEnumerated) reasons.push("univers_selectionne_absent_de_la_famille");
  for (const horizon of runRecord.horizons || []) {
    for (const fold of horizon.folds || []) for (const id of fold.hypothesesEvaluated || []) {
      const hypothesisId = String(id).trim();
      if (hypothesisId) allHypotheses.add(hypothesisId);
    }
  }
  const familyCount = allHypotheses.size + ledger.hypothesisCountLowerBound + cycle.hypothesisCount;
  const historicalFamilyModelIds = (trialLedger?.trials || []).flatMap((trial) =>
    (trial?.hypotheses || []).map((hypothesis) => `historical:${String(trial.id)}:${String(hypothesis?.id || "")}`));
  const cycleFamilyModelIds = (cycle.records || [])
    .map((record) => `cycle:${record.runId}:${record.candidateId}`);
  const expectedFamilyModelIds = [...new Set([
    ...allHypotheses,
    ...historicalFamilyModelIds,
    ...cycleFamilyModelIds,
  ])].sort();
  if (expectedFamilyModelIds.length !== familyCount) reasons.push("famille_hypotheses_non_enumerable_exactement");

  for (const days of policy.requiredHorizonsDays) {
    const horizon = (runRecord.horizons || []).find((item) => Number(item.days) === days);
    const localReasons = [];
    if (!horizon) {
      horizonReports.push({ days, decision: "rejected", reasons: ["horizon_absent"] });
      reasons.push(`horizon_${days}_absent`);
      continue;
    }
    const startTs = cutoffTs - days * DAY_MS;
    const minimumCoverage = assessMinimumDataCoverage(manifest, cutoffTs, days, policy);
    localReasons.push(...minimumCoverage.reasons);
    if (timestamp(horizon.startTs, `horizon.${days}.startTs`) !== startTs
        || timestamp(horizon.endTsExclusive, `horizon.${days}.endTsExclusive`) !== cutoffTs) localReasons.push("horizon_cutoff_different");
    const folds = horizon.folds || [];
    if (!foldCoverageIsContiguous(folds, startTs, cutoffTs)) localReasons.push("folds_oos_non_contigus");
    const normalTrades = [], stressTrades = [];
    const baseCostReturns = [];
    const profitableFolds = [];
    const sideCounts = { long: 0, short: 0 };
    const seenTradeIds = new Set(), usedFillIds = new Set();
    const tradeValidationErrors = [];
    const feeByHash = new Map(feeSchedule.snapshots.map((snapshot) => [snapshot.snapshotSha256, snapshot]));
    let completeCostModel = true;
    let tradesReplayedFromData = executionDataset.verified === true;
    const processRosterStart = folds.length ? Math.min(...folds.map((fold) => Number(fold.train?.startTs))) : startTs;
    const processRosterAudit = auditRosterSchedule(prepared, processRosterStart, cutoffTs,
      policy.universe, instrumentMaster, { retainRosters: false });
    localReasons.push(...processRosterAudit.reasons);
    const rosterCache = new Map();

    for (const fold of folds) {
      const splitCheck = verifyPurgedFold(fold);
      localReasons.push(...splitCheck.reasons);
      if (!(Number(fold.selectionCompletedAt) <= Number(fold.test.startTs))) localReasons.push("strategie_selectionnee_dans_le_futur");
      if (!(Number(fold.selectionDataMaxAvailableAt) <= Number(fold.train.endTsExclusive))) {
        localReasons.push("selection_utilise_embargo_ou_futur");
      }
      if (!fold.strategy?.id || !fold.strategy?.version || !fold.strategy?.config
          || fold.strategy.configSha256 !== sha256Canonical(fold.strategy.config)) localReasons.push("identite_strategie_incomplete");
      for (const id of fold.hypothesesEvaluated || []) {
        const hypothesisId = String(id).trim();
        if (!hypothesisId) localReasons.push("identifiant_hypothese_invalide");
        else allHypotheses.add(hypothesisId);
      }
      if (!(fold.hypothesesEvaluated?.length > 0)) localReasons.push("famille_hypotheses_absente");

      let foldNet = 0;
      for (const trade of fold.trades || []) {
        const tradeId = typeof trade?.tradeId === "string" ? trade.tradeId.trim() : "";
        if (!tradeId) {
          localReasons.push("trade_id_absent");
          tradeValidationErrors.push({ tradeId: null, reason: "trade_id_absent" });
          continue;
        }
        if (seenTradeIds.has(tradeId)) {
          localReasons.push("trade_id_duplique");
          tradeValidationErrors.push({ tradeId, reason: "trade_id_duplique" });
          continue;
        }
        seenTradeIds.add(tradeId);
        const entryTs = timestamp(trade.entryTs, "trade.entryTs"), exitTs = timestamp(trade.exitTs, "trade.exitTs");
        if (!(entryTs >= fold.test.startTs && entryTs < fold.test.endTsExclusive
            && exitTs >= entryTs && exitTs < fold.test.endTsExclusive && exitTs < cutoffTs)) {
          localReasons.push("trade_hors_fold_ou_futur"); continue;
        }
        const selectionTs = Math.floor((entryTs - fold.test.startTs) / policy.universe.rebalanceMs)
          * policy.universe.rebalanceMs + fold.test.startTs;
        if (!rosterCache.has(selectionTs)) {
          rosterCache.set(selectionTs, buildPointInTimeTopMovers(prepared, selectionTs, policy.universe, instrumentMaster));
        }
        const roster = rosterCache.get(selectionTs);
        if (!roster?.constituents.some((item) => item.instId === String(trade.instId || "").toUpperCase())) {
          localReasons.push("trade_hors_roster_point_in_time"); continue;
        }
        let replay;
        try {
          replay = replayTradeFromExecutionDataset(trade, executionDataset);
        } catch (error) {
          tradesReplayedFromData = false;
          localReasons.push("trades_non_rejoues_depuis_donnees");
          tradeValidationErrors.push({ tradeId, reason: "trades_non_rejoues_depuis_donnees", detail: String(error.message) });
          continue;
        }
        if (trade.grossPnlBasis !== replay.grossPnlBasis
            || replay.grossPnlBasis !== policy.costs.requiredGrossPnlBasis) {
          completeCostModel = false;
          localReasons.push("base_pnl_brute_absente_ou_ambigue");
          tradeValidationErrors.push({ tradeId, reason: "base_pnl_brute_absente_ou_ambigue" });
          continue;
        }
        const replayFillIds = [...replay.entryFillIds, ...replay.exitFillIds];
        if (replayFillIds.some((id) => usedFillIds.has(id))) {
          tradesReplayedFromData = false;
          localReasons.push("fills_execution_reutilises");
          tradeValidationErrors.push({ tradeId, reason: "fills_execution_reutilises" });
          continue;
        }
        replayFillIds.forEach((id) => usedFillIds.add(id));
        for (const [field, recalculated] of [["grossPnlQuote", replay.grossPnlQuote],
          ["entryNotionalQuote", replay.entryNotionalQuote], ["exitNotionalQuote", replay.exitNotionalQuote]]) {
          if (trade[field] !== undefined
              && Math.abs(finiteNumber(trade[field], `trade.${field}`) - recalculated) > Math.max(1e-9, Math.abs(recalculated) * 1e-9)) {
            localReasons.push("pnl_ou_notionnel_declare_non_reconcilie");
          }
        }
        const snapshotHash = String(trade.feeSnapshotSha256 || "").toLowerCase();
        const feeSnapshot = feeByHash.get(snapshotHash);
        if (!feeSnapshot || feeSnapshot.availableAt > entryTs
            || entryTs - feeSnapshot.availableAt > policy.costs.maxFeeSnapshotStalenessMs) {
          completeCostModel = false;
          localReasons.push(!feeSnapshot ? "fee_snapshot_trade_absent" : feeSnapshot.availableAt > entryTs
            ? "fee_snapshot_trade_futur" : "fee_snapshot_trade_perime");
          tradeValidationErrors.push({ tradeId, reason: "fee_snapshot_trade_invalide" });
          continue;
        }
        const appliedMaker = finiteNumber(trade.makerFeeRateApplied, "trade.makerFeeRateApplied");
        const appliedTaker = finiteNumber(trade.takerFeeRateApplied, "trade.takerFeeRateApplied");
        if (Math.abs(appliedMaker - feeSnapshot.makerFeeRate) > 1e-15
            || Math.abs(appliedTaker - feeSnapshot.takerFeeRate) > 1e-15) {
          completeCostModel = false;
          localReasons.push("fee_snapshot_taux_non_appliques");
          tradeValidationErrors.push({ tradeId, reason: "fee_snapshot_taux_non_appliques" });
          continue;
        }
        const tradeForCosts = {
          ...trade,
          ...replay,
          filledQty: replay.filledQty,
        };
        const observedCostPolicy = { ...policy.costs,
          makerFeeRate: feeSnapshot.makerFeeRate, takerFeeRate: feeSnapshot.takerFeeRate };
        const base = applyCompleteCosts(tradeForCosts, observedCostPolicy, false);
        const stressed = applyCompleteCosts(tradeForCosts, observedCostPolicy, true);
        const missing = missingCostObservations(base, observedCostPolicy);
        if (missing.length) {
          completeCostModel = false;
          localReasons.push(...missing.map((name) => `cout_non_observe_${name}`));
        }
        const common = {
          tradeId, instId: String(trade.instId).toUpperCase(), side: String(trade.side).toLowerCase(),
          basketId: "", entryTs, exitTs,
        };
        normalTrades.push({ ...common, netReturn: base.netReturn, netPnlQuote: base.netPnlQuote,
          replaySha256: replay.replaySha256, feeSnapshotSha256: feeSnapshot.snapshotSha256 });
        stressTrades.push({ ...common, netReturn: stressed.netReturn, netPnlQuote: stressed.netPnlQuote });
        /* totalCostQuote is the amount debited from fill-to-fill PnL.  Keep the
           already-embedded execution friction in the diagnostic economic-cost
           metric without subtracting it a second time from portfolio PnL. */
        baseCostReturns.push((base.totalCostQuote + base.embeddedExecutionFrictionQuote.total)
          / finiteNumber(trade.riskCapitalQuote, "trade.riskCapitalQuote"));
        foldNet += base.netPnlQuote;
        const side = String(trade.side).toLowerCase();
        if (side === "long" || side === "short") sideCounts[side]++;
        else localReasons.push("sens_trade_invalide");
      }
      profitableFolds.push(foldNet > 0);
    }

    const basketDerivation = deriveTemporalBaskets(normalTrades, policy.walkForward.labelHorizonMs);
    for (const trade of normalTrades) trade.basketId = basketDerivation.assignments.get(trade.tradeId);
    for (const trade of stressTrades) trade.basketId = basketDerivation.assignments.get(trade.tradeId);
    if (!tradesReplayedFromData) localReasons.push("trades_non_rejoues_depuis_donnees");
    const portfolioAudit = validatePortfolioSimulation(horizon.portfolioSimulation, startTs, cutoffTs, normalTrades);
    localReasons.push(...portfolioAudit.reasons);
    if (!processAttestation.verified) {
      localReasons.push("portfolio_transitions_non_rejouees_depuis_donnees");
      localReasons.push("risk_capital_et_couts_non_rejoues_depuis_donnees");
      localReasons.push("matrice_et_null_non_rejoues_depuis_donnees");
    }
    completeCostModel = completeCostModel && processAttestation.verified;
    const portfolioSynchronized = portfolioAudit.verified && processAttestation.verified;
    const { dailyReturns: portfolioDailyReturnsForStatistics, ...portfolioEvidence } = portfolioAudit;

    const performance = calculatePerformance(normalTrades);
    const stressPerformance = calculatePerformance(stressTrades);
    const initialEquityScale = portfolioAudit.verified && Number(portfolioAudit.initialEquity) > 0
      ? portfolioAudit.initialEquity : null;
    const invalidCI = (confidence) => ({
      mean: null, lower: null, upper: null, oneSidedLower: null,
      oneSidedLower95: null, oneSidedLower99: null, confidence, replications: 0, clusters: 0,
      initialEquity: initialEquityScale,
      statistic: "mean-net-pnl-quote-per-trade-over-initial-equity",
    });
    const netCI = initialEquityScale == null ? invalidCI(policy.statistics.netConfidence)
      : clusteredBasketPnlBootstrapSensitivity(normalTrades, {
        confidence: policy.statistics.netConfidence,
        replications: policy.statistics.bootstrapReplications,
        blockLengths: policy.statistics.blockLengthSensitivity,
        seed: `${runRecord.runId}:${days}:net`,
        initialEquity: initialEquityScale,
      });
    const stressCI = initialEquityScale == null ? invalidCI(policy.statistics.costStressConfidence)
      : clusteredBasketPnlBootstrapSensitivity(stressTrades, {
        confidence: policy.statistics.costStressConfidence,
        replications: policy.statistics.bootstrapReplications,
        blockLengths: policy.statistics.blockLengthSensitivity,
        seed: `${runRecord.runId}:${days}:stress`,
        initialEquity: initialEquityScale,
      });
    const netMeanPerTrade = initialEquityScale != null && performance.trades > 0
      ? (performance.meanPnlQuote / initialEquityScale) : null;
    const stressMeanPerTrade = initialEquityScale != null && stressPerformance.trades > 0
      ? (stressPerformance.meanPnlQuote / initialEquityScale) : null;
    const nullTest = netMeanPerTrade == null
      ? { observed: null, extreme: null, replications: 0, pValue: 1, valid: false }
      : { ...empiricalExactPValue(netMeanPerTrade, horizon.nullProcessStatistics || []), valid: true };
    if (nullTest.replications < policy.statistics.nullReplications) localReasons.push("replications_processus_null_insuffisantes");
    if (horizon.nullMethod !== "full-process-block-permutation"
        || horizon.nullStatistic !== "mean-net-pnl-quote-per-trade-over-initial-equity"
        || horizon.selectionRerunForEveryNull !== true) {
      localReasons.push("test_nul_ne_rejoue_pas_le_processus");
    }
    const foldRate = profitableFolds.length ? profitableFolds.filter(Boolean).length / profitableFolds.length : 0;
    const rosterCoverageRate = processRosterAudit.coverageRate;
    const instrumentConcentration = positiveProfitConcentration(normalTrades, (trade) => trade.instId);
    const yearConcentration = positiveProfitConcentration(normalTrades, (trade) => new Date(trade.exitTs).getUTCFullYear());
    const basketConcentration = positiveProfitConcentration(normalTrades, (trade) => trade.basketId || "missing");
    const baskets = independentBasketCount(normalTrades, policy.walkForward.labelHorizonMs);
    const effectiveTradingDays = new Set(normalTrades.map((trade) => new Date(trade.exitTs).toISOString().slice(0, 10))).size;
    const effectiveTradingDayRate = effectiveTradingDays / days;
    const daily = portfolioAudit.verified ? portfolioDailyReturnsForStatistics : dailyReturns(normalTrades, startTs, cutoffTs);
    let deflatedSharpe = {
      valid: false, probability: 0, statistic: null, expectedMaximumSharpe: null,
      trials: familyCount, observations: daily.length, reason: "matrice_famille_non_validee",
    };
    let advancedTests = null;
    try {
      if (horizon.modelReturnMatrix?.method !== "daily-net-after-complete-costs"
          || horizon.modelReturnMatrix?.returnUnit !== "shared-portfolio-equity-return"
          || horizon.modelReturnMatrix?.zeroReturnDaysExplicit !== true
          || horizon.modelReturnMatrix?.containsEveryTrial !== true) {
        throw new Error("la matrice doit contenir les rendements d'equity de tous les essais apres couts complets");
      }
      const modelMatrix = normaliseModelReturnMatrix(horizon.modelReturnMatrix, startTs, cutoffTs,
        policy.statistics.minModelMatrixCoverageRate);
      const expectedModelIds = expectedFamilyModelIds;
      const actualModelIds = [...modelMatrix.modelIds].sort();
      if (expectedFamilyModelIds.length !== familyCount
          || expectedModelIds.length !== actualModelIds.length
          || expectedModelIds.some((id, index) => id !== actualModelIds[index])) {
        localReasons.push("matrice_modeles_ne_couvre_pas_exactement_hypotheses");
        throw new Error("modelIds doit egaler exactement toute la famille courante, historique et autonome");
      }
      const trialSharpeRatios = Array.from({ length: modelMatrix.modelIds.length }, (_, column) => {
        const moments = sampleMoments(modelMatrix.matrix.map((row) => row[column]));
        if (!(moments.standardDeviation > 0)) throw new Error("Sharpe d'un essai non identifiable");
        return moments.mean / moments.standardDeviation;
      });
      const deflatedSharpeSensitivity = policy.statistics.blockLengthSensitivity.map((blockLength) => ({
        blockLength,
        result: deflatedSharpeProbability(daily, { trials: familyCount, trialSharpeRatios, blockLength }),
      }));
      const worstDeflatedSharpe = deflatedSharpeSensitivity.reduce((worst, item) =>
        !worst || item.result.probability < worst.result.probability ? item : worst, null);
      deflatedSharpe = {
        ...worstDeflatedSharpe.result,
        selectedWorstBlockLength: worstDeflatedSharpe.blockLength,
        blockLengths: [...policy.statistics.blockLengthSensitivity],
        sensitivity: deflatedSharpeSensitivity.map((item) => ({
          blockLength: item.blockLength,
          probability: item.result.probability,
          effectiveObservations: item.result.effectiveObservations,
          expectedMaximumSharpe: item.result.expectedMaximumSharpe,
        })),
        method: "deflated-sharpe-worst-over-preregistered-block-lengths",
      };
      const pbo = probabilityBacktestOverfitting(modelMatrix.matrix, { slices: policy.statistics.cscvSlices });
      const resampling = matrixBootstrapSensitivity(modelMatrix.matrix, {
        spaReplications: policy.statistics.spaBootstrapReplications,
        realityReplications: policy.statistics.realityCheckReplications,
        blockLengths: policy.statistics.blockLengthSensitivity,
        seed: `${runRecord.runId}:${days}:spa-reality`,
      });
      advancedTests = {
        matrixSha256: modelMatrix.matrixSha256,
        modelIds: modelMatrix.modelIds,
        coverageRate: modelMatrix.coverageRate,
        pboCscv: pbo,
        hansenSpa: resampling.hansenSpa,
        whiteRealityCheck: resampling.whiteRealityCheck,
        deflatedSharpe,
      };
    } catch (error) {
      localReasons.push("matrice_essais_avances_invalide");
      advancedTests = { error: String(error.message), deflatedSharpe };
    }
    if (performance.trades < policy.gates.minimumTradesPerHorizon) localReasons.push("trades_insuffisants");
    if (foldRate < policy.gates.minimumProfitableFoldRate) localReasons.push("folds_profitables_insuffisants");
    if (performance.maxProfitConcentration > policy.gates.maximumProfitConcentration) localReasons.push("profit_trop_concentre");
    if (instrumentConcentration.top5Share > policy.gates.maximumTop5ProfitConcentration) localReasons.push("profit_top5_trop_concentre");
    if (basketConcentration.maximumShare > policy.gates.maximumBasketProfitConcentration) localReasons.push("profit_basket_trop_concentre");
    const maximumYearShare = Number(policy.gates.maximumYearProfitConcentrationByHorizon?.[String(days)] ?? 1);
    if (yearConcentration.maximumShare > maximumYearShare) localReasons.push("profit_annee_trop_concentre");
    if (effectiveTradingDayRate < policy.gates.minimumEffectiveTradingDayRate) localReasons.push("jours_trades_insuffisants");
    const requiredIndependentBaskets = Math.ceil(policy.gates.minimumIndependentBasketsPerYear * days / 365);
    if (baskets.independentBaskets < requiredIndependentBaskets) localReasons.push("baskets_independantes_insuffisantes");
    if (portfolioAudit.maxDrawdownPct > policy.gates.maximumDrawdownPct) localReasons.push("drawdown_trop_eleve");
    if (!(portfolioAudit.verified && portfolioAudit.finalEquity > portfolioAudit.initialEquity
        && portfolioAudit.reconciledNetPnlQuote > 0)) localReasons.push("portefeuille_net_non_positif");
    if (!(stressPerformance.netPnlQuote > 0)) localReasons.push("pnl_stresse_non_positif");
    if (performance.profitFactor == null || performance.profitFactor < policy.gates.minimumProfitFactor) localReasons.push("profit_factor_insuffisant_ou_non_defini");
    if (policy.gates.requireNetLower99AboveZero && !(netCI.oneSidedLower > 0)) localReasons.push("borne_nette_99_non_positive");
    if (policy.gates.requireCostStressLower95AboveZero && !(stressCI.oneSidedLower > 0)) localReasons.push("borne_stress_95_non_positive");
    if (rosterCoverageRate < policy.universe.minRosterCoverageRate) localReasons.push("couverture_roster_insuffisante");
    if (!(advancedTests?.pboCscv?.pbo <= policy.gates.maximumPbo)) localReasons.push("pbo_cscv_trop_eleve");
    if (!(advancedTests?.deflatedSharpe?.valid === true
        && advancedTests.deflatedSharpe.probability >= policy.gates.minimumDeflatedSharpeProbability)) {
      localReasons.push("deflated_sharpe_insuffisant");
    }
    if (!(advancedTests?.hansenSpa?.pValue <= policy.gates.maximumSpaPValue)) localReasons.push("hansen_spa_non_significatif");
    if (!(advancedTests?.whiteRealityCheck?.pValue <= policy.gates.maximumRealityCheckPValue)) localReasons.push("white_reality_check_non_significatif");

    horizonReports.push({
      days,
      startTs,
      endTsExclusive: cutoffTs,
      folds: folds.length,
      trades: performance.trades,
      netMeanPerTrade,
      netMeanLower95: netCI.oneSidedLower95,
      netMeanLower99: netCI.oneSidedLower,
      costStressMeanPerTrade: stressMeanPerTrade,
      costStressLower95: stressCI.oneSidedLower,
      bootstrapDiagnostics: {
        net: netCI,
        costStress: stressCI,
      },
      rawProcessPValue: nullTest.pValue,
      nullReplications: nullTest.replications,
      profitableFoldRate: foldRate,
      maxProfitConcentration: performance.maxProfitConcentration,
      concentration: {
        byInstrumentMaximum: instrumentConcentration.maximumShare,
        top5Instruments: instrumentConcentration.top5Share,
        byYearMaximum: yearConcentration.maximumShare,
        byBasketMaximum: basketConcentration.maximumShare,
      },
      effectiveTradingDays,
      effectiveTradingDayRate,
      baskets,
      basketDerivation: {
        method: "overlap-plus-label-horizon",
        dependenceWindowMs: basketDerivation.dependenceWindowMs,
        basketDerivationSha256: basketDerivation.basketDerivationSha256,
      },
      maxDrawdownPct: portfolioAudit.maxDrawdownPct,
      portfolioNetReturn: portfolioAudit.verified
        ? (portfolioAudit.finalEquity - portfolioAudit.initialEquity) / portfolioAudit.initialEquity : null,
      netPnlQuote: performance.netPnlQuote,
      costStressNetPnlQuote: stressPerformance.netPnlQuote,
      profitFactor: performance.profitFactor,
      expectedShortfall95: expectedShortfall95(daily),
      costPerTrade: mean(baseCostReturns),
      costAccounting: {
        grossPnlBasis: policy.costs.requiredGrossPnlBasis,
        observedExecutionFriction: "embedded-in-fill-prices-diagnostic-only",
        stressedExecutionFriction: "counterfactual-delta-above-observed-only",
        separatelyDebitedCosts: ["fees", "funding", "borrow", "rejections", "liquidation"],
      },
      rosterCoverageRate,
      processRosterAudit: {
        startTs: processRosterAudit.startTs,
        endTs: processRosterAudit.endTs,
        expectedCount: processRosterAudit.expectedCount,
        acceptedCount: processRosterAudit.acceptedCount,
        rosterScheduleSha256: processRosterAudit.rosterScheduleSha256,
      },
      minimumDataCoverage: minimumCoverage,
      pointInTimeUniverse: rosterCoverageRate >= policy.universe.minRosterCoverageRate,
      includesDelistedInstruments: manifest.instrumentMaster.verified && manifest.instrumentMaster.includesDelisted,
      portfolioSynchronized,
      portfolioAudit: portfolioEvidence,
      tradesReplayedFromData,
      tradeValidationErrors,
      confirmedDataOnly: manifest.confirmedDataOnly === true,
      completeCostModel,
      costsReplayedFromPreparedData: completeCostModel && processAttestation.verified,
      modelAndNullProcessesReplayed: processAttestation.verified,
      sideMetrics: {
        longTrades: sideCounts.long,
        shortTrades: sideCounts.short,
        evaluatedSeparately: true,
      },
      advancedTests,
      decision: localReasons.length ? "rejected" : "provisionally-passed",
      reasons: [...new Set(localReasons)].sort(),
    });
    reasons.push(...localReasons.map((reason) => `horizon_${days}:${reason}`));
  }

  for (const report of horizonReports) {
    if (!Number.isFinite(report.rawProcessPValue)) continue;
    report.familyHypothesisCount = familyCount;
    report.familywisePValueUpperBound = Math.min(1, report.rawProcessPValue * familyCount);
    if (report.familywisePValueUpperBound > policy.statistics.familywiseAlpha) {
      report.reasons = [...new Set([...report.reasons, "famille_non_significative"])].sort();
      report.decision = "rejected";
      reasons.push(`horizon_${report.days}:famille_non_significative`);
    }
  }

  const primary = horizonReports.find((report) => report.days === 1095) || {};
  const liveEvidenceMetricsTemplate = {
    oosTrades: primary.trades ?? 0,
    oosDays: 1095,
    netMeanPerTrade: primary.netMeanPerTrade ?? null,
    netMeanLower99: primary.netMeanLower99 ?? null,
    costStressLower95: primary.costStressLower95 ?? null,
    familywisePValue: primary.familywisePValueUpperBound ?? null,
    pbo: primary.advancedTests?.pboCscv?.pbo ?? null,
    deflatedSharpeProbability: primary.advancedTests?.deflatedSharpe?.probability ?? null,
    spaPValue: primary.advancedTests?.hansenSpa?.pValue ?? null,
    whiteRealityCheckPValue: primary.advancedTests?.whiteRealityCheck?.pValue ?? null,
    nullReplications: primary.nullReplications ?? 0,
    profitableFoldRate: primary.profitableFoldRate ?? null,
    maxProfitConcentration: primary.concentration?.byInstrumentMaximum ?? null,
    effectiveDays: primary.effectiveTradingDays ?? 0,
    independentBaskets: primary.baskets?.independentBaskets ?? 0,
    calendarYearProfitConcentration: primary.concentration?.byYearMaximum ?? null,
    instrumentProfitConcentration: primary.concentration?.byInstrumentMaximum ?? null,
    topFiveProfitConcentration: primary.concentration?.top5Instruments ?? null,
    maxDrawdownPct: primary.maxDrawdownPct ?? null,
    portfolioNetReturn: primary.portfolioNetReturn ?? null,
    netPnlQuote: primary.netPnlQuote ?? null,
    costStressNetPnlQuote: primary.costStressNetPnlQuote ?? null,
    profitFactor: primary.profitFactor ?? null,
    validatedHorizonsDays: horizonReports.filter((report) => report.decision !== "rejected").map((report) => report.days).sort((a, b) => a - b),
    primaryHorizonDays: 1095,
    shadowLiveDays: null,
    shadowLiveTrades: null,
    shadowLiveNet: null,
  };
  const everyHorizonProcessReplayed = horizonReports.length === REQUIRED_HORIZONS_DAYS.length
    && horizonReports.every((report) => report.costsReplayedFromPreparedData === true
      && report.modelAndNullProcessesReplayed === true && report.portfolioSynchronized === true);

  const body = {
    schemaVersion: 1,
    artifactType: "hermes-quantitative-process-evidence",
    runId: String(runRecord.runId || ""),
    candidateId: declaredCandidateId,
    candidateIdentitySha256: calculatedCandidateId,
    evaluatedAtCutoff: new Date(cutoffTs).toISOString(),
    cutoffTs,
    decision: reasons.length ? "rejected" : "passed",
    rejectionReasons: [...new Set(reasons)].sort(),
    lifecycleState: "validate",
    liveAuthorized: false,
    strategyVersions: [...new Set((runRecord.horizons || []).flatMap((horizon) => (horizon.folds || [])
      .map((fold) => `${fold.strategy?.id || "?"}@${fold.strategy?.version || "?"}:${fold.strategy?.configSha256 || "?"}`)))].sort(),
    policySha256,
    externalPolicyAnchorSha256: /^[a-f0-9]{64}$/.test(externalPolicyAnchor) ? externalPolicyAnchor : null,
    quantPolicyAnchorVerified,
    dataManifestSha256: manifest.manifestSha256,
    dataManifestVerified: manifest.verified,
    trialLedgerSha256: ledger.ledgerSha256,
    trialLedgerComplete: ledger.valid,
    cycleLedgerSha256: cycle.cycleLedgerSha256,
    cycleLedgerComplete: cycle.valid,
    cycleLedgerHypothesisCount: cycle.hypothesisCount,
    feeScheduleSha256: feeSchedule.feeScheduleSha256,
    executionDatasetSha256: executionDataset.executionDatasetSha256,
    executionAttributionManifestSha256: executionDataset.attributionManifest.attributionManifestSha256,
    quantProcessReplayManifestSha256: processReplayManifest.processReplayManifestSha256,
    executionAttestationAuditSha256: executionDataset.attestationAudit.attestationAuditSha256,
    processAttestationAuditSha256: processAttestation.attestationAuditSha256,
    cycleLedgerAttestationAuditSha256: cycle.attestationAudit?.attestationAuditSha256 || null,
    executionUniverseParitySha256: universeParity.paritySha256,
    familyHypothesisCount: familyCount,
    hypothesesEvaluated: [...allHypotheses].sort(),
    horizons: horizonReports,
    liveEvidenceMetricsTemplate,
    methodology: {
      processLevel: processAttestation.verified && everyHorizonProcessReplayed,
      walkForward: true,
      nestedWalkForward: true,
      pointInTimeUniverse: true,
      top30Movers: true,
      purgedEmbargo: true,
      usesOkxData: manifest.source.venue === "OKX",
      includesFees: feeSchedule.verified && horizonReports.every((report) => report.completeCostModel),
      includesFunding: processAttestation.verified && everyHorizonProcessReplayed,
      includesSpreadSlippage: processAttestation.verified && everyHorizonProcessReplayed,
      includesMarketImpactLatency: processAttestation.verified && everyHorizonProcessReplayed,
      exclusiveFillToFillCostDecomposition: processAttestation.verified && everyHorizonProcessReplayed
        && horizonReports.every((report) => report.costAccounting?.grossPnlBasis === "fill-to-fill"),
      modelsPartialFillsAndRejections: processAttestation.verified && everyHorizonProcessReplayed,
      familywiseControlled: processAttestation.verified && everyHorizonProcessReplayed,
      historicalTrialsIncluded: true,
      sideSeparated: true,
      dataManifestVerified: manifest.verified,
      instrumentMasterPointInTime: manifest.instrumentMaster.verified,
      includesDelisted: manifest.instrumentMaster.verified && manifest.instrumentMaster.includesDelisted,
      tradesReplayedFromPreparedExecutions: executionDataset.verified
        && horizonReports.every((report) => report.tradesReplayedFromData === true),
      portfolioMetricsRecomputed: processAttestation.verified && everyHorizonProcessReplayed,
      cycleLedgerIncluded: cycle.valid,
    },
  };
  const evidenceSha256 = sha256Canonical(body);
  const evidence = { ...body, evidenceSha256 };
  COMPILER_ISSUED_EVIDENCE.set(evidence, evidence.evidenceSha256);
  return { evidence, dataManifest: manifest, policy,
    trialLedgerAudit: ledger, cycleLedgerAudit: cycle, feeScheduleAudit: feeSchedule,
    executionDatasetAudit: executionDataset, executionUniverseParityAudit: universeParity,
    processReplayManifest, processAttestationAudit: processAttestation,
    attestationRequests: {
      executionDataset: executionDataset.expectedAttestation,
      quantProcess: processAttestation.expectedAttestation,
      cycleLedger: cycle.expectedAttestation,
    } };
}

function verifyQuantitativeEvidenceHash(evidence) {
  if (!evidence || typeof evidence !== "object") return false;
  const body = { ...evidence };
  const expected = body.evidenceSha256;
  delete body.evidenceSha256;
  return /^[a-f0-9]{64}$/i.test(String(expected || "")) && sha256Canonical(body) === expected;
}

function isFreshlyCompiledQuantitativeEvidence(evidence) {
  return Boolean(evidence && COMPILER_ISSUED_EVIDENCE.get(evidence) === evidence.evidenceSha256
    && verifyQuantitativeEvidenceHash(evidence));
}

/* Canonical in-process boundary between the statistical compiler and
   autopilot. Keeping it here avoids two subtly different mappings in CLI and
   orchestration code. It only maps the exact artifact freshly issued by this
   compiler invocation; a serialized/self-rehashed clone is not provenance. */
function toAutopilotHorizonReports(evidence) {
  if (!verifyQuantitativeEvidenceHash(evidence)) throw new Error("hash de preuve quantitative invalide");
  if (evidence.decision !== "passed" || !Array.isArray(evidence.rejectionReasons)
      || evidence.rejectionReasons.length !== 0) {
    throw new Error("preuve quantitative rejetee: conversion autopilot interdite");
  }
  if (!Array.isArray(evidence.horizons) || evidence.horizons.length !== REQUIRED_HORIZONS_DAYS.length
      || evidence.horizons.some((report) => report?.decision === "rejected" || report?.decision !== "provisionally-passed"
        || !Array.isArray(report.reasons) || report.reasons.length !== 0)) {
    throw new Error("un horizon quantitatif est rejete ou incomplet");
  }
  const horizonDays = evidence.horizons.map((report) => Number(report.days)).sort((a, b) => a - b);
  if (horizonDays.some((days, index) => days !== REQUIRED_HORIZONS_DAYS[index])) {
    throw new Error("les horizons quantitatifs 365/730/1095 sont incomplets");
  }
  const cutoff = String(evidence.evaluatedAtCutoff || "");
  if (!Number.isFinite(Date.parse(cutoff))) throw new Error("cutoff de preuve quantitative invalide");
  const cutoffTs = Date.parse(cutoff);
  if (evidence.horizons.some((report) => Number(report.endTsExclusive) !== cutoffTs)) {
    throw new Error("les horizons quantitatifs ne partagent pas le cutoff");
  }
  if (!isFreshlyCompiledQuantitativeEvidence(evidence)) {
    throw new Error("preuve quantitative non issue de la compilation courante ou alteree");
  }
  return (evidence.horizons || []).map((report) => {
    const coverageRatio = Math.min(
      Number(report.rosterCoverageRate || 0),
      report.minimumDataCoverage?.sufficient === true ? 1 : 0,
      Number(report.advancedTests?.coverageRate || 0)
    );
    return {
      schemaVersion: 1,
      horizonDays: Number(report.days),
      cutoff,
      coverageRatio,
      pointInTimeUniverse: evidence.methodology?.pointInTimeUniverse === true
        && evidence.methodology?.instrumentMasterPointInTime === true
        && report.pointInTimeUniverse === true,
      includesDelistedInstruments: evidence.methodology?.includesDelisted === true
        && report.includesDelistedInstruments === true,
      portfolioSynchronized: report.portfolioSynchronized === true,
      confirmedDataOnly: report.confirmedDataOnly === true,
      completeCostModel: report.completeCostModel === true,
      folds: Number(report.folds || 0),
      oosTrades: Number(report.trades || 0),
      oosDays: Number(report.days || 0),
      netMeanPerTrade: report.netMeanPerTrade ?? null,
      netMeanLower95: report.netMeanLower95 ?? null,
      netMeanLower99: report.netMeanLower99 ?? null,
      costStressLower95: report.costStressLower95 ?? null,
      profitableFoldRate: report.profitableFoldRate ?? null,
      maxDrawdownPct: report.maxDrawdownPct ?? null,
      portfolioNetReturn: report.portfolioNetReturn ?? null,
      netPnlQuote: report.netPnlQuote ?? null,
      costStressNetPnlQuote: report.costStressNetPnlQuote ?? null,
      profitFactor: report.profitFactor ?? null,
      nullReplications: Number(report.nullReplications || 0),
      familywisePValue: report.familywisePValueUpperBound ?? null,
      pbo: report.advancedTests?.pboCscv?.pbo ?? null,
      deflatedSharpeProbability: report.advancedTests?.deflatedSharpe?.probability ?? null,
      spaPValue: report.advancedTests?.hansenSpa?.pValue ?? null,
      whiteRealityCheckPValue: report.advancedTests?.whiteRealityCheck?.pValue ?? null,
      maxProfitConcentration: report.concentration?.byInstrumentMaximum ?? null,
      calendarYearProfitConcentration: report.concentration?.byYearMaximum ?? null,
      instrumentProfitConcentration: report.concentration?.byInstrumentMaximum ?? null,
      topFiveProfitConcentration: report.concentration?.top5Instruments ?? null,
      independentBaskets: Number(report.baskets?.independentBaskets || 0),
      effectiveDays: Number(report.effectiveTradingDays || 0),
      expectedShortfall95: report.expectedShortfall95 ?? null,
      costPerTrade: report.costPerTrade ?? null,
      dataManifestSha256: String(evidence.dataManifestSha256 || ""),
      quantEvidenceSha256: String(evidence.evidenceSha256),
      quantPolicySha256: String(evidence.policySha256 || ""),
      candidateId: String(evidence.candidateId || ""),
    };
  }).sort((a, b) => a.horizonDays - b.horizonDays);
}

const LIFECYCLE_STATES = Object.freeze(["discovery", "validate", "shadow", "eligible"]);

function advanceResearchLifecycle({ currentState, candidate, validationEvidence, shadowEvidence,
  evidenceSignatureVerified = false, approvalSignatureVerified = false, policy: policyInput = {} }) {
  const policy = mergePolicy(policyInput);
  const state = String(currentState || "discovery");
  if (!LIFECYCLE_STATES.includes(state)) throw new Error("etat de recherche inconnu");
  const reasons = [];
  let nextState = state;
  if (state === "discovery") {
    if (!candidate?.id || !candidate?.version || !/^[a-f0-9]{64}$/i.test(String(candidate?.configSha256 || ""))) {
      reasons.push("candidat_non_versionne");
    } else nextState = "validate";
  } else if (state === "validate") {
    if (validationEvidence?.decision !== "passed" || validationEvidence?.liveAuthorized !== false) reasons.push("validation_quantitative_refusee");
    else nextState = "shadow";
  } else if (state === "shadow") {
    if (!(Number(shadowEvidence?.days) >= policy.lifecycle.minimumShadowDays)) reasons.push("shadow_jours_insuffisants");
    if (!(Number(shadowEvidence?.trades) >= policy.lifecycle.minimumShadowTrades)) reasons.push("shadow_trades_insuffisants");
    if (!(Number(shadowEvidence?.netReturn) > 0)) reasons.push("shadow_net_non_positif");
    if (policy.lifecycle.requireVerifiedEvidenceSignatureForEligibility && evidenceSignatureVerified !== true) reasons.push("preuve_non_signee");
    if (policy.lifecycle.requireVerifiedApprovalSignatureForEligibility && approvalSignatureVerified !== true) reasons.push("approbation_independante_absente");
    if (!reasons.length) nextState = "eligible";
  }
  return {
    previousState: state,
    state: nextState,
    transitioned: nextState !== state,
    reasons,
    liveAuthorized: false,
    note: nextState === "eligible" ? "eligible pour examen du gate live; aucune activation automatique" : "",
  };
}

module.exports = {
  DAY_MS,
  REQUIRED_HORIZONS_DAYS,
  QUANT_EXECUTION_SIGNATURE_DOMAIN,
  QUANT_PROCESS_SIGNATURE_DOMAIN,
  QUANT_CYCLE_LEDGER_SIGNATURE_DOMAIN,
  CYCLE_LEDGER_HASH_CHAIN_DOMAIN,
  DEFAULT_POLICY,
  mergePolicy,
  canonicalJson,
  sha256Canonical,
  publicKeySpkiSha256,
  auditAttestationTrust,
  quantAttestationSigningPayload,
  verifyExactAttestation,
  finiteNumber,
  timestamp,
  auditExecutionUniverseParity,
  preparePointInTimeSeries,
  preparePointInTimeInstrumentMaster,
  masterSnapshotAt,
  instrumentEligibilityAt,
  createInstrumentMasterManifest,
  auditInstrumentMasterMarketCoverage,
  buildPointInTimeTopMovers,
  verifyRosterPointInTime,
  rosterSelectionTimes,
  buildRosterSchedule,
  auditRosterSchedule,
  createDataManifest,
  feeSnapshotBody,
  prepareFeeSchedule,
  prepareExecutionDataset,
  createExecutionAttributionManifest,
  expectedExecutionAttestationBody,
  replayTradeFromExecutionDataset,
  requiredDataStart,
  assessMinimumDataCoverage,
  buildNestedPurgedWalkForward,
  verifyPurgedFold,
  applyCompleteCosts,
  missingCostObservations,
  movingBlockBootstrapCI,
  clusteredBasketBootstrapCI,
  clusteredBasketPnlBootstrapCI,
  clusteredBasketPnlBootstrapSensitivity,
  blockSignPermutationTest,
  empiricalExactPValue,
  holmBonferroni,
  deflatedSharpeProbability,
  probabilityBacktestOverfitting,
  matrixBootstrapPValues,
  matrixBootstrapSensitivity,
  normaliseModelReturnMatrix,
  validateTrialLedger,
  validateCycleLedger,
  cycleLedgerUnsignedBody,
  buildCycleLedgerHashChain,
  expectedCycleLedgerAttestationBody,
  calculatePerformance,
  validatePortfolioSimulation,
  positiveProfitConcentration,
  independentBasketCount,
  dailyReturns,
  quantitativeCandidateIdentity,
  quantitativeCandidateId,
  createQuantProcessReplayManifest,
  expectedQuantProcessAttestationBody,
  auditQuantProcessAttestation,
  compileQuantitativeEvidence,
  verifyQuantitativeEvidenceHash,
  isFreshlyCompiledQuantitativeEvidence,
  toAutopilotHorizonReports,
  LIFECYCLE_STATES,
  advanceResearchLifecycle,
};
