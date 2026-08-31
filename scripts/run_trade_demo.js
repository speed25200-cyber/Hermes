(async function () {
  try {
    const fs = require("fs");
    const path = require("path");

    // Se placer à la racine du projet (…/HERMES_V4.4)
    const projectRoot = path.resolve(__dirname, "..");
    process.chdir(projectRoot);

    // Résoudre exec.js en chemin absolu, indépendamment du cwd
    const execPath = path.resolve(__dirname, "..", "modules", "exec.js");
    if (!fs.existsSync(execPath)) {
      console.error("[FATAL] modules/exec.js introuvable :", execPath);
      // Petit coup de main pour déboguer l'arbo :
      try {
        const found = [];
        (function walk(d){
          for (const e of fs.readdirSync(d,{withFileTypes:true})) {
            if (e.name === "node_modules" || e.name.startsWith(".")) continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.isFile() && /exec\.js$/i.test(e.name)) found.push(p);
          }
        })(projectRoot);
        console.error("Exec.js candidats :", found);
      } catch {}
      process.exit(2);
    }

    const exec = require(execPath);
    if (!exec || typeof exec.okxTradeOrderWithGuards !== "function") {
      console.error("[FATAL] okxTradeOrderWithGuards introuvable dans", execPath,
                    "exports=", Object.keys(exec || {}));
      process.exit(3);
    }

    // DEMO par défaut (mets OKX_SIMULATED=0 pour LIVE)
    if (!process.env.OKX_SIMULATED) process.env.OKX_SIMULATED = "1";

    const body = {
      instId: "BTC-USDT-SWAP",
      side: "buy",
      ordType: "market",
      leverage: 20,
      autoBudget: true,                 // equity/10 si activé côté module
      tpPct: 0.20,                      // TP +20% (au marché)
      slPct: 0.30,                      // SL -30% (au marché)
      trailingSpec: { activePct: 0.35, callbackRatio: 0.15 } // +35% => trailing 15%
    };

    console.log("[INFO] CWD   :", process.cwd());
    console.log("[INFO] exec  :", execPath);
    console.log("[INFO] order :", body);

    const res = await exec.okxTradeOrderWithGuards(body);
    console.log("[OK] Ordre envoyé");
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  } catch (e) {
    // Affichage d'erreur utile (message + stack + payload API si présent)
    console.error("[ERROR]", e && e.message);
    if (e && e.stack) console.error(e.stack);
    const data = e?.response?.data || e?.response || e;
    try { console.error("[RAW]", JSON.stringify(data, Object.getOwnPropertyNames(data), 2)); } catch {}
    process.exit(1);
  }
})();
