"""Online order-flow predictor over several horizons at once.

Closed candles are almost a random walk after 7 bp. The information that
can still pay for a maker-in scalp is *current* book + tape + BTC lead,
observed before the move. We dump (x, mid) every poll, assign y only after
each horizon elapses, fit ridge + conformal per horizon on that delayed set.

Why several horizons: the cost of a trade is flat while the move a forecast
captures grows with sqrt(h). The measured live gate said it plainly — at
ic=0.27 a 90 s window captures ~3 bps against ~5 of cost, hopeless by
arithmetic; the same skill over 15 minutes captures ~8. One clock cannot
answer for the other, so each horizon gets its own labels, its own model
and its own gate, and inference speaks with the best *validated* head.

Three rules keep this honest, learned the hard way (the version without
them day-halted at -8.33%):

  * one label per instrument per horizon — sampling every poll against a
    90 s horizon made each label overlap ~9 neighbours, which shrank every
    standard error by ~3x and let an ic>0.04 gate pass pure noise;
  * the gate is deflated: the model refits every few dozen labels, and
    each refit is a fresh draw at the gate — and with three horizons
    searched in parallel, every head's bar is charged for all three;
  * the warm-up prior never trades. It reports a score for the screen,
    and that is all a hand rule that has never faced a holdout deserves.
"""

from __future__ import annotations

import json
import math
import os
import time

import numpy as np

from ..backtest.metrics import expected_max_sharpe
from ..ml.models import RidgeRegressor
from .economics import QUEUE_MISS

HORIZON_S = 90.0                       # shortest head; kept for callers
HORIZONS_S = (90.0, 300.0, 900.0)      # 90 s, 5 min, 15 min
# Seuils de déclenchement en écarts-types de la prédiction : une tête ne
# trade pas chaque étiquette, elle trade celles où elle parle fort.
THRESHOLDS = (0.0, 0.5, 1.0, 1.5, 2.0, 2.5)
MIN_TRADES = 40
KEYS = ("imb1", "imb5", "depth", "micro_bps", "ofi", "flow",
        "spread", "tape", "btc_lead", "lag")


def _ic(a, b) -> float:
    m = np.isfinite(a) & np.isfinite(b)
    a, b = np.asarray(a)[m], np.asarray(b)[m]
    if len(a) < 40:
        return 0.0
    a, b = a - a.mean(), b - b.mean()
    da, db = float(np.dot(a, a)), float(np.dot(b, b))
    if da <= 0 or db <= 0:
        return 0.0
    return float(np.dot(a, b) / math.sqrt(da * db))


