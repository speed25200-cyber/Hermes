"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  engineSha256,
  evaluateLiveGate,
  normaliseLiveGatePolicy,
  publicKeySpkiSha256,
  rosterSha256,
  stableStringify,
  verifyEvidenceSignature,
} = require("./live_safety.js");

const STAGES = Object.freeze({
  DISCOVERY: "discovery",
  VALIDATION: "validation",
  SHADOW: "shadow",
  ELIGIBLE: "eligible",
  CANARY: "canary",
  QUARANTINED: "quarantined",
});

const DEFAULT_THRESHOLDS = Object.freeze({
  horizonsDays: [365, 730, 1095],
  primaryHorizonDays: 1095,
  minimumCoverageRatio: 0.99,
  minimumFolds: 10,
  minOosTrades: 1500,
  minOosDays: 1095,
  minNullReplications: 9999,
  maxFamilywisePValue: 0.01,
  maxPbo: 0.10,
  minDeflatedSharpeProbability: 0.95,
  minProfitableFoldRate: 0.70,
  maxProfitConcentration: 0.25,
  maxDrawdownPct: 0.10,
  minProfitFactor: 1.10,
  maxCalendarYearProfitConcentration: 0.60,
  maxInstrumentProfitConcentration: 0.10,
  maxTopFiveProfitConcentration: 0.50,
  minimumIndependentBaskets: 100,
  minimumEffectiveDays: 250,
});

function finite(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function atLeast(value, threshold) {
  const number = finite(value);
  return number !== null && number >= Number(threshold);
}

function atMost(value, threshold) {
  const number = finite(value);
  return number !== null && number <= Number(threshold);
}

function positive(value) {
  const number = finite(value);
  return number !== null && number > 0;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

/* L'identite d'un candidat doit suivre ce qui sera effectivement execute,
   jamais la photo de marche ni les statistiques obtenues lors d'une passe.
   Sinon une simple mise a jour du Top 30 ou du nombre de trades fabrique un
   nouveau candidat et detruit la continuite validation -> shadow. */
function executablePerles(perles) {
  if (perles == null) return null;
  if (!perles || typeof perles !== "object" || Array.isArray(perles)) {
    throw new Error("perles candidates invalides");
  }
  const executable = {};
  for (const instId of Object.keys(perles).sort()) {
    const strategy = perles[instId];
    if (!strategy || typeof strategy !== "object" || Array.isArray(strategy)) {
      throw new Error(`strategie executable invalide: ${instId}`);
    }
    executable[instId] = {
      sig: typeof strategy.sig === "string" ? strategy.sig : "",
      ov: strategy.ov && typeof strategy.ov === "object" && !Array.isArray(strategy.ov)
        ? strategy.ov : null,
    };
  }
  return executable;
}

function executableStrategyIdentity(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("candidate invalide");
  }
  const identity = {
    schemaVersion: Number(candidate.schemaVersion || 1),
    family: String(candidate.family || ""),
    executionType: String(candidate.executionType || ""),
  };
  if (identity.executionType === "directional-signal") {
    const volatileUniverseKeys = new Set([
      "snapshotSha256", "generatedAt", "asOf", "asOfMs", "capturedAt",
      "validUntilMs", "selected", "excluded",
    ]);
    identity.params = candidate.params || {};
    identity.universe = Object.fromEntries(Object.entries(candidate.universe || {})
      .filter(([key]) => !volatileUniverseKeys.has(key)));
    identity.perles = executablePerles(candidate.perles);
  } else {
    /* Pour les familles non compilees en roster directionnel, params/universe
       restent le contrat executable. Les resultats, cutoffs et provenances ne
       participent toujours pas a l'identite. */
    identity.params = candidate.params || {};
    identity.universe = candidate.universe || {};
  }
  return identity;
}

function candidateId(candidate) {
  return sha256(stableStringify(executableStrategyIdentity(candidate)));
}

function hasValidationEvidence(candidate) {
  return Array.isArray(candidate?.horizonReports) && candidate.horizonReports.length > 0;
}

/* Fusion non destructive du catalogue produit par le seeker. Une hypothese
   fraiche remplace seulement une autre hypothese de discovery. Des qu'une
   identite executable exacte porte des rapports longs, elle devient immuable
   pour le seeker; les autres candidats valides restent eux aussi disponibles
   au cycle champion/challenger. */
function mergeCandidateCatalog(previousArtifact, discoveredCandidates, context = {}) {
  const previous = previousArtifact == null
    ? { schemaVersion: 1, candidates: [] }
    : previousArtifact;
  if (!previous || typeof previous !== "object" || Array.isArray(previous)
      || Number(previous.schemaVersion ?? 1) !== 1
      || !Array.isArray(previous.candidates)) {
    throw new Error("catalogue candidats precedent invalide");
  }
  if (!Array.isArray(discoveredCandidates)) throw new Error("candidats discovery invalides");

  const retained = new Map();
  for (const candidate of previous.candidates) {
    const id = candidateId(candidate);
    if (retained.has(id)) throw new Error(`candidat precedent duplique: ${id}`);
    if (hasValidationEvidence(candidate)) retained.set(id, candidate);
  }
  const fresh = new Map();
  for (const candidate of discoveredCandidates) {
    const id = candidateId(candidate);
    if (fresh.has(id)) throw new Error(`candidat discovery duplique: ${id}`);
    fresh.set(id, retained.get(id) || candidate);
  }
  for (const [id, candidate] of retained) if (!fresh.has(id)) fresh.set(id, candidate);

  return {
    schemaVersion: 1,
    runId: String(context.runId || ""),
    generatedAt: context.generatedAt || new Date().toISOString(),
    incumbentCandidateId: previous.incumbentCandidateId || null,
    candidates: [...fresh.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, candidate]) => candidate),
  };
}

