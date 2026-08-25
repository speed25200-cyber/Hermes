"""End-to-end trader cycle tests with the paper broker."""

import numpy as np

from hermes.config import Config
from hermes.data.store import BARS_PER_YEAR
from hermes.data.synthetic import generate
from hermes.exchange.broker import PaperBroker
from hermes.live.trader import Registry, Trader
from hermes.portfolio.allocator import Allocator
from hermes.research.validate import ValidatedStrategy
from hermes.risk import RiskEngine
from hermes.strategy.genome import Genome


def make_trader(tmp_path, strategies, cash=10000.0):
    cfg = Config()
    registry = Registry(str(tmp_path))
    registry.strategies = strategies
    broker = PaperBroker(cash=cash, fee_bps=5.0, slippage_bps=2.0)
    allocator = Allocator(bars_per_year=BARS_PER_YEAR["1H"])
    risk = RiskEngine(max_gross_leverage=2.0, max_instrument_leverage=1.0,
                      daily_loss_limit_pct=50.0, max_drawdown_pct=90.0,
                      min_trade_notional=10.0, max_order_notional=100000.0)
    return Trader(cfg, broker, registry, allocator, risk, log=lambda m: None), broker, risk


def trend_strategy(inst):
    g = Genome(signal="ma_cross", params={"fast": 10, "ratio": 5.0},
               vol_target=0.3, max_lev=1.0)
    return ValidatedStrategy(genome=g, inst=inst, bar="1H",
                             is_stats={}, oos_stats={"sharpe": 1.0, "dsr": 0.5})


def test_cycle_opens_and_updates_positions(tmp_path):
    candles = generate(n=3000, seed=9)
    strat = trend_strategy(candles.inst)
    trader, broker, _ = make_trader(tmp_path, [strat])
    # run several cycles over successive bars
    n_orders = 0
    for i in range(2500, 2600):
        window = {candles.inst: candles.slice(0, i + 1)}
        report = trader.run_cycle(window, candles.ts[i] / 1000.0)
        n_orders += len(report.get("orders", []))
        assert report["equity"] > 0
    assert n_orders > 0  # it actually trades
    # exposure never exceeds per-instrument cap (equity fraction)
    eq = broker.equity()
    pos = broker.positions()
    for inst, q in pos.items():
        assert abs(q) * broker.prices[inst] / eq <= 1.0 + 0.05


def test_kill_switch_flattens(tmp_path):
    candles = generate(n=3000, seed=9)
    strat = trend_strategy(candles.inst)
    trader, broker, risk = make_trader(tmp_path, [strat])
    risk.max_drawdown_pct = 0.0001  # trip immediately after any dip
    window = {candles.inst: candles.slice(0, 2500)}
    trader.run_cycle(window, candles.ts[2499] / 1000.0)
    # force an equity dip by marking prices down sharply
    broker.mark_prices({candles.inst: float(candles.c[2499]) * 0.5})
    window2 = {candles.inst: candles.slice(0, 2501)}
    report = trader.run_cycle(window2, candles.ts[2500] / 1000.0)
    if broker.positions():
        # if a position existed, the halt must have flattened it
        assert report["halted"]
        assert broker.positions() == {}


def test_state_persistence_roundtrip(tmp_path):
    candles = generate(n=3000, seed=9)
    strat = trend_strategy(candles.inst)
    trader, broker, _ = make_trader(tmp_path, [strat])
    window = {candles.inst: candles.slice(0, 2500)}
    trader.run_cycle(window, candles.ts[2499] / 1000.0)
    trader.save_state(str(tmp_path))

    trader2, broker2, _ = make_trader(tmp_path, [strat])
    trader2.load_state(str(tmp_path))
    assert broker2.cash == broker.cash
    assert broker2.pos == broker.pos
    assert trader2.last_close == trader.last_close


