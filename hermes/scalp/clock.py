"""Scale-coherence candle predictor.

Four independent clocks (1m, 3m, 5m, 15m) each forecast the *next candle*:
close return, upside excursion, downside excursion. Split-conformal
quantiles on a purged holdout size the TP/SL and veto any clock whose
interval still contains zero after costs.

Le trade n'est pas une horloge. C'est une horloge qui a franchi une porte
facturée pour TOUTES les cellules cherchées — actifs, horloges, familles
de modèles, seuils de déclenchement, horizons de détention — jugée sur
les trades qu'elle produirait vraiment, aux coûts réellement payés, sur
des étiquettes non chevauchantes.

La cohérence entre horloges n'est plus une porte : c'est un prix. Seule,
une horloge validée trade à demi-taille ; d'accord avec une autre, à
taille pleine. Exiger deux rescapées d'une porte aussi sévère comptait
la prudence deux fois et interdisait de trader ce qui est prouvé.
"""

from __future__ import annotations

import math
import time

import numpy as np

from ..backtest.metrics import expected_max_sharpe
from ..data.store import Candles
from ..ml.models import MLPRegressor, RidgeRegressor
from .economics import QUEUE_MISS

# Deux familles de modèles concourent sur chaque horloge : le ridge (la
# composante linéaire, 14 poids lisibles) et un petit MLP (les
# interactions que le linéaire ne peut pas voir — « le momentum ne paie
# que quand le funding est tendu »). La gate ne préfère personne : elle
# facture la barre pour TOUTES les familles cherchées et garde celle qui
# la bat avec la meilleure marge. À ce volume d'étiquettes (10^4), c'est
# l'architecture que la littérature mesure comme gagnante (Gu-Kelly-Xiu) ;
# un Transformer sur séquences exigerait des millions d'exemples
# indépendants que quatre ans de bougies ne contiennent pas.
FAMILIES = ("ridge", "mlp", "ens")


class _Ensemble:
    """La moyenne des deux, comme troisième candidate.

    Ce n'est pas un compromis mou : deux modèles qui se trompent
    différemment se corrigent en moyenne, et c'est le résultat le plus
    reproduit de la littérature d'apprentissage sur rendements
    (Gu-Kelly-Xiu : les ensembles dominent chacun de leurs membres). Elle
    passe au guichet comme les autres — la barre est facturée pour trois
    familles, pas deux.
    """

    def __init__(self, rr, nn):
        self.rr, self.nn = rr, nn

    def predict(self, X):
        return 0.5 * (self.rr.predict(X) + self.nn.predict(X))

# Seuils de déclenchement, en écarts-types de la prédiction elle-même.
# Une horloge ne trade pas toutes les barres : elle trade celles où elle
# parle fort. Le seuil est cherché sur le holdout et facturé comme tel.
THRESHOLDS = (0.0, 0.5, 1.0, 1.5, 2.0, 2.5)
MIN_TRADES = 40   # sous ce nombre, une moyenne n'est pas une mesure

# Horizons de détention, en barres. Le modèle était validé sur la barre
# suivante pendant que le moteur tenait trois barres : la preuve ne
# portait pas sur le trade joué. Et le mouvement disponible croît comme
# racine(h) quand le coût reste plat — l'horizon se cherche, et se paie.
HORIZONS = (1, 3, 6)

# Deux façons de jouer la même prédiction. « abs » prend le mouvement tel
# qu'il est prévu : on subit le facteur marché, qui à cinq minutes domine
# tout et n'est quasiment pas prévisible. « neu » retranche à chaque
# instant la moyenne du panel — on n'achète plus « SOL va monter » mais
# « SOL va monter PLUS que les autres ». Le livre devient long-short, la
# composante commune s'annule dans le portefeuille, et il ne reste que la
# dispersion, qui est la partie réellement prévisible à cet horizon.
# C'est le vieux fonds neutre transposé au perpétuel. Ce n'est pas un
# réglage gratuit : la variante est cherchée, donc facturée au guichet.
VARIANTS = ("abs", "neu")

# Largeurs de stop candidates, en écarts-types du mouvement sur l'horizon
# tenu. La règle mesurée n'avait AUCUN stop, la règle jouée en avait un —
# et la différence n'est pas cosmétique : à six barres d'une minute sur un
# actif à 31 bps de volatilité par barre, l'écart-type du mouvement vaut
# 76 bps, et le garde-fou posé à 63 tombait DEDANS. Il se déclenche alors
# une fois sur deux, cristallisant -63 bps là où le gain moyen mesuré vaut
# +11. Constaté au premier trade mesuré en direct : XRP ouvert à 14:27:30
# sur une prévision de -7,2 bps, stoppé 3,7 minutes plus tard à -85,8.
#
# Le stop fait donc partie de la règle, il est cherché avec elle et
# facturé comme les autres dimensions. Deux réserves d'honnêteté sur la
# simulation : on suppose un remplissage AU stop (un trou de cotation
# ferait pire), et l'excursion se lit sur les extrêmes de barre sans
# savoir si l'adverse a précédé le favorable (ce qui, lui, fait pire dans
# l'autre sens). Aucune des deux ne se corrige sans données tick.
STOPS = (2.0, 3.0, 4.0)

# Validation glissante. Un découpage unique 80/20 ne rend que 20 % de
# l'histoire en hors-échantillon, et la barre du hasard décroît en
# 1/racine(observations) : c'est LUI le goulot, pas le signal — mesuré en
# production, l'horloge 3m sort à sr=+0,064 contre une barre de 0,141 sur
# 454 instants seulement. Six plis successifs couvrant les 60 % de temps
# les plus récents, chacun jugé par un modèle entraîné uniquement sur ce
# qui le précède, rendent trois fois plus d'observations et divisent la
# barre par racine(3).
#
# Ce n'est pas une porte plus douce, c'est une mesure plus fidèle : ce qui
# est mesuré devient la PROCÉDURE réellement déployée — réapprendre
# périodiquement sur tout l'historique, puis trader la période suivante —
# au lieu d'un modèle figé une fois pour toutes. Chaque pli purge ses
# étiquettes d'entraînement dont la fenêtre traverse sa frontière, et les
# plis sont disjoints dans le temps : leurs instants ne se comptent pas
# deux fois.
FOLDS = 6
DEBUT_TEST = 0.40

# Décalage d'entrée, en barres. Zéro, et le chiffre est mesuré, pas
# supposé : le moteur détecte la clôture d'une barre et agit dans les
# secondes qui suivent — « desk 1m @ <barre> » est journalisé six
# secondes après la fermeture de cette barre, « desk 15m » quarante-trois
# secondes. Rapporté à la durée d'une barre, cela fait un quart de barre
# sur la 1m et trois centièmes sur la 15m.
#
# Cette constante a brièvement valu 1, sur une lecture fautive de ces
# mêmes journaux : l'horodatage d'une barre est son heure d'OUVERTURE, et
# la prendre pour sa clôture gonflait le délai d'un facteur dix. Un
# décalage d'une barre entière aurait été quatre à trente fois trop
# sévère selon l'horloge. Le paramètre reste, parce qu'un test s'en sert
# pour montrer ce qu'un vrai délai d'entrée détruirait ; sa valeur, elle,
# est celle qui décrit la machine.
ENTREE_DECALEE = 0