function candidateQuantEvidenceSha256(candidate) {
  const hashes = new Set((Array.isArray(candidate?.horizonReports) ? candidate.horizonReports : [])
    .map((report) => String(report?.quantEvidenceSha256 || "").toLowerCase()));
  if (hashes.size !== 1) return null;
  const [hash] = hashes;
  return /^[a-f0-9]{64}$/.test(hash) ? hash : null;
}

function candidateQuantPolicySha256(candidate) {
  const hashes = new Set((Array.isArray(candidate?.horizonReports) ? candidate.horizonReports : [])
    .map((report) => String(report?.quantPolicySha256 || "").toLowerCase()));
  if (hashes.size !== 1) return null;
  const [hash] = hashes;
  if (!/^[a-f0-9]{64}$/.test(hash)) return null;
  const declared = candidate?.quantPolicySha256 == null
    ? hash : String(candidate.quantPolicySha256).toLowerCase();
  return declared === hash ? hash : null;
}

function assessOneHorizon(report, cfg, isPrimary) {
  const reasons = [];
  const horizon = finite(report?.horizonDays);
  if (!horizon) reasons.push("horizon_absent");
  if (!report?.cutoff || !Number.isFinite(Date.parse(report.cutoff))) reasons.push("cutoff_invalide");
  if (!atLeast(report?.coverageRatio, cfg.minimumCoverageRatio)) reasons.push("couverture_insuffisante");
  if (report?.pointInTimeUniverse !== true) reasons.push("univers_non_point_in_time");
  if (report?.includesDelistedInstruments !== true) reasons.push("delistes_absents");
  if (report?.portfolioSynchronized !== true) reasons.push("portefeuille_non_synchronise");
  if (report?.confirmedDataOnly !== true) reasons.push("donnees_non_confirmees");
  if (report?.completeCostModel !== true) reasons.push("couts_incomplets");
  if (!atLeast(report?.folds, cfg.minimumFolds)) reasons.push("folds_insuffisants");
  if (!positive(report?.netMeanPerTrade)) reasons.push("esperance_nette_non_positive");
  if (!positive(report?.netMeanLower95)) reasons.push("borne_nette_95_non_positive");
  if (!positive(report?.costStressLower95)) reasons.push("stress_couts_non_positif");
  if (!atLeast(report?.profitableFoldRate, cfg.minProfitableFoldRate)) reasons.push("folds_profitables_insuffisants");
  if (!atMost(report?.maxDrawdownPct, cfg.maxDrawdownPct)) reasons.push("drawdown_trop_eleve");
  if (!atLeast(report?.profitFactor, cfg.minProfitFactor)) reasons.push("profit_factor_insuffisant");

  if (isPrimary) {
    if (!atLeast(report?.oosTrades, cfg.minOosTrades)) reasons.push("oos_trades_insuffisants");
    if (!atLeast(report?.oosDays, cfg.minOosDays)) reasons.push("oos_jours_insuffisants");
    if (!positive(report?.netMeanLower99)) reasons.push("borne_nette_99_non_positive");
    if (!atLeast(report?.nullReplications, cfg.minNullReplications)) reasons.push("null_insuffisant");
    if (!atMost(report?.familywisePValue, cfg.maxFamilywisePValue)) reasons.push("famille_non_significative");
    if (!atMost(report?.pbo, cfg.maxPbo)) reasons.push("pbo_trop_eleve");
    if (!atLeast(report?.deflatedSharpeProbability, cfg.minDeflatedSharpeProbability)) reasons.push("dsr_insuffisant");
    if (!atMost(report?.maxProfitConcentration, cfg.maxProfitConcentration)) reasons.push("profit_trop_concentre");
    if (!atMost(report?.calendarYearProfitConcentration, cfg.maxCalendarYearProfitConcentration)) reasons.push("annee_trop_concentree");
    if (!atMost(report?.instrumentProfitConcentration, cfg.maxInstrumentProfitConcentration)) reasons.push("instrument_trop_concentre");
    if (!atMost(report?.topFiveProfitConcentration, cfg.maxTopFiveProfitConcentration)) reasons.push("top5_trop_concentre");
    if (!atLeast(report?.independentBaskets, cfg.minimumIndependentBaskets)) reasons.push("baskets_independantes_insuffisantes");
    if (!atLeast(report?.effectiveDays, cfg.minimumEffectiveDays)) reasons.push("jours_effectifs_insuffisants");
  }

  return { allowed: reasons.length === 0, reasons, horizonDays: horizon };
}

