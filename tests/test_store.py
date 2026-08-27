import numpy as np

from hermes.data.store import DataStore, map_funding_to_bars


def test_candle_roundtrip(tmp_path):
    store = DataStore(str(tmp_path))
    rows = [(1000 + i * 3_600_000, 1.0, 2.0, 0.5, 1.5, 10.0) for i in range(100)]
    store.upsert_candles("X", "1H", rows)
    store.upsert_candles("X", "1H", rows[:10])  # idempotent upsert
    candles = store.load("X", "1H", with_funding=False)
    assert len(candles) == 100
    assert list(candles.ts[:3]) == [1000, 3601000, 7201000]
    lo, hi, n = store.candle_range("X", "1H")
    assert n == 100 and lo == 1000


def test_funding_mapping():
    bar_ts = np.array([0, 100, 200, 300], dtype=np.int64)
    out = map_funding_to_bars(bar_ts, [(150, 0.001), (300, 0.002), (999, 0.5)])
    assert out[2] == 0.001   # 150 -> first bar at/after = 200
    assert out[3] == 0.002
    assert out.sum() == 0.003  # payment beyond range dropped


def test_microstructure_mapping(tmp_path):
    store = DataStore(str(tmp_path))
    rows = [(1000 + i * 900_000, 1.0, 2.0, 0.5, 1.0 + i, 10.0) for i in range(5)]
    store.upsert_candles("X", "15m", rows)
    store.upsert_oi("X", [(1000, 10.0), (2800, 20.0)])
    store.upsert_flow("X", [(1000, 4.0, 1.0)])
    store.upsert_px("mark_px", "X", "15m", [(1000, 1.01)])
    store.upsert_px("index_px", "X", "15m", [(1000, 1.00)])
    c = store.load("X", "15m")
    assert c.oi[0] == 10.0
    assert c.oi[2] == 20.0          # last-known as of bar close
    assert abs(c.taker_imb[0] - 0.6) < 1e-9
    assert abs(c.basis[0] - 0.01) < 1e-9


def _serie(n: int, depart: int = 0, pas: int = 60_000, base: float = 1.0):
    return [(depart + i * pas, base + i, base + i + 1.0, base + i - 1.0,
             base + i + 0.5, 10.0 + i) for i in range(n)]


def _neuf(chemin) -> "DataStore":
    """Un magasin SANS memoire, sur le meme fichier : la reference."""
    return DataStore(str(chemin))


def _memes(a, b) -> bool:
    return all(np.array_equal(np.asarray(getattr(a, k)),
                              np.asarray(getattr(b, k)))
               for k in ("ts", "o", "h", "l", "c", "v",
                         "funding", "oi", "mark", "index"))


def test_a_reloaded_series_is_the_same_series(tmp_path):
    """Recharger vingt historiques complets a chaque barre nouvelle
    coutait 5,8 s sur une machine de developpement, et cest ce que la
    boucle live faisait — pendant que `candle_range` repond en une
    milliseconde pour les vingt. Le releve du 27 aout mesure vingt-six
    secondes entre la cloture dune barre 1m et la decision quelle
    declenche, quand la porte simule zero.

    La recolle na donc de valeur que si elle rend EXACTEMENT la meme
    serie que la lecture complete. Ce test le verifie a chaque etape,
    contre un magasin neuf qui na aucune memoire.
    """
    st = DataStore(str(tmp_path))
    n0 = DataStore.QUEUE_RELUE + 300
    st.upsert_candles("X", "1m", _serie(n0))
    st.upsert_oi("X", [(0, 10.0), (n0 * 30_000, 20.0)])
    st.upsert_flow("X", [(0, 4.0, 1.0)])
    st.upsert_px("mark_px", "X", "1m", [(0, 1.01)])

    premier = st.load("X", "1m")
    assert _memes(premier, _neuf(tmp_path).load("X", "1m"))

    # Une barre neuve : la recolle doit la voir.
    st.upsert_candles("X", "1m", _serie(1, depart=n0 * 60_000, base=1.0 + n0))
    deux = st.load("X", "1m")
    assert len(deux) == n0 + 1
    assert _memes(deux, _neuf(tmp_path).load("X", "1m"))

    # Une barre DEJA en base, reecrite. `update_latest` en redemande 120 a
    # chaque tour et les upserte : la derniere barre change de valeur sans
    # changer dhorodatage, et cest ELLE qui declenche la decision. Un
    # cache qui ne lirait que les horodatages nouveaux servirait la
    # premiere version.
    ts_r = (n0 - 3) * 60_000
    st.upsert_candles("X", "1m", [(ts_r, 9.0, 9.0, 9.0, 9.0, 9.0)])
    trois = st.load("X", "1m")
    i = int(np.searchsorted(np.asarray(trois.ts), ts_r))
    assert float(trois.c[i]) == 9.0, "une barre reecrite reste figee"
    assert _memes(trois, _neuf(tmp_path).load("X", "1m"))


