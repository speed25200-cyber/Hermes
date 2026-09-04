"use strict";

/*
 * Fail-closed coordinator for the Hermes research lifecycle.
 *
 * The coordinator consumes already-produced artifacts. It never downloads
 * market data, fabricates a missing statistic, signs evidence, reads a private
 * key or sends an order. The only live-facing mutation it can request is the
 * atomic installation/quarantine implemented by modules/autopilot.js.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  STAGES,
  applyPromotionBundle,
  assessHorizonBundle,
  buildCandidateRoster,
  candidateId,
  candidateQuantEvidenceSha256,
  candidateQuantPolicySha256,
  chooseChampionChallenger,
  initialAutopilotState,
  quarantineApprovedRoster,
  rankCandidates,
  transitionAutopilot,
  trialLedgerRecord,
  verifyPromotionBundle,
  writeJsonAtomic,
} = require("./autopilot.js");
const { ATOMIC_EXECUTOR_IMPLEMENTED } = require("./carry_strategy.js");
const {
  emptyMonitoringHighWater,
  evaluateMonitoringReplay,
  evaluateSignedMonitoring,
  normaliseLiveGatePolicy,
  publicKeySpkiSha256,
  rosterSha256,
} = require("./live_safety.js");

const ALL_STAGES = new Set(Object.values(STAGES));
const CHALLENGER_STAGES = new Set([
  STAGES.DISCOVERY, STAGES.VALIDATION, STAGES.SHADOW, STAGES.ELIGIBLE,
]);
const DEFAULT_MONITOR_STALENESS_MINUTES = 5;

function hasActiveRoster(roster) {
  return !!(roster?.perles && typeof roster.perles === "object"
    && !Array.isArray(roster.perles) && Object.keys(roster.perles).length > 0);
}

function finite(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isoTime(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function readJsonIfPresent(file) {
  try { return readJson(file); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function readTextIfPresent(file) {
  try { return fs.readFileSync(file, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertPublicKeyOnly(publicKey) {
  if (publicKey == null || publicKey === "") return null;
  const text = Buffer.isBuffer(publicKey) ? publicKey.toString("utf8") : String(publicKey);
  if (/PRIVATE KEY/i.test(text)) throw new Error("une cle privee est interdite dans l'orchestrateur");
  if (!/BEGIN PUBLIC KEY/.test(text)) throw new Error("cle publique Ed25519 absente ou invalide");
  return text;
}

function normaliseState(rawState, nowMs) {
  if (rawState == null) return initialAutopilotState(nowMs);
  if (!rawState || typeof rawState !== "object" || Array.isArray(rawState)) throw new Error("etat autopilot invalide");
  if (Number(rawState.schemaVersion ?? 1) !== 1) throw new Error("schema etat autopilot invalide");
  if (!ALL_STAGES.has(rawState.stage)) throw new Error("etape autopilot inconnue");
  if (rawState.candidateId != null && !/^[a-f0-9]{64}$/i.test(String(rawState.candidateId))) {
    throw new Error("candidateId d'etat invalide");
  }
  if (rawState.championCandidateId != null && !/^[a-f0-9]{64}$/i.test(String(rawState.championCandidateId))) {
    throw new Error("championCandidateId d'etat invalide");
  }
  if ([STAGES.VALIDATION, STAGES.SHADOW, STAGES.ELIGIBLE, STAGES.CANARY].includes(rawState.stage)
      && !rawState.candidateId) throw new Error("etape active sans candidateId");
  let challenger = null;
  if (rawState.challenger != null) {
    const value = rawState.challenger;
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Number(value.schemaVersion ?? 1) !== 1
        || !CHALLENGER_STAGES.has(value.stage)) {
      throw new Error("etat challenger invalide");
    }
    if (value.candidateId != null && !/^[a-f0-9]{64}$/i.test(String(value.candidateId))) {
      throw new Error("candidateId challenger invalide");
    }
    if ([STAGES.VALIDATION, STAGES.SHADOW, STAGES.ELIGIBLE].includes(value.stage)
        && !value.candidateId) throw new Error("etape challenger active sans candidateId");
    challenger = { ...value, schemaVersion: 1, history: Array.isArray(value.history) ? value.history : [] };
  }
  return {
    schemaVersion: 1,
    ...rawState,
    history: Array.isArray(rawState.history) ? rawState.history : [],
    challenger,
  };
}

function normaliseCandidateArtifact(raw) {
  if (raw == null) return { schemaVersion: 1, runId: "", candidates: [], incumbentCandidateId: null };
  const artifact = Array.isArray(raw) ? { schemaVersion: 1, candidates: raw } : raw;
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) throw new Error("catalogue candidats invalide");
  if (Number(artifact.schemaVersion ?? 1) !== 1) throw new Error("schema catalogue candidats invalide");
  if (!Array.isArray(artifact.candidates)) throw new Error("candidates doit etre un tableau");
  const ids = new Set();
  for (const candidate of artifact.candidates) {
    const id = candidateId(candidate);
    if (ids.has(id)) throw new Error(`candidat duplique: ${id}`);
    ids.add(id);
  }
  const incumbentCandidateId = artifact.incumbentCandidateId == null
    ? null : String(artifact.incumbentCandidateId);
  if (incumbentCandidateId && !/^[a-f0-9]{64}$/i.test(incumbentCandidateId)) {
    throw new Error("incumbentCandidateId invalide");
  }
  return {
    schemaVersion: 1,
    runId: String(artifact.runId || ""),
    generatedAt: artifact.generatedAt || null,
    incumbentCandidateId,
    candidates: artifact.candidates,
  };
}

function validationOptions(policy) {
  return {
    ...(policy?.backtest || {}),
    minimumNetLowerBoundImprovement: finite(policy?.promotion?.minimumNetLowerBoundImprovement) || 0,
  };
}

function canaryEnvelope(policy) {
  const maximum = finite(policy?.promotion?.maximumCanaryEquityPct) ?? 0.05;
  const initial = finite(policy?.promotion?.initialCanaryEquityPct);
  const reasons = [];
  if (!(maximum > 0 && maximum <= 0.05)) reasons.push("plafond_canary_politique_invalide");
  if (!(initial !== null && initial > 0 && initial <= maximum)) reasons.push("plafond_canary_initial_invalide");
  return { valid: reasons.length === 0, initial, maximum, reasons };
}

function isCarryCandidate(candidate) {
  const family = String(candidate?.family || "").toLowerCase();
  const execution = String(candidate?.executionType || "").toLowerCase();
  return family.includes("carry") || execution.includes("spot-perpetual")
    || execution.includes("two-leg") || execution.includes("market-neutral");
}

function candidateMap(candidates) {
  return new Map(candidates.map((candidate) => [candidateId(candidate), candidate]));
}

function selectChampionOrChallenger({ artifact, state, installedRoster, policy }) {
  const byId = candidateMap(artifact.candidates);
  const incumbentId = state.championCandidateId || installedRoster?.strategyCandidateId
    || artifact.incumbentCandidateId || null;
  if (incumbentId && !byId.has(incumbentId)) {
    return { selected: null, reason: "metriques_champion_absentes", ranked: rankCandidates(artifact.candidates, validationOptions(policy)) };
  }
  const incumbent = incumbentId ? byId.get(incumbentId) : null;
  const challengers = incumbentId
    ? artifact.candidates.filter((candidate) => candidateId(candidate) !== incumbentId)
    : artifact.candidates;
  if (incumbent && !assessHorizonBundle(incumbent.horizonReports, {
    ...validationOptions(policy),
    expectedCandidateId: candidateId(incumbent),
    expectedQuantPolicySha256: incumbent.quantPolicySha256 || undefined,
  }).allowed) {
    const replacement = chooseChampionChallenger(challengers, null, validationOptions(policy));
    return { ...replacement, reason: replacement.selected ? "champion_non_admissible_remplace" : "aucun_remplacant_admissible" };
  }
  return chooseChampionChallenger(challengers, incumbent, validationOptions(policy));
}

function bundleMatchesCandidate(candidate, bundle) {
  const reasons = [];
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return { valid: false, reasons: ["bundle_promotion_absent"] };
  if (!bundle.roster || !bundle.evidence) return { valid: false, reasons: ["bundle_roster_ou_preuve_absent"] };
  let expected = null;
  try {
    expected = buildCandidateRoster(candidate, {
      selectionRunId: bundle.roster.selectionRunId,
      dataManifestSha256: bundle.roster.dataManifestSha256,
      generatedAt: bundle.roster.genere,
    });
  } catch (error) {
    reasons.push(`roster_candidat_inconstructible:${error.message}`);
  }
  if (expected && rosterSha256(expected) !== rosterSha256(bundle.roster)) reasons.push("roster_ne_correspond_pas_au_candidat");
  const expectedCandidateId = candidateId(candidate);
  if (bundle.roster?.strategyCandidateId !== expectedCandidateId) reasons.push("roster_candidate_id_different");
  const expectedQuantEvidenceSha256 = candidateQuantEvidenceSha256(candidate);
  if (!expectedQuantEvidenceSha256) reasons.push("preuve_quantitative_candidate_absente");
  if (String(bundle.roster?.quantEvidenceSha256 || "").toLowerCase() !== expectedQuantEvidenceSha256) {
    reasons.push("roster_preuve_quantitative_differente");
  }
  if (String(bundle.evidence?.quantEvidenceSha256 || "").toLowerCase() !== expectedQuantEvidenceSha256) {
    reasons.push("preuve_live_preuve_quantitative_differente");
  }
  const horizonReports = Array.isArray(candidate?.horizonReports) ? candidate.horizonReports : [];
  const expectedQuantPolicySha256 = candidateQuantPolicySha256(candidate);
  if (!expectedQuantPolicySha256) reasons.push("politique_quantitative_candidate_absente");
  if (String(bundle.roster?.quantPolicySha256 || "").toLowerCase() !== expectedQuantPolicySha256) {
    reasons.push("roster_politique_quantitative_differente");
  }
  const expectedCandidateIdFromReports = new Set(horizonReports.map((report) =>
    String(report?.candidateId || "").toLowerCase()));
  if (expectedCandidateIdFromReports.size !== 1
      || [...expectedCandidateIdFromReports][0] !== expectedCandidateId) {
    reasons.push("rapports_quantitatifs_mauvais_candidat");
  }
  const manifestHashes = [candidate?.dataManifestSha256]
    .concat(horizonReports.map((report) => report?.dataManifestSha256))
    .filter(Boolean).map((value) => String(value).toLowerCase());
  if (manifestHashes.some((hash) => hash !== String(bundle.roster?.dataManifestSha256 || "").toLowerCase())) {
    reasons.push("roster_manifest_different_de_la_validation");
  }
  return { valid: reasons.length === 0, reasons };
}

function evaluateDegradation(monitoring, policy, candidateOrId, nowMs, stateEnteredAt, security = {}) {
  const cfg = policy?.demotion || {};
  const reasons = [];
  const configuredMinutes = finite(cfg.maximumMonitoringStalenessMinutes);
  const maximumStalenessMinutes = configuredMinutes !== null && configuredMinutes > 0
    ? Math.min(DEFAULT_MONITOR_STALENESS_MINUTES, configuredMinutes)
    : DEFAULT_MONITOR_STALENESS_MINUTES;
  if (!monitoring) {
    return { degraded: true, assessed: false, reasons: ["monitoring_autoritatif_absent"] };
  }
  if (typeof monitoring !== "object" || Array.isArray(monitoring)) {
    return { degraded: true, assessed: false, reasons: ["monitoring_invalide"] };
  }
  const expectedCandidateId = typeof candidateOrId === "string"
    ? candidateOrId : candidateOrId ? candidateId(candidateOrId) : null;
  if (security.signatureVerified !== true) reasons.push("monitoring_signature_invalide");
  if (Number(monitoring.schemaVersion) !== 1) reasons.push("monitoring_schema_invalide");
  if (String(monitoring.source || "") !== "okx-account-reconciliation-v1") reasons.push("monitoring_source_invalide");
  if (!Number.isSafeInteger(monitoring.sequence) || monitoring.sequence < 0) reasons.push("monitoring_sequence_invalide");
  if (security.expectedRosterSha256
      && String(monitoring.rosterSha256 || "").toLowerCase()
        !== String(security.expectedRosterSha256).toLowerCase()) reasons.push("monitoring_mauvais_roster");
  if (expectedCandidateId
      && String(monitoring.candidateId || "").toLowerCase() !== expectedCandidateId.toLowerCase()) reasons.push("monitoring_mauvais_candidat");
  const observedAt = isoTime(monitoring.asOf || monitoring.generatedAt);
  if (observedAt === null) reasons.push("monitoring_sans_date");
  else if (observedAt > nowMs + 5 * 60e3) reasons.push("monitoring_date_future");
  else if (nowMs - observedAt > maximumStalenessMinutes * 60_000) reasons.push("monitoring_perime");
  /* Les drapeaux de securite sont des attestations positives, pas des champs
     optionnels. Leur absence ne doit jamais etre interpretee comme « sain ». */
  if (monitoring.riskBreach !== false) reasons.push(
    monitoring.riskBreach === true ? "risque_explicite" : "monitoring_riskBreach_absent"
  );
  if (monitoring.killSwitch !== false) reasons.push(
    monitoring.killSwitch === true ? "risque_explicite" : "monitoring_killSwitch_absent"
  );
  if (monitoring.venueHealthy !== true) reasons.push(
    monitoring.venueHealthy === false ? "venue_degradee" : "monitoring_venueHealthy_absent"
  );

  const trades = finite(monitoring.trades);
  if (trades === null || trades < 0) reasons.push("monitoring_trades_invalides");
  const minimumTrades = finite(cfg.minimumTrades) ?? 30;
  const assessMetrics = trades !== null && trades >= minimumTrades;
  if (assessMetrics) {
    const checks = [
      ["netLower95", "borne_nette_degradee", (value) => value <= (finite(cfg.quarantineIfNetLower95AtMost) ?? 0)],
      ["profitFactor", "profit_factor_degrade", (value) => value < (finite(cfg.quarantineIfProfitFactorBelow) ?? 1)],
      ["costRatio", "ratio_couts_degrade", (value) => value > (finite(cfg.quarantineIfCostRatioAbove) ?? 0.8)],
      ["trackingErrorBps", "tracking_error_degrade", (value) => value > (finite(cfg.quarantineIfTrackingErrorBpsAbove) ?? 25)],
    ];
    for (const [name, reason, failed] of checks) {
      const value = finite(monitoring[name]);
      if (value === null) reasons.push(`monitoring_${name}_absent`);
      else if (failed(value)) reasons.push(reason);
    }
  }
  return { degraded: reasons.length > 0, assessed: assessMetrics, reasons: [...new Set(reasons)] };
}

