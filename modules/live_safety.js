"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_POLICY = Object.freeze({
  rosterMaxAgeHours: 2160,
  evidenceMaxAgeDays: 31,
  requireEvidenceSignature: true,
  minOosTrades: 1500,
  minOosDays: 365,
  minShadowDays: 60,
  minShadowTrades: 100,
  minNullReplications: 9999,
  minProfitableFoldRate: 0.70,
  maxProfitConcentration: 0.25,
  maxFamilywisePValue: 0.01,
  maxDrawdownPct: 0.10,
  minProfitFactor: 1.10,
  engineFiles: [
    "app/main.js",
    "modules/live_safety.js",
    "modules/signaux.js",
    "modules/backtest.js",
    "deploy/chercher_perles.js",
    "config/live-gate.policy.json",
    "config/risk.json",
    "package-lock.json",
  ],
  requiredMethodology: [
    "processLevel",
    "walkForward",
    "pointInTimeUniverse",
    "purgedEmbargo",
    "usesOkxData",
    "includesFees",
    "includesFunding",
    "includesSpreadSlippage",
    "modelsPartialFills",
    "familywiseControlled",
    "sideSeparated",
    "dataManifestVerified",
  ],
});

class OkxBusinessError extends Error {
  constructor(operation, code, message, payload) {
    super(`${operation || "OKX"}: code ${code || "?"}${message ? ` - ${message}` : ""}`);
    this.name = "OkxBusinessError";
    this.okxCode = String(code || "?");
    this.okxPayload = payload;
  }
}

function assertOkxSuccess(payload, operation = "OKX") {
  if (!payload || typeof payload !== "object") {
    throw new OkxBusinessError(operation, "INVALID_RESPONSE", "reponse vide ou illisible", payload);
  }
  if (String(payload.code) !== "0") {
    throw new OkxBusinessError(operation, payload.code, payload.msg || "requete refusee", payload);
  }
  const items = Array.isArray(payload.data) ? payload.data : [];
  const rejected = items.find((item) => item && item.sCode != null && String(item.sCode) !== "0");
  if (rejected) {
    throw new OkxBusinessError(operation, rejected.sCode, rejected.sMsg || payload.msg || "operation refusee", payload);
  }
  return payload;
}

function isRetryableOkxError(error) {
  const code = String(error?.okxCode || error?.response?.data?.code || "");
  if (["50001", "50011", "50102"].includes(code)) return true;
  const status = Number(error?.response?.status || 0);
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  return ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "ECONNABORTED"].includes(error?.code);
}

