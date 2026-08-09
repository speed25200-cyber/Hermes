# Hermes sur iOS

## L'essentiel, honnêtement

**Le moteur de trading ne peut pas tourner sur un iPhone.** iOS suspend les
applications quelques secondes après leur passage en arrière-plan : aucune
app ne peut maintenir une boucle de trading 24/7, ni la recherche d'edge, ni
le risk engine. C'est une restriction d'Apple qui s'applique à tout système
de trading autonome.

L'architecture correcte — celle de tous les systèmes professionnels :

```
┌─────────────────────────────┐         ┌──────────────────┐
│  PC / VPS (toujours allumé) │  HTTPS  │      iPhone       │
│  moteur Hermes :            │ ◄─────► │  console Hermes : │
│  recherche, prédiction,     │         │  equity, book,    │
│  risque, exécution OKX      │         │  risque, ordres   │
└─────────────────────────────┘         └──────────────────┘
```

**Toutes les informations** d'Hermes sont sur l'iPhone (equity, positions,
stratégies, régimes, ordres, log, kill-switch visible en direct). **Toute
l'exécution** reste sur la machine qui ne dort jamais.

## Installation (2 minutes, sans App Store)

Le dashboard est une Progressive Web App : installée depuis Safari, elle a
son icône, s'ouvre en plein écran sans barre d'adresse et se comporte comme
une app native.

1. Sur le PC/VPS : `python -m hermes dashboard --no-browser`
   (le serveur écoute sur le port 8899).
2. Mettez l'iPhone sur le même réseau que la machine — ou mieux, installez
   [Tailscale](https://tailscale.com) (gratuit) sur les deux appareils pour
   un accès sécurisé depuis n'importe où.
3. Dans Safari sur l'iPhone, ouvrez `http://<ip-de-la-machine>:8899`
   (avec Tailscale : `http://<nom-tailscale-de-la-machine>:8899`).
4. Bouton **Partager** → **Sur l'écran d'accueil** → **Ajouter**.

L'icône Hermes apparaît sur l'écran d'accueil ; l'app s'ouvre en plein
écran et se met à jour en direct toutes les 2,5 secondes.

> Sécurité : le serveur écoute par défaut sur `127.0.0.1` (localhost seul).
> Pour y accéder depuis l'iPhone, lancez-le avec `--host 0.0.0.0`
> **uniquement sur un réseau de confiance**, ou gardez `127.0.0.1` et
> passez par Tailscale (`tailscale serve` fait le pont proprement, chiffré).
> N'exposez jamais le port 8899 directement sur Internet.

## Coquille native SwiftUI (optionnelle)

Le dossier `HermesConsole/` contient une mini-app SwiftUI (3 fichiers) pour
ceux qui préfèrent une vraie app Xcode : un écran de réglage de l'URL du
serveur + une WKWebView plein écran qui charge la console. À compiler avec
Xcode (Fichier → Nouveau → Projet iOS « App », puis remplacer les fichiers
générés par ceux du dossier). Elle n'apporte rien de plus que la PWA — la
PWA est la voie recommandée.

## Ce que l'iPhone peut et ne peut pas faire

| Fonction                            | iPhone | PC / VPS |
|-------------------------------------|:------:|:--------:|
| Suivi live (equity, book, ordres)   |   ✔    |    ✔     |
| Courbe d'équité, régimes, risque    |   ✔    |    ✔     |
| Recherche d'edge (évolution + ML)   |   ✖    |    ✔     |
| Boucle de trading 24/7              |   ✖    |    ✔     |
| Exécution des ordres OKX            |   ✖    |    ✔     |
| Kill-switch / halts (état visible)  |   ✔*   |    ✔     |

\* l'état du risque est visible en direct sur l'iPhone ; le déclenchement
automatique (drawdown, perte journalière) est appliqué par le moteur côté
serveur, qui est le seul à pouvoir passer des ordres.
