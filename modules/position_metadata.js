"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 1;
const MAX_HOLD_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_ENTRY_MATCH_MS = 15 * 60 * 1000;

function timestamp(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function side(value) {
  const normalized = String(value || "").toLowerCase();
  return normalized === "long" || normalized === "short" ? normalized : null;
}

function normalizeTimedExitRecord(instId, raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`metadata ${instId}: objet absent`);
  if (!instId || (raw.instId && String(raw.instId) !== instId)) throw new Error(`metadata ${instId}: instrument incoherent`);

  const normalizedSide = side(raw.side);
  const enteredAt = timestamp(raw.enteredAt);
  const holdMs = timestamp(raw.holdMs);
  let holdUntil = timestamp(raw.holdUntil);
  if (!normalizedSide) throw new Error(`metadata ${instId}: side invalide`);
  if (!enteredAt || enteredAt > now + MAX_FUTURE_SKEW_MS) throw new Error(`metadata ${instId}: entree invalide`);
  if (!holdMs || holdMs > MAX_HOLD_MS) throw new Error(`metadata ${instId}: duree invalide`);

  const expectedDeadline = enteredAt + holdMs;
  let reconstructed = false;
  if (!holdUntil) {
    holdUntil = expectedDeadline;
    reconstructed = true;
  }
  if (Math.abs(holdUntil - expectedDeadline) > 1000) throw new Error(`metadata ${instId}: deadline incoherente`);

  const posId = raw.posId == null || raw.posId === "" ? null : String(raw.posId);
  return {
    record: { instId, side: normalizedSide, enteredAt, holdMs, holdUntil, posId },
    reconstructed,
  };
}

function createTimedExitRecord({ instId, side: rawSide, enteredAt, holdMs, holdUntil, posId }, options) {
  if (!instId || typeof instId !== "string") throw new Error("metadata: instId absent");
  return normalizeTimedExitRecord(instId, { instId, side: rawSide, enteredAt, holdMs, holdUntil, posId }, options).record;
}

function emptyLedger() {
  return { schemaVersion: SCHEMA_VERSION, updatedAt: Date.now(), positions: {} };
}

function readTimedExitLedger(file, options) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing", ledger: emptyLedger(), reconstructed: false };
    throw new Error(`registre timed-exit illisible: ${error.message}`);
  }
  if (!parsed || Number(parsed.schemaVersion) !== SCHEMA_VERSION
      || !parsed.positions || typeof parsed.positions !== "object" || Array.isArray(parsed.positions)) {
    throw new Error("registre timed-exit invalide");
  }

  const ledger = emptyLedger();
  let reconstructed = false;
  for (const [instId, raw] of Object.entries(parsed.positions)) {
    const normalized = normalizeTimedExitRecord(instId, raw, options);
    ledger.positions[instId] = normalized.record;
    reconstructed ||= normalized.reconstructed;
  }
  ledger.updatedAt = timestamp(parsed.updatedAt) || Date.now();
  return { status: "ok", ledger, reconstructed };
}

/* Ecriture durable minimale : fichier temporaire dans le meme repertoire,
   fsync du contenu, rename atomique, puis fsync du repertoire quand l'OS
   l'autorise. Un crash ne peut donc pas laisser un JSON partiellement ecrit. */
