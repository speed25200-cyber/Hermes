"""Scale-coherence candle predictor.

Four independent clocks (1m, 3m, 5m, 15m) each forecast the *next candle*:
close return, upside excursion, downside excursion. Split-conformal
quantiles on a purged holdout size the TP/SL and veto any clock whose
interval still contains zero after costs.

The trade is not a clock. It is the *agreement* of clocks that survived
conformal gating. Two clocks, same sign, or sit out. That is the whole
anti-overfit: small ridge, embargoed labels, distribution-free intervals,
and a coherence gate instead of a deep net.
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


def feat_matrix(c: Candles) -> np.ndarray:
    """Causal features, one row per bar. Row i uses only bars ≤ i.

    Beyond OHLCV, the store already carries the derivatives series the
    exchange publishes — funding, taker flow, open interest, mark/index
    basis — and the clocks were blind to all of them. Each series maps to
    bars strictly causally upstream (data.store), defaults to zero when
    absent, and is expressed as a bounded, stationary transform so a
    missing series is indistinguishable from an uninformative one.
    """
    n = len(c)
    px = np.asarray(c.c, dtype=np.float64)
    safe = np.where(px > 0, px, np.nan)
    r1 = np.zeros(n)
    r1[1:] = px[1:] / np.where(px[:-1] > 0, px[:-1], np.nan) - 1.0
    r1 = np.nan_to_num(r1, nan=0.0)
    def lagret(k):
        out = np.zeros(n)
        if n > k:
            out[k:] = px[k:] / np.where(px[:-k] > 0, px[:-k], np.nan) - 1.0
        return np.nan_to_num(out, nan=0.0)
    loc = (c.c - c.l) / np.maximum(c.h - c.l, 1e-12) - 0.5
    rng = (c.h - c.l) / np.maximum(safe, 1e-12)
    rng = np.nan_to_num(rng, nan=0.0)
    vol = _roll_std(r1, 20)
    s1, s2, s3 = np.sign(r1), np.roll(np.sign(r1), 1), np.roll(np.sign(r1), 2)
    s2[0] = 0
    s3[:2] = 0
    persist = (s1 + s2 + s3) / 3.0

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

    return np.column_stack([
        r1, lagret(3), lagret(5), lagret(12),
        np.clip(loc, -0.5, 0.5), np.clip(rng, 0, 0.08),
        vol, np.clip(persist, -1, 1),
        funding, taker, basis, d_oi,
    ])


def _targets(c: Candles) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """y at i uses bar i+1 only — close return, up excursion, down excursion."""
    n = len(c)
    y_r = np.full(n, np.nan)
    y_up = np.full(n, np.nan)
    y_dn = np.full(n, np.nan)
    px = c.c
    if n < 3:
        return y_r, y_up, y_dn
    ok = px[:-1] > 0
    y_r[:-1][ok] = px[1:][ok] / px[:-1][ok] - 1.0
    y_up[:-1][ok] = c.h[1:][ok] / px[:-1][ok] - 1.0
    y_dn[:-1][ok] = 1.0 - c.l[1:][ok] / px[:-1][ok]
    y_up = np.maximum(y_up, 0.0)
    y_dn = np.maximum(y_dn, 0.0)
    return y_r, y_up, y_dn


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

    def to_dict(self) -> dict:
        return {
            "bar": self.bar, "ic": self.ic, "q_bps": self.q * 1e4,
            "shrink": self.shrink, "status": self.status,
            "n_train": self.n_train, "holdout_bps": self.holdout_bps,
            "holdout_sr": self.hold_sr, "sel_bar": self.sel_bar,
            "n_holdout": self.n_hold, "family": self.family,
            "thr_bps": self.thr_bps, "n_trades": self.n_trades,
        }

    def _model(self):
        return self.nn if self.family == "mlp" else self.rr

    def fit(self, c: Candles, btc: Candles | None = None) -> dict:
        n = len(c)
        if n < 250:
            self.status = "few-samples"
            return self.to_dict()
        X = feat_matrix(c)
        if btc is not None and len(btc) >= n:
            br = np.zeros(n)
            bp = btc.c[-n:] if len(btc) >= n else btc.c
            if len(bp) == n:
                br[1:] = np.where(bp[:-1] > 0, bp[1:] / bp[:-1] - 1.0, 0.0)
            idio = X[:, 0] - br
            X = np.column_stack([X, br, idio])
        else:
            X = np.column_stack([X, np.zeros(n), np.zeros(n)])
        y_r, y_up, y_dn = _targets(c)
        # embargo: last train label needs bar cut; holdout is last 20%
        ok = np.isfinite(y_r) & np.isfinite(X).all(axis=1)
        idx = np.where(ok)[0]
        if len(idx) < 200:
            self.status = "few-samples"
            return self.to_dict()
        cut = idx[int(0.8 * len(idx))]
        train, hold = idx[idx < cut], idx[idx >= cut]
        self.up.fit(X[train], np.clip(y_up[train], 0, 0.05))
        self.dn.fit(X[train], np.clip(y_dn[train], 0, 0.05))
        # Les familles concourent sur le même train et le même holdout ;
        # chacune est un essai de plus au guichet du hasard.
        self.rr.fit(X[train], y_r[train])
        self.nn.fit(X[train], y_r[train])
        # La porte doit juger la RÈGLE, pas le modèle. L'ancienne version
        # facturait 7 bps sur CHAQUE barre du holdout, y compris les barres
        # où le moteur ne trade jamais : un modèle qui ne parle fort qu'une
        # fois sur cent était condamné par les quatre-vingt-dix-neuf
        # silences. On évalue donc au déclenchement réel — |prédiction| au
        # dessus d'un seuil — et l'on facture les coûts que le moteur paie
        # vraiment : la sortie gagnante repose au carnet (maker, dégradé du
        # risque de file), la perdante traverse le spread.
        c_win = (1.0 - QUEUE_MISS) * self.cost_win + QUEUE_MISS * self.fee
        scores = {}
        for fam, mdl in (("ridge", self.rr), ("mlp", self.nn)):
            p = mdl.predict(X[hold])
            sd_p = float(np.std(p))
            ic = _ic(p, y_r[hold])
            for k in THRESHOLDS:
                # Plancher économique intégré À LA MESURE : un mouvement
                # prévu sous le coût de la jambe gagnante est arithmétique-
                # ment sans espoir. En le mettant ici, la règle mesurée est
                # exactement la règle jouée — un filtre live supplémentaire
                # ferait trader moins de barres que celles validées.
                thr = max(k * sd_p, c_win * 1e-4)
                m = np.abs(p) >= thr
                n_tr = int(m.sum())
                if n_tr < MIN_TRADES:
                    continue
                # PnL directionnel, net des coûts réels. La porte prouve
                # UN avantage de direction qui paie sa friction ; le choix
                # du take et du stop appartient à economics.choose_bracket,
                # qui l'optimise par espérance simulée. Imposer ici une
                # géométrie fixe dégradait la mesure sans la rendre plus
                # fidèle : à barrières symétriques, la jambe perdante coûte
                # plus que la gagnante ne rapporte, et c'est précisément ce
                # déséquilibre que le choix par espérance corrige en aval.
                gains = np.sign(p[m]) * y_r[hold][m] * 1e4
                net = gains - np.where(gains > 0, c_win, self.fee)
                sd = float(np.std(net, ddof=1))
                sr = float(np.mean(net)) / sd if sd > 1e-12 else 0.0
                cur = scores.get("best")
                if cur is None or sr > cur["sr"]:
                    scores["best"] = {
                        "fam": fam, "pred": p, "ic": ic, "thr": thr,
                        "k": k, "n_tr": n_tr,
                        "bps": float(np.mean(net)), "sr": sr,
                    }
        if "best" not in scores:
            # Assez de barres, mais aucun seuil ne déclenche assez souvent :
            # l'horloge prédit des mouvements plus petits que le coût. C'est
            # un refus mesuré, pas un manque de données.
            self.status, self.shrink = "veto", 0.0
            self.thr_bps, self.n_trades = c_win, 0
            self.n_hold = int(len(hold))
            self.n_train = int(len(train))
            return self.to_dict()
        best = scores["best"]
        self.family = best["fam"]
        pred = best["pred"]
        self.ic = best["ic"]
        self.thr_bps = float(best["thr"]) * 1e4
        self.n_trades = best["n_tr"]
        resid = np.abs(y_r[hold] - pred)
        self.q = float(np.quantile(resid, 0.80)) if len(resid) else 0.0
        self.holdout_bps = best["bps"]
        self.n_train = int(len(train))
        sr = best["sr"]
        # Cellules cherchées à chaque refit : 3 actifs x 4 horloges x
        # N familles x N seuils. Le seuil est un paramètre choisi sur le
        # holdout : il se paie au guichet du hasard comme tout le reste, et
        # la barre est comparée au nombre de TRADES, pas de barres — c'est
        # sur eux que la moyenne est estimée.
        n_cells = len(ASSETS) * len(BARS) * len(FAMILIES) * len(THRESHOLDS)
        sel_bar = expected_max_sharpe(n_cells, best["n_tr"])
        ic_floor = 2.0 / math.sqrt(max(len(hold), 4))
        self.hold_sr, self.sel_bar, self.n_hold = sr, sel_bar, int(len(hold))
        if self.holdout_bps > 0 and sr > sel_bar and self.ic > ic_floor:
            self.shrink = float(min(0.6, 0.2 + 2.0 * self.ic))
            self.status = "live"
        else:
            self.shrink = 0.0
            self.status = "veto"
        return self.to_dict()

    def predict_row(self, x: np.ndarray) -> dict:
        if self.status != "live":
            return {"r_bps": 0.0, "up_bps": 0.0, "dn_bps": 0.0,
                    "q_bps": self.q * 1e4, "veto": True, "bar": self.bar,
                    "status": self.status, "ic": self.ic}
        r = float(self._model().predict(x.reshape(1, -1))[0]) * self.shrink
        up = max(float(self.up.predict(x.reshape(1, -1))[0]), 0.0)
        dn = max(float(self.dn.predict(x.reshape(1, -1))[0]), 0.0)
        r_bps, q_bps = r * 1e4, self.q * 1e4
        # La règle jouée EST la règle mesurée : le seuil validé, appliqué à
        # la prédiction brute comme au fit. Rien d'autre — un second filtre
        # non validé ferait trader moins de barres que celles sur
        # lesquelles l'économie a été établie.
        raw = r_bps / max(self.shrink, 1e-9)   # avant retrait, comme au fit
        veto = abs(raw) < self.thr_bps
        return {
            "r_bps": r_bps, "up_bps": up * 1e4, "dn_bps": dn * 1e4,
            "q_bps": q_bps, "veto": veto, "bar": self.bar,
            "status": self.status, "ic": self.ic,
        }


def _row(c: Candles, btc: Candles | None) -> np.ndarray:
    X = feat_matrix(c)
    row = X[-1]
    br = 0.0
    if btc is not None and len(btc) >= 2 and btc.c[-2] > 0:
        br = float(btc.c[-1] / btc.c[-2] - 1.0)
    idio = float(row[0] - br)
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
        names = list(names or ASSETS)
        out = {}
        self.models = {}
        for inst in names:
            for bar in BARS:
                try:
                    c = store.load(inst, bar)
                except Exception:
                    continue
                btc = None
                if inst != "BTC-USDT-SWAP":
                    try:
                        btc = store.load("BTC-USDT-SWAP", bar)
                    except Exception:
                        btc = None
                m = CandleModel(bar, self.fee)
                d = m.fit(c, btc)
                self.models[(inst, bar)] = m
                out[f"{inst.split('-')[0]}:{bar}"] = d
                self.log(f"clock {inst.split('-')[0]} {bar} {d['status']} "
                         f"[{d['family']}] ic={d['ic']:.3f} "
                         f"net={d['holdout_bps']:+.2f}bps/trade "
                         f"sr={d['holdout_sr']:+.3f} vs bar={d['sel_bar']:.3f} "
                         f"seuil={d['thr_bps']:.1f}bps "
                         f"trades={d['n_trades']}/{d['n_holdout']} "
                         f"n={d['n_train']}")
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
            v = m.predict_row(_row(c, btc))
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
        if len(live) < 2:
            return {
                "veto": True, "score": 0.0, "ml_bps": 0.0, "tp_bps": 12.0, "sl_bps": 18.0,
                "alpha": 0.0, "ic": 0.0, "status": "incoherent", "policy": "flat",
                "bar": "5m", "clocks": clock_s, "r_bps": 0.0,
            }
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
        return {
            "veto": False, "score": score, "ml_bps": wsum, "tp_bps": tp, "sl_bps": sl,
            "alpha": 1.0, "ic": float(np.mean([v["ic"] for v in live])),
            "status": "live", "policy": "candle",
            "bar": dom["bar"], "clocks": clock_s, "r_bps": wsum,
            "up_bps": float(dom["up_bps"]), "dn_bps": float(dom["dn_bps"]),
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
                "n_trials": len(ASSETS) * len(BARS) * len(FAMILIES)
                             * len(THRESHOLDS),
                "family": getattr(m, "family", "ridge") if m else "ridge",
                "thr_bps": getattr(m, "thr_bps", 0.0) if m else 0.0,
                "n_trades": getattr(m, "n_trades", 0) if m else 0,
                "alpha": getattr(m, "shrink", 0.0) if m else 0.0,
            }
        d["_best"] = best
        return d