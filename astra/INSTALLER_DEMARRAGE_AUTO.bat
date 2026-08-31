@echo off
REM ============================================================
REM   Installe HERMES en DEMARRAGE AUTOMATIQUE (tache planifiee).
REM   -> le bot se lance a chaque ouverture de session Windows
REM      et se relance seul s'il plante (boucle du START .bat).
REM   A lancer UNE FOIS, en tant qu'administrateur (clic droit >
REM   Executer en tant qu'administrateur).
REM   Pour desinstaller : DESINSTALLER_DEMARRAGE_AUTO.bat
REM ============================================================
set TASK=HERMES_Trading_AutoStart
set BAT=%~dp0START_HERMES_LIVE.bat

schtasks /Create /TN "%TASK%" /TR "cmd /c \"%BAT%\"" /SC ONLOGON /RL HIGHEST /F
if %errorlevel%==0 (
  echo.
  echo [OK] Demarrage automatique installe.
  echo Le bot HERMES se lancera a chaque ouverture de session Windows.
  echo Pour le demarrer MAINTENANT sans attendre : schtasks /Run /TN "%TASK%"
) else (
  echo.
  echo [ERREUR] Echec — relance ce fichier en tant qu'administrateur.
)
echo.
pause
