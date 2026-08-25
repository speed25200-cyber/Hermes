"""Le mode éclaireur : des trades réels, minuscules, sous budget dur.

Sa mission d'origine était de mesurer ce que le modèle de coût suppose —
taux de manqué en file d'attente, écart d'entrée, écart d'une sortie
posée contre une sortie qui traverse. Cette mission est terminée : les
chiffres sont acquis. Ce qui reste est plus étroit et plus utile.

Un éclaireur n'ouvre plus QUE sur une règle validée dont la taille a été
ramenée à zéro par le frein du gouverneur ou par le plancher de levier.
Il joue alors exactement cette règle — même direction, même horizon, même
garde-fou — à taille minimale, et le trade compte dans la mesure en
direct de la règle. Deviner le signe du flux toutes les deux minutes ne
mesurait plus rien : ça payait des frais pour du bruit, et ça donnait à
voir un moteur qui ouvre des micro-positions sans rapport avec ce qu'il a
prouvé.

Ce qu'un éclaireur ne doit JAMAIS faire : grossir avec la conviction,
contourner une gate, ou dépasser son budget du jour.
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


def _pred(inst="SOL-USDT-SWAP", px=180.0, edge=9.0, spread=1.2,
          regle=True):
    """Une prédiction de règle VALIDÉE dont la taille est tombée à zéro.

    C'est le seul cas où un éclaireur ouvre désormais : sortie_temps
    marque une économie mesurée, et dir la direction que la règle a
    choisie. Passer regle=False rend une prédiction ordinaire, sur
    laquelle plus rien ne doit s'ouvrir.
    """
    p = {"inst": inst, "px": px, "edge_bps": edge, "spread_bps": spread,
         "l2": True, "vol_bps": 9.0, "tp_bps": 12.0, "sl_bps": 15.0,
         "bar": "90s"}
    if regle:
        p.update(sortie_temps=True, h_bars=6,
                 dir="long" if edge > 0 else "short",
                 net_bps=11.0, net_sd=55.0, net_n=600)
    else:
        p.update(dir="flat")
    return p


def test_nothing_opens_without_a_validated_rule(tmp_path):
    """Le coeur du changement : plus une seule position sur autre chose
    qu'une règle validée. C'est ce que l'utilisateur voyait — des
    micro-positions ouvertes sur une devinette de signe de flux, sans
    rapport avec la moindre prédiction prouvée."""
    eng, b, _ = _moteur(tmp_path)
    _tick(b, "SOL-USDT-SWAP", 180.0)
    eng._explore([_pred(regle=False)], 10_000.0, {})
    assert not b.positions(), "un éclaireur a ouvert sans règle validée"


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
    assert br.get("mesure") is True, "ce trade doit compter dans la mesure"
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


def test_a_resting_exit_and_a_crossing_exit_are_measured_apart(tmp_path):
    """Un take POSÉ se remplit à son prix pendant que le marché l'a
    dépassé : l'écart au marquage est négatif par construction, et c'est
    le plafond du take, pas un mauvais remplissage. Une sortie qui
    TRAVERSE, elle, mesure une vraie glissade. Les mélanger produisait un
    nombre qui ne veut rien dire — et sur lequel j'ai failli durcir le
    modèle de coût à tort.
    """
    from hermes.scalp.engine import ScalpEngine
    stats = ScalpEngine.__new__(ScalpEngine).__class__
    assert stats is ScalpEngine
    # les deux compteurs existent et sont distincts dès l'initialisation
    import inspect
    src = inspect.getsource(ScalpEngine.__init__)
    for cle in ("exit_maker_bps", "n_exit_maker",
                "exit_taker_bps", "n_exit_taker"):
        assert cle in src, cle
    assert "exit_edge_bps" not in src, "l'ancien chiffre mélangé subsiste"


def _moteur_nu(tmp_path):
    from hermes.scalp.engine import ScalpEngine

    class _B:
        def positions(self): return {}
        def equity(self): return 10_000.0

    class _E:
        peak_equity = 10_000.0
        day_start_equity = 10_000.0

    class _R:
        trading_allowed = True
        daily_loss_limit_pct = 8.0
        max_drawdown_pct = 25.0
        state = _E()

    return ScalpEngine({"scalp": {}, "costs": {}}, _B(), None, _R(),
                       lambda m: None, str(tmp_path))


def test_a_newly_validated_rule_starts_at_a_tenth_of_its_size(tmp_path):
    """La porte établit un avantage sur l'HISTOIRE ; elle ne peut rien
    dire de ce que l'exécution, la latence et le régime du jour lui feront
    subir. Mesuré : une règle à +9 à +11 bps par trade hors échantillon a
    rendu -609 USD en quatre heures de direct pendant que les éclaireurs
    étaient à +3,53. Une règle nouvellement validée paie donc sa mesure au
    tarif de la mesure, pas au tarif de la conviction."""
    eng = _moteur_nu(tmp_path)
    assert eng._confiance() == 0.1


def test_size_grows_only_while_the_live_edge_holds(tmp_path):
    """La montée en taille est conditionnelle : elle suit le nombre de
    trades fermés ET le signe du net réalisé. Un avantage qui s'évapore en
    direct renvoie la règle au dixième de taille, quel que soit son
    holdout."""
    eng = _moteur_nu(tmp_path)
    eng.live_stats = {"n": 30, "bps": +4.0}
    assert eng._confiance() == 0.1
    eng.live_stats = {"n": 80, "bps": +4.0}
    milieu = eng._confiance()
    assert 0.1 < milieu < 1.0
    eng.live_stats = {"n": 200, "bps": +4.0}
    assert eng._confiance() == 1.0
    # le même échantillon, mais perdant : retour au plancher
    eng.live_stats = {"n": 200, "bps": -0.5}
    assert eng._confiance() == 0.1


def test_the_realised_return_is_counted_at_the_same_costs_as_the_gate(tmp_path):
    """Pour que les deux mesures soient comparables, le direct se compte
    avec l'arithmétique de la porte : maker sur la jambe posée, taker sur
    celle qui traverse."""
    eng = _moteur_nu(tmp_path)
    inst = "BTC-USDT-SWAP"
    eng.brackets[inst] = {"entry": 100.0, "side": "long"}

    class _F:
        price, ts, fee = 101.0, 0.0, 0.0
        inst = "BTC-USDT-SWAP"

    # Les jambes simultanees se soldent par INSTANT : on ferme le paquet
    # avant de lire le compteur.
    eng._compter_realise(inst, _F(), +1.0, maker_at=101.0)
    eng._solder_paquet()
    assert eng.live_stats["n"] == 1
    assert abs(eng.live_stats["bps"] - (100.0 - eng.cost_tp_bps)) < 1e-9
    # une sortie qui traverse paie l'aller-retour complet
    eng.live_stats = {"n": 0, "bps": 0.0, "jambes": 0}
    eng._paquet = {}
    eng._compter_realise(inst, _F(), +1.0, maker_at=None)
    eng._solder_paquet()
    assert abs(eng.live_stats["bps"] - (100.0 - eng.round_trip_bps)) < 1e-9


def test_an_explorer_close_is_not_counted_as_the_rule(tmp_path):
    """Les éclaireurs ont leur propre comptabilité : les mélanger
    masquerait le chiffre qu'on cherche."""
    eng = _moteur_nu(tmp_path)
    inst = "SOL-USDT-SWAP"
    eng.brackets[inst] = {"entry": 100.0, "side": "long", "explore": True}

    class _F:
        price, ts, fee = 101.0, 0.0, 0.0
        inst = "SOL-USDT-SWAP"

    eng._compter_realise(inst, _F(), +1.0, maker_at=None)
    assert eng.live_stats["n"] == 0


