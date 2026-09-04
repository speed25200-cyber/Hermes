"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createTimedExitRecord,
  emptyLedger,
  readTimedExitLedger,
  writeTimedExitLedgerAtomic,
  matchTimedExitRecord,
  destructiveSnapshotDecision,
  parsePositionWsUpdate,
} = require("../modules/position_metadata.js");

function temporaryLedger(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-timed-exit-"));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  return { dir, file:path.join(dir, "position_metadata.json") };
}

test("registre timed-exit: ecriture atomique et relecture exacte", (t) => {
  const { dir, file } = temporaryLedger(t);
  const enteredAt = Date.now() - 10_000;
  const ledger = emptyLedger();
  ledger.positions["BTC-USDT-SWAP"] = createTimedExitRecord({
    instId:"BTC-USDT-SWAP", side:"long", enteredAt, holdMs:8 * 3600e3,
    holdUntil:enteredAt + 8 * 3600e3, posId:"42",
  });

  writeTimedExitLedgerAtomic(file, ledger);
  /* Le second passage prouve aussi le remplacement atomique d'un fichier
     existant, notamment sur le runtime Windows utilise en developpement. */
  writeTimedExitLedgerAtomic(file, ledger);
  const loaded = readTimedExitLedger(file);

  assert.equal(loaded.status, "ok");
  assert.deepEqual(loaded.ledger.positions["BTC-USDT-SWAP"], ledger.positions["BTC-USDT-SWAP"]);
  assert.deepEqual(fs.readdirSync(dir), ["position_metadata.json"]);
});

test("registre timed-exit: reconstruit une deadline absente depuis entree + duree", (t) => {
  const { file } = temporaryLedger(t);
  const enteredAt = Date.now() - 1000;
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion:1,
    positions:{ "ETH-USDT-SWAP":{ instId:"ETH-USDT-SWAP", side:"short", enteredAt, holdMs:12 * 3600e3 } },
  }));

  const loaded = readTimedExitLedger(file);
  assert.equal(loaded.reconstructed, true);
  assert.equal(loaded.ledger.positions["ETH-USDT-SWAP"].holdUntil, enteredAt + 12 * 3600e3);
});

test("reconcile timed-exit: lie le posId seulement si side et heure correspondent", () => {
  const enteredAt = Date.now() - 5000;
  const record = createTimedExitRecord({
    instId:"SOL-USDT-SWAP", side:"long", enteredAt, holdMs:24 * 3600e3,
    holdUntil:enteredAt + 24 * 3600e3,
  });
  const result = matchTimedExitRecord(record, {
    instId:"SOL-USDT-SWAP", side:"long", cTime:enteredAt - 250, posId:"position-7",
  });

  assert.equal(result.ok, true);
  assert.equal(result.bound, true);
  assert.equal(result.record.posId, "position-7");
});

test("reconcile timed-exit: refuse une position remplacee ou de cote oppose", () => {
  const enteredAt = Date.now() - 5000;
  const record = createTimedExitRecord({
    instId:"DOGE-USDT-SWAP", side:"long", enteredAt, holdMs:8 * 3600e3,
    holdUntil:enteredAt + 8 * 3600e3, posId:"original",
  });

  assert.equal(matchTimedExitRecord(record, {
    instId:"DOGE-USDT-SWAP", side:"long", cTime:enteredAt, posId:"replacement",
  }).reason, "position_id_incoherent");
  assert.equal(matchTimedExitRecord(record, {
    instId:"DOGE-USDT-SWAP", side:"short", cTime:enteredAt, posId:"original",
  }).reason, "side_incoherent");
});

test("reconcile timed-exit: refuse l'absence de metadata ou d'identite exchange", () => {
  const enteredAt = Date.now() - 5000;
  const record = createTimedExitRecord({
    instId:"XRP-USDT-SWAP", side:"short", enteredAt, holdMs:8 * 3600e3,
    holdUntil:enteredAt + 8 * 3600e3,
  });
  assert.equal(matchTimedExitRecord(null, { instId:"XRP-USDT-SWAP", side:"short" }).reason, "metadata_absente");
  assert.equal(matchTimedExitRecord(record, { instId:"XRP-USDT-SWAP", side:"short" }).reason, "identite_exchange_absente");
  assert.equal(matchTimedExitRecord(record, {
    instId:"XRP-USDT-SWAP", side:"short", posId:"nouvelle-position",
  }).reason, "identite_exchange_absente");

  const boundRecord = { ...record, posId:"position-originale" };
  assert.equal(matchTimedExitRecord(boundRecord, {
    instId:"XRP-USDT-SWAP", side:"short",
  }).reason, "identite_exchange_absente");
});

test("snapshot: seul un relevé autoritatif, stable et postérieur peut supprimer", () => {
  const base = { authoritative:true, startedAt:2000, completedAt:2100, generationAtStart:4 };
  const state = { currentGeneration:4, lastMutationAt:1900, inflight:0, pendingCount:0, intentCount:0 };
  assert.equal(destructiveSnapshotDecision(base, state).allowed, true);
  assert.equal(destructiveSnapshotDecision({ ...base, authoritative:false }, state).reason, "snapshot_non_autoritatif");
  assert.equal(destructiveSnapshotDecision({ ...base, generationAtStart:3 }, state).reason, "generation_modifiee");
  assert.equal(destructiveSnapshotDecision({ ...base, startedAt:1800 }, state).reason, "snapshot_anterieur_mutation");
  assert.equal(destructiveSnapshotDecision(base, { ...state, pendingCount:1 }).reason, "mutation_en_cours");
  assert.equal(destructiveSnapshotDecision(base, { ...state, intentCount:1 }).reason, "mutation_en_cours");
});

test("WS positions: un paquet incomplet n'est jamais transforme en fermeture", () => {
  assert.deepEqual(parsePositionWsUpdate({ instId:"BTC-USDT-SWAP" }), {
    ok:false, reason:"taille_absente", instId:"BTC-USDT-SWAP",
  });
  assert.equal(parsePositionWsUpdate({ instId:"BTC-USDT-SWAP", pos:"NaN" }).reason, "taille_invalide");
  assert.equal(parsePositionWsUpdate({ instId:"BTC-USDT-SWAP", pos:"-2" }).reason, "side_absent");
  assert.equal(parsePositionWsUpdate({ instId:"BTC-USDT-SWAP", pos:"0" }).type, "flat-hint");
  assert.deepEqual(parsePositionWsUpdate({ instId:"BTC-USDT-SWAP", pos:"-2", posSide:"net" }), {
    ok:true, type:"open", instId:"BTC-USDT-SWAP", size:2, side:"short", posId:null, cTime:null,
  });
});

test("registre timed-exit: un contenu corrompu n'est jamais accepte", (t) => {
  const { file } = temporaryLedger(t);
  fs.writeFileSync(file, "{pas-du-json");
  assert.throws(() => readTimedExitLedger(file), /registre timed-exit illisible/);
});