def test_registry_tracks_empty_streak(tmp_path):
    """The hunt escalates while research keeps coming back empty: the
    registry counts consecutive empty passes (persisted) and resets on the
    first deploy."""
    reg = Registry(str(tmp_path))
    reg.record_outcome([])
    reg.record_outcome([])
    reg.save()
    reg2 = Registry(str(tmp_path))
    assert reg2.consecutive_empty == 2
    reg2.record_outcome([trend_strategy("BTC-USDT-SWAP")])
    assert reg2.consecutive_empty == 0


def test_empty_book_uses_fast_research_cadence(tmp_path):
    """With no deployed strategies, research goes stale after
    refresh_hours_empty (daily), not the weekly refresh_hours."""
    import time as _t
    from unittest import mock

    from hermes.live.trader import LiveRunner

    def make_runner(strategies):
        lr = LiveRunner.__new__(LiveRunner)   # no network / broker needed
        lr.cfg = Config()
        lr.registry = Registry(str(tmp_path))
        lr.registry.strategies = strategies
        lr.registry.researched_at = _t.time() - 30 * 3600   # 30h ago
        lr.log = lambda m: None
        lr._load_candles = lambda: {}
        return lr

    with mock.patch("hermes.live.trader.run_research",
                    return_value=([], 0)) as rr:
        make_runner([]).ensure_research()
    assert rr.called, "empty book after 30h must re-run research"

    # a non-empty book at the same age must NOT re-run (weekly cadence)
    with mock.patch("hermes.live.trader.run_research",
                    return_value=([], 0)) as rr2:
        make_runner([trend_strategy("BTC-USDT-SWAP")]).ensure_research()
    assert not rr2.called, "deployed book at 30h is fresh on weekly cadence"


def test_empty_research_does_not_wipe_deployed_book(tmp_path):
    """A research pass that finds nothing must keep the live book."""
    import time as _t
    from unittest import mock

    from hermes.live.trader import LiveRunner

    lr = LiveRunner.__new__(LiveRunner)
    lr.cfg = Config()
    lr.registry = Registry(str(tmp_path))
    keep = [trend_strategy("BTC-USDT-SWAP")]
    lr.registry.strategies = keep
    lr.registry.researched_at = 1.0  # force stale
    lr.log = lambda m: None
    lr._load_candles = lambda: {}
    with mock.patch("hermes.live.trader.run_research", return_value=([], 0)):
        lr.ensure_research(force=True)
    assert lr.registry.strategies is keep or lr.registry.strategies == keep
    assert len(lr.registry.strategies) == 1


def test_dead_strategy_is_retired(tmp_path):
    """A deployed strategy whose live shadow returns show a clearly negative
    risk-adjusted edge over enough bars is removed autonomously; a healthy
    one stays."""
    from hermes.portfolio.allocator import StrategyTrack

    dead = trend_strategy("BTC-USDT-SWAP")
    alive = trend_strategy("ETH-USDT-SWAP")
    trader, _, _ = make_trader(tmp_path, [dead, alive])
    sid_dead = trader.registry.sid(dead)
    sid_alive = trader.registry.sid(alive)
    # losing consistently: mean -2bps/bar, sd ~10bps -> deeply negative sharpe
    trader.allocator.tracks[sid_dead] = StrategyTrack(
        ewma_ret=-2e-4, ewma_var=(1e-3) ** 2, n_obs=2000)
    trader.allocator.tracks[sid_alive] = StrategyTrack(
        ewma_ret=+2e-4, ewma_var=(1e-3) ** 2, n_obs=2000)
    trader._retire_dead_strategies()
    sids = [trader.registry.sid(s) for s in trader.registry.strategies]
    assert sid_dead not in sids and sid_alive in sids
    # too few observations must never retire
    trader.registry.strategies = [dead]
    trader.allocator.tracks[sid_dead].n_obs = 10
    trader._retire_dead_strategies()
    assert len(trader.registry.strategies) == 1