function toPlainDecimal(value) {
  const raw = String(value).trim().toLowerCase();
  if (!raw.includes("e")) return raw;
  const match = raw.match(/^([+-]?)(\d+)(?:\.(\d*))?e([+-]?\d+)$/);
  if (!match) return raw;
  const sign = match[1] === "-" ? "-" : "";
  const whole = match[2];
  const fraction = match[3] || "";
  const exponent = Number(match[4]);
  const digits = whole + fraction;
  const point = whole.length + exponent;
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

function decimalScale(value) {
  const s = toPlainDecimal(value).replace(/^[+-]/, "");
  return (s.split(".")[1] || "").length;
}

function decimalToUnits(value, scale) {
  const s = toPlainDecimal(value).replace(/^\+/, "");
  if (!/^\d+(?:\.\d+)?$/.test(s)) throw new Error(`decimal invalide: ${value}`);
  const [whole, fraction = ""] = s.split(".");
  const padded = (fraction + "0".repeat(scale)).slice(0, scale);
  return BigInt((whole + padded).replace(/^0+(?=\d)/, "") || "0");
}

function unitsToDecimal(units, scale) {
  let s = String(units);
  if (scale === 0) return s;
  s = s.padStart(scale + 1, "0");
  const out = `${s.slice(0, -scale)}.${s.slice(-scale)}`.replace(/\.?0+$/, "");
  return out || "0";
}

function quantityToLotString(contracts, lotSize, minSize) {
  const value = Number(contracts);
  const step = Number(lotSize);
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return "0";
  const scale = Math.max(decimalScale(lotSize), decimalScale(minSize || lotSize));
  const stepUnits = decimalToUnits(lotSize, scale);
  const minUnits = decimalToUnits(minSize || lotSize, scale);
  const minLots = (minUnits + stepUnits - 1n) / stepUnits;
  const estimatedLots = Math.floor(value / step + 1e-9);
  const safeLots = Number.isSafeInteger(estimatedLots) && estimatedLots > 0 ? BigInt(estimatedLots) : 0n;
  const lots = safeLots > minLots ? safeLots : minLots;
  return unitsToDecimal(lots * stepUnits, scale);
}

function computePositionSizing(options) {
  const equity = Math.max(0, Number(options?.equity || 0));
  const maxMarginPct = Math.max(0, Math.min(0.5, Number(options?.maxMarginPct ?? 0.25)));
  const riskPerTradePct = Math.max(0, Math.min(0.02, Number(options?.riskPerTradePct ?? 0.005)));
  const stopLossMarginPct = Math.max(0.01, Number(options?.stopLossMarginPct ?? 0.30));
  const desiredPlaces = Math.max(1, Math.floor(Number(options?.places ?? 3)));
  const maxPositions = Math.max(1, Math.floor(Number(options?.maxPositions ?? desiredPlaces)));
  const minMargin = Math.max(0, Number(options?.minMargin ?? 3));
  const maxMargin = Math.max(minMargin, Number(options?.maxMargin ?? 200));
  const marginBudget = equity * maxMarginPct;
  const riskBudget = equity * riskPerTradePct;
  const marginFromRisk = riskBudget / stopLossMarginPct;
  const places = Math.min(desiredPlaces, maxPositions);
  const perTradeUSDT = Math.min(marginBudget / places, marginFromRisk, maxMargin);
  if (!(perTradeUSDT >= minMargin)) {
    return { perTradeUSDT: 0, maxPositions: 0, marginBudget, riskBudget, maxMarginPct, riskPerTradePct };
  }
  return { perTradeUSDT, maxPositions: places, marginBudget, riskBudget, maxMarginPct, riskPerTradePct };
}

function effectiveStopLossMarginPct(override, fallback = 0.30) {
  const fallbackValue = Number(fallback);
  if (!Number.isFinite(fallbackValue) || fallbackValue < 0.01 || fallbackValue > 1) {
    throw new Error("configuration risque invalide: stopLossMarginPct");
  }
  if (override == null) return fallbackValue;
  if (typeof override !== "object" || Array.isArray(override)) {
    throw new Error("override roster invalide: slPctMargin");
  }
  if (!Object.prototype.hasOwnProperty.call(override, "slPctMargin")) return fallbackValue;
  const value = override.slPctMargin;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0.01 || value > 1) {
    throw new Error("override roster invalide: slPctMargin");
  }
  return value;
}

/* Pure reducer for the maker-order lifecycle. Keeping this decision
   table outside the network loop makes the dangerous transition
   partially_filled -> cancel + protect executable in unit tests. */
function makerOrderDirective(order, state = {}) {
  const orderState = String(order?.state || "").toLowerCase();
  const rawFilledQty = order?.accFillSz;
  const filledQty = Number(rawFilledQty);
  const quantityKnown = rawFilledQty !== undefined && rawFilledQty !== null
    && rawFilledQty !== "" && Number.isFinite(filledQty) && filledQty >= 0;
  const protectedQty = Math.max(0, Number(state?.protectedQty || 0));
  const validFilledQty = quantityKnown && filledQty > 0 ? filledQty : 0;
  const protectQty = Math.max(0, validFilledQty - protectedQty);
  const result = {
    orderState,
    filledQty: validFilledQty,
    protectQty,
    quantityKnown,
    inconsistent: false,
    requestCancel: false,
    terminal: false,
    filled: false,
  };
  if (orderState === "filled") {
    if (!quantityKnown || !(validFilledQty > 0)) return { ...result, inconsistent: true };
    return { ...result, terminal: true, filled: true };
  }
  if (orderState === "canceled" || orderState === "mmp_canceled") {
    if (!quantityKnown) return { ...result, inconsistent: true };
    return { ...result, terminal: true };
  }
  if (orderState === "partially_filled" && validFilledQty > 0) {
    return { ...result, requestCancel: !state?.cancelRequested };
  }
  return result;
}