function quarantine({ root, state, reason, nowMs, dryRun, actions }) {
  const event = transitionAutopilot(state, { type: "DEGRADATION_CONFIRMED" }, {}, nowMs);
  let result = { quarantined: false, dryRun: true };
  if (!dryRun) result = quarantineApprovedRoster(root, reason, nowMs);
  actions.push({ type: dryRun ? "QUARANTINE_WOULD_APPLY" : "QUARANTINE_APPLIED", reason, backup: result.backup || null });
  return { state: event, result };
}

function makeTrialRecords(artifact, policy, nowMs) {
  const options = validationOptions(policy);
  return rankCandidates(artifact.candidates, options).map((row) => trialLedgerRecord(
    row.candidate,
    row.evaluation,
    {
      runId: row.candidate.discoveryRunId
        || artifact.runId || `cutoff-${row.evaluation.cutoff || "absent"}`,
      recordedAt: new Date(nowMs).toISOString(),
    },
  ));
}

function newChallengerState(nowMs) {
  return { ...initialAutopilotState(nowMs), reason: "challenger_initialisation" };
}

function validationForCandidate(candidate, policy) {
  return assessHorizonBundle(candidate.horizonReports, {
    ...validationOptions(policy),
    expectedCandidateId: candidateId(candidate),
    expectedQuantPolicySha256: candidate.quantPolicySha256 || undefined,
  });
}

