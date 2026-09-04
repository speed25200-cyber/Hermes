"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isUniverseSnapshotFresh, selectOkxTopMovers } = require("../modules/okx_top_movers.js");

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-04T12:00:00.000Z");

function fixtures(count = 35) {
  const swapTickers = [];
  const swapInstruments = [];
  const spotInstruments = [];
  for (let index = 0; index < count; index++) {
    const asset = `T${String(index).padStart(2, "0")}`;
    const swap = `${asset}-USDT-SWAP`;
    swapTickers.push({
      instId: swap,
      ts: String(NOW - 1_000),
      last: String(100 + index),
      open24h: "100",
      volCcy24h: "100000",
      bidPx: String(99.98 + index),
      askPx: String(100.02 + index),
    });
    swapInstruments.push({
      instId: swap,
      state: "live",
      ruleType: "normal",
      instCategory: "1",
      settleCcy: "USDT",
      listTime: String(NOW - 365 * DAY),
    });
    spotInstruments.push({
      instId: `${asset}-USDT`, state: "live", ruleType: "normal",
      instCategory: "1", quoteCcy: "USDT",
    });
  }
  return { swapTickers, swapInstruments, spotInstruments };
}

test("selectionne exactement les 30 mouvements absolus et reste deterministe", () => {
  const input = fixtures();
  const first = selectOkxTopMovers({ ...input, asOfMs: NOW });
  const second = selectOkxTopMovers({ ...input, asOfMs: NOW });
  assert.equal(first.accepted, true);
  assert.equal(first.selected.length, 30);
  assert.equal(first.selected[0].instId, "T34-USDT-SWAP");
  assert.equal(first.snapshotSha256, second.snapshotSha256);
  assert.equal(first.sourceManifest.swapTickersCount, 35);
  assert.equal(new Set(first.selected.map((row) => row.instId)).size, 30);
});

test("exclut categories tokenisees, listing recent, ticker futur et spot absent", () => {
  const input = fixtures(34);
  input.swapInstruments[0].instCategory = "3";
  input.swapInstruments[1].listTime = String(NOW - 10 * DAY);
  input.swapTickers[2].ts = String(NOW + 1);
  input.spotInstruments = input.spotInstruments.filter((row) => row.instId !== "T03-USDT");
  const result = selectOkxTopMovers({ ...input, asOfMs: NOW });
  assert.equal(result.accepted, true);
  assert.equal(result.selected.length, 30);
  const reasons = new Map(result.excluded.map((row) => [row.instId, row.reasons]));
  assert.ok(reasons.get("T00-USDT-SWAP").includes("categorie_non_crypto"));
  assert.ok(reasons.get("T01-USDT-SWAP").includes("anciennete_insuffisante"));
  assert.ok(reasons.get("T02-USDT-SWAP").includes("ticker_perime_ou_futur"));
  assert.ok(reasons.get("T03-USDT-SWAP").includes("spot_couverture_absent"));
});

test("echoue ferme si trente actifs conformes ne sont pas disponibles", () => {
  const input = fixtures(29);
  const result = selectOkxTopMovers({ ...input, asOfMs: NOW });
  assert.equal(result.accepted, false);
  assert.equal(result.selected.length, 29);
  assert.equal(result.rejectionReason, "moins_de_30_instruments_eligibles");
});

test("refuse toute configuration autre que top 30", () => {
  const input = fixtures();
  assert.throws(() => selectOkxTopMovers({ ...input, asOfMs: NOW, config: { topN: 20 } }), /exactement 30/);
});

test("un Top30 expire ne peut plus autoriser une entree si le timer derive", () => {
  const asOfMs = 1_700_000_000_000;
  const validUntilMs = asOfMs + 60 * 60_000;
  assert.equal(isUniverseSnapshotFresh({ asOfMs, validUntilMs, nowMs: validUntilMs }), true);
  assert.equal(isUniverseSnapshotFresh({ asOfMs, validUntilMs, nowMs: validUntilMs + 1 }), false);
  assert.equal(isUniverseSnapshotFresh({ asOfMs, validUntilMs, nowMs: asOfMs - 1 }), false);
  assert.equal(isUniverseSnapshotFresh({ asOfMs: null, validUntilMs, nowMs: asOfMs }), false);
});

test("rejette les metadonnees partielles et les doublons au lieu de supposer normal", () => {
  const input = fixtures(34);
  delete input.swapInstruments[0].ruleType;
  delete input.swapInstruments[1].settleCcy;
  delete input.spotInstruments[2].ruleType;
  const result = selectOkxTopMovers({ ...input, asOfMs: NOW });
  const reasons = new Map(result.excluded.map((row) => [row.instId, row.reasons]));
  assert.ok(reasons.get("T00-USDT-SWAP").includes("regle_non_normale"));
  assert.ok(reasons.get("T01-USDT-SWAP").includes("mauvaise_devise_reglement"));
  assert.ok(reasons.get("T02-USDT-SWAP").includes("spot_couverture_absent"));
  assert.throws(() => selectOkxTopMovers({
    ...input,
    swapTickers: [...input.swapTickers, input.swapTickers[3]],
    asOfMs: NOW,
  }), /duplique/);
});