function writeTimedExitLedgerAtomic(file, ledger) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const normalized = emptyLedger();
  for (const [instId, raw] of Object.entries(ledger?.positions || {})) {
    normalized.positions[instId] = normalizeTimedExitRecord(instId, raw).record;
  }
  normalized.updatedAt = Date.now();

  const tmp = `${file}.${process.pid}.${normalized.updatedAt}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(normalized, null, 2) + "\n", "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    try {
      const dirFd = fs.openSync(dir, "r");
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch {
      // Windows ne permet pas toujours fsync sur un repertoire; le rename
      // atomique et le fsync du fichier restent acquis.
    }
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
  }
  ledger.schemaVersion = normalized.schemaVersion;
  ledger.updatedAt = normalized.updatedAt;
  ledger.positions = normalized.positions;
  return normalized;
}

function matchTimedExitRecord(rawRecord, exchangePosition, {
  now = Date.now(),
  maxEntryMatchMs = DEFAULT_ENTRY_MATCH_MS,
} = {}) {
  const instId = String(exchangePosition?.instId || "");
  if (!rawRecord) return { ok: false, reason: "metadata_absente" };

  let record;
  try {
    record = normalizeTimedExitRecord(instId, rawRecord, { now }).record;
  } catch (error) {
    return { ok: false, reason: "metadata_invalide", detail: error.message };
  }
  const exchangeSide = side(exchangePosition?.side || exchangePosition?.posSide);
  if (!exchangeSide || exchangeSide !== record.side) return { ok: false, reason: "side_incoherent" };

  const exchangePosId = exchangePosition?.posId == null || exchangePosition.posId === ""
    ? null : String(exchangePosition.posId);
  const exchangeCTime = timestamp(exchangePosition?.cTime);
  if (record.posId && exchangePosId && record.posId !== exchangePosId) {
    return { ok: false, reason: "position_id_incoherent" };
  }
  const comparablePosId = Boolean(record.posId && exchangePosId);
  const matchingPosId = Boolean(comparablePosId && record.posId === exchangePosId);
  const matchingCTime = Boolean(exchangeCTime
    && Math.abs(exchangeCTime - record.enteredAt) <= maxEntryMatchMs);
  if (exchangeCTime && !matchingCTime) {
    return { ok: false, reason: "heure_entree_incoherente" };
  }
  /* Un identifiant stocke ne prouve rien si le snapshot ne fournit rien
     a comparer. Reciproquement, ne jamais lier un nouveau posId sur le
     seul couple instrument/cote : il faut alors une heure compatible. */
  if (!matchingPosId && !matchingCTime) return { ok: false, reason: "identite_exchange_absente" };

  const bound = Boolean(!record.posId && exchangePosId && matchingCTime);
  if (bound) record = { ...record, posId: exchangePosId };
  return { ok: true, record, bound };
}

function destructiveSnapshotDecision(snapshot, state = {}) {
  if (snapshot?.authoritative !== true) return { allowed:false, reason:"snapshot_non_autoritatif" };
  const startedAt = timestamp(snapshot.startedAt);
  const completedAt = timestamp(snapshot.completedAt);
  const generationAtStart = Number(snapshot.generationAtStart);
  const currentGeneration = Number(state.currentGeneration);
  if (!startedAt || !completedAt || completedAt < startedAt) {
    return { allowed:false, reason:"snapshot_non_date" };
  }
  if (!Number.isSafeInteger(generationAtStart) || !Number.isSafeInteger(currentGeneration)
      || generationAtStart !== currentGeneration) {
    return { allowed:false, reason:"generation_modifiee" };
  }
  if (startedAt < Number(state.lastMutationAt || 0)) {
    return { allowed:false, reason:"snapshot_anterieur_mutation" };
  }
  if (Number(state.inflight || 0) > 0 || Number(state.pendingCount || 0) > 0
      || Number(state.intentCount || 0) > 0) {
    return { allowed:false, reason:"mutation_en_cours" };
  }
  return { allowed:true, reason:null };
}

function parsePositionWsUpdate(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok:false, reason:"payload_invalide" };
  const instId = typeof raw.instId === "string" ? raw.instId.trim() : "";
  if (!instId) return { ok:false, reason:"instrument_absent" };
  if (!Object.prototype.hasOwnProperty.call(raw, "pos") || raw.pos === "") {
    return { ok:false, reason:"taille_absente", instId };
  }
  const size = Number(raw.pos);
  if (!Number.isFinite(size)) return { ok:false, reason:"taille_invalide", instId };
  if (size === 0) return { ok:true, type:"flat-hint", instId, size:0 };

  const posSide = String(raw.posSide || "").toLowerCase();
  let normalizedSide = null;
  if (posSide === "long" || posSide === "short") normalizedSide = posSide;
  else if (posSide === "net") normalizedSide = size < 0 ? "short" : "long";
  if (!normalizedSide) return { ok:false, reason:"side_absent", instId };

  return {
    ok:true, type:"open", instId, size:Math.abs(size), side:normalizedSide,
    posId:raw.posId == null || raw.posId === "" ? null : String(raw.posId),
    cTime:timestamp(raw.cTime),
  };
}

module.exports = {
  SCHEMA_VERSION,
  MAX_HOLD_MS,
  createTimedExitRecord,
  emptyLedger,
  readTimedExitLedger,
  writeTimedExitLedgerAtomic,
  matchTimedExitRecord,
  destructiveSnapshotDecision,
  parsePositionWsUpdate,
};