def test_the_burn_in_scales_notional_not_leverage(tmp_path):
    """Le levier est entier et plancherré à 2 : un dixième de taille
    appliqué LÀ donne zéro, et la règle ne peut alors jamais accumuler les
    trades qui lui feraient gagner sa taille — un blocage circulaire. Le
    rodage agit donc sur le poids notionnel, qui est continu."""
    eng = _moteur_nu(tmp_path)
    eng.max_name = 20.0
    p = {"inst": "BTC-USDT-SWAP", "dir": "long", "edge_bps": 12.0,
         "vol_bps": 25.0, "h_bars": 6, "sl_bps": 60.0, "tp_bps": 200.0,
         "cost_bps": 9.0, "cost_tp_bps": 4.0, "size_mult": 1.0,
         "net_bps": 11.0, "net_sd": 55.0, "net_n": 600,
         "sortie_temps": True}
    eng.live_stats = {"n": 0, "bps": 0.0}
    rodage = eng._targets([dict(p)])["BTC-USDT-SWAP"]
    eng.live_stats = {"n": 500, "bps": +5.0}
    plein = eng._targets([dict(p)])["BTC-USDT-SWAP"]
    assert rodage > 0.0, "le rodage ne doit pas empêcher de trader du tout"
    assert plein > rodage
    assert abs(rodage / plein - 0.1) < 1e-6, f"{rodage} vs {plein}"


