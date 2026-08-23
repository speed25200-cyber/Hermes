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
FAMILIES = ("ridge", "mlp")

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
ASSETS = ("BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP")
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

    return np.column_stack([
        u(r1), u(lagret(3)), u(lagret(5)), u(lagret(12)),
        np.clip(loc, -0.5, 0.5), np.clip(u(rng), 0, 6),
        vol_rel, np.clip(persist, -1, 1),
        funding, taker, basis, d_oi,
        zscore(20), zscore(60), np.sin(ang), np.cos(ang), d_taker,
    ])


def _targets(c: Candles, h: int = 1) -> tuple[np.ndarray, np.ndarray,
                                              np.ndarray]:
    """Rendement et excursions sur les h prochaines barres.

    Le modèle était validé sur la barre SUIVANTE pendant que le moteur
    tenait la position trois barres : la preuve ne portait pas sur le
    trade joué. Et l'horizon n'est pas neutre — le mouvement disponible
    croît comme racine(h) quand le coût, lui, reste plat. Un horizon est
    donc un paramètre, cherché et facturé comme les autres.
    """
    n = len(c)
    h = max(int(h), 1)
    y_r = np.full(n, np.nan)
    y_up = np.full(n, np.nan)
    y_dn = np.full(n, np.nan)
    px = c.c
    if n < h + 2:
        return y_r, y_up, y_dn
    base = px[:-h]
    ok = base > 0
    y_r[:-h][ok] = px[h:][ok] / base[ok] - 1.0
    # excursions extrêmes sur la fenêtre i+1 .. i+h
    hi = np.copy(c.h[1:])
    lo = np.copy(c.l[1:])
    for k in range(1, h):
        hi[:len(hi) - k] = np.maximum(hi[:len(hi) - k], c.h[1 + k:])
        lo[:len(lo) - k] = np.minimum(lo[:len(lo) - k], c.l[1 + k:])
    y_up[:-h][ok] = hi[:len(base)][ok] / base[ok] - 1.0
    y_dn[:-h][ok] = 1.0 - lo[:len(base)][ok] / base[ok]
    y_up = np.maximum(y_up, 0.0)
    y_dn = np.maximum(y_dn, 0.0)
    return y_r, y_up, y_dn


