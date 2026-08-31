const fs   = require("fs");
const path = require("path");

// Dossiers
const ROOT    = process.cwd();
const DATADIR = process.env.HERMES_DATA_DIR || path.join(ROOT, "data");
const DEALDIR = path.join(DATADIR, "trades-logs");
const START   = Number(process.env.HERMES_SIM_START_EQ || 400); // capital de départ SIM

// Utils
const num = v => Number(v) || 0;
function gatherDeals(dir){
  const out = [];
  try{
    if (!fs.existsSync(dir)) return out;
    const files = fs.readdirSync(dir).filter(n => /^deals_\d{8}\.jsonl$/i.test(n)).sort();
    for (const f of files){
      const full = path.join(dir, f);
      try{
        const txt = (fs.readFileSync(full, "utf8") || "").trim();
        if (!txt) continue;
        for (const line of txt.split(/\r?\n/)){
          try { out.push(JSON.parse(line)); } catch {}
        }
      }catch{}
    }
  }catch{}
  return out;
}

// Lecture deals (réalisés)
const deals = gatherDeals(DEALDIR);
const realized = deals.reduce((a,d) => a + num(d.netProfit ?? d.profit ?? d.pnl ?? 0), 0);
const equity   = START + realized;

// Affichage
function fmt(n){ return (Math.abs(n)>=1 ? n.toFixed(2) : n.toFixed(4)); }
console.log("=== SIM ACCOUNT BALANCE ===");
console.log("Data dir   :", DATADIR);
console.log("Deals dir  :", DEALDIR, "(files:", deals.length ? "yes" : "no", ")");
console.log("Start Eq   :", fmt(START), "USDT");
console.log("Realized   :", (realized>=0?"+":"") + fmt(realized), "USDT");
console.log("--------------------------------");
console.log("SIM Equity :", fmt(equity), "USDT");
console.log("");