class _Head:
    """One horizon: its labels, its model, its gate. Nothing shared."""

    def __init__(self, horizon_s: float, fee_bps: float):
        self.h = float(horizon_s)
        self.fee = float(fee_bps)
        self.X: list[list[float]] = []
        self.y: list[float] = []        # bps
        self.T: list[float] = []        # label time (for the purged split)
        self.fits = 0                   # refits so far -> selection trials
        self.sel_bar = 0.0
        self.hold_sr = 0.0
        self._acc: dict[str, float] = {}  # inst -> time of last ACCEPTED label
        self.ridge = RidgeRegressor(l2=8.0)
        self.q = 8.0
        self.ic = 0.0
        self.shrink = 0.0
        self.status = "warmup"
        self.n = 0
        # Coût de la jambe gagnante (entrée postée + take posé au carnet) ;
        # la perdante traverse le spread et paie self.fee.
        self.cost_win = 4.0
        self.thr_bps = 0.0      # sous ce mouvement prévu, la tête se tait
        self.pente = 0.0        # ce que la réalité multiplie à l'annonce
        self.n_trades = 0

    @property
    def nom(self) -> str:
        return f"{int(self.h)}s" if self.h < 600 else f"{int(self.h // 60)}m"

    def label(self, s: dict, mid_now: float, now: float) -> bool:
        """Try to label sample `s` for this horizon. True if consumed."""
        if now - s["t"] < self.h:
            return False
        if mid_now <= 0 or s["mid"] <= 0:
            return True                 # unlabelable, but done for this head
        # one label per instrument per horizon: overlapping labels are the
        # same observation counted several times
        if s["t"] - self._acc.get(s["inst"], -1e18) < self.h:
            return True
        y = (mid_now / s["mid"] - 1.0) * 1e4
        if abs(y) > 250 * math.sqrt(self.h / 90.0):  # bad print, scaled
            return True
        self._acc[s["inst"]] = s["t"]
        self.X.append(s["x"])
        self.y.append(y)
        self.T.append(s["t"])
        return True

    def trim(self) -> None:
        if len(self.y) > 8000:
            self.X, self.y = self.X[-5000:], self.y[-5000:]
            self.T = self.T[-5000:]

    def fit(self, log) -> None:
        if len(self.y) < 250:
            self.status, self.shrink, self.n = "warmup", 0.0, len(self.y)
            return
        X = np.asarray(self.X, dtype=np.float64)
        y = np.asarray(self.y, dtype=np.float64)
        T = np.asarray(self.T[:len(y)] if len(self.T) >= len(y)
                       else list(self.T) + [0.0] * (len(y) - len(self.T)),
                       dtype=np.float64)
        cut = int(0.75 * len(y))
        t_cut = T[cut] if cut < len(T) else 0.0
        # purge: a train label whose window may cross the boundary is dropped
        train = np.arange(cut)[T[:cut] < t_cut - self.h] if t_cut > 0 \
            else np.arange(cut)
        hold = np.arange(cut, len(y))
        if len(train) < 150 or len(hold) < 60:
            self.status, self.shrink = "warmup", 0.0
            self.n = len(y)
            return
        self.ridge = RidgeRegressor(l2=8.0)
        self.ridge.fit(X[train], y[train])
        pred = self.ridge.predict(X[hold])
        self.ic = _ic(pred, y[hold])
        self.q = float(np.quantile(np.abs(y[hold] - pred), 0.80))
        # Diagnostic, jamais une décision : de combien la réalité multiplie
        # ce que la tête annonce. Très en dessous de 1, le modèle est
        # rétréci et ses points de base ne sont pas des points de base.

        self.n = len(y)
        # La porte juge la RÈGLE, pas le modèle : le moteur ne trade pas
        # chaque étiquette, il trade celles où la tête parle fort. Facturer
        # les frais sur les silences condamnait un signal concentré. Coûts
        # réels : la sortie gagnante repose au carnet, la perdante traverse.
        c_win = (1.0 - QUEUE_MISS) * self.cost_win + QUEUE_MISS * self.fee
        sd_p = float(np.std(pred))
        best = None
        # La barre dépend du nombre de trades de la cellule : elle doit
        # donc être connue DANS la boucle, pas après. Chaque refit est un
        # tirage de plus, les trois horizons sont trois recherches
        # parallèles, et la grille de seuils est cherchée dans chacune.
        trials = (min(max(self.fits + 1, 2), 64) * len(HORIZONS_S)
                  * len(THRESHOLDS))
        # Le seuil était plancherré au coût de la jambe gagnante : « sous
        # 4,8 bps prévus, sans espoir ». C'est vrai d'un modèle calibré ;
        # ce n'en est pas un. Un ridge régularisé rend une moyenne
        # conditionnelle rétrécie vers zéro — il peut annoncer 2 bps là où
        # la réalité en délivre 9, et l'ic de 0,182 mesuré en production
        # sur 90 s disait précisément qu'il voyait quelque chose. Le
        # plancher refusait donc a priori ce que la mesure aurait pu
        # accepter. Il tombe. Rien ne s'ouvre pour autant : le net par
        # trade doit rester positif APRÈS coûts réels, et le Sharpe doit
        # battre la barre déflatée. Deux mesures remplacent une hypothèse.
        for k in THRESHOLDS:
            thr = k * sd_p
            m = np.abs(pred) >= thr
            n_tr = int(m.sum())
            if n_tr < MIN_TRADES:
                continue
            gains = np.sign(pred[m]) * y[hold][m]
            net = gains - np.where(gains > 0, c_win, self.fee)
            sd = float(np.std(net, ddof=1))
            mu = float(np.mean(net))
            sr = mu / sd if sd > 1e-12 else 0.0
            # Classement par la MARGE sur la barre de la cellule, et non
            # par le Sharpe nu. Un seuil haut gagne toujours au Sharpe nu
            # — sur soixante trades, où la barre qu'il s'impose vaut 0,41
            # et qu'il ne franchira jamais. Chercher avec le critère qui
            # décide, plutôt que chercher un maximum qu'on refusera.
            # Et à égalité de marge, une cellule qui perd de l'argent ne
            # peut de toute façon pas passer : elle ne prend pas la place
            # d'une qui en gagne.
            barre = expected_max_sharpe(trials, n_tr)
            cle = (1 if mu > 0 else 0, sr - barre)
            if best is None or cle > best["cle"]:
                # Calibration mesurée là où la règle déclenche : de combien
                # la réalité multiplie ce que la tête annonce.
                vp = float(np.var(pred[m]))
                pente = (float(np.cov(pred[m], y[hold][m])[0, 1]) / vp) \
                    if vp > 1e-18 else 0.0
                best = {"thr": thr, "n_tr": n_tr, "mu": mu, "sr": sr,
                        "barre": barre, "cle": cle, "pente": pente}
        if best is None:
            # Assez d'étiquettes, mais aucun seuil ne déclenche assez
            # souvent pour qu'une moyenne soit une mesure : la tête prédit
            # des mouvements plus petits que le coût. C'est un refus, pas
            # une chauffe — le dire autrement masquerait un verdict.
            self.shrink, self.status = 0.0, "veto"
            self.thr_bps, self.n_trades = 0.0, 0
            self.fits += 1
            log(f"flow {self.nom} veto n={self.n} hold={len(hold)} "
                f"ic={self.ic:.3f} aucun seuil ne déclenche {MIN_TRADES}x "
                f"(fit #{self.fits})")
            return
        self.thr_bps = float(best["thr"])
        self.n_trades = best["n_tr"]
        mu, self.hold_sr = best["mu"], best["sr"]
        self.pente = float(best["pente"])
        # Every refit is one more draw at this gate; the three horizons are
        # three parallel searches and the threshold grid is searched inside
        # each — every one of them is charged. Capped so a long-running desk
        # is not punished forever for its own uptime.
        self.fits += 1
        self.sel_bar = best["barre"]
        if mu > 0 and self.hold_sr > self.sel_bar:
            floor = 2.0 / math.sqrt(best["n_tr"])
            # Même correction que pour les horloges : l'échelle appliquée
            # à la prédiction est la pente mesurée, pas une formule sur
            # l'ic. Une tête dont la pente vaut 2,3 annonçait 1,9 bps et
            # se voyait rétrécie à 0,6 — le bracket ne pouvait qu'être
            # refusé. La confiance est jugée par la porte, payée en taille
            # par le quart de Kelly.
            self.shrink = float(min(3.0, max(0.0, self.pente))) \
                if self.ic > floor else 0.25
            self.status = "live"
        else:
            self.shrink, self.status = 0.0, "veto"
        log(f"flow {self.nom} {self.status} n={self.n} hold={len(hold)} "
            f"ic={self.ic:.3f} net={mu:+.2f}bps/trade sr={self.hold_sr:+.3f} "
            f"vs bar={self.sel_bar:.3f} seuil={self.thr_bps:.1f}bps "
            f"pente={self.pente:.2f} "
            f"trades={best['n_tr']} (fit #{self.fits}) q={self.q:.1f}")

    def to_dict(self) -> dict:
        return {"status": self.status, "n": self.n, "ic": self.ic,
                "q_bps": self.q, "shrink": self.shrink,
                "fits": self.fits, "sel_bar": self.sel_bar,
                "hold_sr": self.hold_sr, "thr_bps": self.thr_bps,
                "pente": self.pente,
                "n_trades": self.n_trades}