/* Le champion live reste entierement porte par state.stage/candidateId. Cette
   sous-machine persistante peut chercher, valider et vieillir un challenger
   sans faire sortir le champion du canary. Seule l'installation atomique d'un
   bundle signe remplace finalement l'autorite live. */
function advanceCanaryChallenger({ root, nowMs, state, artifact, byId, policy, gatePolicy,
  publicKey, expectedPublicKeySpkiSha256, promotionBundle, dryRun, actions }) {
  const researchReasons = [];
  let challenger = state.challenger || newChallengerState(nowMs);
  const finish = (exitCode = 0, extra = {}) => ({
    state: { ...state, challenger },
    actions,
    reasons: [...new Set(researchReasons)],
    exitCode,
    ...extra,
  });

  if (challenger.stage === STAGES.DISCOVERY) {
    const selection = selectChampionOrChallenger({
      artifact,
      state: { championCandidateId: state.championCandidateId || state.candidateId },
      installedRoster: null,
      policy,
    });
    if (!selection.selected) {
      actions.push({ type: "CHALLENGER_DISCOVERY_WAIT", reason: selection.reason });
      return finish(0, { ranked: selection.ranked });
    }
    challenger = transitionAutopilot(challenger, {
      type: "CANDIDATE_SELECTED",
      candidateId: selection.selected.candidateId,
    }, policy, nowMs);
    actions.push({
      type: "CHALLENGER_SELECTED",
      candidateId: challenger.candidateId,
      reason: selection.reason,
    });
  }

  const candidate = byId.get(challenger.candidateId);
  if (!candidate) {
    researchReasons.push("challenger_selectionne_absent_du_catalogue");
    actions.push({ type: "CHALLENGER_BLOCKED", reason: researchReasons.at(-1) });
    return finish(2);
  }

  if (challenger.stage === STAGES.VALIDATION) {
    const validation = validationForCandidate(candidate, policy);
    challenger = transitionAutopilot(challenger, {
      type: "VALIDATION_COMPLETED", allowed: validation.allowed,
    }, policy, nowMs);
    actions.push({
      type: validation.allowed ? "CHALLENGER_VALIDATION_ACCEPTED" : "CHALLENGER_VALIDATION_REJECTED",
      candidateId: candidateId(candidate),
      reasons: validation.reasons,
    });
    if (!validation.allowed) {
      researchReasons.push(...validation.reasons);
      return finish(0, { validation });
    }
    actions.push({
      type: "CHALLENGER_SHADOW_STARTED",
      candidateId: candidateId(candidate),
      enteredAt: challenger.enteredAt,
    });
    return finish(0, { validation });
  }

  if (challenger.stage === STAGES.SHADOW) {
    const minimumShadowDays = normaliseLiveGatePolicy(gatePolicy).policy.minShadowDays;
    const shadowStartedAt = isoTime(challenger.enteredAt);
    const elapsedShadowDays = shadowStartedAt === null ? null : (nowMs - shadowStartedAt) / 86_400_000;
    if (shadowStartedAt === null || elapsedShadowDays < 0) {
      researchReasons.push("challenger_shadow_debut_invalide");
      actions.push({ type: "CHALLENGER_SHADOW_WAIT", reason: researchReasons.at(-1) });
      return finish(2);
    }
    if (elapsedShadowDays < minimumShadowDays) {
      actions.push({
        type: "CHALLENGER_SHADOW_WAIT", candidateId: candidateId(candidate),
        elapsedShadowDays, minimumShadowDays,
      });
      return finish(0);
    }
    if (isCarryCandidate(candidate) && ATOMIC_EXECUTOR_IMPLEMENTED !== true) {
      actions.push({
        type: "CHALLENGER_SHADOW_ONLY", candidateId: candidateId(candidate),
        reason: "carry_shadow_only_executeur_atomique_deux_jambes_absent",
      });
      return finish(0);
    }
    if (candidate.executionType !== "directional-signal") {
      actions.push({
        type: "CHALLENGER_SHADOW_ONLY", candidateId: candidateId(candidate),
        reason: "type_execution_shadow_only",
      });
      return finish(0);
    }
    if (!promotionBundle) {
      actions.push({ type: "CHALLENGER_SHADOW_WAIT", candidateId: candidateId(candidate), reason: "bundle_promotion_signe_attendu" });
      return finish(0);
    }
    const binding = bundleMatchesCandidate(candidate, promotionBundle);
    const verification = binding.valid ? verifyPromotionBundle({
      root,
      roster: promotionBundle.roster,
      evidence: promotionBundle.evidence,
      gatePolicy,
      publicKey,
      nowMs,
      expectedPublicKeySpkiSha256,
    }) : { allowed: false, signatureVerified: false, reasons: binding.reasons };
    if (!binding.valid || !verification.allowed || verification.signatureVerified !== true) {
      researchReasons.push(...binding.reasons, ...(verification.reasons || []));
      actions.push({ type: "CHALLENGER_SHADOW_WAIT", candidateId: candidateId(candidate), verification });
      return finish(2, { verification });
    }
    challenger = transitionAutopilot(challenger, {
      type: "SHADOW_COMPLETED", allowed: true, signedEvidenceVerified: true,
    }, policy, nowMs);
    actions.push({ type: "CHALLENGER_ELIGIBLE", candidateId: candidateId(candidate) });
  }

  if (challenger.stage === STAGES.ELIGIBLE) {
    if (!promotionBundle) {
      actions.push({ type: "CHALLENGER_ELIGIBLE_WAIT", candidateId: candidateId(candidate), reason: "bundle_promotion_signe_attendu" });
      return finish(0);
    }
    const binding = bundleMatchesCandidate(candidate, promotionBundle);
    if (!binding.valid) {
      researchReasons.push(...binding.reasons);
      actions.push({ type: "CHALLENGER_ELIGIBLE_WAIT", candidateId: candidateId(candidate), reasons: binding.reasons });
      return finish(2);
    }
    if (policy?.promotion?.automaticLiveApplication !== true) {
      actions.push({ type: "CHALLENGER_ELIGIBLE_WAIT", candidateId: candidateId(candidate), reason: "application_live_automatique_desactivee" });
      return finish(0);
    }
    const envelope = canaryEnvelope(policy);
    if (!envelope.valid) {
      researchReasons.push(...envelope.reasons);
      actions.push({ type: "CHALLENGER_ELIGIBLE_WAIT", candidateId: candidateId(candidate), reasons: envelope.reasons });
      return finish(2);
    }
    if (dryRun === true) {
      const verification = verifyPromotionBundle({
        root,
        roster: promotionBundle.roster,
        evidence: promotionBundle.evidence,
        gatePolicy,
        publicKey,
        nowMs,
        expectedPublicKeySpkiSha256,
      });
      actions.push({
        type: verification.allowed ? "CHALLENGER_PROMOTION_WOULD_APPLY" : "CHALLENGER_PROMOTION_REFUSED",
        candidateId: candidateId(candidate), verification,
      });
      if (!verification.allowed) researchReasons.push(...verification.reasons);
      return finish(verification.allowed ? 0 : 2, { verification });
    }
    const application = applyPromotionBundle({
      root,
      roster: promotionBundle.roster,
      evidence: promotionBundle.evidence,
      gatePolicy,
      publicKey,
      nowMs,
      expectedPublicKeySpkiSha256,
    });
    if (!application.applied) {
      researchReasons.push(...application.verification.reasons);
      actions.push({ type: "CHALLENGER_PROMOTION_REFUSED", verification: application.verification });
      return finish(2, { verification: application.verification });
    }

    const promotedCandidateId = candidateId(candidate);
    const history = Array.isArray(state.history) ? [...state.history] : [];
    history.push({
      at: new Date(nowMs).toISOString(),
      from: STAGES.CANARY,
      to: STAGES.CANARY,
      event: "CHALLENGER_PROMOTION_VERIFIED",
      reason: "challenger_promotion_canary_signee",
      candidateId: promotedCandidateId,
    });
    state = {
      ...state,
      stage: STAGES.CANARY,
      candidateId: promotedCandidateId,
      championCandidateId: promotedCandidateId,
      canaryEquityPct: envelope.initial,
      enteredAt: new Date(nowMs).toISOString(),
      lastDecisionAt: new Date(nowMs).toISOString(),
      reason: "challenger_promotion_canary_signee",
      history: history.slice(-1000),
      challenger: null,
    };
    challenger = null;
    actions.push({
      type: "CHALLENGER_CANARY_APPLIED",
      candidateId: promotedCandidateId,
      canaryEquityPct: envelope.initial,
      backups: application.backups,
    });
    return { state, actions, reasons: [], exitCode: 0, verification: application.verification };
  }

  return finish(0);
}