BARS = ("1m", "3m", "5m", "15m")
HOLD = {"1m": 3, "3m": 3, "5m": 3, "15m": 3}
# Profondeur d'historique par horloge. La barre du hasard décroît en
# 1/racine(trades) : à 21 jours de 5 min, une règle qui déclenche 4 % du
# temps ne produit que ~50 trades hors échantillon et doit battre 0,37 —
# un avantage réel n'y arrive pas. Aux profondeurs ci-dessous elle en
# produit des centaines et la barre tombe vers 0,10. Ce n'est pas une
# porte plus douce : c'est la même porte avec assez de preuves pour
# distinguer un avantage d'une chance.
DAYS = {"1m": 30, "3m": 60, "5m": 120, "15m": 365}
# Le panel : six perpétuels parmi les plus liquides d'OKX. Élargir la
# coupe transversale ne fait pas baisser la barre par magie — elle se lit
# sur le nombre d'INSTANTS mesurés, et deux actifs qui déclenchent en même
# temps n'en font qu'un. Ce qu'elle apporte est réel et double : chaque
# actif ajouté amène ses propres instants de déclenchement (l'union
# grandit, la barre baisse pour de vrai), et il amène ses lignes
# d'entraînement. Le diagnostic mesuré en production était sans ambiguïté
# — les cellules gagnantes plafonnaient à 55-75 trades, où la barre du
# hasard vaut 0,39 ; à quelques centaines elle tombe vers 0,15.
ASSETS = ("BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP",
          "XRP-USDT-SWAP", "DOGE-USDT-SWAP", "BNB-USDT-SWAP")