class FlowBrain:
    def __init__(self, state_dir: str, fee_bps: float = 7.0, log=None):
        self.path = os.path.join(state_dir, "flow.jsonl")
        self.model_path = os.path.join(state_dir, "flow_model.json")
        self.fee = float(fee_bps)
        self.log = log or (lambda m: None)
        self.pending: list[dict] = []   # unlabeled, shared by every head
        self.heads: dict[float, _Head] = {
            h: _Head(h, self.fee) for h in HORIZONS_S}
        self._last = {}                 # inst -> last
        self._btc_px = 0.0
        self._btc_t = 0.0
        self._load()

    # --- aggregate view: the best validated head speaks for the brain --- #
    def _best(self) -> _Head:
        vivants = [h for h in self.heads.values() if h.status == "live"]
        if vivants:
            return max(vivants, key=lambda h: h.hold_sr - h.sel_bar)
        return self.heads[HORIZONS_S[0]]

    @property
    def status(self) -> str:
        return self._best().status

    @property
    def n(self) -> int:
        return max(h.n for h in self.heads.values())

    @property
    def ic(self) -> float:
        return self._best().ic

    @property
    def q(self) -> float:
        return self._best().q

    @property
    def shrink(self) -> float:
        return self._best().shrink

    def to_dict(self) -> dict:
        b = self._best()
        d = b.to_dict()
        d["horizon_s"] = b.h
        d["heads"] = {h.nom: h.to_dict() for h in self.heads.values()}
        return d

    def vec(self, inst: str, micro: dict, tape: dict, last: float,
            btc_last: float, own_ret_bps: float) -> np.ndarray:
        now = time.time()
        btc_lead = 0.0
        if btc_last > 0 and self._btc_px > 0 and now - self._btc_t < 120:
            btc_lead = (btc_last / self._btc_px - 1.0) * 1e4
        if btc_last > 0:
            self._btc_px, self._btc_t = btc_last, now
        lag = btc_lead - own_ret_bps  # + = BTC already moved, alt hasn't
        if inst.startswith("BTC-"):
            lag = 0.0
        return np.array([
            float(micro.get("imb") or 0.0),
            float(micro.get("book") or 0.0),
            float(micro.get("depth") or 0.0),
            float(micro.get("micro") or 0.0) * 1e4,
            float(micro.get("ofi") or 0.0),
            float(tape.get("flow") or 0.0) if tape else 0.0,
            float(micro.get("spread_bps") or 0.0),
            float((tape or {}).get("vwap_vs") or 0.0) * 1e4,
            btc_lead,
            lag,
        ], dtype=np.float64)

    def push(self, inst: str, x: np.ndarray, mid: float) -> None:
        if mid <= 0:
            return
        self.pending.append({
            "t": time.time(), "inst": inst,
            "x": [float(v) for v in x], "mid": float(mid),
            "done": set(),
        })
        if len(self.pending) > 12000:
            self.pending = self.pending[-8000:]

    def settle(self, mids: dict[str, float]) -> int:
        now = time.time()
        max_h = max(HORIZONS_S)
        kept, n_new = [], {h: 0 for h in HORIZONS_S}
        for s in self.pending:
            s.setdefault("done", set())
            mid1 = float(mids.get(s["inst"]) or 0.0)
            for h, head in self.heads.items():
                if h in s["done"]:
                    continue
                before = len(head.y)
                if head.label(s, mid1, now):
                    s["done"].add(h)
                    n_new[h] += len(head.y) - before
            if len(s["done"]) < len(HORIZONS_S) and now - s["t"] < max_h + 120:
                kept.append(s)
        self.pending = kept
        total = 0
        refit = False
        for h, head in self.heads.items():
            head.trim()
            n = n_new[h]
            total += n
            if n and (len(head.y) % 40 < n
                      or (head.status == "warmup" and len(head.y) >= 250)):
                head.fit(self.log)
                refit = True
        if refit:
            self._save()
        return total

    def fit(self) -> dict:
        for head in self.heads.values():
            head.fit(self.log)
        return self.to_dict()

    def infer(self, x: np.ndarray, micro: dict) -> dict:
        """Predicted move in bps at the best validated horizon.

        Model if any head is live, else the extreme-dislocation prior —
        which reports a score for the screen and NEVER trades.
        """
        spread = max(float(micro.get("spread_bps") or 0.0), 0.6)
        imb = float(micro.get("imb") or 0.0)
        ofi = float(micro.get("ofi") or 0.0)
        micro_bps = float(micro.get("micro") or 0.0) * 1e4
        lag = float(x[9]) if len(x) > 9 else 0.0
        best = self._best()
        pred = 0.0
        src = "prior"
        h_bars = max(1, round(best.h / 60.0))
        if best.status == "live" and best.ridge.w is not None:
            brut = float(best.ridge.predict(x.reshape(1, -1))[0])
            pred = brut * best.shrink
            src = f"flow-{best.nom}"
            # La règle jouée EST la règle mesurée : le seuil validé sur la
            # prédiction brute, plancher économique déjà inclus.
            veto = abs(brut) < best.thr_bps
        else:
            # Warm-up prior: it estimates a score for the screen and NEVER
            # trades. A hand rule that has never faced a holdout has no
            # claim on capital — the version that let "extreme dislocation"
            # fire unvalidated is the one that day-halted at -8.33%.
            pred = 0.6 * micro_bps + 6.0 * imb + 3.0 * ofi + 0.55 * lag
            veto = True
        tp = max(8.0, 1.15 * abs(pred), 1.2 * spread + 4.0)
        sl = max(12.0, 1.6 * abs(pred), tp * 1.2)
        return {
            "r_bps": pred, "ml_bps": pred, "tp_bps": tp, "sl_bps": sl,
            "veto": bool(veto), "score": pred / 8.0,
            "status": src if not veto else "wait",
            "policy": src, "bar": best.nom, "q_bps": best.q, "ic": best.ic,
            "h_bars": h_bars,
            "clocks": {h.nom: h.status for h in self.heads.values()},
        }

    def _save(self) -> None:
        try:
            with open(self.model_path, "w") as f:
                json.dump({h.nom: {"n": h.n, "ic": h.ic, "q": h.q,
                                   "status": h.status, "shrink": h.shrink,
                                   "fits": h.fits}
                           for h in self.heads.values()}, f)
            lab = os.path.join(os.path.dirname(self.model_path), "flow_xy.npz")
            arrs = {}
            for h in self.heads.values():
                k = str(int(h.h))
                arrs["X" + k] = np.asarray(h.X[-4000:], dtype=np.float32)
                arrs["y" + k] = np.asarray(h.y[-4000:], dtype=np.float32)
                arrs["T" + k] = np.asarray(h.T[-4000:], dtype=np.float64)
            np.savez(lab, **arrs)
        except OSError:
            pass

    def _load(self) -> None:
        lab = os.path.join(os.path.dirname(self.model_path), "flow_xy.npz")
        try:
            z = np.load(lab)
            if "X" in z:
                # legacy single-horizon file: those labels are 90 s labels
                head = self.heads[90.0]
                head.X = z["X"].astype(np.float64).tolist()
                head.y = z["y"].astype(np.float64).tolist()
                head.T = z["T"].astype(np.float64).tolist() if "T" in z \
                    else [0.0] * len(head.y)
            else:
                for h, head in self.heads.items():
                    k = str(int(h))
                    if "X" + k in z:
                        head.X = z["X" + k].astype(np.float64).tolist()
                        head.y = z["y" + k].astype(np.float64).tolist()
                        head.T = z["T" + k].astype(np.float64).tolist()
            try:
                meta = json.load(open(self.model_path))
                for h in self.heads.values():
                    if h.nom in meta:
                        h.fits = int(meta[h.nom].get("fits", 0))
                    elif "fits" in meta:      # legacy aggregate
                        h.fits = int(meta.get("fits", 0)) if h.h == 90.0 else 0
            except (OSError, ValueError):
                pass
            for head in self.heads.values():
                if len(head.y) >= 250:
                    head.fit(self.log)
        except Exception:
            pass
