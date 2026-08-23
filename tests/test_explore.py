"""Le mode éclaireur : des trades réels, minuscules, sous budget dur.

Le carnet validé peut rester vide des heures — c'est honnête — mais un
moteur qui n'exécute jamais rien ne mesure jamais son exécution. Les
éclaireurs paient un petit prix connu et plafonné pour exercer la chaîne
entrée→bracket→sortie en vrai et mesurer le remplissage maker au TP. Ce
qu'ils ne doivent JAMAIS faire : grossir avec la conviction, contourner
une gate, ou dépasser leur budget du jour.
"""

import numpy as np

from hermes.exchange.broker import PaperBroker
from hermes.scalp.engine import ScalpEngine


def _moteur(tmp_path, **explore):
    class _E:
        peak_equity = 10_000.0
        day_start_equity = 10_000.0

    class _R:
        trading_allowed = True
        must_flatten = False
        daily_loss_limit_pct = 8.0
        max_drawdown_pct = 25.0
        state = _E()

        def update_equity(self, *a, **k):
            pass

    b = PaperBroker(cash=10_000.0)
    cfg = {"scalp": {"explore": {"cooldown_s": 0.0, **explore}}, "costs": {}}
    eng = ScalpEngine(cfg, b, None, _R(), lambda m: None, str(tmp_path))
    return eng, b, _R


def _pred(inst="SOL-USDT-SWAP", px=180.0, edge=9.0, spread=1.2):
    return {"inst": inst, "px": px, "edge_bps": edge, "spread_bps": spread,
            "l2": True, "vol_bps": 9.0, "tp_bps": 12.0, "sl_bps": 15.0,
            "bar": "90s"}


def _tick(b, inst, px):
    b.book[inst] = {"last": px, "bid": px, "ask": px * 1.0001}
    b.prices[inst] = px


def test_an_explorer_opens_tiny_tagged_and_bracketed(tmp_path):
    eng, b, _ = _moteur(tmp_path)
    _tick(b, "SOL-USDT-SWAP", 180.0)
    eng._explore([_pred()], 10_000.0, {})
    pos = b.positions()
    assert "SOL-USDT-SWAP" in pos
    notionnel = abs(pos["SOL-USDT-SWAP"]) * 180.0
    assert notionnel <= 0.03 * 10_000.0 + 1e-6, "jamais au-dessus du plafond"
    br = eng.brackets["SOL-USDT-SWAP"]
    assert br.get("explore") is True
    assert br["tp"] > 180.0 > br["sl"], "le bracket est armé"
    assert eng.trades[-1]["reason"] == "explore"


def test_size_never_scales_with_conviction(tmp_path):
    tailles = []
    for edge in (5.0, 80.0):
        eng, b, _ = _moteur(tmp_path / str(edge))
        _tick(b, "SOL-USDT-SWAP", 180.0)
        eng._explore([_pred(edge=edge)], 10_000.0, {})
        tailles.append(abs(b.positions()["SOL-USDT-SWAP"]))
    assert tailles[0] == tailles[1], "la conviction ne dimensionne pas"


def test_the_daily_budget_is_a_hard_stop(tmp_path):
    eng, b, _ = _moteur(tmp_path)
    _tick(b, "SOL-USDT-SWAP", 180.0)
    eng._explore_day = __import__("time").strftime("%Y-%m-%d",
                                                   __import__("time").gmtime())
    eng.explore_pnl_day = -eng.explore_daily_bps * 1e-4 * 10_000.0 - 0.01
    eng._explore([_pred()], 10_000.0, {})
    assert not b.positions(), "budget épuisé : plus aucune entrée"


def test_a_real_target_or_a_veto_on_risk_blocks_entries(tmp_path):
    eng, b, _ = _moteur(tmp_path)
    _tick(b, "SOL-USDT-SWAP", 180.0)
    eng._explore([_pred()], 10_000.0, {"SOL-USDT-SWAP": 0.5})
    assert not b.positions(), "une vraie cible a priorité sur l'éclaireur"
    eng.risk.trading_allowed = False
    eng._explore([_pred()], 10_000.0, {})
    assert not b.positions()


def test_wide_spread_and_missing_l2_are_refused(tmp_path):
    eng, b, _ = _moteur(tmp_path)
    _tick(b, "SOL-USDT-SWAP", 180.0)
    eng._explore([_pred(spread=25.0)], 10_000.0, {})
    p = _pred()
    p["l2"] = False
    eng._explore([p], 10_000.0, {})
    assert not b.positions()


