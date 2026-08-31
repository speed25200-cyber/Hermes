@echo off
REM Retire le demarrage automatique de HERMES (n'affecte pas le bot en cours).
set TASK=HERMES_Trading_AutoStart
schtasks /Delete /TN "%TASK%" /F
echo.
echo Demarrage automatique retire (le bot deja lance continue jusqu'a fermeture).
echo.
pause