def test_governor_scales_book_targets(tmp_path):
    """A de-risked governor must shrink every target the cycle produces."""
    from hermes.risk import LeverageGovernor

    inst = "BTC-USDT-SWAP"
    c = generate(inst=inst, bar="1H", n=1200, seed=5)

    t_full, _, _ = make_trader(tmp_path / "a", [trend_strategy(inst)])
    t_half, _, _ = make_trader(tmp_path / "b", [trend_strategy(inst)])

    class Halved(LeverageGovernor):
        def update(self, equity, peak):  # forced 0.5x, deterministic
            self.last_mult = 0.5
            return 0.5

    t_full.governor = None
    t_half.governor = Halved()

    r_full = t_full.run_cycle({inst: c}, now_ts=1_700_000_000)
    r_half = t_half.run_cycle({inst: c}, now_ts=1_700_000_000)
    tgt_full = r_full["targets"].get(inst, 0.0)
    tgt_half = r_half["targets"].get(inst, 0.0)
    assert abs(tgt_full) > 0.01, "test needs a live signal"
    assert abs(tgt_half - 0.5 * tgt_full) < 1e-9


def test_the_startup_backfill_does_not_block_on_the_new_names():
    """`_ensure_scalp_data` est BLOQUANT : il tourne avant la boucle. Viser
    d'emblée les vingt plus échangés arrêterait le moteur le temps de
    quatorze instruments sur quatre échelles — le rattrapage coûterait la
    mesure qu'il est censé enrichir. Au démarrage on ne rattrape que le
    panel courant, déjà en cache ; le reste arrive en tâche de fond."""
    import inspect
    from hermes.live.trader import LiveRunner
    src = inspect.getsource(LiveRunner.ensure_data)
    assert "_ensure_scalp_data(list(self.scalp.instruments)" in src, \
        "le démarrage vise autre chose que le panel courant"

    boucle = inspect.getsource(LiveRunner.run_forever)
    # AUCUN appel sans argument ne doit subsister : il viserait les vingt
    # plus échangés et bloquerait le démarrage sur quatorze instruments
    assert "_ensure_scalp_data()" not in boucle, \
        "un rattrapage bloquant vise encore tout le panel visé"
    # La cible reste le panel COURANT, nommée en une variable depuis que le
    # rattrapage a été sorti du chemin bloquant.
    assert "noms = list(self.scalp.instruments)" in boucle
    assert "_ensure_scalp_data(noms)" in boucle
    assert "attendus" in boucle, "aucun rattrapage des noms réclamés"
    assert "_rattrapage" in boucle, "rien n'empêche deux rattrapages simultanés"
    # le rattrapage doit vivre HORS du bloc de rafraichissement d'univers,
    # qui ne s'exécute qu'un quart d'heure sur deux
    i_uni = boucle.index("> 900")
    i_att = boucle.index("attendus")
    assert i_att > i_uni
    assert "elif ticks:" in boucle[:i_att], \
        "le rattrapage est enfermé dans le rafraichissement d'univers"


def test_the_startup_backfill_does_not_block_the_engine():
    """Le rattrapage d histoire au demarrage BLOQUAIT tout.

    Mesure en direct : la profondeur 1m portee de trente a soixante jours
    a fait passer ce rattrapage de huit a dix-sept minutes pour SIX noms —
    dix-sept minutes sans un tick, sans un instantane ecrit, sans une
    position surveillee, et un ecran affichant l etat du processus
    precedent. A vingt noms il en aurait fait cinquante-sept.

    Le magasin porte deja l histoire du tour d avant : on s ajuste dessus
    tout de suite, on creuse derriere. Ce test pinne l ORDRE — l ajustement
    initial vient avant l appel bloquant, et cet appel vit dans un fil.
    """
    import inspect

    from hermes.live.trader import LiveRunner

    src = inspect.getsource(LiveRunner.run_forever)
    tete = src.split("last_cycle_bar", 1)[0]
    i_fit = tete.index("self._ajuster(noms")
    i_bf = tete.index("self._ensure_scalp_data(noms)")
    assert i_fit < i_bf, "le rattrapage bloque encore l ajustement initial"
    # et il est dans un fil, pas sur le chemin du demarrage
    bloc = tete[tete.index("def _fond"):]
    assert "threading.Thread(target=_fond" in bloc
    assert "self._ensure_scalp_data(noms)" in bloc.split("threading.Thread")[0]


