"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(root, "app", "main.js"), "utf8");
const server = fs.readFileSync(path.join(root, "app", "serveur.js"), "utf8");
const keys = fs.readFileSync(path.join(root, "deploy", "poser_cles.sh"), "utf8");
const execModule = fs.readFileSync(path.join(root, "modules", "exec.js"), "utf8");
const repair = fs.readFileSync(path.join(root, "REPARER_protections_tick.js"), "utf8");
const deployWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "deploy-vps.yml"), "utf8");

test("contrat live: aucun roster hardcode ne sert de repli", () => {
  assert.doesNotMatch(main, /STRATS_REPLI/);
  assert.match(main, /let STRATS = \{\};/);
  assert.doesNotMatch(main, /!Object\.keys\(perles\)\.length\) return/);
  assert.match(main, /ROSTER_FAIL_CLOSED/);
});

test("contrat demo: la preuve peut se construire sans argent, mais jamais sans roster", () => {
  assert.match(main, /simulatedReasons = evidence\.reasons\.filter[\s\S]*?startsWith\("roster_"\)/);
  assert.match(main, /allowed: simulatedReasons\.length === 0/);
});

test("contrat live: toutes les voies d'ordre consultent la gate", () => {
  const occurrences = (main.match(/liveGateStatus\(/g) || []).length;
  assert.ok(occurrences >= 8, `seulement ${occurrences} consultations de gate`);
  assert.match(main, /function canPlaceOrder[\s\S]*?if \(!liveGateStatus\(\)\.allowed\) return false/);
  assert.doesNotMatch(main, /ai:order-margin|HERMES_ENABLE_LEGACY_ORDER_MARGIN|LEGACY_ORDER_PATH_DISABLED/);
  assert.match(main, /HERMES_ENABLE_MANUAL_ORDER[\s\S]*?MANUAL_ORDER_PATH_DISABLED/);
  assert.match(main, /INSTRUMENT_NOT_APPROVED/);
});

test("contrat risque: le stop effectif du roster dimensionne l'entree", () => {
  assert.match(main, /effectiveStopMarginPct = effectiveStopLossMarginPct\(ov, SPEC\.slPctMargin\)/);
  assert.match(main, /positionSizing\(AI\.equityUSDT, effectiveStopMarginPct\)/);
  assert.match(main, /specPrices\(instId, side, lmtPx, effectiveOrderOv\)/);
  assert.match(main, /specPrices\(instId, side, marketReferencePx, effectiveOrderOv\)/);
  assert.match(main, /evaluateEntryStopRisk\(\{/);
  assert.match(main, /const finalMarginBudget = evaluateEntryMarginBudget\(\{/);
  assert.match(main, /if \(!finalMarginBudget\.allowed\)[\s\S]*?emergencyFlattenEntry\("entry-margin-budget-exceeded"\)/);
  assert.match(main, /effectiveStopLossMarginPct\(p\.ov, DEFAULT_STOP_MARGIN_PCT\)/);
});

test("contrat risque: un etat corrompu verrouille avant meme la baseline", () => {
  assert.match(main, /function tierBreach\(\) \{[\s\S]*?riskStateCorrupt \|\| AI\.riskLockedReason[\s\S]*?equityPeakTier/);
  assert.match(main, /if \(!AI\.riskStateReady\) return true/);
});

test("contrat reprise: les deadlines sont persistees, restaurees et nettoyees", () => {
  assert.match(main, /runtime", "position_metadata\.json/);
  assert.match(main, /rememberTimedExit\(AI\.openPositions\[instId\], effectiveOrderOv\.holdMs, enteredAt\)/);
  assert.match(main, /function reconcilePositionSnapshot[\s\S]*?restoreTimedExit\(merged, x\)/);
  assert.match(main, /function restoreTimedExit[\s\S]*?timedExitState = "AMBIGUOUS"[\s\S]*?lockTimedExitState/);
  assert.match(main, /delete AI\.openPositions\[instId\];\s*forgetTimedExit\(instId\)/);
  assert.match(main, /note:"NO_OKX_CREDS", snapshot:\{ \.\.\.snapshot, completedAt:Date\.now\(\) \}/);
  assert.match(main, /snapshot:\{ \.\.\.snapshot, authoritative:true, completedAt:Date\.now\(\) \}/);
  assert.match(main, /const destructive = destructiveSnapshotAllowed\(snapshot\)/);
  assert.match(main, /reconcilePositionSnapshot\(port\.positions, port\.snapshot\)/);
  assert.match(main, /parsePositionWsUpdate\(p\)/);
  assert.match(main, /update\.type === "flat-hint"[\s\S]*?scheduleAuthoritativePositionReconcile/);
  assert.doesNotMatch(main, /update\.type === "flat-hint"[\s\S]{0,300}?forgetTimedExit/);
});

test("contrat execution: plus de feature flag qui reactive les tailles flottantes", () => {
  assert.doesNotMatch(main, /HERMES_TAILLE_EXACTE|TAILLE_EXACTE/);
  assert.doesNotMatch(main, /Math\.floor\(qty \/ step\) \* step/);
});

test("contrat execution: le module CLI historique ne peut plus ouvrir de position", () => {
  assert.ok((execModule.match(/if \(!body \|\| body\.reduceOnly !== true\)/g) || []).length >= 2);
  assert.match(execModule, /LEGACY_ENTRY_PATH_DISABLED_USE_APP_MAIN/);
});

test("contrat execution: ordre accepte seulement avec code, sCode et ordId", () => {
  assert.match(main, /String\(res\.code\) === "0" && ack && String\(ack\.sCode\) === "0" && ack\.ordId/);
  assert.match(main, /MAKER_CANCEL_UNCONFIRMED/);
  assert.match(main, /MAKER_OUTCOME_UNKNOWN/);
  assert.match(main, /\^\\d\+\$.*okxCode/);
  assert.match(main, /MARKET_OUTCOME_UNKNOWN/);
  assert.match(main, /order_intents\.json/);
  assert.match(main, /setOrderIntent\(instId, \{ phase:"maker-submit"/);
  assert.match(main, /Object\.keys\(AI\.orderIntents \|\| \{\}\)\.length/);
});

test("contrat execution: seuls les algos identifies Hermes peuvent etre annules", () => {
  assert.match(main, /function isHermesAlgo\(order\)/);
  assert.match(main, /algoClOrdId: hermesClientId\("oco"\)/);
  assert.match(main, /attachAlgoClOrdId: hermesClientId\("attach"\)/);
  assert.match(main, /if \(!isHermesAlgo\(a\)\) continue/);
  assert.match(main, /algoCleanupInProgress/);
  assert.match(main, /if \(POS_MODE !== "net_mode"\) return false/);
  assert.doesNotMatch(execModule, /AI_ORDER_RETRY_MAX/);
  assert.match(execModule, /__isHermesOwnedAlgo/);
  assert.match(repair, /HERMES_MAINTENANCE_CONFIRM/);
  assert.match(repair, /isHermesOwnedAlgo/);
});

test("contrat promotion: chercheur et roster live sont deux artefacts distincts", () => {
  assert.match(main, /config", "approved-roster\.json/);
  assert.match(deployWorkflow, /exclude '\/config\/approved-roster\.json'/);
  assert.match(main, /dataManifestSha256/);
});

test("contrat metadata: aucune taille ni entree avec catalogue absent ou stale", () => {
  assert.match(main, /assertOkxSuccess\(r\.data, "GET public instruments"\)/);
  assert.match(main, /Date\.now\(\) - MARKET\.metaLoadedAt > 6 \* 3600e3/);
  assert.match(main, /if \(!meta \|\| !\(meta\.lotSz > 0\)/);
});

test("contrat demo: 1 et true sont coherents et le script preserve le mode", () => {
  assert.match(main, /\["1", "true", "yes", "on"\]/);
  assert.match(keys, /OKX_SIMULATED=true/);
});

test("contrat console: ecoute locale par defaut et URL nettoyee", () => {
  assert.match(server, /HERMES_HOST \|\| "127\.0\.0\.1"/);
  assert.match(server, /HERMES_ALLOW_INSECURE_REMOTE/);
  assert.match(server, /Location: "\/"/);
  assert.match(server, /SameSite=Strict/);
});