function runAutopilotCycle(input) {
  const root = path.resolve(input.root);
  const nowMs = finite(input.nowMs) ?? Date.now();
  if (!Number.isFinite(nowMs)) throw new Error("horodatage cycle invalide");
  const policy = input.policy || {};
  const gatePolicy = input.gatePolicy || {};
  const publicKey = assertPublicKeyOnly(input.publicKey);
  const monitoringPublicKey = assertPublicKeyOnly(input.monitoringPublicKey);
  const expectedPublicKeySpkiSha256 = input.expectedPublicKeySpkiSha256
    || process.env.HERMES_EVIDENCE_PUBLIC_KEY_SPKI_SHA256 || null;
  const expectedMonitoringPublicKeySpkiSha256 = input.expectedMonitoringPublicKeySpkiSha256
    || process.env.HERMES_MONITORING_PUBLIC_KEY_SPKI_SHA256 || null;
  const normalizedGatePolicy = normaliseLiveGatePolicy(gatePolicy).policy;
  const artifact = normaliseCandidateArtifact(input.candidatesArtifact);
  const byId = candidateMap(artifact.candidates);
  let state = normaliseState(input.state, nowMs);
  const actions = [];
  const reasons = [];
  const trialRecords = makeTrialRecords(artifact, policy, nowMs);

  if (state.stage === STAGES.QUARANTINED) {
    return { state, actions, reasons: ["quarantaine_active"], trialRecords, exitCode: 2 };
  }

  /* An installed non-empty roster is monitored even while a challenger is in
     discovery/validation/shadow. This also repairs the dangerous crash case
     where promotion succeeded but the state file was not yet persisted. */
  const installedActive = hasActiveRoster(input.installedRoster);
  const installedCandidateId = String(input.installedRoster?.strategyCandidateId || "").toLowerCase();
  const installedAutonomous = installedActive && /^[a-f0-9]{64}$/.test(installedCandidateId);
  let installedVerification = null;
  if (installedAutonomous) {
    installedVerification = verifyPromotionBundle({
      root,
      roster: input.installedRoster,
      evidence: input.installedEvidence,
      gatePolicy,
      publicKey,
      nowMs,
      expectedPublicKeySpkiSha256,
    });
    if (!installedVerification.allowed && policy?.demotion?.quarantineIfGateFails !== false) {
      const reason = `gate_live_degrade:${installedVerification.reasons.join("|")}`;
      const quarantined = quarantine({ root, state, reason, nowMs, dryRun: input.dryRun === true, actions });
      return { state: quarantined.state, actions, reasons: installedVerification.reasons, trialRecords, exitCode: 2 };
    }
    if (installedVerification.allowed) {
      const monitoringGate = input.monitoringGate || evaluateSignedMonitoring({
        monitoring: input.monitoring,
        roster: input.installedRoster,
        autopilotPolicy: policy,
        publicKey: monitoringPublicKey,
        nowMs,
        policyPublicKeySpkiSha256: normalizedGatePolicy.monitoringPublicKeySpkiSha256,
        expectedPublicKeySpkiSha256: expectedMonitoringPublicKeySpkiSha256,
        evidencePublicKeySpkiSha256: publicKeySpkiSha256(publicKey),
      });
      const monitoringReplay = input.monitoringReplay || evaluateMonitoringReplay({
        monitoringGate,
        highWater: input.monitoringHighWater,
      });
      if (!monitoringReplay.allowed) {
        const replayReasons = monitoringReplay.reasons || ["monitoring_rejeu_refuse"];
        const reason = `monitoring_rejeu_refuse:${replayReasons.join("|")}`;
        const quarantined = quarantine({ root, state, reason, nowMs, dryRun: input.dryRun === true, actions });
        return {
          state: quarantined.state, actions, reasons: replayReasons, trialRecords,
          monitoringGate, monitoringReplay, exitCode: 2,
        };
      }
      const installedAt = input.installedRoster.genere || state.enteredAt;
      const degradation = evaluateDegradation(
        input.monitoring,
        policy,
        installedCandidateId,
        nowMs,
        installedAt,
        {
          signatureVerified: monitoringGate.signatureVerified === true,
          expectedRosterSha256: rosterSha256(input.installedRoster),
        },
      );
      if (degradation.degraded && policy?.demotion?.automatic !== false) {
        const reason = `performance_degradee:${degradation.reasons.join("|")}`;
        const quarantined = quarantine({ root, state, reason, nowMs, dryRun: input.dryRun === true, actions });
        return {
          state: quarantined.state, actions, reasons: degradation.reasons, trialRecords,
          degradation, monitoringGate, monitoringReplay, exitCode: 2,
        };
      }
      actions.push({
        type: "ACTIVE_CHAMPION_HEALTHY", candidateId: installedCandidateId,
        degradation, monitoringReplay,
      });
    }
  }

  /* applyPromotionBundle remplace d'abord preuve+roster, puis runCycleFromFiles
     persiste l'etat. Apres un crash entre ces deux commits, le disque contient
     un challenger signe deja installe mais l'ancien champion dans state. On ne
     repare cette fenetre que si l'identite attendue du challenger persistant,
     son contenu executable, la preuve live et le monitoring courant convergent
     tous vers le meme candidateId. Toute autre divergence reste quarantinee. */
  if (state.stage === STAGES.CANARY && installedAutonomous
      && String(state.candidateId || "").toLowerCase() !== installedCandidateId) {
    const pending = state.challenger;
    const recoveryCandidate = byId.get(installedCandidateId);
    const expectedPending = pending
      && String(pending.candidateId || "").toLowerCase() === installedCandidateId
      && [STAGES.SHADOW, STAGES.ELIGIBLE].includes(pending.stage);
    const binding = expectedPending && recoveryCandidate
      ? bundleMatchesCandidate(recoveryCandidate, {
        roster: input.installedRoster,
        evidence: input.installedEvidence,
      })
      : { valid: false, reasons: ["challenger_reprise_non_attendu"] };
    if (expectedPending && recoveryCandidate && binding.valid
        && installedVerification?.allowed === true) {
      const envelope = canaryEnvelope(policy);
      if (envelope.valid) {
        const history = Array.isArray(state.history) ? [...state.history] : [];
        history.push({
          at: new Date(nowMs).toISOString(),
          from: STAGES.CANARY,
          to: STAGES.CANARY,
          event: "CHALLENGER_PROMOTION_STATE_RECOVERED",
          reason: "bundle_challenger_signe_deja_installe",
          candidateId: installedCandidateId,
        });
        state = {
          ...state,
          candidateId: installedCandidateId,
          championCandidateId: installedCandidateId,
          canaryEquityPct: envelope.initial,
          enteredAt: new Date(nowMs).toISOString(),
          lastDecisionAt: new Date(nowMs).toISOString(),
          reason: "bundle_challenger_signe_deja_installe",
          history: history.slice(-1000),
          challenger: null,
        };
        actions.push({
          type: "CHALLENGER_PROMOTION_STATE_RECOVERED",
          candidateId: installedCandidateId,
        });
      }
    }
  }

  if (state.stage === STAGES.CANARY) {
    if (!installedAutonomous) {
      const reason = "canary_sans_roster_installe";
      const quarantined = quarantine({ root, state, reason, nowMs, dryRun: input.dryRun === true, actions });
      return { state: quarantined.state, actions, reasons: [reason], trialRecords, exitCode: 2 };
    }
    if (String(state.candidateId || "").toLowerCase() !== installedCandidateId
        || (state.championCandidateId != null
          && String(state.championCandidateId).toLowerCase() !== installedCandidateId)) {
      const reason = "canary_et_roster_installe_divergents";
      const quarantined = quarantine({ root, state, reason, nowMs, dryRun: input.dryRun === true, actions });
      return { state: quarantined.state, actions, reasons: [reason], trialRecords, exitCode: 2 };
    }
    actions.push({ type: "CANARY_HEALTHY", candidateId: state.candidateId });
    const challengerResult = advanceCanaryChallenger({
      root, nowMs, state, artifact, byId, policy, gatePolicy, publicKey,
      expectedPublicKeySpkiSha256,
      promotionBundle: input.promotionBundle,
      dryRun: input.dryRun === true,
      actions,
    });
    return { ...challengerResult, trialRecords };
  }

  if (state.stage === STAGES.DISCOVERY) {
    const selection = selectChampionOrChallenger({ artifact, state, installedRoster: input.installedRoster, policy });
    if (!selection.selected) {
      reasons.push(selection.reason);
      actions.push({ type: "DISCOVERY_WAIT", reason: selection.reason });
      return { state, actions, reasons, trialRecords, ranked: selection.ranked, exitCode: 2 };
    }
    state = transitionAutopilot(state, {
      type: "CANDIDATE_SELECTED",
      candidateId: selection.selected.candidateId,
    }, policy, nowMs);
    actions.push({ type: "CANDIDATE_SELECTED", candidateId: state.candidateId, reason: selection.reason });
  }

  const candidate = byId.get(state.candidateId);
  if (!candidate) {
    reasons.push("candidat_selectionne_absent_du_catalogue");
    actions.push({ type: "CYCLE_BLOCKED", reason: reasons.at(-1) });
    return { state, actions, reasons, trialRecords, exitCode: 2 };
  }

  if (state.stage === STAGES.VALIDATION) {
    const validation = assessHorizonBundle(candidate.horizonReports, {
      ...validationOptions(policy),
      expectedCandidateId: candidateId(candidate),
      expectedQuantPolicySha256: candidate.quantPolicySha256 || undefined,
    });
    state = transitionAutopilot(state, { type: "VALIDATION_COMPLETED", allowed: validation.allowed }, policy, nowMs);
    actions.push({ type: validation.allowed ? "VALIDATION_ACCEPTED" : "VALIDATION_REJECTED", candidateId: candidateId(candidate), reasons: validation.reasons });
    if (!validation.allowed) {
      reasons.push(...validation.reasons);
      return { state, actions, reasons: [...new Set(reasons)], trialRecords, validation, exitCode: 2 };
    }
    /* Entrer en shadow demarre une horloge locale persistante. Un bundle deja
       prepare ne peut pas faire traverser validation, 90 jours de shadow et
       promotion dans le meme appel. */
    actions.push({ type: "SHADOW_STARTED", candidateId: candidateId(candidate), enteredAt: state.enteredAt });
    return { state, actions, reasons, trialRecords, validation, exitCode: 0 };
  }

  if (state.stage === STAGES.SHADOW) {
    const minimumShadowDays = normaliseLiveGatePolicy(gatePolicy).policy.minShadowDays;
    const shadowStartedAt = isoTime(state.enteredAt);
    const elapsedShadowDays = shadowStartedAt === null ? null : (nowMs - shadowStartedAt) / 86_400_000;
    if (shadowStartedAt === null || elapsedShadowDays < 0) {
      reasons.push("shadow_debut_invalide");
      actions.push({ type: "SHADOW_WAIT", candidateId: candidateId(candidate), reason: reasons.at(-1) });
      return { state, actions, reasons, trialRecords, exitCode: 2 };
    }
    if (elapsedShadowDays < minimumShadowDays) {
      reasons.push("shadow_duree_insuffisante");
      actions.push({
        type: "SHADOW_WAIT", candidateId: candidateId(candidate),
        elapsedShadowDays, minimumShadowDays,
      });
      return { state, actions, reasons, trialRecords, exitCode: 0 };
    }
    if (isCarryCandidate(candidate) && ATOMIC_EXECUTOR_IMPLEMENTED !== true) {
      reasons.push("carry_shadow_only_executeur_atomique_deux_jambes_absent");
      actions.push({ type: "SHADOW_ONLY", candidateId: candidateId(candidate), reason: reasons.at(-1) });
      return { state, actions, reasons, trialRecords, exitCode: 0 };
    }
    if (candidate.executionType !== "directional-signal") {
      reasons.push("type_execution_shadow_only");
      actions.push({ type: "SHADOW_ONLY", candidateId: candidateId(candidate), reason: reasons.at(-1) });
      return { state, actions, reasons, trialRecords, exitCode: 0 };
    }
    if (!input.promotionBundle) {
      reasons.push("bundle_promotion_signe_attendu");
      actions.push({ type: "SHADOW_WAIT", candidateId: candidateId(candidate) });
      return { state, actions, reasons, trialRecords, exitCode: 0 };
    }
    const binding = bundleMatchesCandidate(candidate, input.promotionBundle);
    const verification = binding.valid ? verifyPromotionBundle({
      root,
      roster: input.promotionBundle.roster,
      evidence: input.promotionBundle.evidence,
      gatePolicy,
      publicKey,
      nowMs,
      expectedPublicKeySpkiSha256,
    }) : { allowed: false, signatureVerified: false, reasons: binding.reasons };
    if (!binding.valid || !verification.allowed || verification.signatureVerified !== true) {
      reasons.push(...binding.reasons, ...(verification.reasons || []));
      actions.push({ type: "SHADOW_WAIT", candidateId: candidateId(candidate), verification });
      return { state, actions, reasons: [...new Set(reasons)], trialRecords, verification, exitCode: 2 };
    }
    state = transitionAutopilot(state, {
      type: "SHADOW_COMPLETED",
      allowed: true,
      signedEvidenceVerified: true,
    }, policy, nowMs);
    actions.push({ type: "ELIGIBLE", candidateId: candidateId(candidate) });
  }

  if (state.stage === STAGES.ELIGIBLE) {
    const binding = bundleMatchesCandidate(candidate, input.promotionBundle);
    if (!binding.valid) {
      reasons.push(...binding.reasons);
      return { state, actions, reasons: [...new Set(reasons)], trialRecords, exitCode: 2 };
    }
    if (policy?.promotion?.automaticLiveApplication !== true) {
      reasons.push("application_live_automatique_desactivee");
      actions.push({ type: "ELIGIBLE_WAIT", candidateId: candidateId(candidate), reason: reasons.at(-1) });
      return { state, actions, reasons, trialRecords, exitCode: 0 };
    }
    const envelope = canaryEnvelope(policy);
    if (!envelope.valid) {
      reasons.push(...envelope.reasons);
      actions.push({ type: "ELIGIBLE_WAIT", candidateId: candidateId(candidate), reasons: envelope.reasons });
      return { state, actions, reasons: [...new Set(reasons)], trialRecords, exitCode: 2 };
    }
    if (input.dryRun === true) {
      const verification = verifyPromotionBundle({
        root,
        roster: input.promotionBundle.roster,
        evidence: input.promotionBundle.evidence,
        gatePolicy,
        publicKey,
        nowMs,
        expectedPublicKeySpkiSha256,
      });
      actions.push({ type: verification.allowed ? "PROMOTION_WOULD_APPLY" : "PROMOTION_REFUSED", verification });
      if (!verification.allowed) reasons.push(...verification.reasons);
      return { state, actions, reasons: [...new Set(reasons)], trialRecords, verification, exitCode: verification.allowed ? 0 : 2 };
    }
    const application = applyPromotionBundle({
      root,
      roster: input.promotionBundle.roster,
      evidence: input.promotionBundle.evidence,
      gatePolicy,
      publicKey,
      nowMs,
      expectedPublicKeySpkiSha256,
    });
    if (!application.applied) {
      reasons.push(...application.verification.reasons);
      actions.push({ type: "PROMOTION_REFUSED", verification: application.verification });
      return { state, actions, reasons: [...new Set(reasons)], trialRecords, verification: application.verification, exitCode: 2 };
    }
    state = transitionAutopilot(state, {
      type: "PROMOTION_VERIFIED",
      liveGateAllowed: true,
      signedEvidenceVerified: true,
    }, policy, nowMs);
    state.championCandidateId = candidateId(candidate);
    state.canaryEquityPct = envelope.initial;
    actions.push({
      type: "CANARY_APPLIED",
      candidateId: state.candidateId,
      canaryEquityPct: state.canaryEquityPct,
      backups: application.backups,
    });
  }

  return { state, actions, reasons: [...new Set(reasons)], trialRecords, exitCode: 0 };
}