function assessHorizonBundle(reports, options = {}) {
  const cfg = { ...DEFAULT_THRESHOLDS, ...(options || {}) };
  const required = [...cfg.horizonsDays].map(Number).sort((a, b) => a - b);
  const rows = Array.isArray(reports) ? reports : [];
  const reasons = [];
  const seen = new Map();

  for (const report of rows) {
    const horizon = finite(report?.horizonDays);
    if (!horizon || seen.has(horizon)) {
      reasons.push(horizon ? `horizon_duplique_${horizon}` : "horizon_invalide");
      continue;
    }
    seen.set(horizon, report);
  }

  const cutoffs = new Set();
  const assessments = [];
  for (const horizon of required) {
    const report = seen.get(horizon);
    if (!report) {
      reasons.push(`horizon_absent_${horizon}`);
      continue;
    }
    if (report.cutoff) cutoffs.add(String(report.cutoff));
    const assessment = assessOneHorizon(report, cfg, horizon === Number(cfg.primaryHorizonDays));
    assessments.push(assessment);
    for (const reason of assessment.reasons) reasons.push(`${horizon}j_${reason}`);
  }
  if (cutoffs.size !== 1) reasons.push("cutoffs_non_identiques");
  const quantEvidenceHashes = new Set(rows.map((report) =>
    String(report?.quantEvidenceSha256 || "").toLowerCase()));
  if (quantEvidenceHashes.size !== 1 || !/^[a-f0-9]{64}$/.test([...quantEvidenceHashes][0] || "")) {
    reasons.push("preuve_quantitative_absente_ou_multiple");
  }
  const quantPolicyHashes = new Set(rows.map((report) =>
    String(report?.quantPolicySha256 || "").toLowerCase()));
  const quantPolicySha256 = quantPolicyHashes.size === 1 ? [...quantPolicyHashes][0] : null;
  if (!quantPolicySha256 || !/^[a-f0-9]{64}$/.test(quantPolicySha256)) {
    reasons.push("politique_quantitative_absente_ou_multiple");
  }
  const reportCandidateIds = new Set(rows.map((report) =>
    String(report?.candidateId || "").toLowerCase()));
  const reportCandidateId = reportCandidateIds.size === 1 ? [...reportCandidateIds][0] : null;
  if (!reportCandidateId || !/^[a-f0-9]{64}$/.test(reportCandidateId)) {
    reasons.push("candidate_id_quantitatif_absent_ou_multiple");
  }
  const expectedCandidateId = String(options.expectedCandidateId || "").toLowerCase();
  if (expectedCandidateId && reportCandidateId !== expectedCandidateId) {
    reasons.push("candidate_id_quantitatif_different");
  }
  const expectedQuantPolicySha256 = String(options.expectedQuantPolicySha256 || "").toLowerCase();
  if (expectedQuantPolicySha256 && quantPolicySha256 !== expectedQuantPolicySha256) {
    reasons.push("politique_quantitative_differente");
  }
  for (const horizon of seen.keys()) if (!required.includes(horizon)) reasons.push(`horizon_non_preinscrit_${horizon}`);

  const primary = seen.get(Number(cfg.primaryHorizonDays)) || null;
  return {
    allowed: reasons.length === 0,
    reasons: [...new Set(reasons)],
    cutoff: cutoffs.size === 1 ? [...cutoffs][0] : null,
    primaryHorizonDays: Number(cfg.primaryHorizonDays),
    assessments,
    primary,
    candidateId: reportCandidateId,
    quantPolicySha256,
  };
}