def test_the_rebalance_does_not_flatten_an_explorer(tmp_path):
    """_targets met un poids ZÉRO sur tout instrument plat — pas une clé
    absente. La première exemption ne couvrait que l'absence, et chaque
    éclaireur mourait au cycle suivant (mesuré en live : ouvert 10:25:09,
    aplati 10:25:20). Le segment de tick() est reproduit ici avec la
    cible nulle explicite, comme en production."""
    eng, b, _ = _moteur(tmp_path)
    _tick(b, "SOL-USDT-SWAP", 180.0)
    eng._explore([_pred()], 10_000.0, {})
    qty = b.positions()["SOL-USDT-SWAP"]
    targets = {"SOL-USDT-SWAP": 0.0}       # ce que _targets produit vraiment
    pending = {}
    for inst, tgt_w in targets.items():
        pending[inst] = tgt_w * 10_000.0 / 180.0
    for inst in b.positions():
        pending.setdefault(inst, 0.0)
    for inst in list(pending):
        if (eng.brackets.get(inst) or {}).get("explore") \
                and abs(pending[inst]) < 1e-12:
            pending.pop(inst)
    assert "SOL-USDT-SWAP" not in pending
    eng.pending = pending
    eng.execute_pending()
    assert b.positions().get("SOL-USDT-SWAP") == qty, "l'éclaireur survit"
    # une vraie cible non nulle, elle, reprend la main
    assert eng.brackets["SOL-USDT-SWAP"].get("t0"), "la tenue est datée"


def test_a_stale_zero_target_cannot_kill_a_fresh_explorer(tmp_path):
    """Le vrai bug mesuré (explore 15:43:05, fill 15:43:17) : le pending
    construit dans le MÊME tick, AVANT l'ouverture, porte une cible zéro
    explicite pour l'instrument, et execute_pending la consomme après
    coup. L'exemption doit donc vivre à la consommation, pas seulement à
    la construction."""
    eng, b, _ = _moteur(tmp_path)
    _tick(b, "SOL-USDT-SWAP", 180.0)
    # le tick a posé sa cible zéro AVANT que l'éclaireur ouvre
    eng.pending = {"SOL-USDT-SWAP": 0.0}
    eng._explore([_pred()], 10_000.0, {})
    qty = b.positions()["SOL-USDT-SWAP"]
    eng.execute_pending()
    assert b.positions().get("SOL-USDT-SWAP") == qty, \
        "la cible zéro périmée refermait l'éclaireur 12 s après l'entrée"
    # et une vraie cible non nulle garde le droit de le redimensionner
    eng.pending = {"SOL-USDT-SWAP": 2.0}
    eng.execute_pending()
    assert abs(b.positions().get("SOL-USDT-SWAP", 0.0) - 2.0) < 0.5


def test_a_crossed_take_feeds_the_queue_measurement(tmp_path):
    eng, b, _ = _moteur(tmp_path)
    _tick(b, "SOL-USDT-SWAP", 180.0)
    eng._explore([_pred()], 10_000.0, {})
    br = eng.brackets["SOL-USDT-SWAP"]
    au_dela = br["tp"] * 1.001
    eng.ticks["SOL-USDT-SWAP"] = {"last": au_dela, "bid": au_dela,
                                  "ask": au_dela * 1.0001}
    _tick(b, "SOL-USDT-SWAP", au_dela)
    assert eng.check_exits() == ["SOL-USDT-SWAP"]
    assert eng.explore_stats["tp_maker"] == 1
    assert eng.explore_pnl_day > 0, "un TP maker gagné crédite le budget"


def test_a_stopped_explorer_debits_the_budget(tmp_path):
    eng, b, _ = _moteur(tmp_path)
    _tick(b, "SOL-USDT-SWAP", 180.0)
    eng._explore([_pred()], 10_000.0, {})
    br = eng.brackets["SOL-USDT-SWAP"]
    sous = br["sl"] * 0.999
    eng.ticks["SOL-USDT-SWAP"] = {"last": sous, "bid": sous,
                                  "ask": sous * 1.0001}
    _tick(b, "SOL-USDT-SWAP", sous)
    assert eng.check_exits() == ["SOL-USDT-SWAP"]
    assert eng.explore_stats["sl"] == 1
    assert eng.explore_pnl_day < 0