function persistTrialRecords(file, records) {
  const existing = readJsonIfPresent(file) || { schemaVersion: 1, records: [] };
  if (Number(existing.schemaVersion) !== 1 || !Array.isArray(existing.records)) throw new Error("ledger cycle invalide");
  const keys = new Set(existing.records.map((record) => `${record.runId}:${record.candidateId}`));
  for (const record of records) {
    const key = `${record.runId}:${record.candidateId}`;
    if (!keys.has(key)) {
      existing.records.push(record);
      keys.add(key);
    }
  }
  writeJsonAtomic(file, existing);
}

function resolveFile(root, explicit, fallback) {
  return path.resolve(explicit || path.join(root, fallback));
}

function assertMonitoringHighWater(value) {
  if (Number(value?.schemaVersion) !== 1 || !value?.entries
      || typeof value.entries !== "object" || Array.isArray(value.entries)) {
    throw new Error("monitoring high-water invalide");
  }
  for (const [key, entry] of Object.entries(value.entries)) {
    const signer = String(entry?.signerSpkiSha256 || "").toLowerCase();
    const source = String(entry?.source || "");
    const candidate = String(entry?.candidateId || "").toLowerCase();
    const roster = String(entry?.rosterSha256 || "").toLowerCase();
    const hash = String(entry?.monitoringSha256 || "").toLowerCase();
    if (key !== `${signer}:${source}` || !/^[a-f0-9]{64}$/.test(signer)
        || source !== "okx-account-reconciliation-v1"
        || !/^[a-f0-9]{64}$/.test(candidate)
        || !/^[a-f0-9]{64}$/.test(roster) || !Number.isSafeInteger(entry?.sequence)
        || entry.sequence < 0 || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error("monitoring high-water contient une entree invalide");
    }
  }
  return value;
}

