"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_POLICY = Object.freeze({
  rosterMaxAgeHours: 2160,
  evidenceMaxAgeDays: 31,
  requireEvidenceSignature: true,
  evidencePublicKeySpkiSha256: "UNCONFIGURED",
  monitoringPublicKeySpkiSha256: "UNCONFIGURED",
  minOosTrades: 1500,
  minOosDays: 1095,
  minShadowDays: 90,
  minShadowTrades: 100,
  minNullReplications: 9999,
  minProfitableFoldRate: 0.70,
  maxProfitConcentration: 0.25,
  maxFamilywisePValue: 0.01,
  maxPbo: 0.10,
  minDeflatedSharpeProbability: 0.95,
  maxSpaPValue: 0.05,
  maxWhiteRealityCheckPValue: 0.05,
  minEffectiveDays: 250,
  minIndependentBaskets: 100,
  maxCalendarYearProfitConcentration: 0.60,
  maxInstrumentProfitConcentration: 0.10,
  maxTopFiveProfitConcentration: 0.50,
  maxDrawdownPct: 0.10,
  minProfitFactor: 1.10,
  engineFiles: [
    "app/main.js",
    "app/serveur.js",
    "app/pont.js",
    "modules/live_safety.js",
    "modules/position_metadata.js",
    "modules/okx_top_movers.js",
    "modules/autopilot.js",
    "modules/autopilot_cycle.js",
    "modules/quant_validation.js",
    "modules/carry_strategy.js",
    "modules/signaux.js",
    "modules/backtest.js",
    "modules/juge.js",
    "modules/exec.js",
    "deploy/chercher_perles.js",
    "deploy/autopilot_cycle.js",
    "deploy/compiler_preuve_quantitative.js",
    "deploy/verifier_gate_live.js",
    "deploy/install.sh",
    "config/live-gate.policy.json",
    "config/autopilot.policy.json",
    "config/quant-validation.policy.json",
    "config/quant-trial-ledger.json",
    "config/report-profile-priors.json",
    "config/carry-candidate.json",
    "config/risk.json",
    "config/okx.json",
    "config/ai.config.json",
    "config/policy.json",
    "package.json",
    "package-lock.json",
  ],
  requiredMethodology: [
    "processLevel",
    "walkForward",
    "nestedWalkForward",
    "pointInTimeUniverse",
    "top30Movers",
    "purgedEmbargo",
    "usesOkxData",
    "includesFees",
    "includesFunding",
    "includesSpreadSlippage",
    "includesMarketImpactLatency",
    "modelsPartialFillsAndRejections",
    "familywiseControlled",
    "historicalTrialsIncluded",
    "shadowLogsManifestVerified",
    "tradesReplayedFromPreparedExecutions",
    "portfolioMetricsRecomputed",
    "cycleLedgerIncluded",
    "sideSeparated",
    "dataManifestVerified",
    "instrumentMasterPointInTime",
    "includesDelisted",
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

/* Revalue isolated margin with the last executable quote. The reservation was
   computed before the maker wait; a market fallback must not reuse that stale
   dollar value after price moved. totalUsedMargin includes this reservation,
   so the calculation replaces it with the exact revalued margin. */
function evaluateEntryMarginBudget(options) {
  const entryPx = options?.entryPx;
  const qty = options?.qty;
  const contractValue = options?.contractValue;
  const leverage = options?.leverage;
  const reservedMargin = options?.reservedMargin;
  const perTradeMargin = options?.perTradeMargin;
  const totalUsedMargin = options?.totalUsedMargin;
  const totalMarginBudget = options?.totalMarginBudget;
  const values = [entryPx, qty, contractValue, leverage, reservedMargin,
    perTradeMargin, totalUsedMargin, totalMarginBudget];
  const finiteNumbers = values.every((value) => typeof value === "number" && Number.isFinite(value));
  const positiveInputs = finiteNumbers && entryPx > 0 && qty > 0 && contractValue > 0
    && leverage > 0 && reservedMargin > 0 && perTradeMargin > 0 && totalMarginBudget > 0
    && totalUsedMargin >= 0;
  const exactMargin = positiveInputs
    ? (entryPx * Math.abs(qty) * Math.abs(contractValue)) / leverage
    : Infinity;
  const epsilon = positiveInputs
    ? Math.max(1e-10, Math.max(exactMargin, reservedMargin, perTradeMargin, totalMarginBudget)
      * Number.EPSILON * 32)
    : 0;
  const reservationAccounted = positiveInputs && totalUsedMargin + epsilon >= reservedMargin;
  const usedWithoutReservation = reservationAccounted
    ? Math.max(0, totalUsedMargin - reservedMargin)
    : Infinity;
  const totalMarginAtQuote = usedWithoutReservation + exactMargin;
  const reasons = [];
  if (!positiveInputs) reasons.push("marge_entree_invalide");
  else if (!reservationAccounted) reasons.push("reservation_marge_absente");
  if (positiveInputs && exactMargin > reservedMargin + epsilon) reasons.push("marge_cotation_depasse_reservation");
  if (positiveInputs && exactMargin > perTradeMargin + epsilon) reasons.push("marge_cotation_depasse_par_trade");
  if (positiveInputs && reservationAccounted && totalMarginAtQuote > totalMarginBudget + epsilon) {
    reasons.push("marge_cotation_depasse_budget_total");
  }
  return {
    allowed: reasons.length === 0,
    reasons,
    exactMargin,
    usedWithoutReservation,
    totalMarginAtQuote,
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
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const hash = crypto.createHash("sha256");
  for (const relative of files) {
    if (typeof relative !== "string" || !relative || path.isAbsolute(relative)) throw new Error("chemin moteur invalide");
    const absolute = fs.realpathSync(path.resolve(resolvedRoot, relative));
    const inside = path.relative(resolvedRoot, absolute);
    if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) {
      if (!inside) throw new Error("un repertoire ne peut pas etre un fichier moteur");
      throw new Error(`fichier moteur hors racine: ${relative}`);
    }
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
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function atLeast(value, minimum) { const n = asFinite(value); return n !== null && n >= Number(minimum); }
function atMost(value, maximum) { const n = asFinite(value); return n !== null && n <= Number(maximum); }
function positive(value) { const n = asFinite(value); return n !== null && n > 0; }
function between(value, minimum, maximum) {
  const n = asFinite(value);
  return n !== null && n >= Number(minimum) && n <= Number(maximum);
}

const MINIMUM_POLICY_FIELDS = Object.freeze([
  "minOosTrades", "minOosDays", "minShadowDays", "minShadowTrades",
  "minNullReplications", "minProfitableFoldRate", "minDeflatedSharpeProbability",
  "minEffectiveDays", "minIndependentBaskets", "minProfitFactor",
]);
const MAXIMUM_POLICY_FIELDS = Object.freeze([
  "rosterMaxAgeHours", "evidenceMaxAgeDays", "maxProfitConcentration",
  "maxFamilywisePValue", "maxPbo", "maxSpaPValue", "maxWhiteRealityCheckPValue",
  "maxCalendarYearProfitConcentration", "maxInstrumentProfitConcentration",
  "maxTopFiveProfitConcentration", "maxDrawdownPct",
]);

/* Une politique de fichier peut durcir les constantes compilees, jamais les
   assouplir. Son engineFiles effectif contient toujours la surface minimale
   codee ici, y compris la politique elle-meme. */
function normaliseLiveGatePolicy(input) {
  const supplied = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const policy = { ...DEFAULT_POLICY, ...supplied };
  const reasons = [];
  for (const name of MINIMUM_POLICY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(supplied, name)) continue;
    const value = asFinite(supplied[name]);
    if (value === null || value < Number(DEFAULT_POLICY[name])) {
      reasons.push(`politique_assouplie_${name}`);
      policy[name] = DEFAULT_POLICY[name];
    } else policy[name] = value;
  }
  for (const name of MAXIMUM_POLICY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(supplied, name)) continue;
    const value = asFinite(supplied[name]);
    if (!(value > 0) || value > Number(DEFAULT_POLICY[name])) {
      reasons.push(`politique_assouplie_${name}`);
      policy[name] = DEFAULT_POLICY[name];
    } else policy[name] = value;
  }
  if (supplied.requireEvidenceSignature === false) reasons.push("politique_signature_desactivee");
  policy.requireEvidenceSignature = true;

  const requiredFiles = [...DEFAULT_POLICY.engineFiles];
  const suppliedFiles = Array.isArray(supplied.engineFiles) ? supplied.engineFiles : requiredFiles;
  const safeExtras = [];
  for (const item of suppliedFiles) {
    const value = String(item || "").replace(/\\/g, "/");
    if (!value || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
        || value.split("/").includes("..")) {
      reasons.push("politique_fichier_moteur_invalide");
      continue;
    }
    safeExtras.push(value);
  }
  const suppliedSet = new Set(safeExtras);
  for (const file of requiredFiles) if (!suppliedSet.has(file)) reasons.push(`politique_fichier_moteur_absent:${file}`);
  policy.engineFiles = [...new Set([...requiredFiles, ...safeExtras])];

  const requiredMethods = [...DEFAULT_POLICY.requiredMethodology];
  const suppliedMethods = Array.isArray(supplied.requiredMethodology)
    ? supplied.requiredMethodology.map(String) : requiredMethods;
  const suppliedMethodSet = new Set(suppliedMethods);
  for (const name of requiredMethods) if (!suppliedMethodSet.has(name)) reasons.push(`politique_methode_absente:${name}`);
  policy.requiredMethodology = [...new Set([...requiredMethods, ...suppliedMethods])];
  const fingerprintPattern = /^[a-f0-9]{64}$/i;
  const evidenceAnchor = String(policy.evidencePublicKeySpkiSha256 || "").toLowerCase();
  const monitoringAnchor = String(policy.monitoringPublicKeySpkiSha256 || "").toLowerCase();
  if (fingerprintPattern.test(evidenceAnchor) && fingerprintPattern.test(monitoringAnchor)
      && evidenceAnchor === monitoringAnchor) reasons.push("politique_cles_signature_non_distinctes");
  return { policy, reasons: [...new Set(reasons)] };
}

function hasExactHorizonSet(value) {
  if (!Array.isArray(value)) return false;
  const unique = [...new Set(value.map(Number))].sort((a, b) => a - b);
  return unique.length === 3 && unique[0] === 365 && unique[1] === 730 && unique[2] === 1095;
}

function evaluateAutopilotCanaryAuthority({ roster, state, policy } = {}) {
  const hasLiveEntries = roster?.perles && typeof roster.perles === "object"
    && !Array.isArray(roster.perles) && Object.keys(roster.perles).length > 0;
  if (!hasLiveEntries) return { required: false, allowed: true, reasons: [], canaryEquityPct: null };
  const candidate = String(roster?.strategyCandidateId || "").trim().toLowerCase();
  const reasons = [];
  if (!/^[a-f0-9]{64}$/.test(candidate)) reasons.push("autopilot_roster_candidate_invalide");
  if (String(state?.stage || "") !== "canary") reasons.push("autopilot_canary_non_active");
  if (String(state?.candidateId || "").toLowerCase() !== candidate) reasons.push("autopilot_state_candidate_different");
  if (state?.championCandidateId != null
      && String(state.championCandidateId).toLowerCase() !== candidate) reasons.push("autopilot_champion_different");
  const cap = asFinite(state?.canaryEquityPct);
  const maximum = asFinite(policy?.promotion?.maximumCanaryEquityPct) ?? 0.05;
  const initial = asFinite(policy?.promotion?.initialCanaryEquityPct);
  const automaticScaleUp = policy?.promotion?.automaticScaleUp === true;
  if (!(maximum > 0 && maximum <= 0.05)) reasons.push("autopilot_plafond_politique_invalide");
  if (!(cap !== null && cap > 0 && cap <= maximum)) reasons.push("autopilot_plafond_canary_invalide");
  if (!(initial !== null && initial > 0 && initial <= maximum)) reasons.push("autopilot_plafond_initial_invalide");
  if (!automaticScaleUp && cap !== initial) reasons.push("autopilot_scale_up_non_autorise");
  return {
    required: true,
    allowed: reasons.length === 0,
    reasons,
    candidateId: candidate,
    canaryEquityPct: cap,
    initialCanaryEquityPct: initial,
    maximumCanaryEquityPct: maximum,
  };
}

const LIVE_EVIDENCE_SIGNATURE_DOMAIN = "hermes/live-evidence/v1";
const MONITORING_SIGNATURE_DOMAIN = "hermes/okx-account-monitoring/v1";

function unsignedCanonicalPayload(artifact) {
  if (!artifact || typeof artifact !== "object") return "";
  const unsigned = { ...artifact };
  delete unsigned.signature;
  return stableStringify(unsigned);
}

function domainSeparatedSigningPayload(domain, artifact) {
  return `${domain}\0${unsignedCanonicalPayload(artifact)}`;
}

function evidenceSigningPayload(evidence) {
  return domainSeparatedSigningPayload(LIVE_EVIDENCE_SIGNATURE_DOMAIN, evidence);
}

function monitoringSigningPayload(monitoring) {
  return domainSeparatedSigningPayload(MONITORING_SIGNATURE_DOMAIN, monitoring);
}

function publicKeySpkiSha256(publicKey) {
  try {
    if (!publicKey) return null;
    const key = publicKey?.type === "public" ? publicKey : crypto.createPublicKey(publicKey);
    if (key.asymmetricKeyType !== "ed25519") return null;
    const spki = key.export({ type: "spki", format: "der" });
    return crypto.createHash("sha256").update(spki).digest("hex");
  } catch { return null; }
}

function verifyDomainSeparatedSignature(artifact, publicKey, payloadBuilder) {
  try {
    if (!artifact?.signature || !publicKey) return false;
    const key = publicKey?.type === "public" ? publicKey : crypto.createPublicKey(publicKey);
    if (key.asymmetricKeyType !== "ed25519") return false;
    return crypto.verify(
      null,
      Buffer.from(payloadBuilder(artifact), "utf8"),
      key,
      Buffer.from(String(artifact.signature), "base64")
    );
  } catch { return false; }
}

function verifyEvidenceSignature(evidence, publicKey) {
  return verifyDomainSeparatedSignature(evidence, publicKey, evidenceSigningPayload);
}

function verifyMonitoringSignature(monitoring, publicKey) {
  return verifyDomainSeparatedSignature(monitoring, publicKey, monitoringSigningPayload);
}

const MONITORING_HIGH_WATER_SCHEMA_VERSION = 1;

function emptyMonitoringHighWater() {
  return { schemaVersion: MONITORING_HIGH_WATER_SCHEMA_VERSION, entries: {} };
}

/* Decision pure: aucun acces disque et aucune horloge implicite. La sequence
   est globale par autorite de reconciliation (cle SPKI + source), et surtout
   pas par candidat/roster : changer puis restaurer un roster ne doit jamais
   remettre le compteur a zero. Un snapshot identique est idempotent; toute
   regression ou reuse de sequence avec d'autres octets est refusee.
   `replayEligible` ne depend pas de la sante du compte : un constat signe de
   breach/kill-switch doit lui aussi faire avancer la marque, sinon un ancien
   constat sain pourrait etre rejoue. */
function evaluateMonitoringReplay({ monitoringGate, highWater } = {}) {
  const required = monitoringGate?.required === true;
  const candidateId = String(monitoringGate?.candidateId || "").toLowerCase();
  const rosterHash = String(monitoringGate?.rosterSha256 || "").toLowerCase();
  const signerSpkiSha256 = String(monitoringGate?.signerSpkiSha256 || "").toLowerCase();
  const source = String(monitoringGate?.source || "");
  const sequence = Number.isSafeInteger(monitoringGate?.sequence) ? monitoringGate.sequence : null;
  const monitoringHash = String(monitoringGate?.monitoringSha256 || "").toLowerCase();
  const identityKey = /^[a-f0-9]{64}$/.test(signerSpkiSha256)
      && source === "okx-account-reconciliation-v1"
    ? `${signerSpkiSha256}:${source}` : null;
  const base = {
    required,
    candidateId: candidateId || null,
    rosterSha256: rosterHash || null,
    signerSpkiSha256: signerSpkiSha256 || null,
    source: source || null,
    sequence,
    monitoringSha256: /^[a-f0-9]{64}$/.test(monitoringHash) ? monitoringHash : null,
    identityKey,
  };
  if (!required) {
    return { ...base, allowed: true, reasons: [], shouldAdvance: false, nextHighWater: highWater || null };
  }

  const reasons = [];
  const supplied = highWater == null ? emptyMonitoringHighWater() : highWater;
  const entries = supplied?.entries;
  if (supplied?.schemaVersion !== MONITORING_HIGH_WATER_SCHEMA_VERSION
      || !entries || typeof entries !== "object" || Array.isArray(entries)) {
    reasons.push("monitoring_high_water_invalide");
  }
  const normalizedEntries = {};
  if (reasons.length === 0) {
    for (const [key, value] of Object.entries(entries)) {
      const storedSigner = String(value?.signerSpkiSha256 || "").toLowerCase();
      const storedSource = String(value?.source || "");
      const storedCandidate = String(value?.candidateId || "").toLowerCase();
      const storedRoster = String(value?.rosterSha256 || "").toLowerCase();
      const storedHash = String(value?.monitoringSha256 || "").toLowerCase();
      const expectedKey = `${storedSigner}:${storedSource}`;
      if (key !== expectedKey
          || !/^[a-f0-9]{64}$/.test(storedSigner)
          || storedSource !== "okx-account-reconciliation-v1"
          || !/^[a-f0-9]{64}$/.test(storedCandidate)
          || !/^[a-f0-9]{64}$/.test(storedRoster)
          || !Number.isSafeInteger(value?.sequence) || value.sequence < 0
          || !/^[a-f0-9]{64}$/.test(storedHash)) {
        reasons.push("monitoring_high_water_entree_invalide");
        break;
      }
      normalizedEntries[key] = {
        signerSpkiSha256: storedSigner,
        source: storedSource,
        candidateId: storedCandidate,
        rosterSha256: storedRoster,
        sequence: value.sequence,
        monitoringSha256: storedHash,
      };
    }
  }
  if (!identityKey || sequence === null || sequence < 0
      || !base.monitoringSha256 || monitoringGate?.replayEligible !== true) {
    reasons.push("monitoring_snapshot_non_authentifie_pour_rejeu");
  }
  if (reasons.length > 0) {
    return {
      ...base, allowed: false, reasons: [...new Set(reasons)], shouldAdvance: false,
      nextHighWater: null,
    };
  }

  const previous = normalizedEntries[identityKey] || null;
  if (previous && sequence < previous.sequence) reasons.push("monitoring_sequence_regressive");
  if (previous && sequence === previous.sequence
      && (base.monitoringSha256 !== previous.monitoringSha256
        || candidateId !== previous.candidateId
        || rosterHash !== previous.rosterSha256)) reasons.push("monitoring_sequence_collision");
  if (reasons.length > 0) {
    return { ...base, allowed: false, reasons, shouldAdvance: false, nextHighWater: null };
  }
  const shouldAdvance = !previous || sequence > previous.sequence;
  const nextHighWater = {
    schemaVersion: MONITORING_HIGH_WATER_SCHEMA_VERSION,
    entries: { ...normalizedEntries },
  };
  if (shouldAdvance) {
    nextHighWater.entries[identityKey] = {
      signerSpkiSha256,
      source,
      candidateId,
      rosterSha256: rosterHash,
      sequence,
      monitoringSha256: base.monitoringSha256,
    };
  }
  return { ...base, allowed: true, reasons: [], shouldAdvance, nextHighWater };
}

function evaluateSignedMonitoring({ monitoring, roster, autopilotPolicy, publicKey, nowMs,
  policyPublicKeySpkiSha256, expectedPublicKeySpkiSha256,
  evidencePublicKeySpkiSha256 } = {}) {
  const hasLiveEntries = roster?.perles && typeof roster.perles === "object"
    && !Array.isArray(roster.perles) && Object.keys(roster.perles).length > 0;
  if (!hasLiveEntries) return { required: false, allowed: true, reasons: [] };
  const candidateId = String(roster?.strategyCandidateId || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(candidateId)) {
    return { required: true, allowed: false, reasons: ["monitoring_candidate_roster_invalide"] };
  }
  const reasons = [];
  const now = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();
  const configuredTtl = asFinite(autopilotPolicy?.demotion?.maximumMonitoringStalenessMinutes);
  const ttlMinutes = configuredTtl !== null && configuredTtl > 0 ? Math.min(5, configuredTtl) : 5;
  let signatureVerified = false;
  let identityVerified = false;
  let monitoringSha256 = null;
  const signerSpkiSha256 = publicKeySpkiSha256(publicKey);
  const source = typeof monitoring?.source === "string" ? monitoring.source : null;
  const fingerprintPattern = /^[a-f0-9]{64}$/i;
  const policyAnchor = String(policyPublicKeySpkiSha256 || "").toLowerCase();
  const externalAnchor = String(expectedPublicKeySpkiSha256 || "").toLowerCase();
  const evidenceAnchor = String(evidencePublicKeySpkiSha256 || "").toLowerCase();
  const actualAnchor = String(signerSpkiSha256 || "").toLowerCase();
  if (!fingerprintPattern.test(policyAnchor)) reasons.push("monitoring_ancre_politique_absente");
  if (!fingerprintPattern.test(externalAnchor)) reasons.push("monitoring_ancre_deploiement_absente");
  if (!fingerprintPattern.test(actualAnchor)) reasons.push("monitoring_cle_publique_ed25519_invalide");
  if (fingerprintPattern.test(policyAnchor) && fingerprintPattern.test(externalAnchor)
      && policyAnchor !== externalAnchor) reasons.push("monitoring_ancre_politique_differente");
  if (fingerprintPattern.test(actualAnchor) && fingerprintPattern.test(externalAnchor)
      && actualAnchor !== externalAnchor) reasons.push("monitoring_cle_publique_deploiement_differente");
  if (fingerprintPattern.test(actualAnchor) && fingerprintPattern.test(evidenceAnchor)
      && actualAnchor === evidenceAnchor) reasons.push("monitoring_cle_non_distincte");
  const anchorVerified = fingerprintPattern.test(policyAnchor)
    && fingerprintPattern.test(externalAnchor)
    && fingerprintPattern.test(actualAnchor)
    && policyAnchor === externalAnchor
    && actualAnchor === externalAnchor
    && (!fingerprintPattern.test(evidenceAnchor) || actualAnchor !== evidenceAnchor);
  if (!monitoring || typeof monitoring !== "object" || Array.isArray(monitoring)) {
    reasons.push("monitoring_autoritatif_absent");
  } else {
    /* L'identite anti-rejeu porte sur le payload signe, sans l'encodage de la
       signature. Cela evite de traiter deux representations cryptographiques
       d'un meme message comme deux observations differentes. */
    monitoringSha256 = sha256(monitoringSigningPayload(monitoring));
    signatureVerified = verifyMonitoringSignature(monitoring, publicKey);
    const observedAt = Date.parse(String(monitoring.generatedAt || ""));
    const schemaValid = Number(monitoring.schemaVersion) === 1;
    const sourceValid = String(monitoring.source || "") === "okx-account-reconciliation-v1";
    const sequenceValid = Number.isSafeInteger(monitoring.sequence) && monitoring.sequence >= 0;
    const candidateValid = String(monitoring.candidateId || "").toLowerCase() === candidateId;
    const rosterValid = String(monitoring.rosterSha256 || "").toLowerCase() === rosterSha256(roster);
    if (!schemaValid) reasons.push("monitoring_schema_invalide");
    if (!sourceValid) reasons.push("monitoring_source_invalide");
    if (!sequenceValid) reasons.push("monitoring_sequence_invalide");
    if (!candidateValid) reasons.push("monitoring_mauvais_candidat");
    if (!rosterValid) reasons.push("monitoring_mauvais_roster");
    identityVerified = schemaValid && sourceValid && sequenceValid && candidateValid && rosterValid;
    if (!Number.isFinite(observedAt) || observedAt > now + 30_000
        || now - observedAt > ttlMinutes * 60_000) reasons.push("monitoring_perime_ou_futur");
    if (!signatureVerified) reasons.push("monitoring_signature_invalide");
    if (monitoring.riskBreach !== false) reasons.push(
      monitoring.riskBreach === true ? "monitoring_risque_explicite" : "monitoring_riskBreach_absent"
    );
    if (monitoring.killSwitch !== false) reasons.push(
      monitoring.killSwitch === true ? "monitoring_kill_switch" : "monitoring_killSwitch_absent"
    );
    if (monitoring.venueHealthy !== true) reasons.push("monitoring_venue_non_saine");
    const trades = asFinite(monitoring.trades);
    if (trades === null || trades < 0) reasons.push("monitoring_trades_invalides");
    const minimumTrades = asFinite(autopilotPolicy?.demotion?.minimumTrades) ?? 30;
    if (trades !== null && trades >= minimumTrades) {
      const checks = [
        ["netLower95", asFinite(autopilotPolicy?.demotion?.quarantineIfNetLower95AtMost) ?? 0,
          (value, threshold) => value <= threshold, "monitoring_borne_nette_degradee"],
        ["profitFactor", asFinite(autopilotPolicy?.demotion?.quarantineIfProfitFactorBelow) ?? 1,
          (value, threshold) => value < threshold, "monitoring_profit_factor_degrade"],
        ["costRatio", asFinite(autopilotPolicy?.demotion?.quarantineIfCostRatioAbove) ?? 0.8,
          (value, threshold) => value > threshold, "monitoring_ratio_couts_degrade"],
        ["trackingErrorBps", asFinite(autopilotPolicy?.demotion?.quarantineIfTrackingErrorBpsAbove) ?? 25,
          (value, threshold) => value > threshold, "monitoring_tracking_error_degrade"],
      ];
      for (const [name, threshold, failed, reason] of checks) {
        const value = asFinite(monitoring[name]);
        if (value === null) reasons.push(`monitoring_${name}_absent`);
        else if (failed(value, threshold)) reasons.push(reason);
      }
    }
  }
  return {
    required: true,
    allowed: reasons.length === 0,
    reasons,
    ttlMinutes,
    signatureVerified,
    identityVerified,
    anchorVerified,
    replayEligible: signatureVerified && identityVerified && anchorVerified,
    monitoringSha256,
    signerSpkiSha256,
    source,
    sequence: Number.isSafeInteger(monitoring?.sequence) ? monitoring.sequence : null,
    candidateId,
    rosterSha256: rosterSha256(roster),
  };
}

function evaluateLiveGate({ roster, evidence, policy, nowMs, expectedEngineSha256, evidenceSignatureVerified,
  evidencePublicKeySpkiSha256, expectedPublicKeySpkiSha256, policyValidationReasons = [] }) {
  const normalized = normaliseLiveGatePolicy(policy);
  const cfg = normalized.policy;
  const now = Number(nowMs || Date.now());
  const reasons = [...normalized.reasons, ...(policyValidationReasons || [])];
  const perles = roster?.perles;
  const generatedMs = Date.parse(roster?.genere || "");
  const rosterHash = rosterSha256(roster);

  const fingerprintPattern = /^[a-f0-9]{64}$/i;
  const policyAnchor = String(cfg.evidencePublicKeySpkiSha256 || "").toLowerCase();
  const externalAnchor = String(expectedPublicKeySpkiSha256 || "").toLowerCase();
  const actualAnchor = String(evidencePublicKeySpkiSha256 || "").toLowerCase();
  if (!fingerprintPattern.test(policyAnchor)) reasons.push("ancre_confiance_politique_absente");
  if (!fingerprintPattern.test(externalAnchor)) reasons.push("ancre_confiance_deploiement_absente");
  if (!fingerprintPattern.test(actualAnchor)) reasons.push("cle_publique_ed25519_invalide");
  if (fingerprintPattern.test(policyAnchor) && fingerprintPattern.test(externalAnchor)
      && policyAnchor !== externalAnchor) reasons.push("ancre_confiance_politique_differente");
  if (fingerprintPattern.test(actualAnchor) && fingerprintPattern.test(externalAnchor)
      && actualAnchor !== externalAnchor) reasons.push("cle_publique_deploiement_differente");

  if (!roster || typeof roster !== "object") reasons.push("roster_absent");
  else {
    if (Number(roster.schemaVersion) !== 1) reasons.push("roster_schema");
    if (typeof roster.selectionRunId !== "string" || !roster.selectionRunId.trim()) reasons.push("roster_run_absent");
    if (!/^[a-f0-9]{64}$/i.test(String(roster.dataManifestSha256 || ""))) reasons.push("roster_manifest_invalide");
    if (!/^[a-f0-9]{64}$/i.test(String(roster.quantEvidenceSha256 || ""))) reasons.push("roster_preuve_quantitative_invalide");
    if (!/^[a-f0-9]{64}$/i.test(String(roster.strategyCandidateId || ""))) reasons.push("roster_candidat_autopilot_invalide");
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
    if (!/^[a-f0-9]{64}$/i.test(String(evidence.quantEvidenceSha256 || ""))) {
      reasons.push("preuve_quantitative_invalide");
    } else if (String(evidence.quantEvidenceSha256).toLowerCase()
        !== String(roster?.quantEvidenceSha256 || "").toLowerCase()) {
      reasons.push("preuve_quantitative_differente");
    }
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
      [between(metrics.pbo, 0, 1), "pbo_invalide"],
      [atMost(metrics.pbo, cfg.maxPbo), "pbo_trop_eleve"],
      [between(metrics.deflatedSharpeProbability, 0, 1), "dsr_invalide"],
      [atLeast(metrics.deflatedSharpeProbability, cfg.minDeflatedSharpeProbability), "dsr_insuffisant"],
      [between(metrics.spaPValue, 0, 1), "spa_p_value_invalide"],
      [atMost(metrics.spaPValue, cfg.maxSpaPValue), "spa_non_significatif"],
      [between(metrics.whiteRealityCheckPValue, 0, 1), "white_p_value_invalide"],
      [atMost(metrics.whiteRealityCheckPValue, cfg.maxWhiteRealityCheckPValue), "white_reality_check_non_significatif"],
      [atLeast(metrics.nullReplications, cfg.minNullReplications), "replications_null_insuffisantes"],
      [between(metrics.profitableFoldRate, 0, 1), "taux_folds_invalide"],
      [atLeast(metrics.profitableFoldRate, cfg.minProfitableFoldRate), "folds_profitables_insuffisants"],
      [between(metrics.maxProfitConcentration, 0, 1), "concentration_invalide"],
      [atMost(metrics.maxProfitConcentration, cfg.maxProfitConcentration), "profit_trop_concentre"],
      [atLeast(metrics.effectiveDays, cfg.minEffectiveDays), "jours_effectifs_insuffisants"],
      [atLeast(metrics.independentBaskets, cfg.minIndependentBaskets), "baskets_independantes_insuffisantes"],
      [between(metrics.calendarYearProfitConcentration, 0, 1), "concentration_annee_invalide"],
      [atMost(metrics.calendarYearProfitConcentration, cfg.maxCalendarYearProfitConcentration), "profit_annee_trop_concentre"],
      [between(metrics.instrumentProfitConcentration, 0, 1), "concentration_instrument_invalide"],
      [atMost(metrics.instrumentProfitConcentration, cfg.maxInstrumentProfitConcentration), "profit_instrument_trop_concentre"],
      [between(metrics.topFiveProfitConcentration, 0, 1), "concentration_top5_invalide"],
      [atMost(metrics.topFiveProfitConcentration, cfg.maxTopFiveProfitConcentration), "profit_top5_trop_concentre"],
      [between(metrics.maxDrawdownPct, 0, 1), "drawdown_invalide"],
      [atMost(metrics.maxDrawdownPct, cfg.maxDrawdownPct), "drawdown_trop_eleve"],
      [atLeast(metrics.profitFactor, cfg.minProfitFactor), "profit_factor_insuffisant"],
      [atLeast(metrics.shadowLiveDays, cfg.minShadowDays), "shadow_jours_insuffisants"],
      [atLeast(metrics.shadowLiveTrades, cfg.minShadowTrades), "shadow_trades_insuffisants"],
      [positive(metrics.shadowLiveNet), "shadow_net_non_positif"],
    ];
    for (const [ok, reason] of tests) if (!ok) reasons.push(reason);
    if (!hasExactHorizonSet(metrics.validatedHorizonsDays)) reasons.push("horizons_1_2_3_ans_incomplets");
    if (Number(metrics.primaryHorizonDays) !== 1095) reasons.push("horizon_primaire_non_3_ans");
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
  const autopilotPolicyFile = options.autopilotPolicyFile
    || path.join(root, "config", "autopilot.policy.json");
  const autopilotStateFile = options.autopilotStateFile
    || path.join(root, "data", "autopilot", "state.json");
  const monitoringFile = options.monitoringFile
    || path.join(root, "data", "autopilot", "monitoring.json");
  let policy = null;
  const policyValidationReasons = [];
  let roster = null;
  let evidence = null;
  let autopilotPolicy = null;
  let autopilotState = null;
  let monitoring = null;
  const initialFileHashes = new Map();
  const readSnapshot = (file) => {
    try {
      const raw = fs.readFileSync(file);
      initialFileHashes.set(file, crypto.createHash("sha256").update(raw).digest("hex"));
      return JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
    } catch {
      initialFileHashes.set(file, null);
      return null;
    }
  };
  policy = readSnapshot(policyFile);
  if (!policy) policyValidationReasons.push("politique_live_absente_ou_illisible");
  roster = readSnapshot(rosterFile);
  evidence = readSnapshot(evidenceFile);
  autopilotPolicy = readSnapshot(autopilotPolicyFile);
  autopilotState = readSnapshot(autopilotStateFile);
  monitoring = readSnapshot(monitoringFile);
  let publicKey = options.evidencePublicKey || null;
  let publicKeyFile = null;
  if (!publicKey) {
    publicKeyFile = options.publicKeyFile || process.env.HERMES_EVIDENCE_PUBLIC_KEY_FILE
      || path.join(root, "config", "evidence-public-key.pem");
    try {
      const raw = fs.readFileSync(publicKeyFile);
      initialFileHashes.set(publicKeyFile, crypto.createHash("sha256").update(raw).digest("hex"));
      publicKey = raw.toString("utf8");
    } catch { initialFileHashes.set(publicKeyFile, null); }
  }
  const actualPublicKeySpkiSha256 = publicKeySpkiSha256(publicKey);
  const expectedPublicKeySpkiSha256 = options.expectedPublicKeySpkiSha256
    || process.env.HERMES_EVIDENCE_PUBLIC_KEY_SPKI_SHA256 || null;
  let monitoringPublicKey = options.monitoringPublicKey || null;
  let monitoringPublicKeyFile = null;
  if (!monitoringPublicKey) {
    monitoringPublicKeyFile = options.monitoringPublicKeyFile
      || process.env.HERMES_MONITORING_PUBLIC_KEY_FILE
      || path.join(root, "config", "monitoring-public-key.pem");
    try {
      const raw = fs.readFileSync(monitoringPublicKeyFile);
      initialFileHashes.set(monitoringPublicKeyFile, crypto.createHash("sha256").update(raw).digest("hex"));
      monitoringPublicKey = raw.toString("utf8");
    } catch { initialFileHashes.set(monitoringPublicKeyFile, null); }
  }
  const expectedMonitoringPublicKeySpkiSha256 = options.expectedMonitoringPublicKeySpkiSha256
    || process.env.HERMES_MONITORING_PUBLIC_KEY_SPKI_SHA256 || null;
  const normalized = normaliseLiveGatePolicy(policy);
  let engineHash = null;
  try { engineHash = engineSha256(root, normalized.policy.engineFiles); } catch {
    policyValidationReasons.push("hash_moteur_impossible");
  }
  /* Une promotion/quarantaine repose sur plusieurs renames atomiques, mais la
     lecture de l'ensemble ne l'est pas. Relire les octets critiques apres le
     hash moteur interdit de combiner le roster A, la preuve B et la policy C
     au sein d'une meme decision. */
  for (const [file, initialHash] of initialFileHashes.entries()) {
    let currentHash = null;
    try {
      currentHash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    } catch {}
    if (currentHash !== initialHash) policyValidationReasons.push("snapshot_gate_concurrent");
  }
  const result = evaluateLiveGate({
    roster, evidence, policy, nowMs: options.nowMs, expectedEngineSha256: engineHash,
    evidenceSignatureVerified: verifyEvidenceSignature(evidence, publicKey),
    evidencePublicKeySpkiSha256: actualPublicKeySpkiSha256,
    expectedPublicKeySpkiSha256,
    policyValidationReasons,
  });
  const monitoringGate = evaluateSignedMonitoring({
    monitoring,
    roster,
    autopilotPolicy,
    publicKey: monitoringPublicKey,
    nowMs: options.nowMs,
    policyPublicKeySpkiSha256: normalized.policy.monitoringPublicKeySpkiSha256,
    expectedPublicKeySpkiSha256: expectedMonitoringPublicKeySpkiSha256,
    evidencePublicKeySpkiSha256: actualPublicKeySpkiSha256,
  });
  const reasons = [...new Set([...result.reasons, ...monitoringGate.reasons])];
  return {
    ...result,
    allowed: reasons.length === 0,
    reasons,
    monitoringGate,
    snapshots: { roster, autopilotPolicy, autopilotState, monitoring },
  };
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
  evaluateEntryMarginBudget,
  validateRiskConfig,
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
  hermesAlgoOwnerNamespace,
  newHermesClientId,
  isHermesOwnedAlgo,
  isProtectiveStopAlgo,
  rosterSha256,
  engineSha256,
  evaluateLiveGate,
  evaluateAutopilotCanaryAuthority,
  readLiveGate,
};
