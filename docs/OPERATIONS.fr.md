# Hermes — Manuel d'exploitation

Ce document s'adresse au propriétaire du système. Hermes fonctionne seul ;
votre rôle se limite à surveiller, décider du passage en réel, et garder
l'accès sécurisé.

## Ce qui tourne sur le serveur (Hetzner CPX32, 178.104.191.79)

| Service systemd | Rôle |
|---|---|
| `hermes` | moteur de trading (paper) : décision à chaque bougie 1 h, battement 20 s, recherche en tâche de fond |
| `hermes-research` | one-shot : rattrapage des données + recherche d'alpha, relancé par le moteur (hebdo si le livre est garni, **quotidien s'il est vide**, budget croissant) |
| `hermes-dashboard` | console web (port 8899, protégée par jeton) — l'app sur votre iPhone |

Tout est piloté à distance par les workflows GitHub Actions du dépôt :
`deploy-vps.yml` (déployer + relancer la recherche), `vps-status.yml`
(état complet), `update-dashboard.yml` (interface seule, sans toucher au
calcul en cours).

## La boucle autonome (moteur v2)

```
chasse : une RÈGLE appliquée à tout l'univers (majeurs + top-40 perpétuels
         par volume, bougies 1 h, jusqu'à 5 ans), évaluée comme un livre —
         jamais une courbe ajustée à une pièce. Un nom n'est investissable à
         l'instant t que s'il était dans le top-30 par volume glissant 30 j
         à cet instant (biais du survivant contrôlé, en recherche comme en réel)
  → audit de sur-apprentissage (CSCV / PBO sur toutes les règles évaluées :
     si le vainqueur in-sample ne tient pas hors échantillon dans les 252
     découpages, la passe entière est disqualifiée)
    → épreuve hors échantillon (35 % finaux, embargo 3 jours, une seule fois :
       Sharpe ≥ 0,7 · Deflated Sharpe ≥ 0,5 facturé pour les 10 règles testées ·
       drawdown ≤ 30 % · 4 plis purgés majoritairement positifs)
      → livres market-neutral (carry de financement, momentum, réversion,
         suiveurs de BTC) soumis à la même épreuve
        → contrôle du livre : les survivants doivent passer le seuil ENSEMBLE
          → trading (maker d'abord, bande de non-échange, risque à 3 étages)
            → surveillance (retours réels par règle, EWMA, pénalité de foule)
              → retrait autonome (Sharpe réel < −0,5 après 30 jours)
                → re-chasse (hebdo ; quotidienne si le livre est vide)
```

Les seuils de validation ne se règlent pas à la baisse. Jamais. Un passage
de recherche qui ne déploie rien est un verdict, pas une panne.

Preuves sur données réelles (`docs/RESEARCH_EVIDENCE.md`) : sur 5 ans de
l'univers liquide OKX, une seule règle passe la porte — le **momentum
cross-sectionnel à 1 semaine** parmi les 30 perpétuels les plus traités
(Sharpe holdout 1,03, DSR 0,52, drawdown max 23 %, positif 5 années sur 6).
C'est ce que le moteur déploiera en paper à la première passe sur le VPS,
si les données fraîches le confirment.

Le bureau intraday (horloges 1 m–15 m, flux L2) est **désactivé** : son
« holdout » unique n'a aucun contrôle de tests multiples et son économie
après frais n'est pas prouvée. Il reste dans le code pour la recherche.

Au premier démarrage d'une nouvelle version du moteur, l'état écrit par
l'ancienne (registre, livre papier, kill switch) est archivé dans
`state/archive-v*/` et ne pilote plus rien.

## Ce qu'il faut regarder sur l'app

- **Equity + P&L de session** : la vérité du paper trading.
- **Strategies live** : le nombre de stratégies déployées et leurs stats
  OOS (Sharpe, DSR). Un DSR proche de 0,05 = validation marginale, à
  confirmer par le réel.
- **Alpha research** : date de la dernière passe, génomes évalués,
  intensité de la traque (escalade si passes vides).
- **Risk envelope** : drawdown vs kill switch 20 %, perte du jour vs −4 %.
- **Alpha research** affiche aussi le PBO de la dernière passe : > 50 % =
  la recherche classait du bruit, rien n'a pu être déployé de l'évolution.
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

## Mise en ligne du moteur v2 (à faire une fois)

Le mot de passe root du VPS n'est stocké nulle part dans le dépôt (les
mises en ligne précédentes le saisissaient à la main). Deux façons :

1. **Recommandé** — poser une fois le secret `VPS_PASSWORD` (Settings →
   Secrets and variables → Actions → New repository secret). Dès lors,
   chaque push sur `main` ou sur une branche `claude/hermes-autonomous-
   strategy-engine-*` déploie tout seul, et le workflow « Deploy Hermes to
   VPS » peut être lancé sans rien saisir.
2. Actions → « Deploy Hermes to VPS » → *Run workflow* → branche
   `claude/hermes-autonomous-strategy-engine-v65fme` → renseigner
   `root_password`.

Ce que fait la mise en ligne : rsync du dépôt, retrait des unités du
moteur Node précédent (`hermes-perles.*`), installation des unités
Python (`hermes`, `hermes-research`, `hermes-dashboard`), puis
`hermes-research` (backfill 5 ans de l'univers dynamique ≈ 1 h, recherche
≈ 30 min) qui relance le moteur en paper. L'état de l'ancien moteur est
archivé dans `state/archive-v*/`. Vérifier ensuite avec « VPS status ».

**Attention** : le moteur Node actuellement en place trade en réel
(clés OKX présentes dans `/root/hermes/.env`, ~8 USDT d'équité). La mise en
ligne l'arrête ; ses positions ouvertes éventuelles ne sont pas fermées
par Hermes — vérifier le compte OKX. Le moteur v2 démarre en **paper** et
n'envoie aucun ordre réel tant que `hermes.service` n'est pas passé en
`--mode live`.

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
| Bandeau rouge kill switch | drawdown 20 % atteint | décision humaine : analyser avant tout redémarrage |

## Limites assumées

Aucun système ne « trouve toujours » un edge : les marchés n'en offrent
pas en permanence, et un système qui trouverait toujours serait en
surapprentissage — dangereux. Hermes promet autre chose, et le tient :
chercher sans interruption, ne trader que ce qui survit à des preuves
sévères, se retirer seul quand l'edge meurt, et garder les pertes bornées
pendant tout ce temps.