function fsyncDirectory(directory) {
  let descriptor = null;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function writeMonitoringHighWaterAtomic(file, value) {
  assertMonitoringHighWater(value);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + "\n", "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = null;
    fs.renameSync(temporary, file);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function withMonitoringHighWaterLock(file, operation) {
  const directory = path.dirname(file);
  const lockFile = `${file}.lock`;
  let descriptor = null;
  try {
    fs.mkdirSync(directory, { recursive: true });
    descriptor = fs.openSync(lockFile, "wx", 0o600);
    return operation();
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
      try { fs.unlinkSync(lockFile); } catch {}
    }
  }
}

function readMonitoringHighWater(file) {
  return assertMonitoringHighWater(readJson(file));
}

function initialiseMonitoringHighWater(file, installedActive) {
  return withMonitoringHighWaterLock(file, () => {
    try {
      return { highWater: readMonitoringHighWater(file), initialized: false };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (installedActive) throw new Error("monitoring high-water absent avec roster actif");
      const sentinel = emptyMonitoringHighWater();
      writeMonitoringHighWaterAtomic(file, sentinel);
      return { highWater: sentinel, initialized: true };
    }
  });
}

function prepareMonitoringReplay({ file, monitoring, roster, policy, gatePolicy,
  monitoringPublicKey, expectedMonitoringPublicKeySpkiSha256,
  evidencePublicKeySpkiSha256, nowMs, dryRun }) {
  const assess = (highWater) => {
    const monitoringGate = evaluateSignedMonitoring({
      monitoring,
      roster,
      autopilotPolicy: policy,
      publicKey: monitoringPublicKey,
      nowMs,
      policyPublicKeySpkiSha256: normaliseLiveGatePolicy(gatePolicy).policy.monitoringPublicKeySpkiSha256,
      expectedPublicKeySpkiSha256: expectedMonitoringPublicKeySpkiSha256,
      evidencePublicKeySpkiSha256,
    });
    const monitoringReplay = evaluateMonitoringReplay({ monitoringGate, highWater });
    return { monitoringGate, monitoringReplay };
  };
  if (dryRun) return assess(readMonitoringHighWater(file));
  return withMonitoringHighWaterLock(file, () => {
    const highWater = readMonitoringHighWater(file);
    const prepared = assess(highWater);
    if (prepared.monitoringReplay.allowed && prepared.monitoringReplay.shouldAdvance) {
      writeMonitoringHighWaterAtomic(file, prepared.monitoringReplay.nextHighWater);
    }
    return prepared;
  });
}

function runCycleFromFiles(options = {}) {
  /* L'horloge injectee sert au rejeu deterministe, jamais a une mutation.
     Sans cette defense, un appel direct du module pourrait contourner la
     restriction CLI et faire vieillir artificiellement les 90 jours shadow. */
  if (options.nowMs != null && options.dryRun !== true) {
    throw new Error("nowMs explicite reserve au mode dry-run");
  }
  const root = path.resolve(options.root || path.join(__dirname, ".."));
  const files = {
    state: resolveFile(root, options.state, "data/autopilot/state.json"),
    candidates: resolveFile(root, options.candidates, "data/autopilot/candidates.json"),
    bundle: resolveFile(root, options.bundle, "data/autopilot/promotion-bundle.json"),
    monitor: resolveFile(root, options.monitor, "data/autopilot/monitoring.json"),
    policy: resolveFile(root, options.policy, "config/autopilot.policy.json"),
    gatePolicy: resolveFile(root, options.gatePolicy, "config/live-gate.policy.json"),
    publicKey: resolveFile(root, options.publicKey, "config/evidence-public-key.pem"),
    monitoringPublicKey: resolveFile(root, options.monitoringPublicKey, "config/monitoring-public-key.pem"),
    approvedRoster: path.join(root, "config", "approved-roster.json"),
    liveEvidence: path.join(root, "data", "live-evidence.json"),
    ledger: resolveFile(root, options.ledger, "data/autopilot/cycle-ledger.json"),
    monitorHighWater: path.join(root, "data", "autopilot", "monitoring-high-water.json"),
  };
  for (const [name, explicit] of [["candidates", options.candidates], ["bundle", options.bundle],
    ["monitor", options.monitor], ["publicKey", options.publicKey],
    ["monitoringPublicKey", options.monitoringPublicKey]]) {
    if (explicit && !fs.existsSync(files[name])) throw new Error(`fichier explicite absent: ${files[name]}`);
  }
  const cycleNowMs = options.nowMs ?? Date.now();
  const expectedPublicKeySpkiSha256 = options.expectedPublicKeySpkiSha256
    || process.env.HERMES_EVIDENCE_PUBLIC_KEY_SPKI_SHA256 || null;
  const expectedMonitoringPublicKeySpkiSha256 = options.expectedMonitoringPublicKeySpkiSha256
    || process.env.HERMES_MONITORING_PUBLIC_KEY_SPKI_SHA256 || null;
  const loaded = {
    state: readJsonIfPresent(files.state),
    candidatesArtifact: readJsonIfPresent(files.candidates),
    promotionBundle: readJsonIfPresent(files.bundle),
    monitoring: readJsonIfPresent(files.monitor),
    policy: readJson(files.policy),
    gatePolicy: readJson(files.gatePolicy),
    publicKey: readTextIfPresent(files.publicKey),
    monitoringPublicKey: readTextIfPresent(files.monitoringPublicKey),
    installedRoster: readJsonIfPresent(files.approvedRoster),
    installedEvidence: readJsonIfPresent(files.liveEvidence),
  };
  const installedActive = hasActiveRoster(loaded.installedRoster);
  let monitoringHighWater = null;
  let preparedReplay = null;
  if (options.dryRun !== true) {
    monitoringHighWater = initialiseMonitoringHighWater(files.monitorHighWater, installedActive).highWater;
  } else if (installedActive) {
    monitoringHighWater = readMonitoringHighWater(files.monitorHighWater);
  }

  /* Faire avancer la marque avec toute observation liee au roster et signee
     par la cle ancree, meme si la preuve de promotion a expire ou si le
     monitoring annonce un breach. Conditionner l'avance au gate complet
     permettrait de rendre ce gate invalide le temps d'ignorer une sequence
     defavorable, puis de restaurer un ancien snapshot sain. */
  if (installedActive) {
    const actualMonitoringSigner = publicKeySpkiSha256(loaded.monitoringPublicKey);
    const anchoredMonitoringSigner = String(
      expectedMonitoringPublicKeySpkiSha256 || "",
    ).toLowerCase();
    if (/^[a-f0-9]{64}$/.test(anchoredMonitoringSigner)
        && actualMonitoringSigner === anchoredMonitoringSigner) {
      preparedReplay = prepareMonitoringReplay({
        file: files.monitorHighWater,
        monitoring: loaded.monitoring,
        roster: loaded.installedRoster,
        policy: loaded.policy,
        gatePolicy: loaded.gatePolicy,
        monitoringPublicKey: loaded.monitoringPublicKey,
        expectedMonitoringPublicKeySpkiSha256,
        evidencePublicKeySpkiSha256: publicKeySpkiSha256(loaded.publicKey),
        nowMs: cycleNowMs,
        dryRun: options.dryRun === true,
      });
      if (preparedReplay.monitoringReplay.nextHighWater) {
        monitoringHighWater = preparedReplay.monitoringReplay.nextHighWater;
      }
    }
  }

  const result = runAutopilotCycle({
    root,
    nowMs: cycleNowMs,
    dryRun: options.dryRun === true,
    ...loaded,
    monitoringHighWater,
    monitoringGate: preparedReplay?.monitoringGate,
    monitoringReplay: preparedReplay?.monitoringReplay,
    expectedPublicKeySpkiSha256,
    expectedMonitoringPublicKeySpkiSha256,
  });
  if (options.dryRun !== true) {
    writeJsonAtomic(files.state, result.state);
    persistTrialRecords(files.ledger, result.trialRecords);
  }
  return { ...result, files, dryRun: options.dryRun === true };
}

module.exports = {
  DEFAULT_MONITOR_STALENESS_MINUTES,
  assertPublicKeyOnly,
  canaryEnvelope,
  normaliseCandidateArtifact,
  selectChampionOrChallenger,
  bundleMatchesCandidate,
  evaluateDegradation,
  runAutopilotCycle,
  persistTrialRecords,
  runCycleFromFiles,
};