def test_the_risk_brake_is_published_not_inferred(tmp_path):
    """À -6,1 % dun budget journalier de 8 %, le gouverneur retombe à 0,25
    et le levier passe sous son plancher entier : le moteur cesse alors de
    trader tout seul. C'est le comportement voulu, mais sans ce chiffre au
    relevé, « la règle ne trade plus » et « la règle est freinée » se
    ressemblent trop — et j'ai d'abord attribué l'arrêt au rodage."""
    eng = _moteur_nu(tmp_path)
    assert abs(eng._risk_scale() - 1.0) < 1e-9

    class _E:
        peak_equity = 10_000.0
        day_start_equity = 10_000.0

    eng.risk.state = _E()

    class _B:
        def positions(self): return {}
        def equity(self): return 9_390.0     # -6,1 % sur la journée

    eng.broker = _B()
    frein = eng._risk_scale()
    assert abs(frein - 0.25) < 1e-9, frein
    # À ce frein-là, la règle doit trader PLUS PETIT, pas s'arrêter. La
    # version précédente tronquait le levier à l'entier et un optimum de
    # 0,84 devenait zéro : quatorze heures sans une seule position sur
    # signal prouvé, pendant que des éclaireurs ouvraient des
    # micro-positions sur une devinette de signe de flux.
    p = {"tp_bps": 40.0, "sl_bps": 50.0, "edge_bps": 9.0, "vol_bps": 25.0,
         "h_bars": 6, "cost_bps": 9.0, "cost_tp_bps": 4.0, "size_mult": 0.5,
         "net_bps": 10.81, "net_sd": 54.3, "net_n": 402,
         "sortie_temps": True}
    freine = eng._pick_lev(p)
    assert 0.0 < freine < 1.5, freine
    eng._risk_scale = lambda: 1.0
    assert eng._pick_lev(p) > 3.0 * freine, "le frein doit vraiment freiner"


def test_a_blocked_rule_still_gets_measured_at_minimum_size(tmp_path):
    """Une règle dont la taille est ramenée à zéro — par le frein du
    gouverneur ou par le plancher de levier entier — n'accumule aucune
    preuve. Elle attend la levée du frein pour commencer seulement à se
    faire juger, et pendant ce temps le seul chiffre disponible reste
    celui du holdout. Mesuré : quatorze heures avec une horloge live sur
    huit refits sur neuf, et live_rule.n toujours à zéro.

    L'éclaireur joue donc cette règle-là à taille minimale — sa direction,
    son horizon, son garde-fou — et le trade compte dans la mesure. C'est
    ce que les éclaireurs font déjà pour l'exécution ; ils le font
    maintenant aussi pour la règle.
    """
    import inspect
    from hermes.scalp.engine import ScalpEngine
    src = inspect.getsource(ScalpEngine._explore)
    assert 'p.get("sortie_temps")' in src
    assert 'p["dir"] == "long"' in src
    assert '"mesure"' in src


def test_an_ordinary_explorer_trade_stays_out_of_the_rule_measure(tmp_path):
    """Un éclaireur ordinaire ne dit rien de la règle : le compter
    diluerait le seul chiffre qui décide."""
    eng = _moteur_nu(tmp_path)
    inst = "SOL-USDT-SWAP"

    class _F:
        price, ts, fee = 101.0, 0.0, 0.0
        inst = "SOL-USDT-SWAP"

    eng.brackets[inst] = {"entry": 100.0, "side": "long", "explore": True,
                          "mesure": False}
    eng._compter_realise(inst, _F(), +1.0, None)
    assert eng.live_stats["n"] == 0

    # le même trade, mais qui a JOUÉ la règle : il compte
    eng.brackets[inst] = {"entry": 100.0, "side": "long", "explore": True,
                          "mesure": True}
    eng._compter_realise(inst, _F(), +1.0, None)
    eng._solder_paquet()          # les jambes se soldent par INSTANT
    assert eng.live_stats["n"] == 1
    assert abs(eng.live_stats["bps"] - (100.0 - eng.round_trip_bps)) < 1e-9
