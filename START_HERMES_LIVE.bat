@echo off
title HERMES V4 - TRADING REEL (auto-redemarrage)
REM ============================================================
REM   HERMES V4 - LANCEMENT TRADING REEL
REM   Spec (validee client 30/08) : marge = (capital-10%%)/10, levier x15,
REM          10 positions, TP +80%% / SL -30%% / trail 5%% active a +10%%,
REM          entrees maker (limite, bascule marche 5 s), long ET short,
REM          protections posees sur OKX, re-verifiees toutes les heures.
REM   Ce lanceur RELANCE le bot automatiquement s'il s'arrete.
REM   Pour COUPER : ferme cette fenetre.
REM ============================================================
cd /d "%~dp0"
set HERMES_AI_DEFAULT_ON=true
set HERMES_DEFAULT_LEVERAGE=15
set HERMES_MAX_POSITIONS=10

:loop
echo [%date% %time%] Demarrage HERMES en TRADING REEL...
call npm start
echo [%date% %time%] HERMES s'est arrete. Relance dans 10 secondes... (Ctrl+C pour stopper)
timeout /t 10 /nobreak >nul
goto loop
