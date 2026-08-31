# AUDIT COMPLET — HERMES_V4_LIVE
**Date :** 29.08.2026 · **Méthode :** 62 agents (architecture, forensique, 6 dimensions techniques + contre-expertise adversariale de chaque défaut majeur) · **Périmètre :** lecture seule, aucune clé testée, aucun ordre passé.

---

## 1. VERDICT GLOBAL

Le bot **fonctionne juste assez pour passer des ordres réels à levier ×20, mais aucune de ses protections n'est opérationnelle.** Ce n'est pas une opinion : ses propres logs le prouvent — **13 entrées en réel, 0 stop-loss posé, 14 rejets d'ordres de protection par OKX.**

Chiffres clés confirmés :
- **54 défauts confirmés** (après réfutation), dont **15 bloquants**.
- PnL réel journalisé : **−0,20 USDT** sur 2 sorties (les 11 autres positions ont « disparu » des logs, WebSocket instable).
- L'« IA » n'influence aucun ordre (fichiers d'apprentissage lus par aucun code).
- 3 copies des clés API OKX **en clair** sur le disque, dont une passée par OneDrive.

**Conclusion : le bot est terminable, mais il faut reconstruire la couche exécution/protection avant tout lancement réel. En l'état, le lancer en live = positions ×20 sans filet.**

---

## 2. CE QUE LE BOT A RÉELLEMENT FAIT (forensique)

| | |
|---|---|
| Trades RÉELS | 13 entrées (17/09 + 02/10/2025), 2 sorties, **toutes perdantes** |
| PnL réel cumulé | **−0,20 USDT** |
| Simulation | 4 min 15 s le 15/09 (+2,39 USDT), jamais reconnectée au compte sim (figé 400→400) |
| Signaux produits | 56 484 en 5 mois, dont **88 % vides** (score 0) |
| Journées d'activité réelles | **5** en 5 mois |
| Dernière activité | 07.02.2026, session de 11 min terminée par un crash |
| « IA » | Gadget : `ai-train.json`/`ai-tuner.json` lus par aucun code ; seul entraînement réel = poids −0,0048 (bruit), corrélation **négative** |

**Le vrai timeframe n'est pas 5 minutes** : le bot décide sur des **bougies synthétiques de 15 secondes** reconstruites depuis les ticks, sur le **top 100 des micro-caps** (MOG, DUCK, USELESS, SWARMS…). La config `strategy.current.json` (5m, supertrend, squeeze) n'a **aucun effet** — elle n'est lue que par un moteur jamais chargé.

---

## 3. LES 15 DÉFAUTS BLOQUANTS (regroupés)

### A. Protection des positions — INEXISTANTE (le cœur du problème)
1. **SL initial systématiquement rejeté** par OKX (body `order-algo` sans `sz`/`orderPx`) → positions nues côté exchange.
2. **Trailing stop rejeté à 100 %** (`side` et `sz` manquants → erreur 50014, 13 fois dans les logs).
3. **Stop de secours calculé en dollars absolus** (±25 $) → sur un jeton à 0,02 $, le stop est à +118 000 % (inatteignable) ; sur EDEN à 0,35 $, `max(0.5, …)` place le « stop » **au-dessus** du prix d'entrée.
4. **Break-even et trailing purement cosmétiques** : `updateDynamicStop` ne modifie qu'une variable en mémoire et **écrit un log de succès** — l'exchange n'est jamais touché (0 appel `amend-algos`/`cancel-algos` dans tout le code).
5. **Aucune logique de fermeture** : le bot ne sait qu'**ouvrir**. Aucun `reduceOnly`/close. Un crash de l'app = positions qui courent jusqu'à liquidation.
6. **Aucun take-profit** sur le chemin automatique (`patch.tp_sl.js` importé mais jamais appelé).

### B. Garde-fous capital — MORTS
7. **Aucune limite de perte journalière, aucun plafond cumulé, aucun arrêt d'urgence** qui ferme les positions.
8. **`modules/exec.js` ne se compile même pas** (`const __AI_STATE_FILE` déclaré 2×, SyntaxError) → **tout le pipeline « avancé » — kill-switch −30 %/−50 %, retries, clOrdId, TP/SL attachés — est mort depuis sept. 2025** (log « modules exec/okx introuvables » à chaque démarrage).
9. **Baseline du kill-switch fictive** : equity et pic de référence **codés en dur à 250 USDT**, jamais persistés → incohérent à chaque redémarrage.
10. **`modules/okx.js` traite les erreurs OKX comme des succès** (ne vérifie ni le statut HTTP ni le code) → sur une simple erreur réseau, l'équité est lue à 0 → le kill-switch se **verrouille définitivement** (`killed=true` persisté), ou pire, un ordre rejeté est cru « exécuté ».

### C. Cohérence & connexions
11. **`posSide` hedge codé en dur** sans détecter le mode du compte → si le compte est en `net_mode`, les ordres sont mal formés (déjà visible dans les données : `side:"NET"`).
12. **Espérance mathématique négative** : profil TP ~0,8 % / SL ~0,425 % + frais taker 2 % de marge (à ×20) → il faut **≥ 42,9 %** de winrate ; un process sans edge en donne ~34,7 % → **≈ −2 % de marge par trade**. Et le profil réellement en production (SL rejeté) est pire : risque = 100 % de la marge.
13. **Heartbeat WebSocket défectueux** : chaque connexion (publique ET privée) est tuée **~11 s après ouverture**, en boucle infinie (97 % des logs) → le bot rate ses propres fermetures de positions, les fills sont perdus.
14. **Stratégie live sur bougies 15 s synthétiques**, alors que tout le pipeline 5 m (WS + prefill REST) est calculé… puis **jamais lu**.
15. **Logs d'interface mensongers** : l'UI affiche « STOP_BE / STOP_TRAIL » et « Connecté OKX » alors que le stop n'existe pas sur l'exchange et que le flux peut être mort.

---

## 4. DÉFAUTS MAJEURS (extraits — 39 au total)

**Bougies (ta priorité) :**
- **Aucun contrôle de fraîcheur (staleness)** avant de trader : le bot peut entrer sur un **prix périmé** si le flux gèle.
- **`pendingSignals` sans péremption** : un signal basé sur une bougie vieille de plusieurs heures peut déclencher un ordre.
- **Repaint** dans le pipeline alternatif : indicateurs calculés sur la bougie **non close** (flag `confirm` d'OKX ignoré).
- **Warmup insuffisant (8 bougies)** : Bollinger dégénéré (`upper=0`) fabrique de faux signaux SHORT.
- **Le « SuperTrend » du score ne peut mathématiquement jamais se déclencher** (ce n'est pas un vrai SuperTrend) → au seuil live, le bot est quasi muet.

**Connexions :**
- **Aucune synchronisation d'horloge serveur** → sur cette VM Windows (déjà restée down 12 jours), la dérive d'horloge ferait échouer **tous** les appels signés (code 50102 non géré).
- **Aucun timeout** sur les requêtes des modules → un ordre peut rester suspendu indéfiniment.
- **Aucun rate-limiter ni retry** sur le chemin vif (le limiteur existant est du code mort) → un 429 = donnée/ordre perdu.
- **Backoff exponentiel jamais effectif** (recréé à chaque reconnexion) → tempête de reconnexions en cas de panne OKX (risque de ban IP).
- **Canal `orders` souscrit mais jamais lu** → PnL calculé sur le dernier ticker, pas le prix de fill réel ; frais ignorés.
- **Pas de réconciliation au démarrage** → positions « fantômes » qui bloquent des slots ; algos orphelins jamais nettoyés.

**Risque/config :**
- **4 sources de config contradictoires**, dont 3 mortes (`risk.json`, `strategy.current.json`, `symbols.whitelist.json` lus par personne).
- **La moitié du `.env` est fantôme** : `DEFAULT_LEVERAGE`, `MAX_POSITIONS_GLOBAL`, `COOLDOWN_LIVE_SEC`, `DESIRED_MARGIN_USDT=180`… ne pilotent **rien**. Le code utilise des constantes en dur.
- **Sizing divergent** : ~1 USDT de marge réelle par trade auto (au lieu de 20 annoncés) mais **200 USDT** par défaut sur un ordre manuel — faux sentiment de contrôle.

**UI/Electron :**
- **Un clic On/Off arme le trading RÉEL** sans confirmation ni indication de mode (aucun badge « COMPTE RÉEL »).
- **`nodeIntegration:true` + `contextIsolation:false`** + injection de données externes = **XSS → accès Node complet** (= lecture des clés API). Le `preload.js` sécurisé est mort.

---

## 5. SÉCURITÉ — À FAIRE IMMÉDIATEMENT

⚠️ **Les clés API OKX doivent être régénérées** (elles sont en clair dans `.env`, `app/.env`, `.env.bak_…`, et le chemin d'origine `C:\Users\isote\OneDrive\…` indique une synchronisation cloud). Après régénération : les stocker hors du dossier, restreindre les permissions (pas de retrait) et **verrouiller par IP** côté OKX.

---

## 6. PLAN DE FINITION ORDONNÉ

L'objectif : un bot **qui protège chaque position et qu'on peut faire tourner en démo d'abord.** Ordre recommandé :

**Phase 0 — Sécuriser & assainir (avant de coder)**
- Régénérer les clés OKX ; supprimer `app/.env`, `.env.bak`, la ligne corrompue.
- Choisir **un seul** moteur : `app/main.js`. Archiver `modules/engine.js`, les ~70 `.bak`, les clients OKX redondants, les patchs morts.
- Réparer la SyntaxError de `exec.js` OU l'abandonner proprement.
- Mettre un vrai **mode démo** unifié (`x-simulated-trading`) + badge « DÉMO / RÉEL » dans l'UI.

**Phase 1 — La couche exécution (le vrai chantier)**
- **Un client OKX unique** : timeout, vérification `code!=0`, retry 429/5xx, rate-limiter, sync horloge serveur.
- **Corriger la pose du SL/TP côté exchange** : `sz`, `side`, `orderPx`, `triggerPx` arrondi au `tickSz` (fin de la notation exponentielle). SL en **% du prix**, pas en dollars absolus.
- **Fermer la position si le stop n'est pas confirmé** (rollback `reduceOnly`).
- **Fonction de fermeture** + réconciliation des positions au démarrage et après chaque reconnexion.

**Phase 2 — Fiabilité des données**
- **Réparer le heartbeat WS** (n'armer le timeout qu'après un ping envoyé) → connexions stables > 1 h.
- Backoff réellement exponentiel ; consommer le canal `orders` (fills/frais réels).
- **Contrôle de fraîcheur** : refuser de trader si la dernière bougie/prix a plus de N secondes ; TTL sur `pendingSignals`.
- Décider du timeframe (15 s **ou** 5 m) et n'en garder qu'un, indicateurs sur bougie **close** uniquement.

**Phase 3 — Risque**
- Kill-switch réel avec baseline persistée ; **limite de perte journalière** + arrêt d'urgence qui **ferme** les positions.
- Une seule source de config ; profil TP/SL revu pour une espérance ≥ 0 après frais.

**Phase 4 — Validation**
- Tourner **en démo** plusieurs jours, vérifier dans les logs : stops posés (`STOP_PLACED`), fermetures détectées, WS stable, PnL = prix de fill réel.
- Puis micro-live (1 position, petite taille) avant tout déploiement.

---
*Aucun fichier du bot n'a été modifié par cet audit.*
