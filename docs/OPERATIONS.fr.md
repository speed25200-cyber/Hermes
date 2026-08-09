# Hermes — Manuel d'exploitation

Ce document s'adresse au propriétaire du système. Hermes fonctionne seul ;
votre rôle se limite à surveiller, décider du passage en réel, et garder
l'accès sécurisé.

## Ce qui tourne sur le serveur (Hetzner CPX32, 178.104.191.79)

| Service systemd | Rôle |
|---|---|
| `hermes` | moteur de trading (paper) : décision à chaque bougie 15 m, battement ~20 s |
| `hermes-research` | one-shot : rattrapage des données + recherche d'alpha, relancé par le moteur (hebdo si le livre est garni, **quotidien s'il est vide**, budget croissant) |
| `hermes-dashboard` | console web (port 8899, protégée par jeton) — l'app sur votre iPhone |

Tout est piloté à distance par les workflows GitHub Actions du dépôt :
`deploy-vps.yml` (déployer + relancer la recherche), `vps-status.yml`
(état complet), `update-dashboard.yml` (interface seule, sans toucher au
calcul en cours).

## La boucle autonome

```
chasse (30 perpétuels × familles directionnelles + 3 livres market-neutral)
  → validation (Sharpe OOS ≥ 0,5 · Deflated Sharpe ≥ 0,05 sur TOUS les
     essais · 3 plis purgés majoritairement positifs · drawdown borné)
    → trading (exécution maker d'abord, risque à 3 étages)
      → surveillance (retours réels par stratégie, EWMA)
        → retrait autonome (Sharpe réel < −0,5 sur 1000+ barres)
          → re-chasse
```

Les seuils de validation ne se règlent pas à la baisse. Jamais. Un passage
de recherche qui ne déploie rien est un verdict, pas une panne.

## Ce qu'il faut regarder sur l'app

- **Equity + P&L de session** : la vérité du paper trading.
- **Strategies live** : le nombre de stratégies déployées et leurs stats
  OOS (Sharpe, DSR). Un DSR proche de 0,05 = validation marginale, à
  confirmer par le réel.
- **Alpha research** : date de la dernière passe, génomes évalués,
  intensité de la traque (escalade si passes vides).
- **Risk envelope** : drawdown vs kill switch 15 %, perte du jour vs −3 %.
- **Bandeau rouge** = halte de risque. Le moteur s'est mis à plat seul.

## Quand envisager le réel — et comment

1. **Plusieurs semaines** de paper trading avec un P&L cohérent avec les
   stats OOS (pas forcément positif chaque jour — cohérent).
2. Survie du livre à au moins une revalidation hebdomadaire (dont la passe
   « 2 ans d'historique »).
3. Alors seulement : créer une clé API OKX **trade-only** (jamais de droit
   de retrait), IP verrouillée sur 178.104.191.79, l'installer dans
   `/root/hermes/.env` (`OKX_API_KEY/SECRET/PASSPHRASE`), commencer par
   `OKX_SIMULATED=1`, puis un capital minime avec `max_gross_leverage`
   réduit. Augmenter uniquement sur preuves durables.

## Sécurité de l'accès

- Le mot de passe root circule aujourd'hui en entrée de workflow (masqué
  dans les journaux). Mieux : le stocker une fois pour toutes dans un
  secret GitHub `VPS_PASSWORD` (Settings → Secrets → Actions) — les
  workflows le prennent automatiquement — puis **changer le mot de passe**
  et ne plus jamais le passer en clair.
- Le jeton du tableau de bord se change dans `deploy/install.sh`
  (`DASH_TOKEN`) suivi d'un déploiement.

## Pannes courantes

| Symptôme | Cause probable | Geste |
|---|---|---|
| App « OFFLINE » | dashboard arrêté | `vps-status.yml`, puis `update-dashboard.yml` |
| Prix figés | moteur arrêté (recherche en cours ?) | `vps-status.yml` : si `hermes-research` est actif, c'est normal — le moteur revient seul |
| 0 stratégie après une passe | verdict honnête | rien : la traque quotidienne escalade seule |
| Bandeau rouge kill switch | drawdown 15 % atteint | décision humaine : analyser avant tout redémarrage |

## Limites assumées

Aucun système ne « trouve toujours » un edge : les marchés n'en offrent
pas en permanence, et un système qui trouverait toujours serait en
surapprentissage — dangereux. Hermes promet autre chose, et le tient :
chercher sans interruption, ne trader que ce qui survit à des preuves
sévères, se retirer seul quand l'edge meurt, et garder les pertes bornées
pendant tout ce temps.