def test_history_arriving_from_the_past_forces_a_full_read(tmp_path):
    """Le rattrapage dhistoire insere des barres ANCIENNES. La recolle ne
    peut pas les voir — elle ne relit que la queue — et servirait une
    serie amputee du debut. Le compte de barres que la base annonce est
    donc verifie, et tout desaccord retombe sur la lecture complete.
    """
    st = DataStore(str(tmp_path))
    n0 = DataStore.QUEUE_RELUE + 300
    st.upsert_candles("X", "1m", _serie(n0, depart=1_000 * 60_000))
    avant = st.load("X", "1m", with_funding=False)
    assert len(avant) == n0

    st.upsert_candles("X", "1m", _serie(50, depart=0))
    apres = st.load("X", "1m", with_funding=False)
    assert len(apres) == n0 + 50, "le rattrapage dhistoire est invisible"
    assert _memes(apres, _neuf(tmp_path).load("X", "1m", with_funding=False))

    # Et le cas que le seul controle de `lo` ne peut PAS attraper : un
    # trou rebouche AU MILIEU. La premiere barre ne bouge pas, la queue
    # relue ne voit rien, et la recolle rendrait une serie a laquelle il
    # manque une barre — silencieusement. Seule la verification du compte
    # annonce par la base la rattrape.
    b = tmp_path / "b"
    lignes = _serie(n0)
    creux = lignes[:100] + lignes[101:]
    st2 = DataStore(str(b))
    st2.upsert_candles("Y", "1m", creux)
    assert len(st2.load("Y", "1m", with_funding=False)) == n0 - 1
    st2.upsert_candles("Y", "1m", [lignes[100]])
    plein = st2.load("Y", "1m", with_funding=False)
    assert len(plein) == n0, "un trou rebouche au milieu reste invisible"
    assert _memes(plein, _neuf(b).load("Y", "1m", with_funding=False))


def test_the_series_is_rebuilt_and_never_handed_back_stale(tmp_path):
    """La memoire garde les tableaux de la serie rendue au tour
    precedent. Elle ne doit pas rendre DEUX FOIS le meme objet : un
    appelant qui ecrirait dedans corromprait le tour suivant, et la
    serie servie ne serait plus celle de la base.
    """
    st = DataStore(str(tmp_path))
    st.upsert_candles("X", "1m", _serie(DataStore.QUEUE_RELUE + 10))
    a = st.load("X", "1m", with_funding=False)
    b = st.load("X", "1m", with_funding=False)
    assert a is not b
    assert _memes(a, b)


def test_an_emptied_store_forgets_what_it_remembered(tmp_path):
    """Une base videe doit rendre une serie vide, pas la derniere connue."""
    st = DataStore(str(tmp_path))
    st.upsert_candles("X", "1m", _serie(50))
    assert len(st.load("X", "1m", with_funding=False)) == 50
    st.conn.execute("DELETE FROM candles WHERE inst=?", ("X",))
    st.conn.commit()
    assert len(st.load("X", "1m", with_funding=False)) == 0


def test_a_tail_that_vanished_falls_back_to_the_full_read(tmp_path):
    """La recolle relit depuis un horodatage qui EXISTAIT au tour
    precedent. Si cette queue a disparu de la base, la lecture ne rend
    rien — et concatener sur du vide leve, ou pire, rend une serie
    tronquee sans le dire. Le cas se construit : effacer la queue et
    inserer autant de barres AVANT elle laisse le compte et la premiere
    barre inchanges, les deux seules choses que la memoire verifie.
    """
    st = DataStore(str(tmp_path))
    n0 = DataStore.QUEUE_RELUE + 300
    st.upsert_candles("X", "1m", _serie(n0))
    avant = st.load("X", "1m", with_funding=False)
    assert len(avant) == n0

    coupe = (n0 - DataStore.QUEUE_RELUE) * 60_000
    st.conn.execute("DELETE FROM candles WHERE inst=? AND bar=? AND ts>=?",
                    ("X", "1m", coupe))
    st.upsert_candles("X", "1m", [(i * 60_000 + k * 1_000, 1.0, 2.0, 0.5,
                                   1.5, 3.0)
                                  for i in range(60) for k in range(1, 13)])
    st.conn.commit()
    apres = st.load("X", "1m", with_funding=False)
    assert len(apres) == n0
    assert _memes(apres, _neuf(tmp_path).load("X", "1m", with_funding=False))