function evaluateEntryStopRisk(options) {
  const side = String(options?.side || "").toLowerCase();
  const entryPx = Number(options?.entryPx);
  const stopPx = Number(options?.stopPx);
  const qty = Math.abs(Number(options?.qty));
  const contractValue = Math.abs(Number(options?.contractValue));
  const equity = Number(options?.equity);
  const riskPct = Number(options?.riskPct);
  const finitePositive = [entryPx, stopPx, qty, contractValue, equity, riskPct]
    .every((value) => Number.isFinite(value) && value > 0);
  const correctSide = side === "long" ? stopPx < entryPx
    : side === "short" ? stopPx > entryPx : false;
  const plannedLoss = finitePositive ? Math.abs(entryPx - stopPx) * qty * contractValue : Infinity;
  const budget = finitePositive ? equity * riskPct : 0;
  /* Seulement une epsilon numerique. La granularite du tick doit etre
     absorbee par le sizing avant l'ordre, jamais ajoutee au plafond. */
  const tolerance = Math.max(1e-10, Math.abs(budget) * Number.EPSILON * 16);
  return {
    allowed: finitePositive && correctSide && plannedLoss <= budget + tolerance,
    correctSide,
    plannedLoss,
    budget,
    tolerance,
  };
}

function validateRiskConfig(input) {
  const rules = {
    maxPositions: [1, 3, true], leverage: [1, 15, false],
    maxMarginPct: [0.0001, 0.25, false], riskPerTradePct: [0.0001, 0.005, false],
    maxDrawdownPct: [0.0001, 0.10, false], maxDailyLossPct: [0.0001, 0.02, false],
    stopLossMarginPct: [0.01, 1, false],
    sameSideFull: [1, 3, true], correlationScale: [0.01, 1, false],
  };
  const out = {};
  for (const [name, [minimum, maximum, integer]] of Object.entries(rules)) {
    const value = Number(input?.[name]);
    if (!Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
      throw new Error(`configuration risque invalide: ${name}`);
    }
    out[name] = value;
  }
  return out;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hermesAlgoOwnerNamespace(owner = process.env.HERMES_ALGO_OWNER) {
  const identity = String(owner || "").trim();
  return identity ? `HMP${sha256(identity).slice(0, 8).toUpperCase()}` : null;
}

function newHermesClientId(kind = "entry", owner = process.env.HERMES_ALGO_OWNER) {
  const roles = { stop: "S", trail: "T", oco: "O", attach: "A", entry: "E", market: "M" };
  const role = roles[String(kind).toLowerCase()] || "X";
  const namespace = hermesAlgoOwnerNamespace(owner) || "HMU00000000";
  return `${namespace}${role}${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 32);
}

function isHermesOwnedAlgo(order, owner = process.env.HERMES_ALGO_OWNER) {
  const namespace = hermesAlgoOwnerNamespace(owner);
  if (!namespace) return false;
  const protectionPrefix = new RegExp(`^${namespace}[STOA]`);
  return [order?.algoClOrdId, order?.attachAlgoClOrdId]
    .some((value) => protectionPrefix.test(String(value || "")));
}

function isProtectiveStopAlgo(order, { positionSide, entryPx, hedgeMode = false } = {}) {
  const posSide = String(positionSide || "").toLowerCase();
  const closeSide = posSide === "long" ? "sell" : posSide === "short" ? "buy" : "";
  const orderSide = String(order?.side || "").toLowerCase();
  const type = String(order?.ordType || "").toLowerCase();
  if (!closeSide || orderSide !== closeSide || !(Number(entryPx) > 0)) return false;
  if (hedgeMode && String(order?.posSide || "").toLowerCase() !== posSide) return false;

  let stopPx = null;
  if (["oco", "conditional"].includes(type)) stopPx = Number(order?.slTriggerPx);
  else if (type === "trigger") {
    const reduces = order?.reduceOnly === true || ["true", "1"].includes(String(order?.reduceOnly || "").toLowerCase());
    if (!hedgeMode && !reduces) return false;
    stopPx = Number(order?.triggerPx);
  } else return false;
  if (!(stopPx > 0)) return false;
  return posSide === "long" ? stopPx < Number(entryPx) : stopPx > Number(entryPx);
}

function rosterSha256(roster) {
  return sha256(stableStringify(roster || null));
}

function engineSha256(root, files = DEFAULT_POLICY.engineFiles) {
  const hash = crypto.createHash("sha256");
  for (const relative of files) {
    const absolute = path.join(root, relative);
    hash.update(relative.replace(/\\/g, "/"));
    hash.update("\0");
    hash.update(fs.readFileSync(absolute));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function asFinite(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function atLeast(value, minimum) { const n = asFinite(value); return n !== null && n >= Number(minimum); }
function atMost(value, maximum) { const n = asFinite(value); return n !== null && n <= Number(maximum); }
function positive(value) { const n = asFinite(value); return n !== null && n > 0; }
function between(value, minimum, maximum) {
  const n = asFinite(value);
  return n !== null && n >= Number(minimum) && n <= Number(maximum);
}

function evidenceSigningPayload(evidence) {
  if (!evidence || typeof evidence !== "object") return "";
  const unsigned = { ...evidence };
  delete unsigned.signature;
  return stableStringify(unsigned);
}

function verifyEvidenceSignature(evidence, publicKey) {
  try {
    if (!evidence?.signature || !publicKey) return false;
    return crypto.verify(
      null,
      Buffer.from(evidenceSigningPayload(evidence), "utf8"),
      publicKey,
      Buffer.from(String(evidence.signature), "base64")
    );
  } catch { return false; }
}

function evaluateLiveGate({ roster, evidence, policy, nowMs, expectedEngineSha256, evidenceSignatureVerified }) {
  const cfg = { ...DEFAULT_POLICY, ...(policy || {}) };
  const now = Number(nowMs || Date.now());
  const reasons = [];
  const perles = roster?.perles;
  const generatedMs = Date.parse(roster?.genere || "");
  const rosterHash = rosterSha256(roster);

  if (!roster || typeof roster !== "object") reasons.push("roster_absent");
  else {
    if (Number(roster.schemaVersion) !== 1) reasons.push("roster_schema");
    if (typeof roster.selectionRunId !== "string" || !roster.selectionRunId.trim()) reasons.push("roster_run_absent");
    if (!/^[a-f0-9]{64}$/i.test(String(roster.dataManifestSha256 || ""))) reasons.push("roster_manifest_invalide");
    if (!perles || typeof perles !== "object" || Array.isArray(perles)) reasons.push("roster_invalide");
    else if (Object.keys(perles).length === 0) reasons.push("roster_vide");
  }
  if (!Number.isFinite(generatedMs)) reasons.push("roster_sans_date");
  else if (generatedMs > now + 5 * 60e3) reasons.push("roster_date_future");
  else if (now - generatedMs > Number(cfg.rosterMaxAgeHours) * 3600e3) reasons.push("roster_expire");

  if (!evidence || typeof evidence !== "object") {
    reasons.push("preuve_absente");
  } else {
    const made = Date.parse(evidence.generatedAt || "");
    const expires = Date.parse(evidence.expiresAt || "");
    if (Number(evidence.schemaVersion) !== 1) reasons.push("preuve_schema");
    if (cfg.requireEvidenceSignature !== false && evidenceSignatureVerified !== true) reasons.push("preuve_signature_invalide");
    if (evidence.decision !== "approved") reasons.push("preuve_non_approuvee");
    if (!Number.isFinite(made) || now - made > Number(cfg.evidenceMaxAgeDays) * 86400e3) reasons.push("preuve_expiree");
    else if (made > now + 5 * 60e3) reasons.push("preuve_date_future");
    if (!Number.isFinite(expires) || expires <= now) reasons.push("preuve_hors_validite");
    else if (!Number.isFinite(made) || expires <= made || expires - made > Number(cfg.evidenceMaxAgeDays) * 86400e3) reasons.push("preuve_validite_excessive");
    if (evidence.rosterSha256 !== rosterHash) reasons.push("preuve_roster_different");
    if (!expectedEngineSha256 || evidence.engineSha256 !== expectedEngineSha256) reasons.push("preuve_moteur_different");

    const metrics = evidence.metrics || {};
    const tests = [
      [atLeast(metrics.oosTrades, cfg.minOosTrades), "oos_trades_insuffisants"],
      [atLeast(metrics.oosDays, cfg.minOosDays), "oos_jours_insuffisants"],
      [positive(metrics.netMeanPerTrade), "esperance_nette_non_positive"],
      [positive(metrics.netMeanLower99), "borne_99_non_positive"],
      [positive(metrics.costStressLower95), "stress_couts_non_positif"],
      [between(metrics.familywisePValue, 0, 1), "p_value_invalide"],
      [atMost(metrics.familywisePValue, cfg.maxFamilywisePValue), "test_famille_non_significatif"],
      [atLeast(metrics.nullReplications, cfg.minNullReplications), "replications_null_insuffisantes"],
      [between(metrics.profitableFoldRate, 0, 1), "taux_folds_invalide"],
      [atLeast(metrics.profitableFoldRate, cfg.minProfitableFoldRate), "folds_profitables_insuffisants"],
      [between(metrics.maxProfitConcentration, 0, 1), "concentration_invalide"],
      [atMost(metrics.maxProfitConcentration, cfg.maxProfitConcentration), "profit_trop_concentre"],
      [between(metrics.maxDrawdownPct, 0, 1), "drawdown_invalide"],
      [atMost(metrics.maxDrawdownPct, cfg.maxDrawdownPct), "drawdown_trop_eleve"],
      [atLeast(metrics.profitFactor, cfg.minProfitFactor), "profit_factor_insuffisant"],
      [atLeast(metrics.shadowLiveDays, cfg.minShadowDays), "shadow_jours_insuffisants"],
      [atLeast(metrics.shadowLiveTrades, cfg.minShadowTrades), "shadow_trades_insuffisants"],
      [positive(metrics.shadowLiveNet), "shadow_net_non_positif"],
    ];
    for (const [ok, reason] of tests) if (!ok) reasons.push(reason);
    for (const flag of cfg.requiredMethodology || []) {
      if (evidence.methodology?.[flag] !== true) reasons.push(`methode_${flag}`);
    }
  }

  return {
    allowed: reasons.length === 0,
    reasons: [...new Set(reasons)],
    checkedAt: new Date(now).toISOString(),
    rosterSha256: rosterHash,
    engineSha256: expectedEngineSha256 || null,
    rosterCount: perles && typeof perles === "object" ? Object.keys(perles).length : 0,
    evidenceExpiresAt: evidence?.expiresAt || null,
  };
}

function readLiveGate(root, options = {}) {
  const policyFile = options.policyFile || path.join(root, "config", "live-gate.policy.json");
  const rosterFile = options.rosterFile || path.join(root, "config", "approved-roster.json");
  const evidenceFile = options.evidenceFile || process.env.HERMES_LIVE_EVIDENCE_FILE || path.join(root, "data", "live-evidence.json");
  let policy = DEFAULT_POLICY;
  let roster = null;
  let evidence = null;
  try { policy = { ...DEFAULT_POLICY, ...readJson(policyFile) }; } catch {}
  try { roster = readJson(rosterFile); } catch {}
  try { evidence = readJson(evidenceFile); } catch {}
  let publicKey = options.evidencePublicKey || null;
  if (!publicKey) {
    const publicKeyFile = options.publicKeyFile || process.env.HERMES_EVIDENCE_PUBLIC_KEY_FILE
      || path.join(root, "config", "evidence-public-key.pem");
    try { publicKey = fs.readFileSync(publicKeyFile, "utf8"); } catch {}
  }
  let engineHash = null;
  try { engineHash = engineSha256(root, policy.engineFiles); } catch {}
  return evaluateLiveGate({
    roster, evidence, policy, nowMs: options.nowMs, expectedEngineSha256: engineHash,
    evidenceSignatureVerified: verifyEvidenceSignature(evidence, publicKey),
  });
}

module.exports = {
  DEFAULT_POLICY,
  OkxBusinessError,
  assertOkxSuccess,
  isRetryableOkxError,
  quantityToLotString,
  computePositionSizing,
  effectiveStopLossMarginPct,
  makerOrderDirective,
  evaluateEntryStopRisk,
  validateRiskConfig,
  stableStringify,
  evidenceSigningPayload,
  verifyEvidenceSignature,
  hermesAlgoOwnerNamespace,
  newHermesClientId,
  isHermesOwnedAlgo,
  isProtectiveStopAlgo,
  rosterSha256,
  engineSha256,
  evaluateLiveGate,
  readLiveGate,
};
