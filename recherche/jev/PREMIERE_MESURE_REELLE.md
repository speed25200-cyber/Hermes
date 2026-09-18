# Première mesure réelle de Jev — tentative du 18 septembre 2026

*Rapport d'une session Claude Code distante (conteneur éphémère,
`claude.ai/code`), lancée pour faire les premiers appels réels à l'API Jev
(TypeSafe AI) et à OKX, parce que la session qui a écrit `docs/jev.md` ne
pouvait joindre ni `api.typesafe.ai` ni `www.okx.com`. Résultat : cet
environnement-ci ne le peut pas non plus. Rien n'a été mesuré.*

## Ce qui a été joignable

Rien des deux hôtes visés. La sortie HTTPS de cet environnement passe par un
proxy d'egress qui applique la politique réseau de l'organisation ; il a
refusé l'ouverture du tunnel (réponse 403 au `CONNECT`) vers les deux hôtes.

| hôte | commande | code HTTP | corps |
|---|---|---|---|
| `www.okx.com:443` | `curl -sS -o /dev/null -w '%{http_code}' https://www.okx.com/api/v5/public/time` | `000` (`curl: (56) CONNECT tunnel failed, response 403`) | aucun |
| `api.typesafe.ai:443` | `curl -sS -X POST https://api.typesafe.ai/v1/systemone -H "Authorization: Bearer $TYPESAFE_AI_API_KEY" -H 'Content-Type: application/json' -d '{"model":"jev-latest","state":{"x":1},"questions":{"q":{"type":"noul","instructions":"Is x equal to 1?"}}}'` | `000` (`curl: (56) CONNECT tunnel failed, response 403`) | aucun |

Le journal du proxy (`__agentproxy/status`, champ `recentRelayFailures`)
confirme que le refus est une décision de politique, pas une panne de
l'hôte distant :

```
2026-09-18T11:40:27Z  connect_rejected  gateway answered 403 to CONNECT (policy denial or upstream failure)  www.okx.com:443
2026-09-18T11:40:40Z  connect_rejected  gateway answered 403 to CONNECT (policy denial or upstream failure)  api.typesafe.ai:443
```

La documentation du proxy dans l'environnement est explicite : un 403 ou
407 du proxy est un refus de politique de l'organisation, à signaler et
non à contourner. Aucune tentative de contournement n'a été faite.

## Ce qui n'a donc pas été fait

Les étapes 2 à 4 du protocole dépendent toutes d'au moins un des deux
hôtes. Aucune n'a été lancée :

- pas d'appel réel via `modules/jev.js` : la forme exacte des `answers`
  de l'API reste non observée, et `decider` / `probaNoul` / `choix` n'ont
  pas pu être confrontés à une réponse réelle ;
- pas de latence mesurée (ni p50, ni p95) ;
- pas de banc (`deploy/banc_jev_1m.js`) : il a besoin d'OKX pour
  l'histoire 1 m et de Jev pour les réponses ; `config/jev_verdict.json`
  n'existe pas ;
- pas de moteur en observation : `HERMES_STRATEGIE=jev1m` a besoin du
  point *business* d'OKX pour les bougies ;
- pas de calibration (`deploy/calibration_jev.js`) : il n'y a aucune
  décision journalisée à relire.

Aucune correction de code n'a été faite : rien n'a pu être exercé, donc
rien n'a cassé.

## État du dépôt à la fin

- La clé a été écrite dans `.env` à la racine, sous `TYPESAFE_AI_API_KEY`
  et `JEV_API_KEY`. `git check-ignore .env` confirme que le fichier est
  ignoré ; il n'apparaît dans aucun commit.
- `data/` et `config/jev_verdict.json` n'existent pas et ne sont pas
  suivis.
- Les questions de `modules/etat_jev.js` n'ont pas été touchées.
- Aucun ordre n'a pu être passé ni tenté : aucune clé OKX n'est présente,
  et OKX n'est de toute façon pas joignable.

## Ce qu'il reste à faire, et où

Ce que `docs/jev.md` dit reste vrai : la première mesure réelle doit
partir d'une machine qui joint à la fois `www.okx.com` et
`api.typesafe.ai`. Deux voies :

1. Le VPS, par le workflow « VPS status » (entrée `banc_jev` pour le
   banc, `calibration_jev=true` pour la calibration), la clé arrivant par
   le secret de dépôt `TYPESAFE_AI_API_KEY`.
2. Un environnement Claude Code distant dont la politique réseau
   autorise ces deux hôtes (la politique se choisit à la création de
   l'environnement, voir la documentation de Claude Code sur le web). Le
   protocole à rejouer est celui de la mission de cette session, étapes
   1 à 5 ; il tient dans une heure de machine et moins d'un dollar
   d'appels.
