"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const okxPath = require.resolve("../modules/okx.js");
const execPath = require.resolve("../modules/exec.js");
let postCalls = 0;
require.cache[okxPath] = {
  id:okxPath,
  filename:okxPath,
  loaded:true,
  exports:{
    okxGET:async () => ({ data:{ code:"0", data:[] } }),
    okxPOST:async () => {
      postCalls++;
      return { data:{ code:"0", data:[{ sCode:"0", ordId:"unexpected" }] } };
    },
  },
};
delete require.cache[execPath];
const legacyExec = require(execPath);

test("exec legacy: l'export reel refuse une entree avant tout POST", async () => {
  postCalls = 0;
  await assert.rejects(
    legacyExec.okxTradeOrderWithGuards({ instId:"BTC-USDT-SWAP", side:"buy", ordType:"market" }),
    /LEGACY_ENTRY_PATH_DISABLED_USE_APP_MAIN/
  );
  assert.equal(postCalls, 0);
});

test("exec legacy: openMarket ne constitue plus une seconde entree", async () => {
  postCalls = 0;
  await assert.rejects(
    legacyExec.openMarket({ instId:"BTC-USDT-SWAP", side:"buy" }),
    /LEGACY_ENTRY_PATH_DISABLED_USE_APP_MAIN/
  );
  assert.equal(postCalls, 0);
});