def _portfolio(net: np.ndarray, ts: np.ndarray) -> np.ndarray:
    """Les trades simultanés font UN rendement, pas plusieurs mesures.

    Trois actifs corrélés à 0,8 qui déclenchent au même instant ne sont
    pas trois observations indépendantes : compter leurs trades ferait
    croire à une précision qui n'existe pas — c'est la pathologie des
    étiquettes chevauchantes, en travers du panel au lieu du temps. En
    moyennant par instant, la mesure devient celle du portefeuille
    réellement tenu : si les actifs se répètent la variance ne baisse
    pas, s'ils se diversifient le gain est réel et le portefeuille
    l'encaisse.
    """
    if len(net) == 0:
        return np.zeros(0)
    _, inv = np.unique(np.asarray(ts), return_inverse=True)
    return np.bincount(inv, weights=net) / np.bincount(inv)


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
        self.n_cells = (len(ASSETS) * len(BARS) * len(FAMILIES)
                        * len(THRESHOLDS) * len(HORIZONS))
        self._sig_ref = 1e-3   # sigma de repli si l'appelant n'en donne pas

    def to_dict(self) -> dict:
        return {
            "bar": self.bar, "ic": self.ic, "q_bps": self.q * 1e4,
            "shrink": self.shrink, "status": self.status,
            "n_train": self.n_train, "holdout_bps": self.holdout_bps,
            "holdout_sr": self.hold_sr, "sel_bar": self.sel_bar,
            "n_holdout": self.n_hold, "family": self.family,
            "thr_bps": self.thr_bps, "n_trades": self.n_trades,
            "horizon_bars": self.horizon_bars,
            "n_assets": self.n_assets, "n_periods": self.n_periods,
            "n_trials": self.n_cells,
        }

    def _model(self):
        return self.nn if self.family == "mlp" else self.rr

    def fit(self, c: Candles, btc: Candles | None = None) -> dict:
        """Un seul actif : le panel dégénéré à un bloc."""
        return self.fit_panel([(c, btc)])

    def fit_panel(self, series: list) -> dict:
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
                        * len(HORIZONS))
        if self.n_assets < 2:
            self.n_cells *= len(ASSETS)
        self._sig_ref = float(np.median(np.concatenate(
            [b["sig"] for b in blocs])))
        c_win = (1.0 - QUEUE_MISS) * self.cost_win + QUEUE_MISS * self.fee
        meilleur = None
        self._muet = {"ic": 0.0, "fam": "ridge", "h": 1}
        for h in HORIZONS:
            r = self._essai(blocs, h, c_win)
            if r is not None and (meilleur is None
                                  or r["marge"] > meilleur["marge"]):
                meilleur = r
        if meilleur is None:
            self.status, self.shrink = "veto", 0.0
            self.thr_bps, self.n_trades = c_win, 0
            self.ic = self._muet["ic"]
            self.family, self.horizon_bars = self._muet["fam"], self._muet["h"]
            return self.to_dict()
        return self._retenir(meilleur, c_win)

    def _essai(self, blocs: list, h: int, c_win: float) -> dict | None:
        """Un horizon : entraîne sur le panel, cherche le seuil, rend le score."""
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
        # Coupure commune dans le TEMPS, pas dans l'index : deux actifs
        # d'historiques différents doivent être coupés au même instant,
        # sinon le holdout de l'un est le train de l'autre.
        tous = np.sort(np.concatenate([p["ts"][p["idx"]] for p in parts]))
        cut_ts = float(tous[int(0.8 * len(tous))])
        Xtr, ytr, utr, dtr = [], [], [], []
        Xho, yho, sgo, tso = [], [], [], []
        for p in parts:
            ts, idx, sg = p["ts"], p["idx"], p["sg"]
            # embargo : une étiquette d'entraînement dont la fenêtre de h
            # barres traverse la coupure a vu le holdout. Elle sort.
            tr = idx[ts[idx] < cut_ts - h * pas]
            ho = idx[ts[idx] >= cut_ts]
            # Étiquettes NON CHEVAUCHANTES pour la mesure : sur h barres,
            # deux étiquettes consécutives partagent h-1 barres, ce qui
            # écrase les erreurs standard d'un facteur racine(h) et laisse
            # passer du bruit (constaté : 3 horloges vives sur du hasard
            # pur avant ce pas). L'amincissement se fait sur la GRILLE de
            # temps et non sur l'index, pour que les actifs restent
            # alignés et que leurs trades simultanés le restent aussi.
            ho = ho[(ts[ho] // pas) % h == 0]
            if len(tr) < 150 or len(ho) < 20:
                continue
            Xtr.append(p["X"][tr])
            ytr.append(np.clip(p["y"][tr] / sg[tr], -8, 8))
            utr.append(np.clip(p["up"][tr] / sg[tr], 0, 8))
            dtr.append(np.clip(p["dn"][tr] / sg[tr], 0, 8))
            Xho.append(p["X"][ho])
            yho.append(p["y"][ho] * 1e4)
            sgo.append(sg[ho])
            tso.append(ts[ho])
        if not Xtr:
            return None
        Xtr = np.vstack(Xtr)
        ytr, utr, dtr = np.concatenate(ytr), np.concatenate(utr), np.concatenate(dtr)
        Xho = np.vstack(Xho)
        yho, sgo, tso = (np.concatenate(yho), np.concatenate(sgo),
                         np.concatenate(tso))
        if len(ytr) < 150 or len(yho) < 60:
            return None
        up = RidgeRegressor(l2=14.0).fit(Xtr, utr)
        dn = RidgeRegressor(l2=14.0).fit(Xtr, dtr)
        rr = RidgeRegressor(l2=14.0).fit(Xtr, ytr)
        nn = MLPRegressor(hidden=(24, 12), epochs=120,
                          patience=10).fit(Xtr, ytr)
        best, muet = None, self._muet
        sd_y = float(np.std(yho))
        for fam, mdl in (("ridge", rr), ("mlp", nn)):
            p_bps = mdl.predict(Xho) * sgo * 1e4
            sd_p = float(np.std(p_bps))
            # Garde-fou d'échelle : un modèle qui prédit des mouvements dix
            # fois plus grands que ceux qui existent n'est pas audacieux,
            # il est cassé. On ne le juge pas, on l'écarte — un tel modèle
            # a produit en direct des seuils à 240771075 bps.
            if not np.isfinite(sd_p) or sd_p > 10.0 * max(sd_y, 1e-12):
                continue
            ic = _ic(p_bps, yho)
            for k in THRESHOLDS:
                thr = max(k * sd_p, c_win)
                m = np.abs(p_bps) >= thr
                n_tr = int(m.sum())
                if n_tr < MIN_TRADES:
                    continue
                gains = np.sign(p_bps[m]) * yho[m]
                net = gains - np.where(gains > 0, c_win, self.fee)
                # Un instant = un rendement. Les trades simultanés sur
                # plusieurs actifs sont UNE position de portefeuille, pas
                # trois observations indépendantes ; les agréger avant de
                # mesurer est la seule façon de ne pas confondre
                # diversification et répétition.
                pnl = _portfolio(net, tso[m])
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
                if best is None or marge > best["marge"]:
                    best = {
                        "fam": fam, "rr": rr, "nn": nn, "up": up, "dn": dn,
                        "h": h, "pred": p_bps[m], "y": yho[m], "ic": ic,
                        "thr": thr, "n_tr": n_tr, "n_per": n_per,
                        "n_hold": len(yho), "n_train": len(ytr),
                        "bps": float(np.mean(net)), "sr": sr,
                        "barre": barre, "marge": marge,
                    }
            # Aucun seuil ne déclenche assez souvent pour cette famille :
            # on retient quand même l'ic, sinon le refus se raconte avec un
            # ic=0.000 qui n'est pas le sien et le lecteur ne peut pas
            # distinguer « aucun signal » de « signal trop petit à payer ».
            if abs(ic) > abs(muet.get("ic", 0.0)):
                muet.update({"ic": ic, "fam": fam, "h": h})
        return best

    def _retenir(self, b: dict, c_win: float) -> dict:
        """Adopte l'horizon, la famille et le seuil gagnants."""
        self.family, self.horizon_bars = b["fam"], b["h"]
        self.rr, self.nn, self.up, self.dn = b["rr"], b["nn"], b["up"], b["dn"]
        self.ic = b["ic"]
        self.thr_bps = float(b["thr"])
        self.n_trades, self.n_hold = b["n_tr"], int(b["n_hold"])
        self.n_periods = int(b["n_per"])
        self.n_train = int(b["n_train"])
        resid = np.abs(b["y"] - b["pred"])
        self.q = float(np.quantile(resid, 0.80)) / 1e4 if len(resid) else 0.0
        self.holdout_bps, self.hold_sr = b["bps"], b["sr"]
        # La barre se lit sur le nombre d'INSTANTS mesurés, pas de trades :
        # c'est lui qui gouverne la précision d'une moyenne quand les
        # trades sont corrélés entre eux.
        self.sel_bar = b["barre"]
        ic_floor = 2.0 / math.sqrt(max(b["n_hold"], 4))
        if self.holdout_bps > 0 and self.hold_sr > self.sel_bar \
                and self.ic > ic_floor:
            self.shrink = float(min(0.6, 0.2 + 2.0 * self.ic))
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
        veto = abs(raw) < self.thr_bps
        return {
            "r_bps": r_bps, "up_bps": up, "dn_bps": dn,
            "q_bps": self.q * 1e4, "veto": veto, "bar": self.bar,
            "horizon_bars": self.horizon_bars,
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
            m = CandleModel(bar, self.fee)
            d = m.fit_panel(series)
            for inst in insts:
                self.models[(inst, bar)] = m
                out[f"{inst.split('-')[0]}:{bar}"] = d
            self.log(f"clock {bar} panel[{len(insts)}] {d['status']} "
                     f"[{d['family']}/h{d['horizon_bars']}] ic={d['ic']:.3f} "
                     f"net={d['holdout_bps']:+.2f}bps/trade "
                     f"sr={d['holdout_sr']:+.3f} vs bar={d['sel_bar']:.3f} "
                     f"seuil={d['thr_bps']:.1f}bps "
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

    def fuse(self, inst: str) -> dict:
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
        wsum = sum(W.get(v["bar"], 0.2) * v["r_bps"] for v in live)
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
                "family": getattr(m, "family", "ridge") if m else "ridge",
                "thr_bps": getattr(m, "thr_bps", 0.0) if m else 0.0,
                "n_trades": getattr(m, "n_trades", 0) if m else 0,
                "alpha": getattr(m, "shrink", 0.0) if m else 0.0,
            }
        d["_best"] = best
        return d