function candidateScore(candidate, evaluation) {
  const primary = evaluation?.primary || {};
  const lower = finite(primary.netMeanLower99);
  const expectedShortfall = finite(primary.expectedShortfall95);
  const turnoverCost = finite(primary.costPerTrade);
  const concentration = finite(primary.maxProfitConcentration);
  if (lower === null || !(expectedShortfall > 0) || turnoverCost === null || turnoverCost < 0
      || concentration === null || concentration < 0) return -Infinity;
  const riskAdjusted = lower / expectedShortfall;
  const penalty = turnoverCost + concentration;
  return Number.isFinite(riskAdjusted) ? riskAdjusted - penalty : -Infinity;
}

function rankCandidates(candidates, options = {}) {
  const rows = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    let id;
    try { id = candidateId(candidate); } catch { continue; }
    const evaluation = assessHorizonBundle(candidate.horizonReports, {
      ...options,
      expectedCandidateId: id,
      expectedQuantPolicySha256: candidate.quantPolicySha256 || undefined,
    });
    rows.push({ candidate, candidateId: id, evaluation, score: candidateScore(candidate, evaluation) });
  }
  return rows.sort((a, b) => {
    if (a.evaluation.allowed !== b.evaluation.allowed) return a.evaluation.allowed ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    return a.candidateId.localeCompare(b.candidateId);
  });
}

function chooseChampionChallenger(candidates, incumbent, options = {}) {
  const ranked = rankCandidates(candidates, options).filter((row) => row.evaluation.allowed);
  if (!ranked.length) return { selected: null, reason: "aucun_candidat_admissible", ranked };
  const challenger = ranked[0];
  if (!incumbent) return { selected: challenger, reason: "premier_champion", ranked };

  const incumbentEvaluation = assessHorizonBundle(incumbent.horizonReports, {
    ...options,
    expectedCandidateId: candidateId(incumbent),
    expectedQuantPolicySha256: incumbent.quantPolicySha256 || undefined,
  });
  const incumbentScore = candidateScore(incumbent, incumbentEvaluation);
  const minimum = finite(options.minimumNetLowerBoundImprovement) || 0;
  const challengerLower = finite(challenger.evaluation.primary?.netMeanLower99) ?? -Infinity;
  const incumbentLower = finite(incumbentEvaluation.primary?.netMeanLower99) ?? -Infinity;
  if (challengerLower < incumbentLower + minimum || challenger.score <= incumbentScore) {
    return { selected: null, reason: "challenger_sans_amelioration_prudente", incumbentScore, ranked };
  }
  return { selected: challenger, reason: "challenger_superieur", incumbentScore, ranked };
}

function initialAutopilotState(nowMs = Date.now()) {
  return {
    schemaVersion: 1,
    stage: STAGES.DISCOVERY,
    candidateId: null,
    enteredAt: new Date(nowMs).toISOString(),
    lastDecisionAt: new Date(nowMs).toISOString(),
    reason: "initialisation",
    history: [],
  };
}

