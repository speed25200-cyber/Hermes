"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8").replace(/^\uFEFF/, "");

function javascriptFiles(directory, prefix = "") {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", "tests", "data", "banc", "recherche"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.join(prefix, entry.name).replace(/\\/g, "/");
    if (entry.isDirectory()) found.push(...javascriptFiles(absolute, relative));
    else if (entry.isFile() && entry.name.endsWith(".js")) found.push(relative);
  }
  return found;
}

function hasDirectTradeMutation(source) {
  const directHttpCall = /(?:\bokxPOST\s*\(|\b(?:req|call|rest)\s*\(\s*["']POST["']\s*,\s*)["']\/api\/v5\/trade\//;
  const websocketOrder = /\bop\s*:\s*["']order["']/;
  const guardedGenericTransport = /function\s+(?:assertLegacyTradeMutationAllowed|assertLegacyOrderIsReduceOnly)\b/;
  return directHttpCall.test(source) || websocketOrder.test(source)
    || (guardedGenericTransport.test(source) && /\/api\/v5\/trade\//.test(source));
}

function loadLegacyGuardModule(relative) {
  const module = { exports: {} };
  const dependencyStubs = {
    "./ratelimit": { RateLimiter: class { enqueue(fn) { return Promise.resolve().then(fn); } } },
    axios: { get: async () => ({}), post: async () => ({}) },
    dotenv: { config() {} },
    ws: class WebSocketStub {},
  };
  vm.runInNewContext(read(relative), {
    Buffer,
    console,
    module,
    exports: module.exports,
    process: { env: {} },
    require(id) { return Object.hasOwn(dependencyStubs, id) ? dependencyStubs[id] : require(id); },
  }, { filename: relative });
  return module.exports;
}

test("le depot n'ajoute aucune voie POST trade hors de l'allowlist auditee", () => {
  const directOrderFiles = javascriptFiles(ROOT)
    .filter((relative) => hasDirectTradeMutation(read(relative)))
    .sort();
  assert.deepEqual(directOrderFiles, [
    "PREUVE_protections.js",
    "REPARER_protections_tick.js",
    "app/main.js",
    "app/patch.tp_sl.js",
    "modules/exec.js",
    "modules/okx-rest.js",
    "modules/okx-trade.js",
    "modules/okx.js",
  ]);
});

test("l'executeur live lie signal et sorties au roster relu a chaque autorisation", () => {
  const main = read("app/main.js");
  const legacyStart = main.indexOf("async function placeMarket()");
  const legacyEnd = main.indexOf("/* ===== Logging", legacyStart);
  const legacy = main.slice(legacyStart, legacyEnd);
  assert.match(legacy, /ENTRY_EXECUTOR_NOT_READY_FAIL_CLOSED/);
  assert.doesNotMatch(legacy, /okxPOST\s*\(/);
  assert.match(main, /function captureEntryAuthority\(instId, expectedStrategy\)/);
  assert.match(main, /approvedStrategySha256,\s*strategyAllowed,/);
  assert.match(main, /instrumentAllowed: strategyAllowed && entryUniverse\.includes/);
  assert.ok((main.match(/captureEntryAuthority\(instId, strategy\)/g) || []).length >= 3);
  assert.match(main, /__hermesEntre\(instId, side, cfg\)/);
  assert.match(main, /placeMarket\(instId, side, approved\[instId\]\)/);
});

test("les clients secondaires refusent une ouverture avant toute I/O", async () => {
  const okx = require("../modules/okx.js");
  const oldRest = loadLegacyGuardModule("modules/okx-rest.js");
  const oldTrader = loadLegacyGuardModule("modules/okx-trade.js");
  const expected = (error) => error?.code === "LEGACY_ENTRY_DISABLED";

  await assert.rejects(
    okx.okxPOST("/api/v5/trade/order", { instId: "BTC-USDT-SWAP", side: "buy" }),
    expected,
  );
  await assert.rejects(
    okx.okxPOST("/api/v5/trade/batch-orders", [{ instId: "BTC-USDT-SWAP", side: "buy" }]),
    expected,
  );
  await assert.rejects(
    okx.okxPOST("/api/v5/trade/amend-order", { instId: "BTC-USDT-SWAP" }),
    expected,
  );
  assert.doesNotThrow(() => okx.assertLegacyTradeMutationAllowed(
    "POST", "/api/v5/trade/batch-orders", [
      { instId: "BTC-USDT-SWAP", side: "sell", reduceOnly: true },
      { instId: "ETH-USDT-SWAP", side: "buy", reduceOnly: true },
    ],
  ));
  assert.doesNotThrow(() => okx.assertLegacyTradeMutationAllowed(
    "POST", "/api/v5/trade/cancel-order", { instId: "BTC-USDT-SWAP", ordId: "1" },
  ));

  for (const guard of [
    okx.assertLegacyTradeMutationAllowed,
    oldRest.assertLegacyOrderIsReduceOnly,
    oldTrader.assertLegacyOrderIsReduceOnly,
  ]) {
    for (const route of [
      "/api/v5/trade/order",
      "/api/v5/trade/order-algo",
      "/api/v5/trade/batch-orders",
    ]) {
      assert.throws(() => guard("POST", route, { reduceOnly: "true" }), expected);
      assert.throws(() => guard("POST", route, [{ reduceOnly: true }, { reduceOnly: false }]), expected);
      assert.doesNotThrow(() => guard("POST", route, [{ reduceOnly: true }]));
    }
    for (const route of [
      "/api/v5/trade/amend-order",
      "/api/v5/trade/mass-cancel",
      "/api/v5/trade/future-entry-endpoint",
    ]) assert.throws(() => guard("POST", route, { reduceOnly: true }), expected);
    for (const route of [
      "/api/v5/trade/cancel-order",
      "/api/v5/trade/cancel-batch-orders",
      "/api/v5/trade/cancel-algos",
    ]) assert.doesNotThrow(() => guard("POST", route, {}));
  }

  const oldRestSource = read("modules/okx-rest.js");
  assert.match(oldRestSource, /async function prv[^\n]*assertLegacyOrderIsReduceOnly\(method,path,body\)/);
});

test("scripts et maintenance restent explicitement non-entry ou reduce-only", () => {
  const proof = read("PREUVE_protections.js");
  assert.match(proof, /LEGACY_REAL_ENTRY_DISABLED_REDUCE_ONLY_REQUIRED/);
  assert.match(proof, /seul --close reduce-only est autorise/);
  assert.doesNotMatch(proof, /attachAlgoOrds/);
  assert.match(read("test_trade.js"), /test_trade\.js desactive/);
  assert.match(read("scripts/run_trade_env.js"), /LEGACY_REAL_ENTRY_DISABLED_USE_APP_MAIN_GATED_EXECUTOR/);
  assert.match(read("scripts/run_trade_demo.js"), /LEGACY_REAL_ENTRY_DISABLED_USE_APP_MAIN_GATED_EXECUTOR/);
  assert.match(read("app/patch.tp_sl.js"), /reduceOnly:\s*true/);
  const repair = read("REPARER_protections_tick.js");
  assert.match(repair, /HERMES_MAINTENANCE_CONFIRM/);
  assert.match(repair, /MAINTENANCE_ENTRY_DISABLED_REDUCE_ONLY_REQUIRED/);
  assert.ok((repair.match(/reduceOnly:\s*true/g) || []).length >= 2);
  const exec = read("modules/exec.js");
  assert.match(exec, /const __legacyReduceOnlyExport = async function\(body\)/);
  assert.match(exec, /module\.exports\.openMarket = async function\(\)[\s\S]*LEGACY_ENTRY_PATH_DISABLED_USE_APP_MAIN/);
  assert.doesNotMatch(exec, /delete order\.reduceOnly/);
  const oldTrader = read("modules/okx-trade.js");
  assert.match(oldTrader, /function assertLegacyOrderIsReduceOnly/);
  assert.match(oldTrader, /async orderWS\(args\)\{assertLegacyOrderIsReduceOnly/);
  assert.match(oldTrader, /placeMarketWithAttach[\s\S]*LEGACY_REAL_ENTRY_DISABLED_USE_APP_MAIN_GATED_EXECUTOR/);
  const shadowLab = read("lab_vagues/fableD_ombre_inverse.js");
  assert.match(shadowLab, /LEGACY_REAL_ENTRY_DISABLED_USE_APP_MAIN_GATED_EXECUTOR/);
  assert.doesNotMatch(shadowLab, /S\.cfg\.entrerReel\s*\(/);
});

test("workflows sensibles sans credential input et actions toutes pinees par SHA", () => {
  const deploy = read(".github/workflows/deploy-vps.yml");
  const status = read(".github/workflows/vps-status.yml");
  const quality = read(".github/workflows/quality-gate.yml");
  for (const workflow of [deploy, status]) {
    assert.doesNotMatch(workflow, /root_password|PW_INPUT/);
    assert.match(workflow, /PW_SECRET:\s*\$\{\{ secrets\.VPS_PASSWORD \}\}/);
    assert.doesNotMatch(workflow, /\.Hermes1|pexpect|password rotated|attempting forced/);
  }
  assert.doesNotMatch(deploy, /HERMES_UNIVERSE_SIZE/);
  const checkoutSha = "11d5960a326750d5838078e36cf38b85af677262";
  assert.match(deploy, new RegExp(`actions/checkout@${checkoutSha}`));
  assert.match(status, new RegExp(`actions/checkout@${checkoutSha}`));
  for (const workflow of [deploy, status, quality]) {
    for (const line of workflow.split(/\r?\n/).filter((item) => /\buses:/.test(item))) {
      assert.match(line, /@[a-f0-9]{40}(?:\s|#|$)/, line);
    }
  }
  for (const deploymentKey of [
    "evidence-public-key.pem",
    "monitoring-public-key.pem",
    "quant-execution-attestation-public-key.pem",
    "quant-cycle-ledger-attestation-public-key.pem",
  ]) {
    assert.match(deploy, new RegExp(`--exclude '/config/${deploymentKey.replace(/\./g, "\\.")}'`));
    assert.match(read(".gitignore"), new RegExp(`^/config/${deploymentKey.replace(/\./g, "\\.")}$`, "m"));
  }
});

test("install systemd active les chemins seeker/autopilot sans masquer leur echec", () => {
  const install = read("deploy/install.sh");
  assert.match(install, /ExecStart=\/usr\/bin\/env node deploy\/chercher_perles\.js/);
  assert.match(install, /ExecStart=\/usr\/bin\/env node deploy\/autopilot_cycle\.js/);
  for (const command of [
    "systemctl enable hermes",
    "systemctl enable --now hermes-perles.timer",
    "systemctl enable --now hermes-autopilot.timer",
    "systemctl start --no-block hermes-perles.service",
  ]) {
    const line = install.split(/\r?\n/).find((item) => item.includes(command));
    assert.ok(line, command);
    assert.doesNotMatch(line, /\|\|\s*true/);
  }
  assert.match(install, /OnUnitActiveSec=30min/);
  assert.match(install, /OnUnitActiveSec=5min/);
});

test("seeker et compilateur partagent le lock du catalogue", () => {
  const seeker = read("deploy/chercher_perles.js");
  const compiler = read("deploy/compiler_preuve_quantitative.js");
  assert.match(seeker, /`\$\{path\.resolve\(file\)\}\.quant\.lock`/);
  assert.match(seeker, /fs\.openSync\(lockFile, "wx", 0o600\)/);
  assert.match(seeker, /await withCandidateCatalogLock\(CANDIDATE_CATALOG/);
  assert.match(seeker, /mergeCandidateCatalog\(previousCatalog, discoveredCandidates/);
  assert.match(compiler, /`\$\{file\}\.quant\.lock`/);
  assert.match(compiler, /fs\.openSync\(lockFile, "wx", 0o600\)/);
});