def test_two_clock_fits_never_run_at_once():
    """Trois chemins declenchent un ajustement — le demarrage, le fond qui
    finit son rattrapage, le refit horaire. fit_store VIDE self.models
    avant de le repeupler : deux passes concurrentes laisseraient le vote
    lire un dictionnaire a moitie rempli, et le moteur veto-erait des
    horloges vivantes sans que rien ne plante. C est le genre de defaut
    qu on ne voit jamais dans un journal."""
    import threading

    from hermes.live.trader import LiveRunner

    class _Faux:
        def __init__(self):
            self.dedans = 0
            self.max = 0
            self.n = 0

    faux = _Faux()
    barriere = threading.Event()

    class _Desk:
        def fit_store(self, store, names):
            faux.dedans += 1
            faux.max = max(faux.max, faux.dedans)
            faux.n += 1
            barriere.wait(0.4)
            faux.dedans -= 1

    class _Scalp:
        horizons = _Desk()

    r = LiveRunner.__new__(LiveRunner)
    r.scalp = _Scalp()
    r.store = None
    r.log = lambda m: None

    fils = [threading.Thread(target=r._ajuster, args=(["BTC"], "t"))
            for _ in range(4)]
    for f in fils:
        f.start()
    barriere.set()
    for f in fils:
        f.join(3.0)
    assert faux.max == 1, f"{faux.max} ajustements simultanes"
    assert faux.n >= 1, "aucun ajustement n a eu lieu"


def test_a_bar_is_loaded_only_when_it_has_actually_advanced():
    """Le moteur devenait muet plusieurs minutes d affilee — visible a
    l ecran, « moteur muet depuis 5 min ».

    La boucle chargeait l historique COMPLET de chaque instrument pour
    chaque barre a chaque tour de cinq secondes : quatre-vingts series de
    dizaines de milliers de lignes, avec leurs jointures de funding,
    d open interest, de flux et de mark — pour n en lire qu un seul
    nombre, le dernier horodatage. Doubler la profondeur 1m de trente a
    soixante jours a double ce cout.

    Ce test suit le SOURCE parce que le defaut est une question de
    sequence, pas de resultat : le resultat etait juste, il coutait
    simplement cent fois son prix.
    """
    import inspect

    from hermes.live.trader import LiveRunner

    src = inspect.getsource(LiveRunner.run_forever)
    i_ts = src.find("dernier_ts(inst, bar)")
    i_load = src.find("self.store.load(inst, bar)")
    assert i_ts > 0, "le dernier horodatage nest plus demande a bon marche"
    assert i_load > i_ts, "la serie est encore chargee avant d etre utile"
    # et le chargement doit etre DANS la branche qui a vu une barre neuve
    tete = src[:i_load]
    assert tete.rfind("if newest > last_scalp_bar") > tete.rfind("for bar in _BARS"), \
        "le chargement nest pas conditionne a une barre neuve"


def test_the_cheap_timestamp_matches_the_loaded_series(tmp_path):
    """Le raccourci doit donner exactement ce que donnait le chemin long,
    sinon on echangerait de la lenteur contre des barres manquees."""
    import numpy as np

    from hermes.data.store import DataStore

    st = DataStore(str(tmp_path))
    lignes = [(i * 60_000, 1.0, 2.0, 0.5, 1.5, 10.0) for i in range(50)]
    st.upsert_candles("X-USDT-SWAP", "1m", lignes)
    c = st.load("X-USDT-SWAP", "1m")
    assert st.dernier_ts("X-USDT-SWAP", "1m") == int(c.ts[-1])
    # un nom inconnu ne fait pas exploser la boucle, il vaut zero
    assert st.dernier_ts("INCONNU-USDT-SWAP", "1m") == 0
    st.close()
