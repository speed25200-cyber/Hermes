"""1-minute scalp loop: predict, cost-gate, time-stop, flatten."""

from __future__ import annotations

import json
import math
import os
import time

import numpy as np

from ..data.store import Candles, BAR_MS
from ..exchange.broker import Broker, PaperBroker
from . import features as F
from . import economics as ECON
from . import model as M
from .clock import ASSETS as CLOCK_ASSETS
from .clock import BARS, HOLD, ScaleDesk
from .flow import HORIZON_S, FlowBrain


class ScalpEngine:
    def __init__(self, cfg: dict, broker: Broker, client, risk, log, state_dir: str):
        s = cfg.get("scalp") or {}
        self.cfg = s
        self.broker = broker
        self.client = client
        self.risk = risk
        self.log = log
        self.state_path = os.path.join(state_dir, "scalp.json")
        # Le panel jugé et le panel tradé sont le MÊME ensemble, par
        # construction. La porte mesure un portefeuille sur ces actifs-là ;
        # en trader d'autres, ou moins, jouerait une règle que personne n'a
        # validée. Trois listes codées en dur traînaient ici et dans le
        # trader, et elles ont tenu le panel à trois actifs pendant que la
        # définition en annonçait six.
        self.instruments = list(CLOCK_ASSETS)
        self.store = None          # branché par la boucle live
        self.attendus: list[str] = []   # réclamés par le volume, sans histoire
        self.min_barres = 5_000    # barres 1m exigées avant d'entrer au panel
        # Une crypto remplit presque toutes ses barres ; un perpétuel adossé
        # à une action en remplit cinq septièmes. Le seuil sépare les deux
        # sans liste noire à tenir à jour.
        self.couverture_min = 0.90
        # Noms deja rattrapes et recales par la continuite : on ne les
        # reclasse plus. Ce sont les actions et matieres premieres
        # tokenisees, dont le volume les remettrait sinon en tete a chaque
        # classement.
        self.recales: set[str] = set()
        # Et ceux qui ont deja passe l examen : un incumbent etait garde
        # sur son seul volume, sans jamais etre rejuge. Les six noms ecrits
        # dans la configuration entraient donc au panel sans avoir montre
        # patte blanche une seule fois. On les juge une fois, on retient le
        # verdict — la nature d un actif ne change pas.
        self.admis: set[str] = set()
        # Combien de barres le magasin portait la DERNIERE fois qu on a
        # regarde. Un nom qui manque d histoire est remis en file de
        # rattrapage, rattrape, puis reteste — et s il n a tout simplement
        # pas assez d histoire A L ECHANGE, ce cycle ne s arrete jamais et
        # consomme le quota d appels que les noms admissibles attendent.
        # On chasse tant que le rattrapage FAIT PROGRESSER le compte ; des
        # qu il n apporte plus rien, l echange a donne tout ce qu il a.
        self.barres_vues: dict[str, int] = {}
        # Le panel vise les N perpétuels USDT les plus échangés sur OKX ;
        # la liste écrite en dur ne sert que de point de départ avant le
        # premier classement par volume.
        self.universe_n = int(s.get("universe_n", len(self.instruments)))
        self.trade_top = int(s.get("trade_top", self.universe_n))
        self.require_l2 = False
        self.max_spread = float(s.get("max_spread_bps", 6.0))
        self.min_vol = float(s.get("min_vol_usd", 10_000_000))
        self.horizon = int(s.get("horizon", 3))
        # Le pré-filtre doit MINORER le coût vrai, pas ajouter un seuil
        # arbitraire par-dessus : 6 bps en dur bloquait des horloges
        # validées à 5. Ce qui juge vraiment, c'est l'espérance simulée du
        # bracket, qui exige déjà de battre sa propre friction d'un quart.
        self.min_edge = float(s.get("min_edge_bps", 0.0))
        self.max_hold = int(s.get("max_hold_bars", 16))
        self.max_name = float(s.get("max_name_lev", 20.0))
        self.gross_cap = float(s.get("gross_cap", 20.0))
        self.trade_top = int(s.get("trade_top", len(self.instruments)))
        # Un levier de 1 est MOINS risqué qu'un levier de 2 : plancher à
        # deux, le frein du gouverneur et le rodage ne réduisaient pas la
        # taille, ils l'annulaient. Une règle validée à quart de frein
        # sortait à 0,84 de levier et ne tradait donc pas du tout —
        # quatorze heures sans une seule position sur signal prouvé. Le
        # plancher existe contre les trades de poussière ; c'est le poids
        # notionnel minimal, déjà appliqué à la consommation des ordres,
        # qui s'en charge.
        # Le levier d echange n est PAS la taille de la position. Une
        # jambe de 153 USDT immobilise 153 USDT de marge a x1, et 31 a x5 :
        # meme position, meme risque de marche, meme distance au stop. Ce
        # que le levier decide, c est la marge bloquee — donc COMBIEN DE
        # JAMBES le compte peut tenir en meme temps.
        #
        # A x1, l exposition brute totale est plafonnee par les fonds
        # propres : vingt jambes du panel ne tiennent pas. C est un
        # plafond qui n a aucune raison economique d exister, et il
        # annulait le plafond brut de x20 que la configuration annonce.
        # NB : `lev_min` reste le plancher de la TAILLE (Kelly non
        # tronquee, cf. plus bas) ; le plancher du levier d ECHANGE est
        # une autre grandeur et porte un autre nom.
        self.lev_min = 1
        self.lev_max = 20
        self.lev_ech_min = int(s.get("lev_min", 5))
        self.lev_ech_max = int(s.get("max_name_lev", 20))
        self.opened_bar: dict[str, int] = {}
        self.last_bar: dict[str, int] = {}
        self.last_preds: list[dict] = []
        self.ticks: dict[str, dict] = {}
        self.universe_at = 0.0
        costs = (cfg.get("costs") or {})
        taker = float(costs.get("taker_fee_bps", 5.0))
        self.taker_fee_bps = taker
        # Entry is posted, exit is taken: maker + taker. Read from the same
        # costs block the rest of the system uses — a hardcoded 7.0 meant
        # configuring costs changed the backtest and not the live gate.
        maker = float(costs.get("maker_fee_bps", 2.0))
        self.round_trip_bps = float(s.get("round_trip_bps", maker + taker))
        # The winning leg is cheaper than the losing one: entry is posted
        # and the take-profit rests on the book, so a trade that ends at
        # its take pays maker twice and crosses no spread. Stops and
        # time-stops still pay the full taker round trip.
        self.cost_tp_bps = 2.0 * maker
        self.stop_bps = float(s.get("stop_bps", 15.0))
        self.take_bps = float(s.get("take_bps", 10.0))
        self.brackets: dict[str, dict] = {}
        self.l2: dict[str, dict] = {}
        self.flow: dict[str, float] = {}
        self.tape: dict[str, dict] = {}
        self.pending: dict[str, float] = {}
        self.horizons = ScaleDesk(fee_bps=self.round_trip_bps, log=self.log)
        self.brain = FlowBrain(state_dir, fee_bps=self.round_trip_bps, log=self.log)
        self._px_t: dict[str, tuple[float, float]] = {}
        self.preds_h: dict[str, list] = {b: [] for b in BARS}
        self.hold_ms: dict[str, int] = {}
        self.opened_h: dict[str, str] = {}
        self.sans_regle: set[str] = set()
        self.poussiere_usd = 1.0
        self.desync: dict[str, int] = {}
        self.trades: list[dict] = []
        # Mode éclaireur : des trades réels à la taille MINIMALE de
        # l'échange, sous un budget de perte journalier plafonné en dur.
        # Il ne prédit rien et ne remplace aucune gate : il paie un tout
        # petit prix connu pour (a) exercer la chaîne d'exécution en vrai
        # et (b) mesurer ce que la simulation suppose — d'abord le taux de
        # remplissage maker au take-profit (QUEUE_MISS). La taille ne
        # dépend jamais du signal : un éclaireur qui grossirait avec la
        # conviction redeviendrait un trade non validé.
        ex = (s.get("explore") or {})
        self.explore_on = bool(ex.get("enabled", True))
        self.explore_daily_bps = float(ex.get("daily_loss_bps", 15.0))
        self.explore_cooldown_s = float(ex.get("cooldown_s", 600.0))
        self.explore_max_open = int(ex.get("max_open", 2))
        self.explore_notional = float(ex.get("notional_usd", 150.0))
        self.explore_cap_pct = float(ex.get("notional_cap_pct", 3.0))
        self.explore_pnl_day = 0.0
        self._explore_day = ""
        self._explore_last: dict[str, float] = {}
        # Ce que la règle validée rapporte EN DIRECT, par trade fermé. Le
        # holdout est une mesure ; le direct en est une autre, et quand les
        # deux se contredisent on ne choisit pas la plus flatteuse.
        self.live_stats = {"n": 0, "bps": 0.0, "jambes": 0}
        # Le retard reel entre la cloture de barre qui a produit la cible
        # et l'ordre qui la joue. La porte mesure une entree AU PRIX DE
        # CLOTURE ; tant que ce chiffre n'est pas au releve, l'ecart entre
        # la regle mesuree et la regle jouee reste une supposition.
        # Le retard d entree etait MESURE (1,3 s sur 252 ordres) et la
        # porte continuait de supposer zero. Ce que ce retard coute ne se
        # deduit pas : entre la cloture de la barre qui a decide et le
        # remplissage, le prix a bouge, et il a bouge dans le sens du
        # signal aussi souvent qu il faut pour manger l avantage. On le
        # mesure donc directement — prix paye contre prix du signal, signe
        # par le sens — et on le FACTURE.
        self.exec_stats = {"n_entrees": 0, "retard_s": 0.0,
                           "glissement_bps": 0.0, "n_gliss": 0}
        self._dernier_net: float | None = None
        # Le paquet de fermetures du meme INSTANT, en attente d etre
        # soldees en un seul rendement de portefeuille.
        self._paquet: dict = {}
        self._pending_ts = 0.0
        self.explore_stats = {"trades": 0, "tp_maker": 0, "tp_taker": 0,
                              "sl": 0, "time": 0,
                              # mesures qui remplacent des hypothèses du
                              # modèle de coût, une fois assez d'échantillons
                              "entry_edge_bps": 0.0,
                              "exit_maker_bps": 0.0, "n_exit_maker": 0,
                              "exit_taker_bps": 0.0, "n_exit_taker": 0}
        try:
            with open(self.state_path) as f:
                prev = json.load(f)
            self.trades = list(prev.get("trades") or [])[-200:]
            # Une mesure ne redémarre pas à zéro parce qu'on a redéployé.
            # Le rodage ne laisse la règle prendre sa taille pleine qu'après
            # 30 trades fermés ; si le compteur repart de zéro à chaque mise
            # en ligne, il n'atteint jamais 30 et la taille reste bloquée au
            # dixième — la règle validée serait condamnée aux micro-positions
            # par un détail de persistance, pas par ses résultats.
            self._reprendre(self.live_stats, prev.get("live_rule"),
                            ("n", "bps", "jambes"))
            self._reprendre(self.explore_stats, prev.get("explore"),
                            tuple(self.explore_stats))
            self._reprendre(self.exec_stats, prev.get("entree"),
                            tuple(self.exec_stats))
            # Une position ouverte appartient à une règle : prix d'entrée,
            # stop, durée validée, politique qui l'a décidée. Rien de tout
            # cela ne survivait au redémarrage — le moteur retrouvait la
            # position à l'échange sans savoir à qui elle était. Elle
            # échappait alors à check_exits (ni stop ni sortie au temps),
            # se faisait refermer au hasard d'une cible par une politique
            # qui n'avait rien validé, et n'entrait dans AUCUNE mesure :
            # _compter_realise sort sans prix d'entrée. Mesuré au journal :
            # « fermeture SOL (prior -3,4bps h=2 tenue=0.0m) » sept minutes
            # après une ouverture candle à h=6, et un DOGE -8050 que plus
            # personne ne tenait. La mesure du direct était donc amputée
            # exactement des trades traversant une mise en ligne.
            self.brackets = {k: dict(v) for k, v in
                             (prev.get("brackets") or {}).items()
                             if isinstance(v, dict)}
            suivi = prev.get("suivi") or {}
            self.opened_bar = {k: int(v) for k, v in
                               (suivi.get("opened_bar") or {}).items()}
            self.hold_ms = {k: int(v) for k, v in
                            (suivi.get("hold_ms") or {}).items()}
            self.opened_h = {k: str(v) for k, v in
                             (suivi.get("opened_h") or {}).items()}
        except (OSError, ValueError):
            pass

    @staticmethod
    def _reprendre(cible: dict, source: object, cles: tuple) -> None:
        """Recharge des compteurs de mesure, et seulement eux.

        On ne relit que les clés attendues, et seulement si elles portent un
        nombre fini : `confiance` par exemple est dérivé, il se recalcule et
        n'a rien à faire dans l'état repris. Un fichier tronqué, ou écrit par
        une version antérieure, laisse simplement les compteurs à zéro.
        """
        if not isinstance(source, dict):
            return
        for k in cles:
            v = source.get(k)
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                continue
            if v != v or v in (float("inf"), float("-inf")):
                continue
            cible[k] = type(cible[k])(v)

    # ------------------------------------------------------------------ #

    def _snapshot(self, extra: dict | None = None) -> None:
        # Une jambe fermee seule ne doit pas attendre indefiniment un
        # compagnon : des que la minute est passee, son paquet se solde.
        if self._paquet and int(time.time() // 60.0) > self._paquet["minute"]:
            self._solder_paquet()
        tg = self._targets(self.last_preds or []) if self.last_preds else {}
        eq = 0.0
        if extra and extra.get("equity"):
            eq = float(extra["equity"])
        else:
            try:
                eq = float(self.broker.equity())
            except Exception:
                eq = 0.0
        used = 0.0
        if eq > 0:
            pos = self.broker.positions()
            for inst, q in pos.items():
                last, _, _ = self._px(inst)
                used += abs(float(q) * last) / eq
        preds = []
        for p in (self.last_preds or []):
            q = dict(p)
            q["lev"] = float(tg.get(p.get("inst"), 0.0) or 0.0)
            preds.append(q)
        d = {
            "ts": time.time(),
            "preds": preds,
            "universe": self.instruments,
            "brackets": self.brackets,
            "round_trip_bps": self.round_trip_bps,
            "min_edge_bps": self.min_edge,
            "horizon_bars": self.horizon,
            "horizons": self.horizons.to_dict(),
            "live_bars": self.horizons.live_bars(),
            "flow": self.brain.to_dict(),
            "lev": {
                "name_cap": self.max_name,
                "gross_cap": self.gross_cap,
                "used": used,
                "okx": int(self.lev_max),
                "targets": tg,
                "margin": (self.broker.margin_used() / eq) if eq and hasattr(self.broker, "margin_used") else 0.0,
            },
            "risk_limits": {
                "daily_pct": self.risk.daily_loss_limit_pct,
                "dd_pct": self.risk.max_drawdown_pct,
                "scale": self._risk_scale(),
            },
            "trades": self.trades[-80:],
            # de quoi reprendre une position en cours après un redémarrage
            "suivi": {"opened_bar": self.opened_bar,
                      "hold_ms": self.hold_ms,
                      "opened_h": self.opened_h},
            "live_rule": dict(self.live_stats,
                              confiance=self._confiance()),
            "entree": dict(self.exec_stats),
            # Le frein du gouverneur : à -6,1 % dun budget de 8 %, il
            # retombe à 0,25 et le levier passe sous son plancher entier —
            # le moteur cesse alors de trader. Sans ce chiffre au relevé,
            # « la règle ne trade plus » et « la règle est freinée » se
            # ressemblent trop.
            "frein_risque": self._risk_scale(),
            # Ce qui cloche, dit par la machine. Les deux defauts les plus
            # couteux de la nuit etaient VISIBLES a l ecran et personne ne
            # les a vus : un ecran qui affiche « LEVIER x1,0 » sans rien
            # dire n apprend rien a qui ne sait pas que x1 est anormal.
            "anomalies": self._anomalies_sures(eq, tg),
            # Ou part l argent, sur la vie entiere du compte. Le journal
            # des fills est plafonne : il ne peut pas repondre pour une
            # semaine. Ces compteurs-la si, et ils bouclent au centime.
            "livre": {**(getattr(self.broker, "livre", None) or {}),
                      "depart": float(getattr(self.broker, "depart", 0.0) or 0.0),
                      "equite": eq},
            "explore": {
                "enabled": self.explore_on,
                "pnl_day_usd": self.explore_pnl_day,
                "budget_usd": self.explore_daily_bps * 1e-4 * eq,
                **self.explore_stats,
            },
            "desk": { (p.get("inst") or "").split("-")[0]: {
                "bar": p.get("bar"), "policy": p.get("policy"),
                "status": p.get("ml") or p.get("reason"),
                "holdout": p.get("edge_bps"), "clocks": p.get("clocks"),
                "lev": p.get("lev"),
            } for p in preds},
        }
        if extra:
            d.update(extra)
        try:
            with open(self.state_path, "w") as f:
                json.dump(d, f)
        except OSError:
            pass

    def refresh_universe(self, tickers: dict[str, dict]) -> list[str]:
        """Le panel = les N perpétuels USDT les plus échangés sur OKX.

        Cette fonction recevait les tickers et les jetait : elle recopiait
        six noms écrits en dur. Or l'horloge est un PANEL — une seule règle
        pour tous les actifs, jugée sur le rendement de portefeuille à
        chaque instant. Chaque jambe supplémentaire moyenne une variance
        idiosyncratique de plus : à poids de risque égal, passer de six à
        vingt jambes divise la part non commune de l'écart-type par
        racine(20/6), soit 1,8. C'est le levier le plus direct sur le
        Sharpe du panel, et il ne coûte aucune barre — la dimension
        « actif » ne fait pas partie de la grille cherchée dès que le panel
        en compte au moins deux.

        Trois garde-fous, tous nécessaires :

        - le SPREAD. Un actif très échangé mais large au carnet paie sa
          fourchette à chaque aller-retour ; à 6 bps d'écart sur un
          avantage de 4, la jambe est perdante par construction.
        - l'HISTOIRE. Une horloge se valide sur des dizaines de milliers de
          barres. Un nom fraîchement listé n'en a pas et ne ferait
          qu'ajouter du bruit au panel ; il attend d'avoir été rattrapé.
        Le meneur transversal (BTC) n'est PAS forcé dans le panel : son
        rôle est d'être une source de données — la colonne de décalage BTC
        -> alts de toutes les autres jambes — et le magasin la possède
        qu'il soit tradé ou non. Lui réserver une place de trading la
        volerait à un nom que le volume a réellement classé devant.

        - l'HYSTÉRÉSIS. Le classement par volume bouge en permanence au
          voisinage du rang N. Un sortant est conservé tant qu'il reste
          dans les 1,5·N premiers, sinon le panel changerait d'identité
          toutes les quinze minutes — exactement le défaut qu'on a mesuré
          sur la cellule retenue par la porte.
        """
        self.ticks = tickers or {}
        n = max(1, int(self.universe_n))
        classe = self.classement(tickers)
        if not classe:
            self.universe_at = time.time()
            return self.instruments
        garde = set(classe[: int(n * 1.5)])
        retenus = [i for i in self.instruments
                   if i in garde and (i in self.admis
                                      or self._assez_dhistoire(i))][:n]
        for inst in classe:
            if len(retenus) >= n:
                break
            if inst not in retenus and self._assez_dhistoire(inst):
                retenus.append(inst)
        self.instruments = retenus
        self.universe_n = n
        self.universe_at = time.time()
        # Ce que le volume reclame mais que l histoire ne permet pas encore :
        # la boucle live va le rattraper en tache de fond, et le nom entrera
        # au panel des qu il aura de quoi etre juge.
        # `classe` a ete capture AVANT que _assez_dhistoire ne recale les
        # series a trous : on refiltre, sinon le nom recale du tour meme
        # serait quand meme mis en file de rattrapage.
        # Et elle descend AUSSI PROFOND qu il le faut. Mesure en
        # production : le top 20 par volume d OKX contenait SNDK, XAU et
        # SKHYNIX — des actions et des matieres premieres tokenisees. La
        # boucle de remplissage ci-dessus, elle, parcourt TOUT le
        # classement ; la file de rattrapage s arretait au rang 20. Les
        # noms eligibles au-dela du rang 20 n etaient donc jamais
        # rattrapes, donc jamais eligibles : le panel restait bloque a six
        # pendant que le journal affichait « desk panel vise 1 ».
        #
        # On veut les vingt premiers ELIGIBLES, pas les eligibles parmi
        # les vingt premiers. La file porte exactement le nombre de
        # places manquantes.
        manque = max(0, n - len(retenus))
        self.attendus = [i for i in classe
                         if i not in retenus and i not in self.recales][:manque]
        self.flatten_foreign()
        return self.instruments

    def classement(self, tickers: dict[str, dict] | None) -> list[str]:
        """Les perpetuels USDT eligibles, du plus echange au moins echange.

        Le spread est un filtre et non un tri : un actif large au carnet
        paie sa fourchette a chaque aller-retour, et a 6 bps d ecart sur
        un avantage de 4 la jambe est perdante par construction — la
        garder au classement ne servirait qu a la voir echouer.
        """
        cands = []
        for inst, t in (tickers or {}).items():
            if not inst.endswith("-USDT-SWAP") or inst in self.recales:
                continue
            v = float((t or {}).get("vol_usd") or 0.0)
            sp = float((t or {}).get("spread_bps") or 999.0)
            if v < self.min_vol or sp > self.max_spread:
                continue
            cands.append((v, inst))
        cands.sort(reverse=True)
        return [i for _, i in cands]

    def _assez_dhistoire(self, inst: str) -> bool:
        """Assez de barres stockees, ET une serie qui tourne 24/7.

        Le classement par volume seul ramene desormais des ACTIONS et
        des matieres premieres tokenisees — SanDisk, SK Hynix, SpaceX,
        l or — qui figurent parmi les perpetuels USDT les plus echanges
        d OKX. Ce n est pas seulement un ecart avec « le top 20 des
        cryptos » : le panel met les actifs en commun en les divisant
        par leur sigma, ce qui suppose qu ils partagent la MEME horloge.
        Un instrument qui s arrete le week-end n en partage aucune, et
        la colonne de decalage BTC -> alts n a aucun sens pour lui.

        Le critere est donc la CONTINUITE plutot qu une liste noire :
        une crypto cote 24 heures sur 24 et remplit presque toutes ses
        barres d une minute ; un perpetuel adosse a une action en
        remplit environ cinq septiemes. Une liste noire ecrite a la main
        serait perimee au prochain listing ; ce critere-la se maintient
        tout seul.
        """
        store = getattr(self, "store", None)
        if store is None:
            return True
        try:
            c = store.load(inst, "1m")
        except Exception:
            return False
        if c is None or len(c) < self.min_barres:
            n_vu = 0 if c is None else len(c)
            avant = self.barres_vues.get(inst)
            if avant is not None and n_vu <= avant:
                # Le rattrapage precedent n a rien apporte : l echange n a
                # pas plus d histoire a donner. Inutile de le poursuivre.
                self.log(f"scalp recale {inst} : {n_vu} barres 1m et le "
                         f"rattrapage n en ajoute plus (il en faut "
                         f"{self.min_barres})")
                self.recales.add(inst)
                self.barres_vues.pop(inst, None)
                return False
            self.barres_vues[inst] = n_vu
            return False
        ts = np.asarray(c.ts, dtype=np.float64)
        duree = float(ts[-1] - ts[0])
        if duree <= 0:
            return False
        attendues = duree / 60_000.0 + 1.0
        if (len(c) / attendues) >= self.couverture_min and self._vit_le_weekend(c):
            self.admis.add(inst)
            return True
        # Assez de barres, mais une serie a trous : ce n est pas une crypto.
        # Le verdict est DEFINITIF, sinon le nom resterait eternellement
        # « reclame par le volume, pas encore pret » et se ferait rattraper
        # a chaque tour — un puits sans fond pour le quota d appels, sur un
        # actif qui n entrera jamais.
        self.recales.add(inst)
        return False

    def _vit_le_weekend(self, c) -> bool:
        """Un actif 24/7 bouge le samedi comme le mercredi.

        Le premier critere de continuite comptait les BARRES PRESENTES,
        et il a laisse passer SNDK, XAU et SKHYNIX : ces perpetuels
        publient une bougie d une minute meme quand leur sous-jacent est
        ferme. La bougie existe, elle est simplement PLATE — et un compte
        de barres ne distingue pas les deux.

        Ce qui distingue vraiment une crypto d une action tokenisee, c est
        que son prix vit le week-end. On compare donc l amplitude moyenne
        des barres du samedi et du dimanche a celle des jours ouvres. Une
        crypto donne un rapport voisin de 1 — le week-end est un peu plus
        calme, jamais mort. Une action tokenisee donne un rapport proche
        de zero.

        Le seuil est a la moitie, loin des deux populations : il n y a pas
        de reglage fin a trouver entre 0,9 et 0,05. Et le critere se
        maintient tout seul au prochain listing, contrairement a une liste
        noire ecrite a la main.

        Sans assez de barres de week-end pour trancher, on ne tranche pas :
        le nom reste candidat et sera rejuge quand il aura plus d histoire.
        """
        ts = np.asarray(c.ts, dtype=np.int64)
        px = np.asarray(c.c, dtype=np.float64)
        if len(px) < 2:
            return True
        amp = np.abs(np.diff(px) / np.where(px[:-1] > 0, px[:-1], np.nan))
        amp = np.nan_to_num(amp, nan=0.0)
        # 1970-01-01 etait un jeudi : (jours + 4) % 7 donne 5 = samedi,
        # 6 = dimanche.
        jour = ((ts[1:] // 86_400_000) + 4) % 7
        we = jour >= 5
        if int(we.sum()) < 500 or int((~we).sum()) < 500:
            return True
        ouvre = float(amp[~we].mean())
        if ouvre <= 0.0:
            return True
        rapport = float(amp[we].mean()) / ouvre
        if rapport >= 0.5:
            return True
        self.log(f"scalp recale {c.inst} : week-end a {rapport:.2f} "
                 f"de l amplitude des jours ouvres — pas 24/7")
        return False

    def flatten_foreign(self) -> None:
        """Close leftover names that are not in the live scalp universe
        (old RSI dust, delisted alts, zero-price junk)."""
        uni = set(self.instruments)
        pos = self.broker.positions()
        for inst, qty in list(pos.items()):
            if inst in uni or abs(qty) < 1e-12:
                continue
            px = float((self.ticks.get(inst) or {}).get("last") or 0.0)
            if px <= 0:
                px = float(getattr(self.broker, "prices", {}).get(inst, 0.0) or 0.0)
            if px <= 0:
                continue
            self.broker.market_order(inst, -qty, px, force_taker=True)
            self.opened_bar.pop(inst, None)
            self.brackets.pop(inst, None)
            self.log(f"scalp flatten dust {inst} qty={qty:.6f}")

    def ingest_trades(self, inst: str, trades: list) -> None:
        now_ms = int(time.time() * 1000)
        last = float((self.ticks.get(inst) or {}).get("last") or 0.0)
        tape = F.trade_tape(trades, now_ms, last)
        self.flow[inst] = tape["flow"]
        self.tape[inst] = tape

    def ingest_book(self, inst: str, book: dict) -> None:
        last = float((self.ticks.get(inst) or {}).get("last") or 0.0)
        feats = F.book_l2(book, last)
        prev = (self.l2.get(inst) or {}).get("raw")
        feats["ofi"] = F.ofi_l1(prev, book)
        self.l2[inst] = {"ts": time.time(), "feats": feats, "raw": book}

    def _micro(self, inst: str, last: float) -> dict[str, float]:
        rec = self.l2.get(inst)
        if rec and (time.time() - rec["ts"]) < 25.0:
            f = rec["feats"]
            return {
                "imb": f["imb1"], "book": f["imb5"], "depth": f["depth_imb"],
                "micro": f["micro"], "spread_bps": f["spread_bps"], "l2": 1.0,
                "ofi": float(f.get("ofi") or 0.0),
            }
        t = self.ticks.get(inst) or {}
        bsz = float(t.get("bid_sz") or 0.0)
        asz = float(t.get("ask_sz") or 0.0)
        bid = float(t.get("bid") or 0.0)
        ask = float(t.get("ask") or 0.0)
        imb = (bsz - asz) / (bsz + asz) if (bsz + asz) > 0 else 0.0
        den = bsz + asz
        micro_px = (bid * asz + ask * bsz) / den if den > 0 and bid > 0 and ask > 0 else last
        vs = (micro_px / last - 1.0) if last > 0 else 0.0
        spr = ((ask - bid) / last * 1e4) if last > 0 and bid > 0 and ask > bid else 0.0
        return {"imb": imb, "book": imb, "depth": 0.0, "micro": vs,
                "spread_bps": spr, "l2": 0.0, "ofi": 0.0}

    def predict_all(self, candles_1m: dict[str, Candles], bar: str = "1m") -> list[dict]:
        btc = candles_1m.get("BTC-USDT-SWAP")
        btc_r1 = 0.0
        if btc is not None and len(btc) >= 2 and btc.c[-2] > 0:
            btc_r1 = float(btc.c[-1] / btc.c[-2] - 1.0)
        # Tout le panel vote AVANT que quoi que ce soit ne fusionne. Une
        # horloge validée en marché-neutre ne décide pas sur sa propre
        # prédiction mais sur son écart à la moyenne du panel : cet écart
        # n'existe qu'une fois tout le monde passé au micro. Voter et
        # fusionner dans la même boucle aurait fait juger le premier actif
        # sur la moyenne du tour PRÉCÉDENT.
        # Le panel vote d un bloc : le facteur de marche de chaque jambe
        # est la moyenne des AUTRES, et elle n existe qu une fois tout le
        # monde rassemble. Voter actif par actif contre BTC jouerait une
        # regle que la porte n a pas validee.
        self.horizons.vote_panel(
            bar, {i: candles_1m.get(i) for i in self.instruments}, btc)
        out = []
        for inst in self.instruments:
            c = candles_1m.get(inst)
            if c is None or len(c) < 12:
                continue
            feat = F.candle_feats(c)
            micro = self._micro(inst, feat["px"])
            feat["imb"], feat["book"] = micro["imb"], micro["book"]
            feat["micro"], feat["depth"] = micro["micro"], micro["depth"]
            feat["flow"] = float(self.flow.get(inst) or 0.0)
            feat["ofi"] = float(micro.get("ofi") or 0.0)
            feat["vwap_vs"] = float((self.tape.get(inst) or {}).get("vwap_vs") or 0.0)
            pred = M.predict(feat, btc_r1, inst.startswith("BTC-"), self.horizon)
            last = float(feat["px"] or 0.0)
            btc_last = float((self.ticks.get("BTC-USDT-SWAP") or {}).get("last") or 0.0)
            if btc is not None and len(btc) and btc.c[-1] > 0:
                btc_last = float(btc.c[-1])
            prev = self._px_t.get(inst)
            own = 0.0
            nowt = time.time()
            if prev and last > 0 and prev[1] > 0 and nowt - prev[0] < 120:
                own = (last / prev[1] - 1.0) * 1e4
            self._px_t[inst] = (nowt, last)
            x = self.brain.vec(inst, micro, self.tape.get(inst) or {}, last, btc_last, own)
            if last > 0 and micro.get("l2") and bar == "1m":
                self.brain.push(inst, x, last)
            mids = {i: float((self.ticks.get(i) or {}).get("last") or 0.0)
                    for i in self.instruments}
            mids = {k: v for k, v in mids.items() if v > 0}
            if last > 0:
                mids[inst] = last
            if bar == "1m":
                self.brain.settle(mids)
            inf = self.brain.infer(x, micro)
            # The clocks used to vote and be ignored: fuse() was computed for
            # the dashboard while every order followed the flow model alone.
            # Two validated sources now co-decide. Agreement adds size,
            # disagreement sits out, and either alone may still trade.
            cinf = self.horizons.fuse(inst)
            # the flow brain now speaks at the horizon of its best
            # validated head — 90 s, 5 min or 15 min
            h_flow = int(inf.get("h_bars") or max(1, round(HORIZON_S / 60.0)))
            mins = {"1m": 1, "3m": 3, "5m": 5, "15m": 15, "1H": 60}
            # L'horizon vient de la validation de l'horloge, plus d'une
            # constante : le modèle a été prouvé sur h barres, la position
            # doit vivre h barres.
            h_clock = (mins.get(cinf.get("bar") or "5m", 5)
                       * int(cinf.get("horizon_bars")
                             or HOLD.get(cinf.get("bar") or "5m", 3)))
            sources = []
            if not inf.get("veto"):
                sources.append((float(inf.get("r_bps") or 0.0),
                                max(float(inf.get("q_bps") or 8.0), 4.0), h_flow, "flow"))
            if not cinf.get("veto"):
                sources.append((float(cinf.get("r_bps") or 0.0),
                                max(float(cinf.get("q_bps") or 12.0), 4.0), h_clock, "candle"))
            fused_veto = not sources
            if len(sources) == 2 and sources[0][0] * sources[1][0] < 0:
                # validated sources that disagree are a fact worth respecting
                sources, fused_veto = [], True
                inf = dict(inf); inf["status"] = "disagree"
            if sources:
                wts = [1.0 / q for _, q, _, _ in sources]
                edge = sum(e * w for (e, _, _, _), w in zip(sources, wts)) / sum(wts)
                h_use = max(h for _, _, h, _ in sources)
                inf = dict(inf)
                inf["veto"] = False
                inf["policy"] = "+".join(nom for *_, nom in sources)
                # la cohérence des horloges se paie en taille : une seule
                # horloge validée trade à demi-Kelly, deux d'accord à plein
                inf["size_mult"] = float(cinf.get("alpha") or 1.0) \
                    if any(n == "candle" for *_, n in sources) else 1.0
                inf["bar"] = cinf.get("bar") if any(n == "candle" for *_, n in sources) else inf.get("bar")
            else:
                edge = float(inf.get("r_bps") or 0.0)
                h_use = h_flow
                inf = dict(inf); inf["veto"] = True
            score = edge / 8.0
            pred["score"], pred["edge_bps"] = score, edge
            pred["p_up"] = 0.5 + 0.5 * max(-1.0, min(1.0, edge / 12.0))
            spread = float(micro["spread_bps"] or 0.0) or float(
                (self.ticks.get(inst) or {}).get("spread_bps") or 0.0)
            if spread <= 0:
                spread = 3.0
            # The pre-filter is a lower bound of the true cost; the
            # simulated EV makes the precise call. Gating at the full taker
            # round trip killed forecasts the maker take could have paid for.
            hurdle = max(self.min_edge, self.cost_tp_bps, spread + 1.5)
            reason = ""
            sortie_temps = False
            mode_stop = "fixe"
            # la source dont l'économie a été mesurée sur données réelles
            temoin = cinf if any(n == "candle" for *_, n in sources) else {}
            # The losing exit is taken: fees plus half the spread. The
            # winning exit rests at the take and pays maker, no spread.
            cost_bps = self.round_trip_bps + 0.5 * spread + self._glissement()
            bracket = None
            if inf["veto"]:
                direction, reason = "flat", inf.get("status") or "veto"
            elif abs(edge) < hurdle:
                direction, reason = "flat", "cost"
            else:
                # La règle jouée est la règle mesurée — toujours, pas
                # seulement en dernier recours. Ce que l'horloge a validé
                # n'est PAS un bracket : c'est « entrer sur le signal,
                # tenir h barres, sortir », et son économie a été établie
                # sur données réelles aux coûts réels. Tant que cette
                # mesure existe, elle décide de tout : direction, sortie,
                # et taille.
                #
                # La version précédente ne s'en servait que si
                # choose_bracket refusait. Quand il acceptait, on jouait
                # un objectif/stop que personne n'avait validé et on
                # dimensionnait au brownien : mesuré en direct, une
                # position SOL à 5x là où les moments MESURÉS de la règle
                # (+9,29 bps par trade, écart-type 61,9) donnent 3x après
                # quart de Kelly et demi-taille de solitude. Le brownien
                # n'a jamais vu ces données ; les moments, si.
                mes = float(temoin.get("net_bps") or 0.0)
                mes_sd = float(temoin.get("net_sd") or 0.0)
                if mes > 0.0 and mes_sd > 0.0:
                    direction = "long" if edge > 0 else "short"
                    # stop LARGE : garde-fou de ruine, pas instrument de
                    # rendement — la règle mesurée sort au temps
                    # Le garde-fou est celui qui a été MESURÉ avec la
                    # règle, pas une formule inventée ici. Le premier
                    # trade mesuré en direct l'a montré : un stop posé à
                    # 63 bps sur un horizon dont l'écart-type vaut 76 se
                    # déclenche une fois sur deux et transforme un
                    # avantage en saignée. La porte cherche maintenant sa
                    # largeur et la fait voyager jusqu'ici.
                    garde = float(temoin.get("stop_mesure") or 0.0)
                    mode_stop = str(temoin.get("stop_mode") or "fixe")
                    if garde <= 0.0:
                        garde = max(3.0 * abs(edge),
                                    2.0 * max(pred["vol_bps"], 1.0))
                    bracket = (10.0 * abs(edge) + garde, garde, mes)
                    sortie_temps = True
                else:
                    # Sans économie mesurée derrière (le flux seul), le
                    # bracket simulé reste le seul juge disponible.
                    bracket = ECON.choose_bracket(
                        edge_bps=edge, vol_bps=max(pred["vol_bps"], 1.0),
                        horizon=h_use, cost_bps=cost_bps,
                        cost_tp_bps=self.cost_tp_bps)
                    if bracket is None:
                        direction, reason = "flat", "no-ev"
                    elif edge > 0:
                        direction = "long"
                    else:
                        direction = "short"
            out.append({
                "inst": inst,
                "px": feat["px"],
                "p_up": pred["p_up"],
                "edge_bps": edge,
                "dir": direction,
                "score": pred["score"],
                "vol_bps": pred["vol_bps"],
                "spread_bps": spread,
                "r1": feat["r1"],
                "book": micro["book"],
                "depth": micro["depth"],
                "ofi": feat["ofi"],
                "loc": feat.get("loc", 0.0),
                "l2": bool(micro["l2"]),
                "reason": reason,
                "ml_bps": inf["ml_bps"],
                "ml": inf.get("status"),
                "policy": inf.get("policy"),
                "tp_bps": bracket[0] if bracket else inf["tp_bps"],
                "sl_bps": bracket[1] if bracket else inf["sl_bps"],
                "ev_bps": bracket[2] if bracket else 0.0,
                # sortie au temps : le take est hors d'atteinte, c'est la
                # durée validée qui referme la position
                "sortie_temps": sortie_temps,
                # Le MODE du garde-fou validé voyage avec lui : un suiveur
                # mesuré par la porte puis joué en stop fixe serait une
                # AUTRE règle que celle qui a été prouvée.
                "stop_mode": mode_stop if sortie_temps else "fixe",
                "net_bps": float(temoin.get("net_bps") or 0.0),
                "net_sd": float(temoin.get("net_sd") or 0.0),
                "net_defl": float(temoin.get("net_defl") or 0.0),
                "net_n": int(temoin.get("net_n") or 0),
                "cost_bps": cost_bps,
                "cost_tp_bps": self.cost_tp_bps,
                "size_mult": float(inf.get("size_mult") or 1.0),
                # what this horizon demands of the forecast before trading it
                # can pay — the number a flat book is really reporting
                "required_ic": ECON.required_ic(cost_bps, h_use,
                                                max(pred["vol_bps"], 1.0)),
                "h_bars": h_use,
                "bar": inf.get("bar") or bar,
                "clocks": inf.get("clocks") or {},
                "bar_ts": int(c.ts[-1]),
            })
        self.preds_h[bar] = out
        self.last_preds = out
        return out

    def _refresh_dashboard_preds(self) -> None:
        by: dict[str, dict] = {}
        live = set(self.horizons.live_bars()) or set(BARS)
        for bar, preds in self.preds_h.items():
            if bar not in live and bar != "1m":
                continue
            for p in preds:
                cur = by.get(p["inst"])
                if cur is None or abs(p.get("edge_bps") or 0) > abs(cur.get("edge_bps") or 0):
                    by[p["inst"]] = p
        if by:
            self.last_preds = list(by.values())
        elif self.preds_h.get("1m"):
            self.last_preds = self.preds_h["1m"]

    def anomalies(self, eq: float, tg: dict) -> list[dict]:
        """Ce qui cloche, dit par la machine plutot que cherche par l oeil.

        Les deux defauts les plus couteux de la nuit — un levier bloque a
        x1 sur chaque position, et des tailles quarante fois trop petites
        — etaient VISIBLES sur la page d accueil, et c est le proprietaire
        du compte qui les a remarques, pas la machine. Ce n est pas un
        defaut de vigilance mais d interface : un ecran qui affiche
        « LEVIER x1,0 » sans rien dire n apprend rien a qui ne sait pas
        deja que x1 est anormal.

        Chaque controle ci-dessous correspond a un defaut REELLEMENT
        rencontre. On ne devine pas ce qui pourrait mal tourner, on liste
        ce qui a mal tourne.

        niveau : "grave" (l argent est en jeu maintenant),
                 "attention" (la machine tourne bridee ou a moitie),
                 "info" (un fait a savoir, pas un probleme).
        """
        out: list[dict] = []

        def dire(niveau, titre, detail):
            out.append({"niveau": niveau, "titre": titre, "detail": detail})

        pos = self.broker.positions() or {}

        # 1. Le levier. Defaut du 25 aout : `plan["lev"]` est un POIDS, il
        #    etait compare a 2, la condition n etait jamais vraie et
        #    l echange retombait a x1 sur CHAQUE position.
        lev = getattr(self.broker, "lever", {}) or {}
        bas = [i for i, q in pos.items()
               if abs(float(q)) > 1e-12
               and float(lev.get(i, 1.0) or 1.0) < self.lev_ech_min - 1e-9]
        if bas:
            dire("grave", "Levier sous le plancher",
                 f"{len(bas)} position(s) a moins de x{self.lev_ech_min} : "
                 + ", ".join(i.split("-")[0] for i in bas[:4]))

        # 2. La taille contre ce que l avantage justifie — la question
        #    « pourquoi les positions sont-elles minuscules » rendue lisible.
        plein = sum(abs(float(p.get("poids_plein") or 0.0))
                    for p in (self.last_preds or []))
        joue = sum(abs(float(v or 0.0)) for v in (tg or {}).values())
        if plein > 1e-9 and joue < 0.5 * plein:
            frein, conf = self._risk_scale(), self._confiance()
            causes = []
            if conf < 0.95:
                causes.append(f"rodage x{conf:.2f} (le direct nest pas prouve)")
            if frein < 0.95:
                causes.append(f"frein du jour x{frein:.2f}")
            dire("attention", "Taille bridee",
                 f"{joue / plein * 100:.0f} % de ce que lavantage justifie"
                 + (" — " + ", ".join(causes) if causes else "")
                 + self._distance_au_deverrouillage())

        # 3. Une position sans regle : ni stop, ni duree, personne pour la
        #    fermer. Mesure : un DOGE -8050 immobile pendant des heures.
        orph = [i for i, q in pos.items()
                if abs(float(q)) > 1e-12
                and not (self.brackets.get(i) or {}).get("entry")]
        if orph:
            dire("grave", "Position sans regle",
                 ", ".join(i.split("-")[0] for i in orph[:4])
                 + " — ni stop ni sortie au temps")

        # 4. La poussiere : sous le plancher economique elle ne peut ni
        #    rapporter ni etre geree, et un reliquat plus petit qu un LOT
        #    de l echange ne peut meme pas etre ferme.
        pous = [i for i, q in pos.items()
                if abs(float(q)) > 1e-12 and not self._tient(i, q)]
        if pous:
            dire("attention", "Poussiere en position",
                 ", ".join(i.split("-")[0] for i in pous[:4])
                 + f" — sous {self.poussiere_usd:.0f} USD de notionnel")

        # 5. Les frais contre le brut. Si les frais dominent, le probleme
        #    est le NOMBRE de trades et pas le signal — et cette phrase
        #    doit etre dite, pas deduite.
        livre = getattr(self.broker, "livre", None) or {}
        brut = float(livre.get("brut") or 0.0)
        frais = float(livre.get("frais") or 0.0)
        if frais > 1.0 and abs(brut) < frais:
            dire("grave", "Les frais depassent le brut",
                 f"{frais:.2f} USD de frais pour {brut:+.2f} de brut realise "
                 "— cest le nombre de trades qui coute, pas le signal")

        # 6. Aucune horloge validee. Ce n est PAS un defaut — un carnet
        #    vide est un resultat honnete — mais il faut le dire au lieu de
        #    laisser croire a une panne.
        if not self.horizons.live_bars():
            dire("info", "Aucune horloge validee",
                 "la porte refuse toutes les cellules : le moteur observe "
                 "sans trader, cest un resultat et pas une panne")

        # 7. Le panel contre ce que le volume reclame.
        if len(self.instruments) < self.universe_n:
            dire("attention", "Panel incomplet",
                 f"{len(self.instruments)} jambes sur {self.universe_n} — "
                 f"{len(self.attendus)} en attente dhistoire, "
                 f"{len(self.recales)} ecartes")

        # 8. Le retard d entree, et ce qu il coute une fois mesure.
        retard = float(self.exec_stats.get("retard_s") or 0.0)
        if retard > 5.0:
            dire("attention", "Retard dentree",
                 f"{retard:.1f} s entre la barre qui decide et lordre")
        gl = self._glissement()
        if gl > 0.5:
            dire("attention", "Glissement defavorable",
                 f"{gl:+.2f} bps factures a la porte sur "
                 f"{int(self.exec_stats.get('n_gliss') or 0)} ouvertures")

        rang = {"grave": 0, "attention": 1, "info": 2}
        out.sort(key=lambda a: rang.get(a["niveau"], 3))
        return out

    def _distance_au_deverrouillage(self) -> str:
        """Combien de mesures manquent pour que la taille monte, et de
        combien elle montera.

        « Pourquoi les positions sont-elles minuscules » a une reponse
        exacte, et elle n etait nulle part : le rodage vaut 0,10, il
        passera a une valeur CALCULABLE des que la moyenne en direct
        franchira zero, et il faut un nombre CALCULABLE de mesures pour
        l y amener. Sans ces deux chiffres, « la taille est bridee » est
        une constatation ; avec eux, c est un compte a rebours.

        Mesure du 25 aout : n=66, bps=-2,21. La confiance passerait de
        0,10 a 0,42 au franchissement — x4,2 sur la taille, d un coup —
        et vingt mesures a +7,3 bps y suffisent, ce qui est en dessous du
        net deflate de la regle retenue (+14,6).
        """
        n = int(self.live_stats.get("n") or 0)
        bps = float(self.live_stats.get("bps") or 0.0)
        if n < 1 or bps > 0:
            return ""
        conf = self._confiance()
        # ce que vaudrait le rodage si la moyenne franchissait zero, a n
        # inchange : c est le saut immediat, pas une projection lointaine
        apres = (min(1.0, 0.1 + 0.9 * min(1.0, (n - 30) / 100.0))
                 if n >= 30 else 0.1)
        if apres <= conf * 1.05:
            return ""
        # combien de mesures a l avantage deflate annonce, pour ramener la
        # moyenne courante a zero : n*|bps| / defl
        defl = max((float(p.get("net_defl") or 0.0)
                    for p in (self.last_preds or [])), default=0.0)
        combien = ""
        if defl > 0.0:
            k = int(math.ceil(n * abs(bps) / defl))
            combien = f", soit environ {k} mesure(s) a lavantage annonce"
        return (f". Le franchissement de zero par la mesure en direct "
                f"({bps:+.2f} bps sur {n}) ferait passer le rodage de "
                f"{conf:.2f} a {apres:.2f}{combien}")

    def _anomalies_sures(self, eq: float, tg: dict) -> list[dict]:
        """L instantane ne doit JAMAIS echouer a cause du diagnostic.

        Un bandeau qui empeche d ecrire l etat serait le comble : on
        perdrait la page entiere pour afficher ce qui cloche.
        """
        try:
            return self.anomalies(eq, tg)
        except Exception as exc:            # pragma: no cover - filet
            return [{"niveau": "info", "titre": "Diagnostic indisponible",
                     "detail": type(exc).__name__}]

    def _risk_scale(self) -> float:
        """Cut leverage as we spend the daily / DD budget. Never blind-trade into the kill."""
        s = self.risk.state
        try:
            eq = float(self.broker.equity())
        except Exception:
            return 1.0
        dd_lim = max(self.risk.max_drawdown_pct / 100.0, 1e-6)
        day_lim = max(self.risk.daily_loss_limit_pct / 100.0, 1e-6)
        dd = (1.0 - eq / s.peak_equity) if s.peak_equity > 0 else 0.0
        day = (1.0 - eq / s.day_start_equity) if s.day_start_equity > 0 else 0.0
        def taper(used, lim):
            if used <= 0.4 * lim:
                return 1.0
            if used >= 0.85 * lim:
                return 0.25
            return max(0.25, 1.0 - (used - 0.4 * lim) / (0.45 * lim))
        return min(taper(dd, dd_lim), taper(day, day_lim))

    def _levier_echange(self, notionnel: float, equity: float) -> int:
        """Le levier d echange : une affaire de MARGE, pas de taille.

        La taille de la position est deja decidee — par Kelly deflate, le
        frein du gouverneur, le rodage et le plafond de ruine. Le levier
        ne la change pas d un centime : il decide seulement combien de
        marge elle immobilise, donc combien de jambes le compte peut
        tenir a la fois.

        A x1 la marge egale le notionnel et vingt jambes ne tiennent pas
        dans les fonds propres — un plafond sans raison economique, qui
        annulait en silence le plafond brut de x20 annonce par la
        configuration.

        Le levier n approche jamais la liquidation : le courtier la
        declenche sur la MAINTENANCE (0,4 % du notionnel), qui ne depend
        pas de lui, et le garde-fou de ruine limite deja la perte par stop
        touche a 2,5 % des fonds propres.
        """
        besoin = 0.0
        if equity > 0:
            besoin = float(notionnel) / max(0.10 * float(equity), 1e-9)
        return int(min(self.lev_ech_max,
                       max(self.lev_ech_min, math.ceil(besoin))))

    def _pick_lev(self, p: dict, frein: float | None = None,
                  parite: float = 1.0) -> float:
        """Growth-optimal size, then the caps.

        Quarter-Kelly from the same simulation that priced the bracket sets
        the notional; the 2.5%-per-stop rule survives as a ruin ceiling, not
        as the size. The old rule sized every trade at the ceiling — the
        -8.33% day was three stop-outs at maximum size. And when the
        growth-optimal size lands below the exchange minimum, the honest
        answer is no trade at all: forcing 2x onto a 0.4x edge is trading
        at five times Kelly, where expected log growth is negative.
        """
        if self.max_name <= 1.0:
            return float(self.max_name)
        sl = max(float(p.get("sl_bps") or 12.0), 8.0)
        tp = max(float(p.get("tp_bps") or 10.0), 1.0)
        edge = abs(float(p.get("edge_bps") or 0.0))
        vol = max(float(p.get("vol_bps") or 4.0), 1.0)
        h = int(p.get("h_bars") or self.horizon)
        cost = float(p.get("cost_bps") or self.round_trip_bps)
        c_tp = float(p.get("cost_tp_bps") or self.cost_tp_bps)
        if p.get("sortie_temps"):
            # La règle jouée est celle qui a été mesurée : entrer, tenir h
            # barres, sortir. Son Kelly se lit directement dans ses moments
            # mesurés — f* = E[R]/E[R²] — au lieu d'être re-dérivé d'un
            # brownien qui n'a jamais vu ces données. Quart de Kelly comme
            # partout ailleurs, et le plafond de ruine s'applique ensuite.
            #
            # Mais f* est PROPORTIONNEL à mu, et mu est la quantité la plus
            # mal estimée de toute la chaîne : sur 402 instants à
            # écart-type 54 bps, son erreur-type vaut 2,7 bps pour une
            # moyenne de 10,8. Prendre le point comme s'il était connu,
            # c'est parier la taille sur le haut de l'intervalle. On
            # dimensionne donc sur la borne basse à une erreur-type. La
            # correction vaut mu(1 - 1/(sr·racine(n))) : elle s'efface
            # quand les preuves s'accumulent, et mord quand elles manquent.
            mu = float(p.get("net_bps") or 0.0) * 1e-4
            sd = float(p.get("net_sd") or 0.0) * 1e-4
            # Le net DÉFLATÉ quand la porte le fournit : le net brut est le
            # maximum d'une recherche sur ~1300 cellules, et Kelly est
            # proportionnel a mu. Mesuré sur douze ajustements de l'horloge
            # 1m : brut +14,66 bps/trade, déflaté +2,97, direct +3,74. La
            # porte déduisait déjà cette prime pour DÉCIDER ; ne pas la
            # déduire pour DIMENSIONNER faisait prendre cinq fois trop de
            # risque par unité de preuve.
            #
            # La déflation REMPLACE la borne basse a une erreur type : la
            # barre vaut deja ~3,3 erreurs types et decroit comme 1/racine(n)
            # exactement comme elle. Sans champ deflate — une porte d'une
            # version anterieure — on retombe sur l'ancienne borne basse
            # plutot que de dimensionner sur le brut nu.
            defl = float(p.get("net_defl") or 0.0) * 1e-4
            # À défaut d'un compte transmis, on suppose le MINIMUM que la
            # porte accepte (40 instants) : une mesure existe forcément
            # derrière, mais la plus maigre possible. Supposer 1 ferait
            # retrancher un écart-type entier et annulerait toute taille
            # sur un simple oubli de câblage.
            n = max(int(p.get("net_n") or 40), 1)
            # La borne basse reste calculée dans tous les cas et sert de
            # PLAFOND au déflaté. Par construction marge < sr, donc le
            # déflaté est déjà plus petit que le brut ; mais un champ
            # aberrant venant d'une porte future ne doit pas pouvoir
            # agrandir une position — la nouvelle règle ne peut jamais
            # dimensionner plus haut que l'ancienne.
            borne = max(0.0, mu - sd / float(np.sqrt(n)))
            mu = min(borne, defl) if defl > 0.0 else borne
            m2 = mu * mu + sd * sd
            kelly = 0.25 * mu / m2 if (m2 > 1e-18 and mu > 0) else 0.0
        else:
            kelly = ECON.kelly_fraction(tp, sl, edge, vol, h, cost,
                                        cost_tp_bps=c_tp)
        kelly *= float(p.get("size_mult") or 1.0)
        # PARITE DE RISQUE entre les jambes. La porte ne mesure pas un
        # livre equipondere : _portfolio agrege les trades simultanes en
        # ponderant chaque jambe par l inverse de sa volatilite, pour que
        # toutes apportent le meme risque. Le moteur, lui, envoyait le
        # MEME notionnel a toutes — DOGE, trois fois plus agite que BTC,
        # dominait alors la variance du livre reellement tenu sans
        # apporter plus d avantage. On jouait donc un portefeuille que
        # personne n avait mesure.
        #
        # Le facteur arrive de _targets, ou seul on connait les autres
        # jambes du tour. Il vaut 1 en moyenne : la taille TOTALE ne
        # change pas, sa repartition oui. Et il passe AVANT les plafonds,
        # pour qu une jambe agrandie reste bornee par son propre plafond
        # de ruine.
        kelly *= max(float(parite), 0.0)
        lev = kelly * (self._risk_scale() if frein is None else float(frein))
        lev = min(lev, 0.025 / (sl * 1e-4), self.lev_max, self.max_name)
        # Rendu SANS troncature. Le levier que l'échange accepte est un
        # entier, mais la TAILLE d'une position ne l'est pas : elle se
        # règle par le poids notionnel. Tronquer ici confondait les deux
        # et transformait « réduire » en « arrêter » — un optimum de 0,88
        # devenait zéro, et une règle validée sous frein ne tradait pas du
        # tout. La séparation se fait chez l'appelant : entier ≥ 1 pour
        # l'échange, réel pour le poids.
        return max(lev, 0.0)

    def _targets(self, preds: list[dict]) -> dict[str, float]:
        """Weights are notional/equity. Margin = |w|/lev ≤ 0.92 of equity total."""
        raw = {}
        live = [p for p in preds if p["dir"] != "flat"]
        live.sort(key=lambda p: abs(p["edge_bps"]), reverse=True)
        keep = {p["inst"] for p in live[: self.trade_top]}
        n_keep = max(1, len(keep))
        margin_each = 0.92 / n_keep if self.max_name > 1.0 else None
        # Parite de risque : la part de chaque jambe est proportionnelle a
        # 1/volatilite, et le garde-fou mesure EST cette volatilite —
        # stop_bps = stop_sig x sigma x racine(h). Normalise a une moyenne
        # de 1, de sorte que seule la REPARTITION change.
        inv = {}
        for p in preds:
            if p.get("inst") in keep and p.get("dir") != "flat":
                inv[p["inst"]] = 1.0 / max(float(p.get("sl_bps") or 0.0), 1.0)
        moy_inv = (sum(inv.values()) / len(inv)) if inv else 0.0
        for p in preds:
            if p["dir"] == "flat" or p["inst"] not in keep:
                raw[p["inst"]] = 0.0
                p["lev"] = 0.0
                p["margin"] = 0.0
                continue
            part = ((inv.get(p["inst"], moy_inv) / moy_inv)
                    if moy_inv > 0 else 1.0)
            lev = self._pick_lev(p, parite=part)   # réel, non tronqué
            # Le levier envoyé à l'échange est un entier ; il ne descend
            # pas sous 1 et ne franchit jamais le plafond de ruine par le
            # haut, d'où la troncature vers le bas.
            p["lev"] = float(max(1, int(lev))) if lev > 0 else 0.0
            if margin_each is None:
                w = float(lev)
            else:
                w = float(margin_each * lev)
            # Ce que l'avantage SEUL justifierait, frein et rodage retires.
            # Le calculer par division serait faux : le plafond de ruine
            # — 2,5 % de fonds propres par stop touche — borne le levier
            # AVANT les deux multiplicateurs, et quand il mord, retirer le
            # frein ne change plus rien. Il faut donc refaire le chemin,
            # pas diviser le resultat. Sans ce chiffre a cote de l'autre,
            # « la regle est faible » et « la regle est bridee » se
            # ressemblent trop — et ce sont deux problemes opposes.
            plein = self._pick_lev(p, frein=1.0, parite=part)
            p["poids_plein"] = abs(float(plein if margin_each is None
                                         else margin_each * plein))
            # La confiance de rodage agit sur le NOTIONNEL, pas sur le
            # levier — un dixième de poids est un dixième de poids, alors
            # qu'un dixième de levier entier est zéro.
            if p.get("sortie_temps"):
                w *= self._confiance()
            # Sous ce poids, l'ordre ne survivrait pas au minimum notionnel
            # de la consommation : autant ne pas le compter comme vivant.
            if abs(w) < 1e-4:
                w = 0.0
                p["lev"] = 0.0
            p["margin"] = (abs(w) / p["lev"]) if p["lev"] else 0.0
            raw[p["inst"]] = w if p["dir"] == "long" else -w
        gross = sum(abs(v) for v in raw.values())
        cap = min(self.gross_cap, float(self.lev_max)) if self.max_name > 1 else self.gross_cap
        if gross > cap and gross > 0:
            s = cap / gross
            raw = {k: v * s for k, v in raw.items()}
            for p in preds:
                if p.get("inst") in raw and p.get("lev"):
                    p["margin"] = abs(raw[p["inst"]]) / p["lev"]
                    p["lev"] = abs(raw[p["inst"]]) / max(p["margin"], 1e-9) if p["margin"] else p["lev"]
        return raw

    def _px(self, inst: str, fallback: float = 0.0) -> tuple[float, float, float]:
        t = self.ticks.get(inst) or {}
        if not t:
            t = getattr(self.broker, "book", {}).get(inst) or {}
        # Dernier recours : le prix que le courtier a marqué au tour
        # courant. Sans lui, un flux de ticks momentanément muet faisait
        # abandonner SILENCIEUSEMENT tous les ordres en attente — le desk
        # décide, calcule ses cibles, et rien n'arrive au carnet sans
        # qu'aucune ligne de journal ne le dise.
        marque = float((getattr(self.broker, "prices", {}) or {}).get(inst)
                       or 0.0)
        last = float(t.get("last") or fallback or marque or 0.0)
        bid = float(t.get("bid") or 0.0) or last
        ask = float(t.get("ask") or 0.0) or last
        return last, bid, ask

    def _compter_realise(self, inst: str, fill, qty: float,
                         maker_at) -> None:
        """Le rendement réellement encaissé par un trade sur règle mesurée.

        Frais réels : l'entrée est postée (maker), la sortie paie maker si
        elle a reposé au take, taker sinon. C'est la même arithmétique que
        celle de la porte — pour que les deux chiffres soient comparables.
        """
        br = self.brackets.get(inst) or {}
        if not br.get("entry"):
            return
        # Un éclaireur ordinaire ne dit rien de la règle et ne doit pas
        # entrer dans sa mesure. Un éclaireur qui a JOUÉ la règle — même
        # direction, même horizon, même garde-fou — en dit tout : la
        # taille ne change pas un rendement en points de base.
        if br.get("explore") and not br.get("mesure"):
            return
        entree = float(br["entry"])
        if entree <= 0 or not fill:
            return
        brut = float(np.sign(qty)) * (float(fill.price) - entree) / entree * 1e4
        frais = self.cost_tp_bps if maker_at is not None else self.round_trip_bps
        net = brut - float(frais)
        # Les jambes simultanees font UN rendement, pas plusieurs mesures.
        #
        # La porte ne valide pas une jambe : elle valide le PORTEFEUILLE
        # que l horloge tient a chaque instant, jambes ponderees par
        # l inverse de leur volatilite (_portfolio). Le direct, lui,
        # empilait les jambes une par une dans la meme moyenne. Deux
        # consequences, et la seconde est la pire.
        #
        # D abord on ne mesurait pas le meme objet que celui qu on a
        # prouve : trois jambes correlees qui perdent ensemble comptaient
        # pour trois observations, ce qui gonfle la confiance qu on croit
        # avoir sur un chiffre qui n en merite qu une.
        #
        # Ensuite l ecart-type. Une jambe seule rend 44 bps d ecart-type ;
        # un portefeuille de trois jambes a risque egal en rend 44/racine(3)
        # = 25. A un avantage deflate de +1,1 bps, distinguer la moyenne de
        # zero a deux ecarts-types demande 6 400 jambes, contre 2 100
        # instants de portefeuille. C est la difference entre des mois et
        # des semaines pour savoir si la regle paie — et c est ce chiffre
        # qui commande le rodage.
        self._verser(net, float(fill.ts))
        # Le journal des fills ne portait que des prix. « Ou part
        # l'argent » demandait alors de reapparier a la main les entrees
        # et les sorties, instrument par instrument — et une sortie par
        # stop ne se distinguait pas d'une sortie a l'horizon. On attache
        # donc le resultat au fill qui le realise ; _record le ramasse.
        self._dernier_net = net

    def _glissement(self) -> float:
        """Le cout mesure du retard d entree, facture a la porte.

        Asymetrique, et c est delibere : un glissement mesure DEFAVORABLE
        est ajoute au cout, un glissement favorable est ignore. Une mesure
        bruitee ne doit jamais pouvoir abaisser la barre — elle ne peut
        que la relever. Trente ouvertures avant de facturer quoi que ce
        soit, pour la meme raison.
        """
        if int(self.exec_stats.get("n_gliss") or 0) < 30:
            return 0.0
        return max(0.0, float(self.exec_stats.get("glissement_bps") or 0.0))

    def _verser(self, net: float, ts: float) -> None:
        """Accumule une jambe fermee dans le paquet de son INSTANT.

        Le paquet se solde des qu une fermeture appartient a une minute
        posterieure, ou au premier instantane qui suit d une minute — une
        jambe restee seule ne doit pas attendre indefiniment un
        compagnon.
        """
        minute = int(float(ts) // 60.0)
        if self._paquet and self._paquet["minute"] != minute:
            self._solder_paquet()
        if not self._paquet:
            self._paquet = {"minute": minute, "nets": []}
        self._paquet["nets"].append(float(net))

    def _solder_paquet(self) -> None:
        """Un instant, un rendement : la moyenne des jambes fermees."""
        p = self._paquet
        self._paquet = {}
        nets = (p or {}).get("nets") or []
        if not nets:
            return
        # Egalement ponderees, parce que la parite de risque a deja rendu
        # les jambes equivalentes en risque a l ouverture : les additionner
        # a poids egaux EST le rendement du portefeuille tenu.
        net = float(np.mean(nets))
        n = int(self.live_stats.get("n") or 0)
        moy = float(self.live_stats.get("bps") or 0.0)
        self.live_stats["bps"] = (moy * n + net) / (n + 1)
        self.live_stats["n"] = n + 1
        self.live_stats["jambes"] = int(self.live_stats.get("jambes") or 0) + len(nets)

    def _confiance(self) -> float:
        """Une règle prouvée sur l'histoire doit gagner sa taille au présent.

        La porte établit qu'une règle a un avantage sur l'histoire ; elle
        ne peut rien dire de ce que l'exécution, la latence et le régime du
        jour lui feront subir. Mesuré : une règle à +9 à +11 bps par trade
        hors échantillon a rendu -609 USD en quatre heures de direct, avec
        les éclaireurs à +3,53. Deux mesures se contredisent, et on ne
        choisit pas la plus flatteuse — on prend la taille de la pire tant
        qu'elles ne se réconcilient pas.

        Donc : dixième de taille jusqu'à trente trades fermés, puis montée
        progressive vers la taille pleine à cent trente — et seulement
        tant que le net réalisé reste positif. C'est le principe de
        l'éclaireur appliqué à une règle nouvellement validée : on paie sa
        mesure au tarif de la mesure, pas au tarif de la conviction.
        """
        n = int(self.live_stats.get("n") or 0)
        if n < 30:
            return 0.1
        if float(self.live_stats.get("bps") or 0.0) <= 0.0:
            return 0.1
        return float(min(1.0, 0.1 + 0.9 * min(1.0, (n - 30) / 100.0)))

    def _record(self, fill, qty: float, reason: str, lev: float = 0.0) -> None:
        if not fill:
            return
        self.trades.append({
            "ts": float(fill.ts),
            "inst": fill.inst,
            "qty": float(qty),
            "px": float(fill.price),
            "fee": float(fill.fee),
            "reason": reason,
            "notional": abs(float(qty)) * float(fill.price),
            "lev": float(lev or 0.0),
            # rempli seulement sur les fermetures de regle mesuree
            "net_bps": self._dernier_net,
        })
        self._dernier_net = None
        self.trades = self.trades[-200:]

    def _arm(self, inst: str, qty: float, fill, vol_bps: float,
             tp_bps: float | None = None, sl_bps: float | None = None) -> None:
        entry = float(fill.price)
        # A 45-minute clock signal cut by the global 16-minute time-stop was
        # never given the time its own forecast asked for.
        plan = next((q for q in (self.last_preds or [])
                     if q.get("inst") == inst), {})
        h = int(plan.get("h_bars") or self.horizon)
        # Deux fois l'horizon pour ne pas couper un bracket avant que sa
        # prévision ait eu le temps de se réaliser. Mais une sortie au
        # temps N'EST QUE sa durée : la tenir plus longtemps jouerait une
        # règle plus longue que celle qui a été mesurée.
        garde = h if plan.get("sortie_temps") else min(90, max(6, 2 * h))
        self.hold_ms[inst] = int(max(garde, 1) * 60_000)
        sl_bps = float(sl_bps if sl_bps is not None else self.stop_bps)
        tp_bps = float(tp_bps if tp_bps is not None else self.take_bps)
        # These arrive already chosen by expected value; the floors that used
        # to widen them here could arm a 6bps take against a 7bps round trip,
        # a "winning" trade that books a loss. The only floor left is the one
        # that cannot be argued with: a take must clear its own cost.
        tp_bps = max(tp_bps, 1.25 * self.cost_tp_bps)
        sl_bps = max(sl_bps, 1.0)
        if qty > 0:
            sl = entry * (1.0 - sl_bps * 1e-4)
            tp = entry * (1.0 + tp_bps * 1e-4)
            side = "long"
        else:
            sl = entry * (1.0 + sl_bps * 1e-4)
            tp = entry * (1.0 - tp_bps * 1e-4)
            side = "short"
        # Ce qu il faut pour LIRE la position sans recouper trois fichiers :
        # le levier envoye a l echange, la marge reellement immobilisee, la
        # duree validee, et la source qui a decide. L ecran montrait une
        # position sans jamais dire a quel levier elle etait prise ni ce
        # qu elle bloquait en marge — deux chiffres qu on ne peut pas
        # reconstituer apres coup, parce que la cible du desk a change
        # depuis.
        notion = abs(float(qty)) * entry
        lev = float(plan.get("lev") or 0.0)
        self.brackets[inst] = {
            "side": side, "entry": entry, "sl": sl, "tp": tp,
            "sl_bps": sl_bps, "tp_bps": tp_bps,
            # une position ouverte sur règle mesurée doit vivre sa durée
            "sortie_temps": bool(plan.get("sortie_temps")),
            "t0": int(time.time() * 1000),   # l'écran affiche la tenue
            "lev": lev,
            "notional": notion,
            "margin": (notion / lev) if lev > 0 else notion,
            "hold_ms": int(self.hold_ms.get(inst) or 0),
            "stop_mode": str(plan.get("stop_mode") or "fixe"),
            # Le sommet du suiveur, en PRIX. Il ne monte que sur les
            # cloture de barre du moteur : un pic intra-tick n est pas
            # verrouillable, et en donner credit inventerait un gain que
            # l execution n a jamais pu prendre — c est exactement la
            # convention sous laquelle la porte l a mesure.
            "sommet": entry,
            "trail": (entry * (1.0 - sl_bps * 1e-4) if qty > 0
                      else entry * (1.0 + sl_bps * 1e-4)),
            "policy": plan.get("policy"),
            "edge_bps": float(plan.get("edge_bps") or 0.0),
            "h_bars": int(plan.get("h_bars") or 0),
            "bar": plan.get("bar"),
        }

    def _tient(self, inst: str, qty) -> bool:
        """Une poussière n'est pas une position.

        Mesuré en direct : un reliquat de 1,2e-10 DOGE — un dix-milliardième
        de cent — passait le seuil de QUANTITÉ, se faisait déclarer orpheline
        à chaque cycle, et recevait un ordre de sortie que l'arrondi de
        l'échange ramenait à zéro. Le reliquat restait, le journal se
        remplissait, et la sortie ne sortait rien. Le seuil doit donc être
        en ARGENT : sous un dollar de notionnel il n'y a rien à fermer, rien
        à surveiller, et rien à signaler.
        """
        q = abs(float(qty))
        if q < 1e-12:
            return False
        last, _, _ = self._px(inst)
        if last <= 0:
            return True          # prix inconnu : on ne déclare rien mort
        return q * last >= self.poussiere_usd

    def _balayer_poussiere(self) -> None:
        """Une position sous le plancher economique et sans proprietaire sort.

        Le plancher d ordre laissait desormais passer une FERMETURE, mais
        encore fallait-il qu une cible zero soit emise pour cet
        instrument — et un nom sans signal ne recoit aucune cible du tout.
        Mesure en direct : -10 DOGE, 89 centimes, toujours la des heures
        apres, affiches a l ecran comme une position ouverte. Exactement la
        micro-position qu on reproche au moteur.

        Une position qui porte encore un bracket est un vrai trade en
        cours, meme petit : on n y touche pas. Ce qui sort, c est le
        reliquat d arrondi que plus personne ne tient.
        """
        for inst, q in list(self.broker.positions().items()):
            if abs(float(q)) < 1e-12 or self._tient(inst, q):
                continue
            if (self.brackets.get(inst) or {}).get("entry"):
                continue
            last, _, _ = self._px(inst)
            if last <= 0:
                continue
            if not self.broker.market_order(inst, -float(q), last,
                                            force_taker=True):
                # L ordre a ete refuse : le reliquat est plus petit qu un
                # lot de l echange, donc AUCUN ordre ne le fermera jamais.
                # Mesure en direct : -9,999999999883585 DOGE, 89 centimes,
                # soit 0,01 contrat sur un ctVal de 1000. On le solde au
                # prix courant, sinon il reste a l ecran pour toujours.
                solder = getattr(self.broker, "solder", None)
                if solder is None or not solder(inst, last):
                    continue
            self.opened_bar.pop(inst, None)
            self.hold_ms.pop(inst, None)
            self.opened_h.pop(inst, None)
            self.brackets.pop(inst, None)
            self.log(f"scalp poussiere {inst} qty={float(q):+.9f} "
                     f"({abs(float(q)) * last:.2f} USD)")

    def _orphelines(self, pos: dict) -> None:
        """Toute position doit appartenir à une règle ; sinon elle sort.

        L'état repris couvre le cas normal, mais il reste les désyncs.
        Dans un sens, une position sans propriétaire : un remplissage côté
        échange qu'on n'a pas vu, un état effacé, une position ouverte à
        la main. Sans règle, elle n'a ni stop ni durée — elle ne peut que
        dériver. Mesuré en direct : un DOGE -8050, sept cents dollars de
        notionnel, immobile depuis des heures parce qu'aucune règle ne
        répondait plus pour lui. Dans l'autre, un suivi sans position :
        l'état écrit juste avant un arrêt brutal garde le bracket d'un
        trade déjà sorti, et comme une règle mesurée gèle la cible de son
        instrument pendant sa durée, ce fantôme empêcherait le desk
        d'ouvrir la position suivante.

        Les deux demandent DEUX constats consécutifs avant qu'on agisse :
        une lecture de positions incomplète — un échange qui hoquette et
        renvoie une liste tronquée — ne doit ni effacer un suivi valide ni
        déclencher une sortie sur une position parfaitement tenue.
        """
        tenus = {i for i, q in pos.items() if self._tient(i, q)}
        suivis = set(self.brackets) | set(self.opened_bar)
        ecart = (suivis - tenus) | (tenus - suivis)
        for inst in [i for i in self.desync if i not in ecart]:
            self.desync.pop(inst, None)
        for inst in ecart:
            self.desync[inst] = self.desync.get(inst, 0) + 1
        for inst in [i for i, n in self.desync.items() if n >= 2]:
            if inst in tenus:
                if inst not in self.sans_regle:
                    self.sans_regle.add(inst)
                    self.log(f"scalp position orpheline {inst} "
                             f"{float(pos[inst]):+.6f} — aucune règle ne la "
                             f"tient, sortie demandée")
            else:
                for suivi in (self.brackets, self.opened_bar,
                              self.hold_ms, self.opened_h):
                    suivi.pop(inst, None)
        for inst in list(self.sans_regle):
            if inst not in tenus:
                self.sans_regle.discard(inst)

    def check_exits(self, candles_1m: dict[str, Candles] | None = None) -> list[str]:
        """SL / TP / time-stop.

        Stops and time-stops always exit taker at bid (sell) / ask (buy).
        The take-profit rests on the book as a post-only limit: when price
        trades strictly THROUGH the level the resting order has filled at
        its own price at the maker fee. A mere touch leaves the queue
        position unknown, so it exits taker at the market, as before —
        never better than reality, sometimes worse.
        """
        hit: list[str] = []
        pos = self.broker.positions()
        self._orphelines(pos)
        for inst, qty in list(pos.items()):
            last, bid, ask = self._px(inst)
            if last <= 0 or not self._tient(inst, qty):
                continue
            reason = None
            maker_at = None
            br = self.brackets.get(inst)
            if br and br.get("stop_mode") == "suiv":
                # Le suiveur : le sommet ne monte que sur les cloture du
                # moteur, jamais sur un pic intra-tick — un pic n est pas
                # verrouillable, et lui donner credit inventerait un gain
                # que l execution n a jamais pu prendre. C est la
                # convention exacte sous laquelle la porte l a mesure.
                lar = float(br.get("sl_bps") or 0.0) * 1e-4
                if lar > 0:
                    if qty > 0:
                        br["sommet"] = max(float(br.get("sommet") or br["entry"]), last)
                        br["trail"] = br["sommet"] * (1.0 - lar)
                        if bid <= br["trail"]:
                            reason = f"TRAIL {br['sl_bps']:.0f}bps"
                    else:
                        br["sommet"] = min(float(br.get("sommet") or br["entry"]), last)
                        br["trail"] = br["sommet"] * (1.0 + lar)
                        if ask >= br["trail"]:
                            reason = f"TRAIL {br['sl_bps']:.0f}bps"
            if br and reason is None and br.get("stop_mode") != "suiv":
                if qty > 0:
                    if bid <= br["sl"]:
                        reason = f"SL {br['sl_bps']:.0f}bps"
                    elif bid > br["tp"]:
                        reason = f"TP {br['tp_bps']:.0f}bps maker"
                        maker_at = br["tp"]
                    elif bid >= br["tp"]:
                        reason = f"TP {br['tp_bps']:.0f}bps"
                else:
                    if ask >= br["sl"]:
                        reason = f"SL {br['sl_bps']:.0f}bps"
                    elif ask < br["tp"]:
                        reason = f"TP {br['tp_bps']:.0f}bps maker"
                        maker_at = br["tp"]
                    elif ask <= br["tp"]:
                        reason = f"TP {br['tp_bps']:.0f}bps"
            if reason is None and inst in self.sans_regle:
                reason = "orpheline"
            if reason is None:
                opened = self.opened_bar.get(inst)
                if opened:
                    held_ms = int(time.time() * 1000) - int(opened)
                    lim = int(self.hold_ms.get(inst) or self.max_hold * 60_000)
                    if held_ms >= lim:
                        reason = f"time-stop {held_ms // 60_000}m"
            if not reason:
                continue
            fill = self.broker.market_order(inst, -qty, last,
                                            force_taker=maker_at is None,
                                            maker_at=maker_at)
            if fill and br and not br.get("explore"):
                self._compter_realise(inst, fill, qty, maker_at)
            if fill and br and br.get("explore"):
                entree = float(br.get("entry") or fill.price)
                # Ce que la sortie obtient par rapport au marché courant —
                # mais séparément selon qu'elle a REPOSÉ ou TRAVERSÉ, car
                # les deux chiffres ne disent pas la même chose et les
                # mélanger produit un nombre qui ne veut rien dire.
                #
                # Un take posé se remplit à SON prix pendant que le marché
                # l'a dépassé : l'écart au marquage est alors négatif PAR
                # CONSTRUCTION, et c'est le plafond du take, pas un mauvais
                # remplissage. Le modèle de coût en tient déjà compte
                # ailleurs (l'économie du bracket borne le gain).
                #
                # L'écart d'une sortie qui TRAVERSE, lui, est de la vraie
                # glissade : c'est le seul des deux qui puisse dire que
                # traverser coûte plus cher que les frais modélisés.
                if last > 0:
                    ex = -float(np.sign(qty)) * (last - fill.price) / last * 1e4
                    cle = ("exit_maker_bps" if maker_at is not None
                           else "exit_taker_bps")
                    cnt = "n_exit_maker" if maker_at is not None else "n_exit_taker"
                    n_ex = int(self.explore_stats.get(cnt) or 0)
                    moy = float(self.explore_stats.get(cle) or 0.0)
                    self.explore_stats[cle] = (moy * n_ex + ex) / (n_ex + 1)
                    self.explore_stats[cnt] = n_ex + 1
                self.explore_pnl_day += qty * (fill.price - entree) \
                    - float(br.get("entry_fee") or 0.0) - float(fill.fee)
                if maker_at is not None:
                    self.explore_stats["tp_maker"] += 1
                elif reason.startswith("TP"):
                    self.explore_stats["tp_taker"] += 1
                elif reason.startswith("SL"):
                    self.explore_stats["sl"] += 1
                else:
                    self.explore_stats["time"] += 1
            self.brackets.pop(inst, None)
            self.opened_bar.pop(inst, None)
            self.hold_ms.pop(inst, None)
            self.opened_h.pop(inst, None)
            self.sans_regle.discard(inst)
            if fill:
                self._record(fill, -qty, reason, 0.0)
                self.log(f"scalp {reason} {inst} {qty:+.6f} @ {fill.price:.6f}")
                hit.append(inst)
                self.pending.pop(inst, None)
        return hit

    def _blend_targets(self) -> dict[str, float]:
        return self._targets(self.last_preds or [])

    def _explore(self, preds: list[dict], equity: float,
                 targets: dict[str, float]) -> None:
        """Ouvre au plus une position éclaireur par appel.

        Taille minimale d'échange, plafond notionnel, budget de perte
        journalier ; direction = signe du prévu courant (même non validé :
        au pire une pièce, et la taille est fixe). Les sorties passent par
        check_exits — c'est là que le remplissage maker au TP se mesure.
        """
        if not self.explore_on or not self.risk.trading_allowed:
            return
        jour = time.strftime("%Y-%m-%d", time.gmtime())
        if jour != self._explore_day:
            self._explore_day, self.explore_pnl_day = jour, 0.0
        if self.explore_pnl_day <= -self.explore_daily_bps * 1e-4 * equity:
            return          # budget du jour consommé : on observe, c'est tout
        ouverts = sum(1 for b in self.brackets.values() if b.get("explore"))
        if ouverts >= self.explore_max_open:
            return
        now = time.time()
        pos = self.broker.positions()
        for p in preds:
            inst = p.get("inst") or ""
            if inst in pos or targets.get(inst):
                continue
            if not p.get("l2"):
                continue
            spread = float(p.get("spread_bps") or 99.0)
            if spread > self.max_spread:
                continue
            if now - self._explore_last.get(inst, 0.0) < self.explore_cooldown_s:
                continue
            edge = float(p.get("edge_bps") or 0.0)
            last = float(p.get("px") or 0.0)
            if edge == 0.0 or last <= 0:
                continue
            # Quand la règle validée a PARLÉ pour cet instrument mais que
            # sa taille a été ramenée à zéro — par le frein du gouverneur
            # ou par le plancher de levier entier — l'éclaireur joue
            # exactement cette règle-là, à taille minimale : sa direction,
            # son horizon, son garde-fou. Le trade compte alors dans la
            # mesure en direct.
            #
            # Sans cela, une règle bloquée n'accumule aucune preuve : elle
            # attend la levée du frein pour commencer seulement à se faire
            # juger, et pendant ce temps le seul chiffre disponible reste
            # celui du holdout. Payer une taille minimale pour continuer à
            # mesurer est exactement ce que les éclaireurs font déjà pour
            # l'exécution ; ils le font désormais aussi pour la règle.
            regle = bool(p.get("sortie_temps")) and p.get("dir") in ("long",
                                                                    "short")
            if not regle:
                # Plus une seule position ouverte sur autre chose qu'une
                # règle validée. Les éclaireurs avaient une mission
                # précise — mesurer ce que le modèle de coût suppose : le
                # taux de manqué en file d'attente, l'écart d'entrée,
                # l'écart de sortie posée contre traversée. Cette mission
                # est FINIE, les chiffres sont acquis (entrée +0,15 bps,
                # sortie posée -3,4, treize prises au carnet sur trente et
                # une). Continuer à deviner le signe du flux toutes les
                # deux minutes ne mesure plus rien : ça paie des frais
                # pour du bruit, et ça donne à voir un système qui ouvre
                # des micro-positions sans rapport avec ce qu'il a prouvé.
                #
                # Ce qui reste, et c'est tout ce qui doit rester : jouer à
                # taille minimale une règle VALIDÉE dont la taille a été
                # ramenée à zéro par le frein ou par le plancher de
                # levier. Là, chaque trade mesure la seule chose qui
                # compte encore.
                continue
            sens = 1.0 if p["dir"] == "long" else -1.0
            qty = sens * self.explore_notional / last
            if hasattr(self.broker, "_round_qty"):
                arrondi = self.broker._round_qty(inst, qty)
                if arrondi == 0:      # le minimum d'échange dépasse le vœu :
                    arrondi = self.broker._round_qty(   # tenter sous plafond
                        inst, sens * self.explore_cap_pct * 1e-2 * equity / last)
                qty = arrondi
            if qty == 0 or abs(qty) * last > self.explore_cap_pct * 1e-2 * equity:
                continue              # minimum d'échange inabordable : passer
            _, bid, ask = self._px(inst, last)
            mid = (bid + ask) / 2.0 if bid > 0 and ask > bid else last
            fill = self.broker.market_order(inst, qty, last)   # entrée maker
            if not fill:
                continue
            # Ce que l'entrée postée obtient VRAIMENT par rapport au mid.
            # Le modèle de coût suppose maker + rien ; poser à l'intérieur
            # du spread gagne une fraction du spread, mais la sélection
            # adverse la reprend en partie. Personne ne peut trancher ça
            # depuis un fauteuil : on le mesure, comme QUEUE_MISS. Positif
            # = rempli mieux que le mid.
            if mid > 0:
                edge_e = float(sens) * (mid - fill.price) / mid * 1e4
                n = self.explore_stats["trades"]
                moy = self.explore_stats["entry_edge_bps"]
                self.explore_stats["entry_edge_bps"] = (moy * n + edge_e) / (n + 1)
            self._explore_last[inst] = now
            self.explore_stats["trades"] += 1
            self.opened_bar[inst] = int(now * 1000)
            self.opened_h[inst] = p.get("bar") or "90s"
            self._arm(inst, qty, fill, float(p.get("vol_bps") or 0.0),
                      p.get("tp_bps"), p.get("sl_bps"))
            self.brackets[inst]["explore"] = True
            self.brackets[inst]["mesure"] = regle
            self.brackets[inst]["entry_fee"] = float(fill.fee)
            self._record(fill, qty, "explore", 0.0)
            self.log(f"explore {inst} {qty:+.6f} @ {fill.price:.6f} "
                     f"(pnl jour {self.explore_pnl_day:+.2f} USD)")
            return                    # un seul par cycle : pas un moulin

    def tick(self, candles_1m: dict[str, Candles], now: float | None = None,
             bar: str = "1m") -> dict:
        now = now or time.time()
        if hasattr(self.broker, "mark_ticks") and self.ticks:
            self.broker.mark_ticks(self.ticks)
        preds = self.predict_all(candles_1m, bar=bar)
        prices = {p["inst"]: p["px"] for p in preds if p["px"] > 0}
        extra = {i: float((t or {}).get("last") or 0) for i, t in self.ticks.items()}
        prices.update({k: v for k, v in extra.items() if v > 0})
        self.broker.mark_prices(prices)
        vol = {p["inst"]: float(p.get("vol_bps") or 0) for p in preds}

        if self.risk.must_flatten:
            for inst, qty in list(self.broker.positions().items()):
                px = prices.get(inst, 0.0)
                if px > 0 and abs(qty) * px > 1:
                    self.broker.market_order(inst, -qty, px, force_taker=True)
            self.brackets.clear()
            self.opened_bar.clear()
            self.hold_ms.clear()
            self.opened_h.clear()
            self.sans_regle.clear()
            self.desync.clear()
            self._snapshot({"halted": True})
            return {"preds": self.last_preds, "equity": self.broker.equity(), "halted": True}

        self.check_exits(candles_1m)
        self._balayer_poussiere()

        if not self.risk.trading_allowed:
            self.pending = {}
            self._snapshot()
            return {"preds": self.last_preds, "equity": self.broker.equity()}

        equity = max(self.broker.equity(), 1.0)
        targets = self._blend_targets()
        pending: dict[str, float] = {}
        for inst, tgt_w in targets.items():
            last, _, _ = self._px(inst, prices.get(inst, 0.0))
            if last <= 0:
                continue
            pending[inst] = tgt_w * equity / last
        for inst in self.broker.positions():
            pending.setdefault(inst, 0.0)
        # Une position éclaireur vit par son bracket (TP/SL/time-stop), pas
        # par la cible du desk : _targets met un poids ZÉRO sur tout
        # instrument plat, et cette cible nulle refermait chaque éclaireur
        # au cycle suivant en payant deux fois les frais — mesuré en live :
        # ouvert 10:25:09, aplati 10:25:20. Une vraie cible non nulle,
        # elle, garde la priorité.
        for inst in list(pending):
            if (self.brackets.get(inst) or {}).get("explore") \
                    and abs(pending[inst]) < 1e-12:
                pending.pop(inst)
        # Et une position ouverte sur règle MESURÉE vit sa durée validée.
        # Ce que la porte a jugé est « entrer sur le signal, tenir h
        # barres, sortir » : la refermer au premier tour où le signal
        # fusionné bouge joue une AUTRE règle, dont personne ne connaît
        # l'économie. Mesuré en direct : DOGE ouvert à 02:53:23 sur un
        # signal candle à h=6, refermé à 02:54:31 — soixante-huit secondes,
        # et par la politique « prior » qui n'a rien validé. Chaque
        # aller-retour de ce genre paie les frais complets pour une
        # fraction du mouvement mesuré ; c'est ainsi qu'une règle mesurée
        # à +9 bps par trade perd de l'argent en direct.
        #
        # Le stop et la sortie au temps continuent de s'appliquer : ils
        # passent par check_exits, qui ne consulte pas les cibles.
        maintenant = int(time.time() * 1000)
        for inst in list(pending):
            br = self.brackets.get(inst) or {}
            if not br.get("sortie_temps") or br.get("explore"):
                continue
            ouvert = int(self.opened_bar.get(inst) or 0)
            lim = int(self.hold_ms.get(inst) or 0)
            if ouvert and lim and (maintenant - ouvert) < lim:
                pending.pop(inst)
        self.pending = pending
        self._pending_ts = time.time()
        self._explore(preds, equity, targets)
        self._vol = vol
        self.risk.update_equity(self.broker.equity(), now)
        self._snapshot({"equity": self.broker.equity(), "targets": targets})
        return {"preds": self.last_preds, "equity": self.broker.equity(), "targets": targets,
                "bar": bar, "live_bars": self.horizons.live_bars()}

    def execute_pending(self) -> None:
        """Fill last bar's targets once at the current bid/ask. Consumed.
        Re-firing the same delta every poll is a fee mill."""
        if not self.risk.trading_allowed:
            self.pending = {}
            return
        orders = self.pending
        self.pending = {}
        if not orders:
            return
        if self._pending_ts:
            n = int(self.exec_stats.get("n_entrees") or 0)
            moy = float(self.exec_stats.get("retard_s") or 0.0)
            self.exec_stats["retard_s"] = \
                (moy * n + (time.time() - self._pending_ts)) / (n + 1)
            self.exec_stats["n_entrees"] = n + 1
            self._pending_ts = 0.0
        equity = max(self.broker.equity(), 1.0)
        current = self.broker.positions()
        vol = getattr(self, "_vol", {})
        for inst, tgt_qty in list(orders.items()):
            last, _, _ = self._px(inst)
            if last <= 0:
                continue
            if hasattr(self.broker, "_round_qty"):
                tgt_qty = self.broker._round_qty(inst, tgt_qty)
            cur = current.get(inst, 0.0)
            # L'exemption éclaireur doit vivre ICI, à la consommation : le
            # pending construit dans le même tick AVANT l'ouverture porte
            # une cible zéro explicite pour l'instrument, et la version qui
            # n'exemptait qu'à la construction refermait l'éclaireur ~12 s
            # après l'entrée (mesuré : explore 15:43:05, fill 15:43:17).
            if (self.brackets.get(inst) or {}).get("explore") \
                    and abs(tgt_qty) < 1e-12:
                continue
            delta = tgt_qty - cur
            # Le plancher d ordre economise les frais d un ajustement qui
            # ne vaut pas son aller-retour. Mais il s appliquait AUSSI aux
            # fermetures, et une position devenue poussiere ne pouvait donc
            # plus jamais etre refermee : mesure en production, un reliquat
            # de -10 DOGE — 89 centimes — laisse par l arrondi de lot,
            # affiche a l ecran des heures durant comme une position
            # ouverte. Fermer coute un demi-millieme de dollar et ne se
            # produit qu une fois ; le laisser vivre coute une ligne de
            # « micro position » a l ecran pour toujours.
            if abs(tgt_qty) > 1e-9 and abs(delta) * last < max(10.0, 0.002 * equity):
                continue
            # « Ouvrir » se juge en ARGENT, comme partout ailleurs. Avec un
            # test a 1e-9, un reliquat de poussiere — 10 DOGE, 92 centimes,
            # laisse par l arrondi de lot — faisait passer la vraie entree
            # suivante pour un simple redimensionnement. Or seul un
            # redimensionnement n arme AUCUN bracket : la position naissait
            # donc sans proprietaire, le balayage la declarait orpheline au
            # tour suivant et la refermait, le desk la rouvrait... Mesure au
            # journal : DOGE ouvert et declare orphelin quatre fois en huit
            # minutes, en payant l aller-retour a chaque tour.
            opening = (not self._tient(inst, cur)) and abs(tgt_qty) > 1e-9
            flatten = abs(tgt_qty) < 1e-9
            # Passer long -> court en un ordre, c'est fermer un trade et en
            # ouvrir un autre, pas « ajuster ». Traite en resize, la jambe
            # fermee n'entrait dans aucune mesure et le bracket restait
            # celui du SENS OPPOSE : pour la position retournee, son stop
            # se retrouvait du mauvais cote du prix et sortait au tour
            # suivant sous l'etiquette « SL », un stop qui n'a jamais ete
            # arme. Le gel de cible d'une regle mesuree rend ce cas rare,
            # il ne le rend pas impossible.
            retourne = cur * tgt_qty < 0
            plan = next((p for p in self.last_preds if p.get("inst") == inst), {})
            # `plan["lev"]` est un POIDS notionnel — une fraction des fonds
            # propres, de l ordre de 0,02. Le comparer a 2 pour decider du
            # levier d echange confondait deux grandeurs sans rapport : la
            # condition n etait jamais vraie, aucun levier n etait donc
            # jamais transmis, et l echange retombait a x1 sur CHAQUE
            # position. Mesure a l ecran : « LEVIER x1,0 MARGE 153,51 »
            # pour un notionnel de 153,15.
            #
            # Le levier se deduit du besoin de MARGE : assez pour qu une
            # jambe n immobilise pas plus d un dixieme des fonds propres,
            # jamais moins que le plancher, jamais plus que le plafond.
            lev_ex = self._levier_echange(abs(tgt_qty) * last, equity)
            fill = self.broker.market_order(
                inst, delta, last, force_taker=flatten,
                leverage=(None if flatten else lev_ex),
            )
            if not fill:
                continue
            why = ("close" if flatten
                   else ("open" if (opening or retourne) else "resize"))
            # Ce que le retard coute VRAIMENT, en points de base, sur
            # chaque ouverture de regle : le prix paye contre le prix sur
            # lequel la decision a ete prise. Positif = paye plus cher que
            # le signal, donc un cout.
            sig_px = float(plan.get("px") or 0.0)
            if why == "open" and sig_px > 0 and fill.price > 0:
                gl = (float(np.sign(delta)) * (float(fill.price) - sig_px)
                      / sig_px * 1e4)
                ng = int(self.exec_stats.get("n_gliss") or 0)
                mg = float(self.exec_stats.get("glissement_bps") or 0.0)
                self.exec_stats["glissement_bps"] = (mg * ng + gl) / (ng + 1)
                self.exec_stats["n_gliss"] = ng + 1
            if flatten or retourne:
                self._compter_realise(inst, fill, cur, None)
            self._record(fill, delta, why, float(lev_ex))
            # Une position ouverte sur signal validé ne doit pas être plus
            # discrète qu'un éclaireur : sans cette ligne, le seul indice
            # qu'une horloge passée live a réellement travaillé était une
            # variation de trésorerie, et rien ne disait quelle source
            # avait décidé ni à quel levier.
            if why in ("open", "close"):
                # La durée réellement tenue, en clair. Sans elle, savoir si
                # une position a vécu les six minutes qu'on lui a mesurées
                # demande de recouper deux lignes de journal à la main, et
                # une fermeture par le temps ne se distingue pas d'une
                # fermeture par la cible.
                ouvert = int(self.opened_bar.get(inst) or 0)
                tenue = ((int(time.time() * 1000) - ouvert) / 60_000.0
                         if ouvert else 0.0)
                self.log(f"{'ouverture' if why == 'open' else 'fermeture'} "
                         f"{inst} {delta:+.6f} @ {fill.price:.6f} x{lev_ex:d} "
                         f"({plan.get('policy') or '?'} "
                         f"{float(plan.get('edge_bps') or 0.0):+.1f}bps "
                         f"h={int(plan.get('h_bars') or 0)}"
                         + (f" tenue={tenue:.1f}m" if why == "close" else "")
                         + ")")
            if abs(tgt_qty) < 1e-9:
                self.opened_bar.pop(inst, None)
                self.brackets.pop(inst, None)
                self.hold_ms.pop(inst, None)
                self.opened_h.pop(inst, None)
            elif opening or retourne:
                self.opened_bar[inst] = int(time.time() * 1000)
                plan = next((p for p in self.last_preds if p.get("inst") == inst), {})
                hb = plan.get("bar") or "90s"
                self.opened_h[inst] = hb
                if hb in ("90s", "flow") or plan.get("policy") in ("prior", "flow"):
                    self.hold_ms[inst] = 180_000
                else:
                    h_val = int(plan.get("h_bars") or 0)
                    self.hold_ms[inst] = (h_val * 60_000 if h_val > 0 else
                                          int(HOLD.get(hb, 3))
                                          * int(BAR_MS.get(hb, 60_000)))
                self._arm(inst, tgt_qty, fill, vol.get(inst, 0.0),
                          plan.get("tp_bps"), plan.get("sl_bps"))
            self.log(f"scalp fill {inst} {delta:+.6f} @ {fill.price:.6f}")
        self.risk.update_equity(self.broker.equity(), time.time())
        self._snapshot({"equity": self.broker.equity()})
