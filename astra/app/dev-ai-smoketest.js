/**
 * dev-ai-smoketest.js
 * Emet des événements IA synthétiques (INFO, TRAINER_TICK, ...).
 * S'active seulement si HERMES_SMOKE=1 depuis app/main.js.
 */
function safeNowISO(){ try { return (new Date()).toISOString(); } catch { return "" } }

function safeEmit(payload){
  try {
    if (typeof broadcastAILog === "function") {
      broadcastAILog(payload);
    } else if (global && typeof global.broadcastAILog === "function") {
      global.broadcastAILog(payload);
    } else {
      // Pas de canal UI => log console (debug)
      // eslint-disable-next-line no-console
      console.log("[SMOKE->console]", payload);
    }
  } catch (e) {
    try { console.error("[SMOKE emit error]", e && e.message ? e.message : e); } catch {}
  }
}

function startSmokeTest(opts){
  const intervalMs = (opts && Number.isFinite(opts.intervalMs)) ? opts.intervalMs : 1200;
  const durationMs = (opts && Number.isFinite(opts.durationMs)) ? opts.durationMs : 12000;
  const withSim    = !!(opts && opts.withSim); // on peut tester l'effet SIM_SIGNAL si besoin

  // Sequence initiale
  safeEmit("AI_TOGGLE"); // doit ressortir en INFO "Hermes – IA Activée/Désactivée"
  safeEmit({ ts: safeNowISO(), event: "INFO", info: "SmokeTest: démarrage" });

  let tick = 0;
  const id = setInterval(() => {
    tick++;

    // TRAINER_TICK -> doit s'afficher comme INFO lisible (via garde de logs)
    safeEmit({ ts: safeNowISO(), event: "TRAINER_TICK", samples: 100 + tick });

    // INFO "normale" (dédoublonnée si répétée < 5s)
    safeEmit({ ts: safeNowISO(), event: "INFO", info: `SmokeTest: ping #${tick}` });

    // SIM_SIGNAL: selon ta garde UI, il peut être masqué à l'écran (c'est voulu)
    if (withSim) {
      safeEmit({ ts: safeNowISO(), event: "SIM_SIGNAL", instId: "BTC-USDT-SWAP", side: (tick%2?"buy":"sell"), score: 0.73 });
    }
  }, intervalMs);

  setTimeout(() => {
    clearInterval(id);
    safeEmit({ ts: safeNowISO(), event: "INFO", info: "SmokeTest: terminé ✅" });
  }, durationMs);
}

module.exports = { startSmokeTest };
