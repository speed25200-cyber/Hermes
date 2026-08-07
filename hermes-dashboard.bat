@echo off
rem ------------------------------------------------------------------
rem  HERMES dashboard launcher (Windows)
rem  Double-click to start the local console; it opens in your browser.
rem  Requires Python 3.10+ on PATH (https://python.org, check "Add to PATH").
rem ------------------------------------------------------------------
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
    echo Python introuvable. Installez Python 3 depuis https://python.org
    echo en cochant "Add Python to PATH", puis relancez ce fichier.
    pause
    exit /b 1
)
python -m hermes dashboard %*
pause