function transitionAutopilot(rawState, event, policy = {}, nowMs = Date.now()) {
  const previous = rawState && typeof rawState === "object" ? rawState : initialAutopilotState(nowMs);
  const state = { ...previous, history: Array.isArray(previous.history) ? [...previous.history] : [] };
  const type = String(event?.type || "");
  let next = state.stage;
  let reason = "aucun_changement";
  let nextCandidate = state.candidateId || null;

  if (type === "GATE_FAILED" && [STAGES.ELIGIBLE, STAGES.CANARY].includes(state.stage)) {
    next = STAGES.QUARANTINED;
    reason = "gate_live_refuse";
  } else if (type === "RISK_BREACH" || type === "DEGRADATION_CONFIRMED") {
    next = STAGES.QUARANTINED;
    reason = type.toLowerCase();
  } else if (state.stage === STAGES.DISCOVERY && type === "CANDIDATE_SELECTED" && event.candidateId) {
    next = STAGES.VALIDATION;
    nextCandidate = String(event.candidateId);
    reason = "candidat_selectionne";
  } else if (state.stage === STAGES.VALIDATION && type === "VALIDATION_COMPLETED") {
    if (event.allowed === true) {
      next = STAGES.SHADOW;
      reason = "validation_historique_acceptee";
    } else {
      next = STAGES.DISCOVERY;
      nextCandidate = null;
      reason = "validation_historique_refusee";
    }
  } else if (state.stage === STAGES.SHADOW && type === "SHADOW_COMPLETED") {
    if (event.allowed === true && event.signedEvidenceVerified === true) {
      next = STAGES.ELIGIBLE;
      reason = "shadow_et_preuve_signes_acceptes";
    } else {
      reason = "shadow_incomplet_ou_non_signe";
    }
  } else if (state.stage === STAGES.ELIGIBLE && type === "PROMOTION_VERIFIED") {
    const auto = policy?.promotion?.automaticLiveApplication === true;
    if (auto && event.liveGateAllowed === true && event.signedEvidenceVerified === true) {
      next = STAGES.CANARY;
      reason = "promotion_canary_signee";
    } else {
      reason = "promotion_live_refusee";
    }
  } else if (state.stage === STAGES.QUARANTINED && type === "RESEARCH_RESTARTED") {
    next = STAGES.DISCOVERY;
    nextCandidate = null;
    reason = "nouveau_cycle_recherche";
  }

  if (next !== state.stage || reason !== "aucun_changement") {
    state.history.push({
      at: new Date(nowMs).toISOString(),
      from: state.stage,
      to: next,
      event: type,
      reason,
      candidateId: nextCandidate,
    });
    if (state.history.length > 1000) state.history = state.history.slice(-1000);
    if (next !== state.stage) state.enteredAt = new Date(nowMs).toISOString();
    state.stage = next;
    state.candidateId = nextCandidate;
    state.lastDecisionAt = new Date(nowMs).toISOString();
    state.reason = reason;
  }
  return state;
}

function buildCandidateRoster(candidate, context = {}) {
  if (!candidate || typeof candidate !== "object") throw new Error("candidate invalide");
  if (candidate.executionType !== "directional-signal") throw new Error("type execution non pris en charge par le roster live");
  if (!candidate.perles || typeof candidate.perles !== "object" || Array.isArray(candidate.perles)) {
    throw new Error("perles absentes");
  }
  const perles = executablePerles(candidate.perles);
  if (!Object.keys(perles).length) throw new Error("roster candidat vide");
  for (const [instId, strategy] of Object.entries(perles)) {
    if (!strategy.sig || !strategy.ov) throw new Error(`strategie live invalide: ${instId}`);
  }
  if (!/^[a-f0-9]{64}$/i.test(String(context.dataManifestSha256 || ""))) throw new Error("manifeste donnees invalide");
  const quantEvidenceSha256 = candidateQuantEvidenceSha256(candidate);
  if (!quantEvidenceSha256) throw new Error("preuve quantitative candidate absente ou multiple");
  const quantPolicySha256 = candidateQuantPolicySha256(candidate);
  if (!quantPolicySha256) throw new Error("politique quantitative candidate absente ou multiple");
  const generatedAt = context.generatedAt || new Date().toISOString();
  return {
    schemaVersion: 1,
    genere: generatedAt,
    selectionRunId: String(context.selectionRunId || candidateId(candidate)),
    dataManifestSha256: String(context.dataManifestSha256).toLowerCase(),
    quantEvidenceSha256,
    quantPolicySha256,
    strategyCandidateId: candidateId(candidate),
    universePolicy: candidate.universe || null,
    perles,
  };
}

