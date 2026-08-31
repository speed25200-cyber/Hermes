// Extraction compacte des signaux (|score|>=2, dir non-null) de sim-logs.jsonl
// -> lab_vagues/fable_signaux.json  (relu par les bancs tools_fable_ancienne_*)
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const LAB = __dirname;

(async () => {
  const signaux = [];
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(LAB, "..", "data", "sim-logs.jsonl")) });
  for await (const l of rl) {
    try {
      const j = JSON.parse(l);
      if (j.dir && Math.abs(j.score) >= 2)
        signaux.push([Date.parse(j.ts), j.instId, (j.dir === "long" || j.dir === 1 || j.dir > 0) ? 1 : -1, +j.score.toFixed(4)]);
    } catch {}
  }
  signaux.sort((a, b) => a[0] - b[0]);
  fs.writeFileSync(path.join(LAB, "fable_signaux.json"), JSON.stringify(signaux));

  // stats par époque + couverture data365
  const d365 = new Set(fs.readdirSync(path.join(LAB, "data365")).map(f => f.replace(".json", "")));
  const epo = ts => { const m = new Date(ts).toISOString().slice(0, 7); return m >= "2026-08" ? "aout26" : (m >= "2026-01" ? "fev26" : "sept-oct25"); };
  const cnt = {}, cov365 = {};
  for (const s of signaux) {
    const e = epo(s[0]);
    cnt[e] = (cnt[e] || 0) + 1;
    if (d365.has(s[1])) cov365[e] = (cov365[e] || 0) + 1;
  }
  console.log("total signaux |score|>=2 :", signaux.length);
  console.log("par époque :", cnt);
  console.log("couverts par data365 :", cov365);
  // bornes temporelles d'août pour le split IS/OOS
  const aout = signaux.filter(s => epo(s[0]) === "aout26").map(s => s[0]);
  console.log("aout26 : de", new Date(aout[0]).toISOString(), "à", new Date(aout[aout.length - 1]).toISOString(),
    "· médiane ts:", new Date(aout[Math.floor(aout.length / 2)]).toISOString());
  // instruments distincts par époque
  const inst = { "sept-oct25": new Set(), "fev26": new Set(), "aout26": new Set() };
  for (const s of signaux) inst[epo(s[0])].add(s[1]);
  for (const e in inst) console.log(e, "instruments distincts:", inst[e].size, "· dont data365:", [...inst[e]].filter(i => d365.has(i)).length);
})();
