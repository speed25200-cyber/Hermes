const fs = require("fs");
const path = require("path");
let baseDir = null;
function init({ baseDir: dir }){ baseDir = dir; if(!fs.existsSync(baseDir)) fs.mkdirSync(baseDir,{recursive:true}); }
function fileFor(ts){
  const d = new Date(ts); const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,"0"), day=String(d.getDate()).padStart(2,"0");
  return path.join(baseDir, `${y}-${m}-${day}.jsonl`);
}
function logDecision(obj){
  const f = fileFor(obj.ts_open || Date.now());
  fs.appendFileSync(f, JSON.stringify(obj)+"\n");
}
function finishTrade(instId, payload){
  const f = fileFor(Date.now());
  fs.appendFileSync(f, JSON.stringify({ instId, ...payload })+"\n");
}
module.exports = { init, logDecision, finishTrade };