W = {"1m": 0.15, "3m": 0.20, "5m": 0.28, "15m": 0.37}
FEE = 7.0  # maker in + taker SL, bps
BAR_MS = {"1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000}


def _roll_std(x: np.ndarray, w: int) -> np.ndarray:
    n = len(x)
    out = np.zeros(n)
    c = np.cumsum(np.insert(x, 0, 0.0))
    c2 = np.cumsum(np.insert(x * x, 0, 0.0))
    for i in range(w, n):
        s = c[i + 1] - c[i + 1 - w]
        s2 = c2[i + 1] - c2[i + 1 - w]
        var = max(s2 / w - (s / w) ** 2, 0.0)
        out[i] = math.sqrt(var)
    if n > w:
        out[:w] = out[w]
    return out


def _sigma(c: Candles) -> np.ndarray:
    """Écart-type causal du retour d'une barre — l'unité de mesure de l'actif.

    Vingt points de base ne veulent pas dire la même chose sur BTC un
    dimanche calme et sur SOL en pleine tempête. Toute la mise en commun
    des actifs repose sur cette division : exprimées en sigmas, les
    colonnes de rendement d'un actif deviennent comparables à celles d'un
    autre, et un panel a enfin un sens. Le plancher est lui aussi causal
    (5 % de la moyenne courue), pour qu'aucune valeur future ne fuie dans
    une normalisation.
    """
    n = len(c)
    px = np.asarray(c.c, dtype=np.float64)
    r1 = np.zeros(n)
    if n > 1:
        r1[1:] = np.nan_to_num(
            px[1:] / np.where(px[:-1] > 0, px[:-1], np.nan) - 1.0, nan=0.0)
    s = _roll_std(r1, 20)
    cm = np.cumsum(s) / np.maximum(np.arange(1, n + 1), 1)
    return np.maximum(s, np.maximum(0.05 * cm, 1e-6))


N_FEATURES = 27   # colonnes de feat_matrix ; +2 (BTC, idio) à l'entraînement


def feat_matrix(c: Candles) -> np.ndarray:
    """Causal features, one row per bar. Row i uses only bars ≤ i.

    Beyond OHLCV, the store already carries the derivatives series the
    exchange publishes — funding, taker flow, open interest, mark/index
    basis — and the clocks were blind to all of them. Each series maps to
    bars strictly causally upstream (data.store), defaults to zero when
    absent, and is expressed as a bounded, stationary transform so a
    missing series is indistinguishable from an uninformative one.

    Toute colonne de rendement est divisée par le sigma courant de
    l'actif. Deux raisons, et la seconde est la plus importante : un
    modèle entraîné sur un régime calme reconnaît un régime agité, et
    surtout trois actifs peuvent nourrir la MÊME horloge — la matrice ne
    dit plus « BTC a bougé de 8 bps », elle dit « il a bougé d'un demi
    sigma », phrase que SOL peut prononcer aussi.
    """
    n = len(c)
    px = np.asarray(c.c, dtype=np.float64)
    safe = np.where(px > 0, px, np.nan)
    r1 = np.zeros(n)
    r1[1:] = px[1:] / np.where(px[:-1] > 0, px[:-1], np.nan) - 1.0
    r1 = np.nan_to_num(r1, nan=0.0)
    sig = _sigma(c)

    def u(x):
        """En sigmas, borné."""
        return np.clip(np.nan_to_num(x / sig, nan=0.0), -6.0, 6.0)

    def lagret(k):
        out = np.zeros(n)
        if n > k:
            out[k:] = px[k:] / np.where(px[:-k] > 0, px[:-k], np.nan) - 1.0
        return np.nan_to_num(out, nan=0.0) / math.sqrt(k)
    loc = (c.c - c.l) / np.maximum(c.h - c.l, 1e-12) - 0.5
    rng = (c.h - c.l) / np.maximum(safe, 1e-12)
    rng = np.nan_to_num(rng, nan=0.0)
    s1, s2, s3 = np.sign(r1), np.roll(np.sign(r1), 1), np.roll(np.sign(r1), 2)
    s2[0] = 0
    s3[:2] = 0
    persist = (s1 + s2 + s3) / 3.0

    # Régime de volatilité : le NIVEAU de sigma dépend de l'actif, son
    # rapport à sa propre moyenne courue n'en dépend pas. C'est cette
    # forme-là qui traverse le panel.
    cm = np.cumsum(sig) / np.maximum(np.arange(1, n + 1), 1)
    vol_rel = np.clip(sig / np.maximum(cm, 1e-12), 0.0, 5.0) - 1.0

    # dérivés : chaque transforme est bornée et vaut 0 quand la série manque
    funding = np.clip(np.nan_to_num(np.asarray(c.funding, dtype=np.float64),
                                    nan=0.0) * 1e4, -10, 10)
    taker = np.nan_to_num(c.taker_imb, nan=0.0)          # déjà dans [-1, 1]
    basis = np.clip(np.nan_to_num(c.basis, nan=0.0) * 1e4, -50, 50)
    oi = np.asarray(c.oi, dtype=np.float64)
    d_oi = np.zeros(n)
    prev = np.where(oi[:-1] > 0, oi[:-1], np.nan)
    if n > 1:
        d_oi[1:] = np.nan_to_num(oi[1:] / prev - 1.0, nan=0.0)
    d_oi = np.clip(d_oi, -0.2, 0.2)

    # Retour à la moyenne : l'écart du prix à sa propre moyenne, en
    # écarts-types. Les retours décalés disent le MOUVEMENT récent, jamais
    # la POSITION dans la fourchette récente — c'est pourtant la moitié du
    # métier, et la seule forme sous laquelle un scalp de réversion peut
    # s'exprimer. Deux fenêtres : la courte pour l'excès local, la longue
    # pour l'excès de régime.
    def zscore(w):
        m = np.convolve(px, np.ones(w) / w, mode="full")[:n]
        m[:w] = px[:w]
        sd = _roll_std(r1, w) * px * math.sqrt(w)
        return np.clip(np.nan_to_num((px - m) / np.maximum(sd, 1e-12)), -4, 4)

    # Heure de la journée : les sessions asiatique, européenne et
    # américaine n'ont ni la même volatilité ni le même sens moyen. Deux
    # colonnes plutôt qu'une pour que minuit et 23 h soient voisines.
    hod = (np.asarray(c.ts, dtype=np.float64) / 3_600_000.0) % 24.0
    ang = 2.0 * math.pi * hod / 24.0

    # Poussée du flux taker : le NIVEAU du déséquilibre est déjà là, sa
    # VARIATION ne l'est pas — et c'est elle qui marque une arrivée.
    d_taker = np.zeros(n)
    if n > 1:
        d_taker[1:] = np.clip(taker[1:] - taker[:-1], -1, 1)

    # La SÉQUENCE, pas seulement ses résumés. Les retours cumulés à 3, 5 et
    # 12 barres imposent une base fixe : ils forcent le modèle à voir des
    # sommes, jamais des motifs. Les huit derniers retours donnés un par un
    # laissent le réseau apprendre le filtre qu'il veut — momentum à
    # certains décalages, réversion à d'autres, alternance — ce qu'aucune
    # somme pondérée d'avance ne peut représenter. C'est le « MLP sur la
    # séquence des bougies précédentes » sous la seule forme que ce volume
    # d'étiquettes justifie : huit entrées de plus sur des centaines de
    # milliers de lignes, pas un Transformer qui en réclamerait des
    # millions d'indépendantes.
    def decale(x, k):
        out = np.zeros(n)
        if n > k:
            out[k:] = x[:-k]
        return out
    seq = [u(decale(r1, k)) for k in range(1, 9)]
    # Et la forme des deux bougies précédentes : où le prix a fermé dans
    # sa fourchette dit un rejet, un chiffre que le retour seul efface.
    loc_c = np.clip(loc, -0.5, 0.5)

    return np.column_stack([
        u(r1), u(lagret(3)), u(lagret(5)), u(lagret(12)),
        loc_c, np.clip(u(rng), 0, 6),
        vol_rel, np.clip(persist, -1, 1),
        funding, taker, basis, d_oi,
        zscore(20), zscore(60), np.sin(ang), np.cos(ang), d_taker,
        *seq, decale(loc_c, 1), decale(loc_c, 2),
    ])


def _targets(c: Candles, h: int = 1,
             lag: int = ENTREE_DECALEE) -> tuple[np.ndarray, np.ndarray,
                                                 np.ndarray]:
    """Rendement et excursions du trade RÉELLEMENT jouable.

    Le modèle était validé sur la barre SUIVANTE pendant que le moteur
    tenait la position trois barres : la preuve ne portait pas sur le
    trade joué. Et l'horizon n'est pas neutre — le mouvement disponible
    croît comme racine(h) quand le coût, lui, reste plat. Un horizon est
    donc un paramètre, cherché et facturé comme les autres.

    Le décalage d'entrée est paramétrable et vaut zéro par défaut, parce
    que c'est ce que la machine fait : elle détecte la clôture d'une barre
    et agit dans les secondes qui suivent, pas une barre plus tard. Le
    paramètre existe pour pouvoir MONTRER, dans un test, ce qu'un vrai
    délai détruirait — un mouvement prévisible une seule barre à l'avance
    ne survit à aucun retard.
    """
    n = len(c)
    h = max(int(h), 1)
    lag = max(int(lag), 0)
    y_r = np.full(n, np.nan)
    y_up = np.full(n, np.nan)
    y_dn = np.full(n, np.nan)
    px = c.c
    m = n - h - lag
    if m < 2:
        return y_r, y_up, y_dn
    base = px[lag:lag + m]
    fut = px[lag + h:lag + h + m]
    ok = base > 0
    y_r[:m][ok] = fut[ok] / base[ok] - 1.0
    # excursions extrêmes sur la fenêtre i+lag+1 .. i+lag+h
    hi = np.copy(c.h[lag + 1:lag + 1 + m])
    lo = np.copy(c.l[lag + 1:lag + 1 + m])
    for k in range(1, h):
        hi = np.maximum(hi, c.h[lag + 1 + k:lag + 1 + k + m])
        lo = np.minimum(lo, c.l[lag + 1 + k:lag + 1 + k + m])
    y_up[:m][ok] = hi[ok] / base[ok] - 1.0
    y_dn[:m][ok] = 1.0 - lo[ok] / base[ok]
    y_up = np.maximum(y_up, 0.0)
    y_dn = np.maximum(y_dn, 0.0)
    return y_r, y_up, y_dn


def _portfolio(net: np.ndarray, ts: np.ndarray,
               w: np.ndarray | None = None) -> np.ndarray:
    """Les trades simultanés font UN rendement, pas plusieurs mesures.

    Trois actifs corrélés à 0,8 qui déclenchent au même instant ne sont
    pas trois observations indépendantes : compter leurs trades ferait
    croire à une précision qui n'existe pas — c'est la pathologie des
    étiquettes chevauchantes, en travers du panel au lieu du temps. En
    moyennant par instant, la mesure devient celle du portefeuille
    réellement tenu : si les actifs se répètent la variance ne baisse
    pas, s'ils se diversifient le gain est réel et le portefeuille
    l'encaisse.

    Les jambes ne pèsent pas également : chacune est pondérée par
    l'inverse de sa volatilité, de sorte que toutes apportent le même
    risque. Ce n'est pas un réglage de rendement mais une question de
    fidélité — le moteur dimensionne déjà ainsi (le plafond de ruine
    donne un levier proportionnel à 1/volatilité), et mesurer un
    portefeuille équipondéré en points de base laisserait DOGE, trois
    fois plus agité que BTC, dominer la variance sans apporter plus
    d'avantage. On mesurerait alors un livre que personne ne tient.
    """
    if len(net) == 0:
        return np.zeros(0)
    _, inv = np.unique(np.asarray(ts), return_inverse=True)
    if w is None:
        return np.bincount(inv, weights=net) / np.bincount(inv)
    w = np.asarray(w, dtype=np.float64)
    w = np.where(np.isfinite(w) & (w > 0), w, 0.0)
    tot = np.bincount(inv, weights=w)
    tot = np.where(tot > 0, tot, 1.0)
    return np.bincount(inv, weights=w * net) / tot


def _ic(a: np.ndarray, b: np.ndarray) -> float:
    m = np.isfinite(a) & np.isfinite(b)
    a, b = a[m], b[m]
    if len(a) < 40:
        return 0.0
    a, b = a - a.mean(), b - b.mean()
    da, db = float(np.dot(a, a)), float(np.dot(b, b))
    if da <= 0 or db <= 0:
        return 0.0
    return float(np.dot(a, b) / math.sqrt(da * db))


class CandleModel:
    """Ridge + split-conformal on next-bar return and envelope."""

    def __init__(self, bar: str, fee_bps: float = FEE):
        self.bar = bar
        self.fee = float(fee_bps)
        self.rr = RidgeRegressor(l2=14.0)
        self.nn = MLPRegressor(hidden=(24, 12), epochs=120, patience=10)
        self.family = "ridge"   # qui a gagné le droit de parler
        # Le coût que paie la jambe gagnante : entrée postée + take posé au
        # carnet. C'est ce que le moteur paie vraiment depuis l'exécution
        # maker ; la jambe perdante traverse et paie self.fee.
        self.cost_win = 4.0
        self.thr_bps = 0.0      # sous ce mouvement prévu, l'horloge se tait
        self.n_trades = 0       # combien de déclenchements sur le holdout
        self.horizon_bars = 1   # combien de barres la position doit vivre
        self.up = RidgeRegressor(l2=14.0)
        self.dn = RidgeRegressor(l2=14.0)
        self.q = 0.0          # conformal |resid| 80%
        self.ic = 0.0
        self.shrink = 0.0
        self.status = "unfitted"
        self.n_train = 0
        self.holdout_bps = 0.0
        self.hold_sr = 0.0     # Sharpe par barre du holdout
        self.sel_bar = 0.0     # ce que le hasard aurait produit
        self.n_hold = 0
        self.n_assets = 1      # combien d'actifs nourrissent cette horloge
        self.n_periods = 0     # instants mesurés (trades simultanés agrégés)
        self.hold_sd = 0.0     # écart-type du net par trade, mesuré
        self.n_cells = (len(ASSETS) * len(BARS) * len(FAMILIES)
                        * len(THRESHOLDS) * len(HORIZONS) * len(STOPS))
        self.variant = "abs"   # brut, ou net de la moyenne du panel
        self.pente = 0.0       # ce que la réalité multiplie à l'annonce
        self.stop_sig = 3.0    # stop retenu, en sigmas de l'horizon tenu
        self._sig_ref = 1e-3   # sigma de repli si l'appelant n'en donne pas
        self._precedent = None  # cellule retenue au dernier ajustement
        self.ident = None       # (famille, horizon, k, variante) retenue

    def to_dict(self) -> dict:
        return {
            "bar": self.bar, "ic": self.ic, "q_bps": self.q * 1e4,
            "shrink": self.shrink, "status": self.status,
            "n_train": self.n_train, "holdout_bps": self.holdout_bps,
            "holdout_sr": self.hold_sr, "sel_bar": self.sel_bar,
            "n_holdout": self.n_hold, "net_sd": self.hold_sd,
            "family": self.family,
            "thr_bps": self.thr_bps, "n_trades": self.n_trades,
            "horizon_bars": self.horizon_bars,
            "n_assets": self.n_assets, "n_periods": self.n_periods,
            "variant": self.variant, "pente": self.pente,
            "stop_sig": self.stop_sig,
            "garde": bool(self.ident is not None
                          and self.ident == self._precedent),
            "n_trials": self.n_cells,
        }

    def _model(self):
        if self.family == "mlp":
            return self.nn
        if self.family == "ens":
            return _Ensemble(self.rr, self.nn)
        return self.rr

    def fit(self, c: Candles, btc: Candles | None = None,
            precedent=None) -> dict:
        """Un seul actif : le panel dégénéré à un bloc."""
        return self.fit_panel([(c, btc)], precedent)

    def fit_panel(self, series: list, precedent=None) -> dict:
        """Une horloge, tous les actifs à la fois.

        Douze modèles indépendants (3 actifs x 4 horloges) posaient deux
        problèmes que le panel règle d'un coup. Le premier est comptable :
        chercher l'actif EST une recherche, et la barre déflatée la
        facturait — 432 cellules. Une horloge partagée n'en cherche plus
        que 144, et la barre du hasard baisse pour de vrai, sans qu'on ait
        touché à la porte. Le second est statistique : un modèle qui ne
        marche que sur SOL est exactement la forme que prend un
        sur-ajustement. Exiger d'une règle qu'elle tienne sur les trois
        actifs à la fois est un test de robustesse qu'aucune validation
        croisée mono-actif ne remplace, et il vient avec trois fois plus
        de lignes d'entraînement.

        Ce que le panel ne donne PAS, et qu'il serait malhonnête de
        s'accorder : trois fois plus d'information. BTC, ETH et SOL bougent
        ensemble à ~0,8 de corrélation. C'est pourquoi la mesure ne compte
        pas les trades — elle agrège les trades simultanés en UN rendement
        de portefeuille par instant, et juge cette série-là. Si les actifs
        se répètent, la variance ne baisse pas et le Sharpe ne bouge pas ;
        s'ils se diversifient, le gain est réel et le portefeuille le
        touche vraiment.
        """
        self._precedent = precedent
        blocs = []
        for c, btc in series:
            if c is None or len(c) < 250:
                continue
            n = len(c)
            X = feat_matrix(c)
            sig = _sigma(c)
            br = np.zeros(n)
            if btc is not None and len(btc) >= n:
                bp = np.asarray(btc.c, dtype=np.float64)[-n:]
                if len(bp) == n:
                    br[1:] = np.where(bp[:-1] > 0, bp[1:] / bp[:-1] - 1.0, 0.0)
                br = np.clip(br / sig, -6.0, 6.0)
                idio = np.clip(X[:, 0] - br, -6.0, 6.0)
            else:
                idio = np.zeros(n)
            blocs.append({"c": c, "X": np.column_stack([X, br, idio]),
                          "sig": sig, "ts": np.asarray(c.ts, dtype=np.int64)})
        if not blocs:
            self.status = "few-samples"
            return self.to_dict()
        self.n_assets = len(blocs)
        # Cellules cherchées : horloges x familles x seuils x HORIZONS. La
        # dimension « actif » disparaît du guichet parce qu'elle disparaît
        # de la recherche : une seule horloge par échelle, la même pour
        # tout le monde. Quand le panel se réduit à un actif, elle revient.
        self.n_cells = (len(BARS) * len(FAMILIES) * len(THRESHOLDS)
                        * len(HORIZONS) * len(STOPS))
        if self.n_assets < 2:
            # un seul actif : la dimension revient au guichet, et la
            # variante neutre n'a pas de sens (rien à retrancher)
            self.n_cells *= len(ASSETS)
        else:
            self.n_cells *= len(VARIANTS)
        self._sig_ref = float(np.median(np.concatenate(
            [b["sig"] for b in blocs])))
        c_win = (1.0 - QUEUE_MISS) * self.cost_win + QUEUE_MISS * self.fee
        meilleur = None
        self._muet = {"ic": 0.0, "fam": "ridge", "h": 1}
        sortant = None
        for h in HORIZONS:
            r = self._essai(blocs, h, c_win)
            if r is None:
                continue
            if r.get("sortant") is not None:
                sortant = r["sortant"]
            if meilleur is None or r["cle"] > meilleur["cle"]:
                meilleur = r
        # Hystérésis. La surface des marges est plate — deux cellules
        # voisines se départagent au millième — et l'argmax changeait donc
        # de famille et de seuil d'un ajustement à l'autre : mlp/seuil 10,0
        # puis ens/seuil 5,0 à cinq minutes d'intervalle, deux règles qui
        # ne tradent pas au même rythme. La barre déflatée paie déjà ce
        # bruit de sélection ; ce qu'elle ne répare pas, c'est qu'en direct
        # la règle jouée change toutes les heures et ne ressemble alors
        # durablement à AUCUNE économie mesurée.
        #
        # La cellule sortante est donc conservée tant qu'aucune autre ne la
        # bat de plus d'une erreur-type de son propre Sharpe (1/racine des
        # instants). Ce n'est pas une porte : la sortante doit franchir
        # exactement les mêmes conditions que n'importe quelle autre dans
        # _retenir, et si elle cesse de gagner de l'argent elle n'est même
        # plus candidate.
        if (sortant is not None and meilleur is not None
                and sortant["ident"] != meilleur["ident"]):
            bruit = 1.0 / math.sqrt(max(sortant["n_per"], 1))
            if (sortant["cle"][0] == meilleur["cle"][0]
                    and sortant["marge"] + bruit >= meilleur["marge"]):
                meilleur = sortant
        if meilleur is None:
            self.status, self.shrink = "veto", 0.0
            self.thr_bps, self.n_trades = c_win, 0
            self.ic = self._muet["ic"]
            self.family, self.horizon_bars = self._muet["fam"], self._muet["h"]
            return self.to_dict()
        return self._retenir(meilleur, c_win)

    def _essai(self, blocs: list, h: int, c_win: float) -> dict | None:
        """Un horizon : validation glissante sur le panel, puis recherche."""
        pas = BAR_MS.get(self.bar, 300_000)
        parts = []
        for bl in blocs:
            y_r, y_up, y_dn = _targets(bl["c"], h)
            # La cible aussi est en sigmas : sur h barres le mouvement
            # disponible croît comme racine(h), et c'est cette quantité-là
            # qui est comparable d'un actif à l'autre. Le retour en points
            # de base — le seul qui paie des frais — se refait à la sortie
            # en remultipliant par le sigma de la barre.
            sg = bl["sig"] * math.sqrt(h)
            ok = np.isfinite(y_r) & np.isfinite(bl["X"]).all(axis=1)
            idx = np.where(ok)[0]
            if len(idx) < 200:
                continue
            parts.append({"X": bl["X"], "ts": bl["ts"], "idx": idx, "sg": sg,
                          "y": y_r, "up": y_up, "dn": y_dn})
        if not parts:
            return None
        # Frontières communes dans le TEMPS, pas dans l'index : deux actifs
        # d'historiques différents doivent être coupés au même instant,
        # sinon le test de l'un est l'entraînement de l'autre. Et le
        # quantile se prend sur les instants DISTINCTS : un actif arrivé
        # récemment n'a que des horodatages récents, les compter une fois
        # par ligne tirerait les frontières vers le présent.
        tous = np.unique(np.concatenate([p["ts"][p["idx"]] for p in parts]))
        if len(tous) < 800:
            return None
        bornes = [float(tous[min(int(q * len(tous)), len(tous) - 1)])
                  for q in np.linspace(DEBUT_TEST, 1.0, FOLDS + 1)]
        bornes[-1] = float(tous[-1]) + pas          # dernière borne incluse
        hors = {f: [] for f in FAMILIES}
        yho, sgo, tso, upo, dno = [], [], [], [], []
        for k in range(FOLDS):
            t0, t1 = bornes[k], bornes[k + 1]
            if t1 <= t0:
                continue
            Xtr, ytr, Xte, yte, sgte, tste = [], [], [], [], [], []
            upte, dnte = [], []
            for p in parts:
                ts, idx, sg = p["ts"], p["idx"], p["sg"]
                # embargo : une étiquette d'entraînement dont la fenêtre de
                # h barres traverse la frontière a vu le pli de test.
                tr = idx[ts[idx] < t0 - h * pas]
                te = idx[(ts[idx] >= t0) & (ts[idx] < t1)]
                # Étiquettes NON CHEVAUCHANTES pour la mesure : sur h
                # barres, deux étiquettes consécutives partagent h-1
                # barres, ce qui écrase les erreurs standard d'un facteur
                # racine(h) et laisse passer du bruit (constaté : 3
                # horloges vives sur du hasard pur avant ce pas).
                # L'amincissement se fait sur la GRILLE de temps et non sur
                # l'index, pour que les actifs restent alignés et que leurs
                # trades simultanés le restent aussi.
                te = te[(ts[te] // pas) % h == 0]
                if len(tr) < 150 or len(te) < 3:
                    continue
                Xtr.append(p["X"][tr])
                ytr.append(np.clip(p["y"][tr] / sg[tr], -8, 8))
                Xte.append(p["X"][te])
                yte.append(p["y"][te] * 1e4)
                sgte.append(sg[te])
                tste.append(ts[te])
                upte.append(p["up"][te] * 1e4)
                dnte.append(p["dn"][te] * 1e4)
            if not Xtr:
                continue
            Xtr, ytr = np.vstack(Xtr), np.concatenate(ytr)
            Xte = np.vstack(Xte)
            if len(ytr) < 300 or len(Xte) < 20:
                continue
            rr_k = RidgeRegressor(l2=14.0).fit(Xtr, ytr)
            nn_k = MLPRegressor(hidden=(24, 12), epochs=120,
                                patience=10).fit(Xtr, ytr)
            par_fam = {"ridge": rr_k, "mlp": nn_k,
                       "ens": _Ensemble(rr_k, nn_k)}
            for f in FAMILIES:
                hors[f].append(par_fam[f].predict(Xte))
            yho.append(np.concatenate(yte))
            sgo.append(np.concatenate(sgte))
            tso.append(np.concatenate(tste))
            upo.append(np.concatenate(upte))
            dno.append(np.concatenate(dnte))
            del Xtr, Xte
        if not yho:
            return None
        yho = np.concatenate(yho)
        sgo, tso = np.concatenate(sgo), np.concatenate(tso)
        upo, dno = np.concatenate(upo), np.concatenate(dno)
        if len(yho) < 200:
            return None
        # Les modèles qui iront en direct sont le pli suivant de la même
        # procédure : entraînés sur TOUT l'historique disponible. Aucune de
        # leurs prédictions n'entre dans la mesure ci-dessus.
        Xall, yall, uall, dall = [], [], [], []
        for p in parts:
            idx, sg = p["idx"], p["sg"]
            Xall.append(p["X"][idx])
            yall.append(np.clip(p["y"][idx] / sg[idx], -8, 8))
            uall.append(np.clip(p["up"][idx] / sg[idx], 0, 8))
            dall.append(np.clip(p["dn"][idx] / sg[idx], 0, 8))
        Xall = np.vstack(Xall)
        yall, uall, dall = (np.concatenate(yall), np.concatenate(uall),
                            np.concatenate(dall))
        up = RidgeRegressor(l2=14.0).fit(Xall, uall)
        dn = RidgeRegressor(l2=14.0).fit(Xall, dall)
        rr = RidgeRegressor(l2=14.0).fit(Xall, yall)
        nn = MLPRegressor(hidden=(24, 12), epochs=120,
                          patience=10).fit(Xall, yall)
        n_train = len(yall)
        del Xall

        best, sortant, muet = None, None, self._muet
        sd_y = float(np.std(yho))
        for fam in FAMILIES:
            p_bps = np.concatenate(hors[fam]) * sgo * 1e4
            sd_p = float(np.std(p_bps))
            # Garde-fou d'échelle : un modèle qui prédit des mouvements dix
            # fois plus grands que ceux qui existent n'est pas audacieux,
            # il est cassé. On ne le juge pas, on l'écarte — un tel modèle
            # a produit en direct des seuils à 240771075 bps.
            if not np.isfinite(sd_p) or sd_p > 10.0 * max(sd_y, 1e-12):
                continue
            ic = _ic(p_bps, yho)
            # « neu » : à chaque instant, on retranche la moyenne du panel.
            # Le signal ne dit plus « ça monte » mais « ça monte plus que
            # les autres » — et comme le portefeuille moyenne ensuite des
            # legs de signes opposés, le mouvement commun s'annule au lieu
            # d'être pris en pleine face.
            variantes = [("abs", p_bps)]
            if self.n_assets >= 2:
                _, iv = np.unique(tso, return_inverse=True)
                moy = np.bincount(iv, weights=p_bps) / np.bincount(iv)
                variantes.append(("neu", p_bps - moy[iv]))
            for var, pv in variantes:
                sd_v = float(np.std(pv))
                for ks in STOPS:
                    for k in THRESHOLDS:
                        # Pas de plancher au coût. Il serait juste pour un
                        # modèle calibré ; un ridge régularisé rend une
                        # moyenne conditionnelle rétrécie vers zéro et peut
                        # annoncer 2 bps là où la réalité en délivre 9. Le
                        # plancher refusait a priori ce que la mesure peut
                        # accepter. Ce qui reste est mesuré, pas supposé : net
                        # positif après coûts réels, et Sharpe au-dessus de la
                        # barre déflatée.
                        thr = k * sd_v
                        m = np.abs(pv) >= thr
                        n_tr = int(m.sum())
                        if n_tr < MIN_TRADES:
                            continue
                        # La règle JOUÉE : entrer, tenir h barres, sortir —
                        # sauf si l'excursion adverse touche le stop d'abord,
                        # auquel cas on sort là, en traversant.
                        sens = np.sign(pv[m])
                        stop = ks * sgo[m] * 1e4
                        adverse = np.where(sens > 0, dno[m], upo[m])
                        touche = adverse >= stop
                        # Un stop déclenché ne remplit PAS à son niveau :
                        # le prix le traverse et l'ordre part au marché.
                        # Le supposer rempli au niveau exact rendait les
                        # stops étroits artificiellement bons — vérifié
                        # sur marche aléatoire, un stop à un sigma
                        # ressortait meilleur qu'un stop à six, ce qui est
                        # impossible sans dérive. On ne connaît pas le
                        # chemin dans la barre ; on sait seulement que le
                        # remplissage est entre le niveau et l'extrême de
                        # la barre. Le milieu des deux est le seul choix
                        # non arbitraire.
                        gains = np.where(touche, -0.5 * (stop + adverse),
                                         sens * yho[m])
                        net = gains - np.where(
                            touche, self.fee, np.where(gains > 0, c_win, self.fee))
                        # Un instant = un rendement. Les trades simultanés sur
                        # plusieurs actifs sont UNE position de portefeuille, pas
                        # plusieurs observations indépendantes ; les agréger avant
                        # de mesurer est la seule façon de ne pas confondre
                        # diversification et répétition — et, en variante neutre,
                        # c'est cette moyenne-là qui annule le facteur commun.
                        pnl = _portfolio(net, tso[m], 1.0 / np.maximum(sgo[m], 1e-12))
                        n_per = len(pnl)
                        if n_per < MIN_TRADES:
                            continue
                        sd = float(np.std(pnl, ddof=1))
                        sr = float(np.mean(pnl)) / sd if sd > 1e-12 else 0.0
                        # On classe les cellules par la MARGE sur leur propre
                        # barre, pas par le Sharpe nu. Un seuil très haut produit
                        # toujours le plus beau Sharpe — sur trente trades, où il
                        # ne prouve rien et ne franchira jamais la barre que ces
                        # trente trades imposent. Trier par (sr - barre), c'est
                        # chercher avec le critère qui décide, au lieu de chercher
                        # un maximum qu'on refusera ensuite. La porte, elle, ne
                        # bouge pas d'un pouce.
                        barre = expected_max_sharpe(self.n_cells, n_per)
                        marge = sr - barre
                        # Une cellule qui perd de l'argent après frais ne peut
                        # de toute façon pas passer la porte : elle ne doit
                        # pas prendre la place d'une qui en gagne dans ce
                        # qu'on retient et publie. C'est un ordre de
                        # présentation, pas une porte — les deux conditions de
                        # _retenir sont inchangées.
                        mu = float(np.mean(net))
                        # Calibration, mesurée là où la règle DÉCLENCHE : de
                        # combien la réalité multiplie ce que le modèle
                        # annonce sur ces barres-là. Un ridge régularisé rend
                        # une moyenne conditionnelle rétrécie vers zéro ; en
                        # production cette pente vaut 1,6 à 2,4. Ce n'est pas
                        # une cellule cherchée mais une échelle estimée, et le
                        # Sharpe est invariant d'échelle : la porte n'en est
                        # pas affectée d'un iota.
                        vp = float(np.var(pv[m]))
                        pente = (float(np.cov(pv[m], yho[m])[0, 1]) / vp) \
                            if vp > 1e-18 else 0.0
                        cle = (1 if mu > 0 else 0, marge)
                        ident = (fam, h, float(k), var, float(ks))
                        cellule = {
                            "fam": fam, "rr": rr, "nn": nn, "up": up, "dn": dn,
                            "h": h, "pred": pv[m], "y": yho[m], "ic": ic,
                            "thr": thr, "n_tr": n_tr, "n_per": n_per,
                            "var": var, "ident": ident, "stop": float(ks),
                            "n_hold": len(yho), "n_train": n_train,
                            "bps": mu, "sr": sr, "cle": cle, "sd": sd,
                            "barre": barre, "marge": marge, "pente": pente,
                        }
                        if best is None or cle > best["cle"]:
                            best = cellule
                        if ident == self._precedent:
                            sortant = cellule
            # Aucun seuil ne déclenche assez souvent pour cette famille :
            # on retient quand même l'ic, sinon le refus se raconte avec un
            # ic=0.000 qui n'est pas le sien et le lecteur ne peut pas
            # distinguer « aucun signal » de « signal trop petit à payer ».
            if abs(ic) > abs(muet.get("ic", 0.0)):
                muet.update({"ic": ic, "fam": fam, "h": h})
        if best is not None:
            best["sortant"] = sortant
        return best

    def _retenir(self, b: dict, c_win: float) -> dict:
        """Adopte l'horizon, la famille et le seuil gagnants."""
        self.family, self.horizon_bars = b["fam"], b["h"]
        self.variant = b.get("var", "abs")
        self.ident = b.get("ident")
        self.pente = float(b.get("pente") or 0.0)
        self.stop_sig = float(b.get("stop") or 3.0)
        self.rr, self.nn, self.up, self.dn = b["rr"], b["nn"], b["up"], b["dn"]
        self.ic = b["ic"]
        self.thr_bps = float(b["thr"])
        self.n_trades, self.n_hold = b["n_tr"], int(b["n_hold"])
        self.n_periods = int(b["n_per"])
        self.n_train = int(b["n_train"])
        resid = np.abs(b["y"] - b["pred"])
        self.q = float(np.quantile(resid, 0.80)) / 1e4 if len(resid) else 0.0
        self.holdout_bps, self.hold_sr = b["bps"], b["sr"]
        # L'écart-type du net par trade. Avec la moyenne, il donne le Kelly
        # de la règle telle qu'elle a été MESURÉE — f* = E[R]/E[R²] — sans
        # passer par un mouvement brownien qui n'a jamais vu ces données.
        self.hold_sd = float(b.get("sd") or 0.0)
        # La barre se lit sur le nombre d'INSTANTS mesurés, pas de trades :
        # c'est lui qui gouverne la précision d'une moyenne quand les
        # trades sont corrélés entre eux.
        self.sel_bar = b["barre"]
        ic_floor = 2.0 / math.sqrt(max(b["n_hold"], 4))
        if self.holdout_bps > 0 and self.hold_sr > self.sel_bar \
                and self.ic > ic_floor:
            # Le facteur appliqué à la prédiction avant qu'elle serve à
            # choisir un bracket et une taille était min(0,6 ; 0,2+2·ic) —
            # une formule, pas une mesure. Elle rétrécissait de moitié ou
            # plus un modèle DÉJÀ rétréci d'un facteur deux : le moteur
            # voyait un mouvement trois à douze fois plus petit que celui
            # qui allait vraiment se produire, refusait ses propres
            # brackets faute d'espérance, et sous-dimensionnait le reste.
            # La bonne échelle n'est pas une opinion sur la confiance :
            # c'est la pente mesurée. La confiance, elle, est déjà jugée
            # deux lignes plus haut (ic au-dessus de son plancher, Sharpe
            # au-dessus de la barre) et payée en taille par le quart de
            # Kelly. Pondérée par sa propre crédibilité, et bornée : une
            # pente mesurée sur 553 trades vaut ce qu'elle dit ; la même
            # sur 62 ne vaut pas qu'on triple une position — observée en
            # production, elle saute de 0,97 à 3,14 d'un ajustement à
            # l'autre. Le point neutre est 1 (faire confiance à l'échelle
            # du modèle) et on s'en écarte à proportion des preuves.
            credit = min(1.0, self.n_periods / 200.0)
            self.shrink = float(min(3.0, max(
                0.0, 1.0 + (self.pente - 1.0) * credit)))
            self.status = "live"
        else:
            self.shrink = 0.0
            self.status = "veto"
        return self.to_dict()

    def predict_row(self, x: np.ndarray, sig: float | None = None) -> dict:
        if self.status != "live":
            return {"r_bps": 0.0, "up_bps": 0.0, "dn_bps": 0.0,
                    "q_bps": self.q * 1e4, "veto": True, "bar": self.bar,
                    "status": self.status, "ic": self.ic}
        # Le modèle parle en sigmas ; les frais, eux, se paient en points
        # de base. La conversion se fait avec le sigma de CETTE barre —
        # la même que celle utilisée pour juger la règle.
        s = float(sig if sig is not None else self._sig_ref)
        s *= math.sqrt(max(int(self.horizon_bars), 1))
        row = x.reshape(1, -1)
        raw = float(self._model().predict(row)[0]) * s * 1e4
        r_bps = raw * self.shrink
        up = max(float(self.up.predict(row)[0]), 0.0) * s * 1e4
        dn = max(float(self.dn.predict(row)[0]), 0.0) * s * 1e4
        # La règle jouée EST la règle mesurée : le seuil validé, appliqué à
        # la prédiction brute comme au fit. Rien d'autre — un second filtre
        # non validé ferait trader moins de barres que celles sur
        # lesquelles l'économie a été établie.
        # En variante neutre, ce n'est pas cette prédiction-ci qui décide
        # mais son écart à la moyenne du panel — que seul le pupitre
        # connaît. On publie le brut et on se tait ; ScaleDesk tranchera.
        veto = abs(raw) < self.thr_bps
        return {
            "r_bps": r_bps, "up_bps": up, "dn_bps": dn, "raw_bps": raw,
            "stop_bps": self.stop_sig * s * 1e4,
            "net_bps": self.holdout_bps, "net_sd": self.hold_sd,
            "net_n": self.n_periods,
            "q_bps": self.q * 1e4, "veto": veto, "bar": self.bar,
            "horizon_bars": self.horizon_bars, "variant": self.variant,
            "status": self.status, "ic": self.ic,
        }


def _row(c: Candles, btc: Candles | None) -> np.ndarray:
    X = feat_matrix(c)
    row = X[-1]
    sig = float(_sigma(c)[-1])
    br = 0.0
    if btc is not None and len(btc) >= 2 and btc.c[-2] > 0:
        br = float(btc.c[-1] / btc.c[-2] - 1.0)
    # mêmes unités qu'à l'entraînement : le retour BTC en sigmas de CET actif
    br = float(np.clip(br / max(sig, 1e-9), -6.0, 6.0))
    idio = float(np.clip(row[0] - br, -6.0, 6.0))
    return np.append(row, [br, idio])


class ScaleDesk:
    """Per-asset conformal clocks + coherence fuse."""

    def __init__(self, fee_bps: float = FEE, log=None):
        self.fee = float(fee_bps)
        self.log = log or (lambda m: None)
        self.models: dict[tuple[str, str], CandleModel] = {}
        self.votes: dict[tuple[str, str], dict] = {}
        self.fit_at = 0.0

    def fit_store(self, store, names: list[str] | None = None) -> dict:
        """Une horloge par échelle, nourrie par tous les actifs.

        Le même objet modèle est rangé sous chaque clé (actif, barre) :
        le reste du moteur continue de demander « l'horloge 5m de SOL »
        sans savoir qu'elle a été apprise sur les trois. Conséquence
        voulue côté trading — une horloge validée parle pour BTC, ETH et
        SOL au même instant, donc trois positions au lieu d'une, et c'est
        exactement le portefeuille sur lequel elle a été jugée.
        """
        names = list(names or ASSETS)
        out = {}
        # La cellule retenue au dernier ajustement sert d'ancre : sur une
        # surface de marges aussi plate, l'argmax change d'avis pour un
        # millième et la règle jouée changerait toutes les heures.
        anciens = {b: m for (i, b), m in self.models.items()}
        self.models = {}
        for bar in BARS:
            series, insts = [], []
            for inst in names:
                try:
                    c = store.load(inst, bar)
                except Exception:
                    continue
                if c is None or len(c) < 250:
                    continue
                btc = None
                if inst != "BTC-USDT-SWAP":
                    try:
                        btc = store.load("BTC-USDT-SWAP", bar)
                    except Exception:
                        btc = None
                series.append((c, btc))
                insts.append(inst)
            if not series:
                continue
            ancien = anciens.get(bar)
            m = CandleModel(bar, self.fee)
            d = m.fit_panel(series, getattr(ancien, "ident", None))
            for inst in insts:
                self.models[(inst, bar)] = m
                out[f"{inst.split('-')[0]}:{bar}"] = d
            self.log(f"clock {bar} panel[{len(insts)}] {d['status']} "
                     f"[{d['family']}/h{d['horizon_bars']}/{d['variant']}] "
                     f"ic={d['ic']:.3f} "
                     f"net={d['holdout_bps']:+.2f}bps/trade "
                     f"sr={d['holdout_sr']:+.3f} vs bar={d['sel_bar']:.3f} "
                     f"seuil={d['thr_bps']:.1f}bps stop={d['stop_sig']:.0f}sig "
                     f"pente={d['pente']:.2f} "
                     f"{'gardee ' if d.get('garde') else ''}"
                     f"trades={d['n_trades']}/{d['n_holdout']} "
                     f"instants={d['n_periods']} n={d['n_train']}")
        self.fit_at = time.time()
        self.log(f"desk live={self.live_bars() or ['none']}")
        return out

    def live_bars(self) -> list[str]:
        return sorted({bar for (inst, bar), m in self.models.items() if m.status == "live"})

    def vote_clock(self, inst: str, bar: str, c: Candles, btc: Candles | None) -> dict:
        m = self.models.get((inst, bar))
        if m is None or len(c) < 20:
            v = {"r_bps": 0.0, "up_bps": 0.0, "dn_bps": 0.0, "q_bps": 0.0,
                 "veto": True, "bar": bar, "status": "unfitted", "ic": 0.0}
        else:
            v = m.predict_row(_row(c, btc), float(_sigma(c)[-1]))
        self.votes[(inst, bar)] = v
        return v

    def _neutraliser(self, bar: str) -> None:
        """Retranche, pour cette échelle, la moyenne du panel au tour courant.

        Une horloge validée en neutre n'a pas été mesurée sur « SOL
        monte » mais sur « SOL monte plus que les autres ». Jouer le brut
        serait jouer une règle que personne n'a validée ; il faut donc
        que tous les actifs aient voté avant de trancher — c'est pourquoi
        le moteur fait voter tout le panel avant de fusionner quoi que ce
        soit.
        """
        m = None
        bruts = []
        for (i, b), v in self.votes.items():
            if b != bar or not v or v.get("status") != "live":
                continue
            mm = self.models.get((i, b))
            if mm is None or getattr(mm, "variant", "abs") != "neu":
                continue
            m = mm
            bruts.append((i, float(v.get("raw_bps") or 0.0)))
        if m is None or len(bruts) < 2:
            # rien à retrancher : une jambe seule n'est pas un livre neutre
            for i, _ in bruts:
                self.votes[(i, bar)]["veto"] = True
            return
        moy = sum(x for _, x in bruts) / len(bruts)
        for i, brut in bruts:
            v = self.votes[(i, bar)]
            net = brut - moy
            v["raw_neu"] = net
            v["r_bps"] = net * m.shrink
            v["veto"] = abs(net) < m.thr_bps

    def fuse(self, inst: str) -> dict:
        for bar in BARS:
            self._neutraliser(bar)
        vs = [self.votes.get((inst, bar)) for bar in BARS]
        vs = [v for v in vs if v]
        live = [v for v in vs if not v["veto"] and v.get("status") == "live"]
        clocks = {v["bar"]: ("+" if v["r_bps"] > 0 else "-" if v["r_bps"] < 0 else "0")
                  + ("" if v["veto"] else "")
                  for v in vs}
        # compact: A=agree live, v=veto
        clock_s = {v["bar"]: ("veto" if v["veto"] else ("up" if v["r_bps"] > 0 else "dn"))
                   for v in vs}
        if not live:
            return {
                "veto": True, "score": 0.0, "ml_bps": 0.0, "tp_bps": 12.0, "sl_bps": 18.0,
                "alpha": 0.0, "ic": 0.0, "status": "incoherent", "policy": "flat",
                "bar": "5m", "clocks": clock_s, "r_bps": 0.0,
            }
        # « Deux horloges d'accord, ou rien » datait d'une époque où chaque
        # horloge ne franchissait qu'un ic>0,03 fixe : la cohérence servait
        # alors de porte. Elle en franchit maintenant une facturée pour
        # toutes les cellules cherchées — actifs, horloges, familles,
        # seuils, horizons. Exiger DEUX rescapées de cette porte-là compte
        # la prudence deux fois et interdit de trader ce qui est prouvé.
        # La cohérence n'est donc plus une porte : c'est un prix. Seule,
        # une horloge validée trade à demi-taille ; d'accord avec une
        # autre, à taille pleine.
        signs = {np.sign(v["r_bps"]) for v in live if v["r_bps"] != 0}
        # MOYENNE pondérée, pas somme pondérée. Les poids somment à 1 quand
        # les quatre horloges parlent ; avec une seule, la somme rendait
        # 0,15 fois sa prédiction pour la 1m — un rétrécissement arbitraire
        # qui n'a rien à voir avec l'économie validée, et qui s'ajoutait au
        # demi-Kelly déjà appliqué aux horloges solitaires. Une prédiction
        # de 30 bps ressortait à 4,5 et l'espérance du bracket la refusait.
        # Depuis que la cohérence est un prix et non une porte, le cas
        # solitaire est le cas NORMAL : ce défaut suffisait à garder le
        # livre vide quoi qu'il arrive.
        poids = sum(W.get(v["bar"], 0.2) for v in live) or 1.0
        wsum = sum(W.get(v["bar"], 0.2) * v["r_bps"] for v in live) / poids
        if len(signs) > 1:
            # mixed clocks: only go if the weighted move still clears fees
            if abs(wsum) < self.fee:
                return {
                    "veto": True, "score": 0.0, "ml_bps": wsum, "tp_bps": 12.0, "sl_bps": 18.0,
                    "alpha": 0.0, "ic": 0.0, "status": "disagree", "policy": "flat",
                    "bar": "5m", "clocks": clock_s, "r_bps": wsum,
                }
        dom = max(live, key=lambda v: abs(v["r_bps"]) / max(v["q_bps"], 1.0))
        tp = max(self.fee + 2.0, 0.7 * float(dom["up_bps"]), abs(dom["r_bps"]))
        sl = max(self.fee + 4.0, 1.1 * float(dom["dn_bps"]), 1.4 * abs(dom["r_bps"]))
        sl = max(sl, tp * 1.15)  # never tighter SL than TP
        score = wsum / 8.0
        solo = len(live) == 1
        return {
            "veto": False, "score": score, "ml_bps": wsum, "tp_bps": tp, "sl_bps": sl,
            # la cohérence se paie en taille, pas en refus
            "alpha": 0.5 if solo else 1.0,
            "ic": float(np.mean([v["ic"] for v in live])),
            "status": "live", "policy": "candle-solo" if solo else "candle",
            "bar": dom["bar"], "clocks": clock_s, "r_bps": wsum,
            "up_bps": float(dom["up_bps"]), "dn_bps": float(dom["dn_bps"]),
            # ce que la règle a RÉELLEMENT rapporté par trade, et sa
            # dispersion : de quoi dimensionner sans modèle
            "net_bps": float(dom.get("net_bps") or 0.0),
            "net_sd": float(dom.get("net_sd") or 0.0),
            "net_n": int(dom.get("net_n") or 0),
            # le garde-fou EST celui qui a été mesuré, pas un autre
            "stop_mesure": float(dom.get("stop_bps") or 0.0),
            # la position doit vivre exactement l'horizon sur lequel
            # l'horloge dominante a été validée, pas une constante
            "horizon_bars": int(dom.get("horizon_bars") or 1),
        }

    def infer_asset(self, inst: str, feat, btc_r1, is_btc, prior, vol_bps) -> dict:
        """Engine-compatible. Fuse already-voted clocks; feat unused beyond fallback."""
        inf = self.fuse(inst)
        vol = max(float(vol_bps), 4.0)
        inf["tp_bps"] = max(inf["tp_bps"], 1.2 * vol)
        inf["sl_bps"] = max(inf["sl_bps"], 1.8 * vol)
        return inf

    @property
    def best(self) -> dict:
        """Engine snapshot: dominant live clock per asset (or 5m veto)."""
        out = {}
        for inst in ASSETS:
            inf = self.fuse(inst)
            class _L:
                pass
            lr = _L()
            lr.policy = inf["policy"]
            lr.status = inf["status"]
            lr.holdout_mean = inf.get("ml_bps") or 0.0
            lr.ic = inf.get("ic") or 0.0
            lr.to_dict = lambda inf=inf: inf
            out[inst] = (inf.get("bar") or "5m", lr)
        return out

    def to_dict(self) -> dict:
        d = {f"{i.split('-')[0]}:{b}": m.to_dict() for (i, b), m in self.models.items()}
        # l'écran juge sur l'évidence : le sr du holdout de l'horloge
        # dominante, la barre du hasard qu'il a (ou non) franchie, et le
        # nombre d'observations derrière — pas seulement un mot "live"
        best = {}
        for i, (bar, lr) in self.best.items():
            m = self.models.get((i, bar))
            best[i.split("-")[0]] = {
                "bar": bar, "policy": lr.policy, "status": lr.status,
                "holdout": lr.holdout_mean,
                "holdout_sr": getattr(m, "hold_sr", 0.0) if m else 0.0,
                "sel_bar": getattr(m, "sel_bar", 0.0) if m else 0.0,
                "n_holdout": getattr(m, "n_hold", 0) if m else 0,
                "n_trials": getattr(m, "n_cells", 0) if m else 0,
                "n_assets": getattr(m, "n_assets", 1) if m else 1,
                "n_periods": getattr(m, "n_periods", 0) if m else 0,
                "variant": getattr(m, "variant", "abs") if m else "abs",
                "family": getattr(m, "family", "ridge") if m else "ridge",
                "thr_bps": getattr(m, "thr_bps", 0.0) if m else 0.0,
                "n_trades": getattr(m, "n_trades", 0) if m else 0,
                "alpha": getattr(m, "shrink", 0.0) if m else 0.0,
            }
        d["_best"] = best
        # Une horloge par échelle, partagée par tout le panel : la vérité
        # de l'écran n'est plus « l'horloge de SOL » mais « l'horloge 3m,
        # apprise sur six actifs ». Six cartes identiques auraient menti
        # sur la nature de la preuve.
        echelles = {}
        for bar in BARS:
            m = next((mm for (i, b), mm in self.models.items() if b == bar),
                     None)
            if m is None:
                continue
            vivants = sum(1 for (i, b), v in self.votes.items()
                          if b == bar and v and not v.get("veto")
                          and v.get("status") == "live")
            # getattr partout : un instantané d'écran ne doit jamais
            # pouvoir faire tomber le moteur parce qu'un modèle est en
            # cours de construction ou qu'un champ a changé de nom.
            def g(nom, defaut=0.0, _m=m):
                return getattr(_m, nom, defaut)
            echelles[bar] = {
                "bar": bar, "status": g("status", "unfitted"),
                "family": g("family", "ridge"), "variant": g("variant", "abs"),
                "horizon_bars": g("horizon_bars", 1),
                "ic": g("ic"), "pente": g("pente"),
                "holdout": g("holdout_bps"), "holdout_sr": g("hold_sr"),
                "sel_bar": g("sel_bar"), "n_periods": g("n_periods", 0),
                "n_trades": g("n_trades", 0), "n_holdout": g("n_hold", 0),
                "n_train": g("n_train", 0), "n_assets": g("n_assets", 1),
                "n_trials": g("n_cells", 0), "thr_bps": g("thr_bps"),
                "alpha": g("shrink"), "actifs_qui_parlent": vivants,
            }
        d["_echelles"] = echelles
        return d