function verifyPromotionBundle({ root, roster, evidence, gatePolicy, publicKey, nowMs,
  expectedPublicKeySpkiSha256 }) {
  const normalized = normaliseLiveGatePolicy(gatePolicy);
  let engineHash = null;
  try { engineHash = engineSha256(root, normalized.policy.engineFiles); } catch {}
  const signatureVerified = verifyEvidenceSignature(evidence, publicKey);
  const gate = evaluateLiveGate({
    roster,
    evidence,
    policy: gatePolicy,
    nowMs,
    expectedEngineSha256: engineHash,
    evidenceSignatureVerified: signatureVerified,
    evidencePublicKeySpkiSha256: publicKeySpkiSha256(publicKey),
    expectedPublicKeySpkiSha256: expectedPublicKeySpkiSha256
      || process.env.HERMES_EVIDENCE_PUBLIC_KEY_SPKI_SHA256 || null,
  });
  return { ...gate, signatureVerified, expectedRosterSha256: rosterSha256(roster) };
}

function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}

function backupIfPresent(file, backupDir, label, nowMs = Date.now()) {
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, "-");
  const backup = path.join(backupDir, `${stamp}-${label}.json`);
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  return backup;
}

function applyPromotionBundle({ root, roster, evidence, gatePolicy, publicKey, nowMs = Date.now(),
  expectedPublicKeySpkiSha256 }) {
  const verification = verifyPromotionBundle({
    root, roster, evidence, gatePolicy, publicKey, nowMs, expectedPublicKeySpkiSha256,
  });
  if (!verification.allowed) return { applied: false, verification };
  const approvedFile = path.join(root, "config", "approved-roster.json");
  const evidenceFile = path.join(root, "data", "live-evidence.json");
  const historyDir = path.join(root, "data", "autopilot", "promotions");
  const backups = [
    backupIfPresent(approvedFile, historyDir, "approved-roster", nowMs),
    backupIfPresent(evidenceFile, historyDir, "live-evidence", nowMs),
  ].filter(Boolean);
  writeJsonAtomic(evidenceFile, evidence);
  writeJsonAtomic(approvedFile, roster);
  return { applied: true, verification, backups };
}

function quarantineApprovedRoster(root, reason, nowMs = Date.now()) {
  const approvedFile = path.join(root, "config", "approved-roster.json");
  const historyDir = path.join(root, "data", "autopilot", "quarantine");
  const backup = backupIfPresent(approvedFile, historyDir, "approved-roster", nowMs);
  const quarantine = {
    schemaVersion: 1,
    genere: new Date(nowMs).toISOString(),
    selectionRunId: `quarantine-${nowMs}`,
    dataManifestSha256: "0".repeat(64),
    quarantine: { reason: String(reason || "raison_absente"), previousRosterBackup: backup },
    perles: {},
  };
  writeJsonAtomic(approvedFile, quarantine);
  return { quarantined: true, backup, approvedFile };
}

function trialLedgerRecord(candidate, evaluation, context = {}) {
  const candidateIdentity = executableStrategyIdentity(candidate);
  return {
    schemaVersion: 1,
    recordedAt: context.recordedAt || new Date().toISOString(),
    runId: String(context.runId || ""),
    candidateId: candidateId(candidate),
    family: String(candidate.family || ""),
    executionType: String(candidate.executionType || ""),
    sourcePriorSha256: candidate.sourcePriorSha256 || null,
    paramsSha256: sha256(stableStringify(candidateIdentity.params || {})),
    universeSha256: sha256(stableStringify(candidateIdentity.universe || {})),
    accepted: evaluation?.allowed === true,
    rejectionReasons: evaluation?.reasons || [],
    primaryMetrics: evaluation?.primary || null,
    candidateIdentity,
  };
}

module.exports = {
  STAGES,
  DEFAULT_THRESHOLDS,
  executablePerles,
  executableStrategyIdentity,
  candidateId,
  mergeCandidateCatalog,
  candidateQuantEvidenceSha256,
  candidateQuantPolicySha256,
  assessHorizonBundle,
  rankCandidates,
  chooseChampionChallenger,
  initialAutopilotState,
  transitionAutopilot,
  buildCandidateRoster,
  verifyPromotionBundle,
  applyPromotionBundle,
  quarantineApprovedRoster,
  trialLedgerRecord,
  writeJsonAtomic,
};
