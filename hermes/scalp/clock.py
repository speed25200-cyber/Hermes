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
from ..data.store import Candles, BAR_MS as _DUREES
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
# Seuils de declenchement, en ecarts-types de la prediction.
#
# Le 3,0 a ete ajoute apres avoir constate que la cellule retenue sortait
# regulierement avec un seuil eleve — 13,5 puis 15,2 bps en direct. Une
# grille tronquee juste au-dessus de l optimum coute exactement ce que
# l optimum vaut, et on ne pouvait pas le savoir sans le chercher : le
# balayage des seuils s applique a des predictions DEJA calculees, il ne
# reajuste aucun modele. Le seul prix est la barre deflatee : sur le panel,
# 2 592 cellules deviennent 3 024 et la barre passe de 0,2069 a 0,2093 a
# 290 instants, soit 1,2 % — a comparer a une marge mesuree de 0,035, que
# la cellule voisine de la grille pourrait tout aussi bien doubler.
#
# Le 3,5 et le 4,0 ont ete ajoutes ensuite, sur une mesure sans ambiguite :
# le journal du 24 aout donne seuil=3.0sig sur les TROIS refits de
# l horloge 1m, plus le 5m et le 15m. Cinq verdicts sur cinq collent a la
# borne — l optimum est dehors, pas dedans. Une grille tronquee juste
# au-dessus de l optimum coute exactement ce que l optimum vaut. Prix :
# 3 024 cellules -> 3 888, barre 0,1650 -> 0,1682 a 466 instants, soit
# 1,9 %.
THRESHOLDS = (0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0)
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
# Le stop est cherche en LARGEUR et en MODE. Mesure sur 400 000 chemins
# a h=6 : quand le mouvement est precoce puis se retourne — la forme
# meme d un avantage de micro-structure — le suiveur rend 11,4 bps par
# trade contre 8,0 au fixe (Sharpe 0,220 contre 0,147). Quand la derive
# est reguliere il fait jeu egal, et il ne perd dans aucun regime
# essaye. Doubler cette dimension double les cellules cherchees et donc
# releve la barre pour tout le monde : c est le prix honnete de la
# recherche, et il est paye avant que le gain ne soit reclame.
STOPS = (("fixe", 2.0), ("fixe", 3.0), ("fixe", 4.0),
         ("suiv", 2.0), ("suiv", 3.0), ("suiv", 4.0))
LARGEURS = (2.0, 3.0, 4.0)
# Plafond de lignes d entrainement par pli.
#
# Le panel passe de six a vingt jambes et la profondeur 1m de trente a
# soixante jours : le produit fait x6,5, soit 1,7 million de lignes pour
# le dernier pli. Ni la memoire ni le temps d ajustement ne suivent, et
# un moteur qui met un quart d heure a se reajuster n est plus en direct.
#
# Ce qu on echantillonne coute peu : sur h barres, deux etiquettes
# consecutives partagent h-1 barres — ce sont des quasi-doublons, c est
# d ailleurs la raison pour laquelle la MESURE, elle, est amincie a des
# etiquettes non chevauchantes. Un pas regulier dans le temps garde la
# meme couverture calendaire avec moins de redondance.
#
# Ce qu on n echantillonne JAMAIS, c est le holdout : la barre deflatee
# se lit sur le nombre d instants mesures, et en retirer reviendrait a
# se rendre la porte plus facile.
BUDGET_TRAIN = 400_000

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

# Les echelles cherchees. Le 1H a ete ajoute pour une raison
# arithmetique, pas par gout de la variete.
#
# Ce qui decide qu une echelle est tradable, c est le rapport entre le
# mouvement DISPONIBLE et le cout de l aller-retour. Le cout est plat —
# environ 7 bps, entree postee plus sortie traversee — pendant que le
# mouvement croit comme racine du temps. Sur un actif a 10 bps de sigma
# par minute :
#
#   echelle x horizon      mouvement       cout        rapport
#   1m  x 1                    10 bps       7 bps          1,4
#   1m  x 6                     24 bps      7 bps          3,5
#   15m x 6  (90 min)           95 bps      7 bps         13,6
#   1H  x 6  (6 heures)        190 bps      7 bps         27
#
# A la minute, le cout mange la moitie de ce qui bouge : il faut une
# precision de prediction que la litterature ne rapporte nulle part. A
# l heure, il en mange 4 %. Ce n est pas que la minute soit impossible,
# c est qu elle exige un avantage dix fois plus grand pour le meme
# resultat — et le 1m reste cherche, il n est rien retire.
#
# Le prix : une echelle de plus multiplie la grille par 5/4, donc la
# barre deflatee monte d environ 1 %. Et le 1H donne moins d instants
# (17 520 barres sur deux ans contre 86 400 pour un mois de 1m), donc sa
# barre a lui sera plus haute. La porte tranchera ; c est son travail.
BARS = ("1m", "3m", "5m", "15m", "1H")
HOLD = {"1m": 3, "3m": 3, "5m": 3, "15m": 3, "1H": 3}
# Profondeur d'historique par horloge. La barre du hasard décroît en
# 1/racine(trades) : à 21 jours de 5 min, une règle qui déclenche 4 % du
# temps ne produit que ~50 trades hors échantillon et doit battre 0,37 —
# un avantage réel n'y arrive pas. Aux profondeurs ci-dessous elle en
# produit des centaines et la barre tombe vers 0,10. Ce n'est pas une
# porte plus douce : c'est la même porte avec assez de preuves pour
# distinguer un avantage d'une chance.
# La barre de selection deflatee vaut ~3,63 / racine(instants) : elle ne
# depend QUE du nombre d instants non chevauchants du holdout. Mesure en
# production le 24 aout, horloge 1m : sr=+0,242 contre barre=0,207 sur
# 290 instants — une marge de 0,035, dont la taille jouee se deduit
# directement (net deflate = mu x marge/sr, soit +1,9 bps sur +13,0
# annonces). Ce n est pas le modele qui manque, c est le denominateur.
#
# Trente jours de barres d une minute donnent 26 752 instants de holdout,
# dont 411 declenchent et 290 survivent au deschevauchement. Soixante en
# donnent deux fois plus, et la barre tombe d un facteur racine(2) : 0,207
# -> 0,147, marge 0,035 -> 0,095, soit pres de trois fois le net deflate a
# signal INCHANGE. Aucun autre levier disponible ne rend cela.
#
# Le prix est le temps d ajustement, qui double lui aussi : un balayage
# complet passe de deux a environ quatre minutes toutes les seize. Et si
# l avantage n existait que dans le dernier mois, le sr baissera — c est
# un resultat honnete, pas un echec du dispositif.
DAYS = {"1m": 60, "3m": 60, "5m": 120, "15m": 365, "1H": 730}
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
# Poids du vote par echelle. Ils montent avec l horizon parce que le
# rapport mouvement/cout monte avec lui — voir le tableau au-dessus de
# BARS. Ils somment a 1.
W = {"1m": 0.12, "3m": 0.15, "5m": 0.20, "15m": 0.26, "1H": 0.27}
FEE = 7.0  # maker in + taker SL, bps
# La duree de CHAQUE barre de BARS, sans exception. Le defaut de
# `BAR_MS.get(bar, 300_000)` est un piege : « 1H » y manquait pendant que
# BARS le contenait, et la recherche retombait donc sur cinq minutes pour
# l echelle horaire. Trois consequences, et les deux dernieres sont des
# defauts de MESURE, pas d affichage :
#
#   - `par_jour` divisait par le mauvais pas ;
#   - l EMBARGO valait h x 5 min au lieu de h x 60 min, soit 30 minutes
#     la ou les etiquettes couvrent six heures : de la fuite pure ;
#   - le sous-echantillonnage du holdout, `(ts // pas) % h == 0`, devenait
#     TOUJOURS VRAI. Les horodatages horaires sont des multiples de
#     3 600 000 ; divises par 300 000 ils donnent 12k, et 12k % 6 vaut
#     toujours zero. Le 1H gardait donc ses SIX etiquettes chevauchantes
#     au lieu d une sur six.
#
# Mesure du 27 aout : a h=6 le holdout gardait 60 barres sur 60 au lieu
# de 10, l instants du 1H etait donc gonfle d un facteur six, et sa barre
# deflatee valait 0,102 au lieu de 0,251. C est ce qui faisait croire que
# le 1H etait « a 0,007 de la porte » alors qu il en est a un facteur 2,5.
#
# Un test exige desormais que BAR_MS couvre BARS : le defaut silencieux
# ne peut pas revenir.
# La duree dune barre a UNE seule definition, celle du magasin, et
# cette ligne la restreint aux echelles cherchees. Ecrite en dur ici,
# elle avait diverge : « 1H » manquait alors que le magasin le
# connaissait depuis toujours. Derivee, lomission devient impossible
# — un nom de BARS sans duree leve a limport, ce qui est bien plus
# fort quun `.get(bar, 300_000)` silencieux.
BAR_MS = {b: _DUREES[b] for b in BARS}


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


# Les colonnes de feat_matrix, NOMMEES et dans l ordre. Les tests
# reperaient jusqu ici les decalages de rendement par un indice ecrit en
# dur ; inserer une colonne au milieu — le volume — les a casses en
# silence. Un nom ne se decale pas.
COLONNES = (
    "r1", "lag3", "lag5", "lag12", "loc", "rng", "vol_rel", "persist",
    "funding", "taker", "basis", "d_oi", "z20", "z60", "sin_h", "cos_h",
    "d_taker", "vz",
    "r1_1", "r1_2", "r1_3", "r1_4", "r1_5", "r1_6", "r1_7", "r1_8",
    "loc_1", "loc_2", "d_basis", "vers_reglement", "weekend",
)
CROISEES = ("btc_r1", "xs", "btc_r1_1")
N_FEATURES = len(COLONNES)   # colonnes de feat_matrix (un seul actif)


def col(nom: str) -> int:
    """L indice d une colonne par son NOM, jamais par sa position."""
    return COLONNES.index(nom)

N_CROISE = len(CROISEES)   # colonnes ajoutées par croise()


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

    # La PROXIMITE DU REGLEMENT de funding. Les perpetuels le reglent
    # toutes les huit heures — 00, 08 et 16 UTC — et les positions se
    # concentrent avant puis se defont apres. L effet a donc une periode
    # de HUIT heures, quand la matrice ne portait qu un cycle de
    # vingt-quatre : deux colonnes qui font un tour complet sur la journee
    # ne peuvent pas representer trois zones identiques dans la journee.
    #
    # Mesure, meme protocole que pour le volume, sur une fixture ou le
    # flux paie pres du reglement et se retourne loin de lui — effet
    # construit pour etre invisible aux retours decales, le signe du
    # retour suivant le FLUX qui est blanc :
    #
    #   sans la colonne   live 0/4   ic -0,011
    #
    # Zero sur quatre : aveugle, pas subtile.
    #
    # UNE colonne, et elle encode exactement l hypothese — la distance au
    # reglement le plus proche, nulle au reglement et pleine a mi-chemin.
    # Pas un cycle a deux colonnes : sur le jour de la semaine, l encodage
    # minimal revelait MIEUX que le cycle complet et coutait moins.
    dow_ = ((np.asarray(c.ts, dtype=np.int64) // 86_400_000) + 4) % 7
    weekend = (dow_ >= 5).astype(np.float64)
    vers_reglement = 2.0 * np.minimum(
        (np.asarray(c.ts, dtype=np.float64) % 28_800_000.0) / 28_800_000.0,
        1.0 - (np.asarray(c.ts, dtype=np.float64) % 28_800_000.0) / 28_800_000.0)
    # Le WEEK-END, et pourquoi il a failli ne pas etre la.
    #
    # La crypto cote 24/7 mais le monde qui la trade, non : moins de flux
    # institutionnel le week-end, moins de couverture, et un meme
    # desequilibre de flux n y paie pas la meme chose.
    #
    # Mesure, meme protocole que pour le volume, sur une fixture ou le
    # flux paie en semaine et se retourne le week-end — effet construit
    # pour etre invisible aux retours decales :
    #
    #   sans colonne              live 0/4   ic +0,232
    #   sin/cos du jour (2 col)   live 4/4   ic +0,575
    #   week-end binaire (1 col)  live 4/4   ic +0,686
    #   bruit pur                 live 0/4 dans TOUS les cas
    #
    # L encodage minimal de l hypothese — « le week-end est different »
    # plutot que « chaque jour l est » — revele MIEUX que le cycle complet
    # a sept valeurs, en retirant six degres de liberte.
    #
    # Cette colonne a d abord ete REJETEE, a tort, et l erreur vaut d etre
    # gardee. Le cout mesure sur la fixture de reference — 2 400 barres de
    # 5m — faisait tomber le compte de succes de 12/12 a 9/12, et cela
    # semblait trancher. Mais la meme mesure repetee en faisant GRANDIR la
    # fixture donne :
    #
    #        2 400 barres ( 8 jours)   6/8
    #        6 000 barres (21 jours)   8/8
    #       14 000 barres (49 jours)   8/8
    #
    # Le cout etait entierement un artefact de petit echantillon : avec
    # peu de lignes, le reseau n a pas de quoi apprendre qu une colonne
    # est inutile. En production il en voit des centaines de milliers.
    # Mesurer un cout sur une fixture trop courte pour le mesurer, c est
    # rejeter de bonnes idees pour du bruit — et j en ai rejete une.
    lv = np.log1p(np.maximum(np.nan_to_num(np.asarray(c.v, dtype=np.float64),
                                           nan=0.0), 0.0))
    mv = np.convolve(lv, np.ones(60) / 60.0, mode="full")[:n]
    mv[:60] = lv[:60]
    sv = _roll_std(lv, 60)
    vz = np.clip(np.nan_to_num((lv - mv) / np.maximum(sv, 1e-9), nan=0.0),
                 -4.0, 4.0)

    # Poussée du flux taker : le NIVEAU du déséquilibre est déjà là, sa
    # VARIATION ne l'est pas — et c'est elle qui marque une arrivée.
    d_taker = np.zeros(n)
    if n > 1:
        d_taker[1:] = np.clip(taker[1:] - taker[:-1], -1, 1)

    # Même raisonnement pour le basis, et il porte plus loin. Le NIVEAU
    # dit qu un perpétuel est cher par rapport a son indice ; sa VARIATION
    # dit que quelqu un vient de payer pour l acheter LA, tout de suite,
    # sans passer par le comptant. C est la pression propre au perpétuel,
    # celle qui se paie ensuite en financement et qui revient a la
    # moyenne — le seul signal que ce marche-ci possede et que le comptant
    # n a pas.
    d_basis = np.zeros(n)
    if n > 1:
        d_basis[1:] = np.clip(basis[1:] - basis[:-1], -20, 20)

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
        zscore(20), zscore(60), np.sin(ang), np.cos(ang), d_taker, vz,
        *seq, decale(loc_c, 1), decale(loc_c, 2),
        # AJOUTEE A LA FIN, et c est essentiel. La couche 0 du reseau est
        # tiree en un seul bloc (d, h) : INSERER une colonne au milieu
        # re-associe chaque colonne existante a d autres poids, alors que
        # l ajouter a la fin laisse les precedentes intactes. Mesure sur
        # la fixture d interaction, ou d_basis vaut identiquement zero
        # donc ne peut rien apporter ni rien coûter : inseree a l index
        # 18, mlp/ens tombait de 11/12 a 8/12 ; ajoutee a la fin, une
        # colonne morte ne change rien (8/12 -> 8/12). Le « cout » n en
        # etait pas un, c etait un deplacement.
        d_basis,
        # Meme regle : a la fin.
        vers_reglement, weekend,
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
    m = n - h - lag - 1
    if m < 2:
        return y_r, y_up, y_dn
    # L ENTREE EST L OUVERTURE DE LA BARRE SUIVANTE, pas la cloture de
    # celle qui decide.
    #
    # Le moteur voit la cloture de la barre i a ts+60s, envoie un ordre,
    # et le remplissage arrive 2,0 secondes plus tard (mesure : retard_s
    # sur 458 ordres). Le prix de cloture, lui, existait deja quand
    # l ordre est parti : la porte simulait un remplissage a un prix
    # qu on ne peut PAS obtenir.
    #
    # L ecart n est pas anodin, parce qu il porte exactement le rebond
    # bid-ask : chaque print tombe au bid ou a l ask, si bien que la
    # serie des CLOTURES herite d une autocorrelation negative qui ne
    # doit rien a une prevision. Mesure sur un marche ou le prix efficient
    # est une marche aleatoire pure et ou seul le rebond existe :
    # autocorrelation des retours de cloture -0,131, contre -0,023 pour
    # le retour ouverture -> cloture suivante. Entrer a l ouverture de la
    # barre suivante retire ce mirage, et il ne coute rien la ou
    # l avantage est vrai.
    #
    # C est un DURCISSEMENT : le prix d entree devient celui qu on peut
    # reellement avoir, jamais meilleur.
    base = np.asarray(c.o, dtype=np.float64)[lag + 1:lag + 1 + m]
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


def _suiveur(c: Candles, h: int, lag: int, largeur: np.ndarray,
             sens: int) -> tuple[np.ndarray, np.ndarray]:
    """Le stop SUIVEUR, simule barre par barre et sans se flatter.

    Un stop fixe encaisse tout ce que la fenetre lui laisse ; un stop
    suiveur verrouille ce qui a deja ete gagne. Mesure sur 400 000
    chemins a h=6, avec frais : quand le mouvement est PRECOCE puis se
    retourne — la forme meme dun avantage de micro-structure — le
    suiveur rend 11,4 bps par trade contre 8,0 au fixe, Sharpe 0,220
    contre 0,147. Quand la derive est reguliere il fait jeu egal. Il ne
    perd dans aucun des trois regimes essayes.

    Deux choix conservateurs, sans lesquels un suiveur simule ment :

    - le sommet se met a jour sur les CLOTURES, jamais sur les hauts.
      Un pic intra-barre nest pas verrouillable : en donner credit
      inventerait un gain que lexecution na jamais pu prendre.
    - le declenchement se teste contre lEXTREME adverse de la barre,
      et le remplissage se fait au MILIEU entre le niveau et cet
      extreme — la meme discipline que le stop fixe. Supposer un
      remplissage AU niveau violerait larret optionnel et ferait
      paraitre les suiveurs etroits meilleurs quils ne sont.
    """
    n = len(c)
    touche = np.zeros(n, dtype=bool)
    gain = np.full(n, np.nan)
    m = n - h - lag - 1
    if m < 2:
        return touche, gain
    px = np.asarray(c.c, dtype=np.float64)
    # Meme entree que _targets : l ouverture de la barre suivante.
    base = np.asarray(c.o, dtype=np.float64)[lag + 1:lag + 1 + m]
    ok = base > 0
    T = largeur[:m]
    # en unites de rendement, oriente dans le sens favorable au trade
    def rel(x, k):
        return sens * (x[lag + k:lag + k + m] / np.where(ok, base, np.nan) - 1.0)
    adverse_src = c.l if sens > 0 else c.h
    sommet = np.zeros(m)
    vivant = np.ones(m, dtype=bool)
    sortie = np.full(m, np.nan)
    for k in range(1, h + 1):
        niveau = sommet - T
        bas = rel(np.asarray(adverse_src, dtype=np.float64), k)
        pris = vivant & np.isfinite(bas) & (bas <= niveau)
        if pris.any():
            sortie[pris] = 0.5 * (niveau[pris] + bas[pris])
            vivant &= ~pris
        clo = rel(px, k)
        sommet = np.where(vivant & np.isfinite(clo),
                          np.maximum(sommet, clo), sommet)
    fin = rel(px, h)
    sortie = np.where(vivant, fin, sortie)
    touche[:m] = ~vivant & ok
    gain[:m] = np.where(ok, sortie, np.nan)
    return touche, gain


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


def _en_risque(net: np.ndarray, ts: np.ndarray,
               sig: np.ndarray) -> np.ndarray:
    """Le meme portefeuille, mesure en unites de RISQUE et non en bps.

    `_portfolio` divise par la somme des poids 1/sigma. Son numerateur
    vaut deja somme(net_i/sigma_i) — mais son denominateur, en croissant
    quand la volatilite baisse, ecrase les instants calmes et gonfle les
    instants agites. La serie obtenue est celle d un livre a NOTIONNEL
    constant.

    Or le moteur ne tient pas ce livre-la. Le plafond de ruine donne une
    taille proportionnelle a 1/sigma : il tient un livre a RISQUE
    constant. Et le seuil d entree etant lui-meme exprime en sigma, un
    signal de 3 sigma rapporte mecaniquement plus de bps une heure
    agitee qu une heure calme — `net` est heteroscedastique par
    construction, et le Sharpe d une serie heteroscedastique est
    mecaniquement rabaisse.

    Diviser par le NOMBRE de jambes au lieu de la somme des poids donne
    la moyenne des rendements en unites de risque. C est le meme argument
    de fidelite que celui qui a impose la parite de risque ENTRE jambes,
    applique cette fois DANS LE TEMPS — il n avait ete applique qu a une
    moitie du probleme.

    Mesure du 27 aout, panel synthetique a regimes de volatilite (x3
    entre calme et tempete), verite terrain = le Sharpe du P&L en dollars
    d un livre a risque constant :

        avantage             actuel   en risque   verite
        proportionnel a sig  0.0697   0.0863      0.1054
        constant en bps      0.0659   0.1192      0.1451

    Sur les douze cellules essayees, la mesure en risque tombe TOUJOURS
    entre l ancienne et la verite, et ne la depasse jamais : elle retire
    un biais vers le bas sans en creer un vers le haut. La moyenne (et
    non la somme) sur les jambes reste la convention prudente — sommer
    supposerait les jambes independantes, ce qu elles ne sont pas.

    Et la BARRE ne bouge pas. Sous nul dur (queues de Student a 3 degres
    de liberte, sigma en regimes), le max de Sharpe sur 4 860 cellules
    vaut 0,1089 avec l ancienne agregation et 0,1086 avec celle-ci, pour
    une barre theorique de 0,1093 a 1 143 instants. Le changement ne
    touche donc pas la porte : il ne change que l estimation du signal.
    """
    if len(net) == 0:
        return np.zeros(0)
    u = net / np.maximum(np.asarray(sig, dtype=np.float64), 1e-12)
    _, inv = np.unique(np.asarray(ts), return_inverse=True)
    return np.bincount(inv, weights=u) / np.bincount(inv)


def _part_prolongee(ts_tr, inst_tr, sens_tr, pas_ms: float, h: int) -> float:
    """La part des declenchements qui PROLONGENT le precedent.

    Le moteur solde au temps a h barres, puis rouvre si le signal tient
    encore. Mesure en direct du 27-28 aout, trois lectures : 39 % des
    ouvertures (7/18), puis 54 % (51/95), puis 51 % (63/124) reprennent
    une jambe que le time-stop vient de solder, du meme sens, dans la
    barre. A 07h22 cela representait 4,28 USD dallers-retours sur 6,44 de
    frais — 74 % de la perte de la fenetre.

    La question est de savoir si la PORTE voit la meme chose. Le holdout
    est aminci a `(ts // pas) % h == 0` : deux instants de test consecutifs
    dun meme nom sont donc exactement h barres lun de lautre, ce qui est
    EXACTEMENT le motif « solder au temps puis rouvrir ». La comparaison
    est donc licite, et bon marche.

    Si la part mesuree ici vaut aussi la moitie, alors la porte facture
    deja ces allers-retours et le direct ne fait que ce quelle a mesure.
    Si elle est nettement plus basse, le moteur rouvre bien plus souvent
    que la regle validee, et lecart est un vrai defaut.

    MESUREE, BRANCHEE A RIEN. On la journalise ; on ne decide rien avec.
    """
    # Une cellule peut etre construite sans ces series — un test en
    # fabrique une a la main, et `_retenir` doit rester appelable sur
    # un dict minimal. Sans mesure, la reponse est zero, pas une
    # exception : une sonde ne doit jamais pouvoir arreter la porte.
    if ts_tr is None or inst_tr is None or sens_tr is None:
        return 0.0
    n = len(ts_tr)
    if n < 2:
        return 0.0
    ts_tr = np.asarray(ts_tr, dtype=np.float64)
    inst_tr = np.asarray(inst_tr)
    sens_tr = np.asarray(sens_tr, dtype=np.float64)
    o = np.lexsort((ts_tr, inst_tr))
    t, i, sg = ts_tr[o], inst_tr[o], sens_tr[o]
    pas_h = float(pas_ms) * max(int(h), 1)
    suite = ((i[1:] == i[:-1])
             & (np.abs((t[1:] - t[:-1]) - pas_h) < 1.0)
             & (sg[1:] * sg[:-1] > 0.0))
    return float(suite.sum()) / float(n)


def _pente_et_erreur(x: np.ndarray, y: np.ndarray) -> tuple:
    """La pente de la realite sur l annonce, ET son erreur type.

    La pente sert a redimensionner la prediction :
        shrink = max(0 ; 1 + (pente - 1) * credit)
    Une pente negative rend donc un shrink NUL, et une cellule inerte :
    elle gagne la recherche, bloque toutes les autres, et ne produit
    jamais une direction. Le verdict 1H du 27 aout portait -0,70 puis
    -1,53 sur deux ajustements consecutifs.

    Or cette pente est mesuree sur le SOUS-ENSEMBLE DECLENCHE, celui ou
    |prediction| depasse k sigma. C est un conditionnement sur la
    variable explicative, et il attenue la pente vers zero de facon
    connue : en selectionnant les predictions extremes on selectionne
    aussi les lignes ou la part de BRUIT de la prediction est extreme, et
    le realise ne suit pas ce bruit. Avec un ic de 0,010, la part de
    signal est minuscule et l attenuation peut faire passer la pente sous
    zero sans qu il y ait la moindre anti-prediction.

    Le point neutre de la formule est 1 — faire confiance a l echelle du
    modele — et `credit` etait cense s en ecarter « a proportion des
    preuves ». Mais `credit = n_periods/200` compte des INSTANTS, pas la
    precision de la pente : a 1 142 instants il vaut 1, et la formule
    accorde une confiance totale a une pente dont on ignore l erreur.

    On mesure donc cette erreur. La forme `1 + (b - 1) * credit` est
    exactement la moyenne a posteriori d un b bruite autour d un a priori
    centre en 1, avec credit = tau2 / (tau2 + se2) : la formule etait
    juste, c est le poids qui etait faux. Reste a savoir si, sur les
    donnees reelles, une pente de -1,53 est etablie ou non — et cela ne
    se decide pas au raisonnement. On journalise, on lit, on tranche.
    """
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    n = len(x)
    if n < 3:
        return 0.0, float("inf")
    vx = float(np.var(x))
    if vx <= 1e-18:
        return 0.0, float("inf")
    b = float(np.cov(x, y)[0, 1]) / vx
    res = (y - float(np.mean(y))) - b * (x - float(np.mean(x)))
    se = float(np.std(res, ddof=2)) / (math.sqrt(vx) * math.sqrt(n))
    return b, (se if np.isfinite(se) and se > 0.0 else float("inf"))


def _agreger(net: np.ndarray, ts: np.ndarray,
             sig: np.ndarray) -> tuple:
    """Les DEUX series du portefeuille, en UN seul tri.

    `_portfolio` et `_en_risque` mesurent le meme portefeuille dans deux
    unites, et chacune faisait son propre `np.unique` sur les memes
    horodatages. Le balayage en appelle une par cellule, donc 4 860 par
    echelle : ajouter la seconde mesure a double le nombre de tris de la
    boucle la plus interne.

    Mesure du 27 aout, et elle est severe : apres le deploiement de la
    mesure en unites de risque, AUCUN verdict d horloge n est sorti en
    deux fenetres de trente-sept minutes, la ou un moteur sain en produit
    quatre. Le cycle complet etait passe d environ cinquante minutes a
    environ cent, et chaque deploiement l interrompait avant le premier
    verdict.

    Un tri partage rend le cout d origine. Les deux series restent
    disponibles separement — les tests les appellent directement, et
    c est par elles que la barre a ete verifiee sous nul dur.
    """
    net = np.asarray(net, dtype=np.float64)
    if len(net) == 0:
        return np.zeros(0), np.zeros(0)
    _, inv = np.unique(np.asarray(ts), return_inverse=True)
    compte = np.bincount(inv)
    sg = np.maximum(np.asarray(sig, dtype=np.float64), 1e-12)
    w = 1.0 / sg
    w = np.where(np.isfinite(w) & (w > 0), w, 0.0)
    tot = np.bincount(inv, weights=w)
    tot = np.where(tot > 0, tot, 1.0)
    bps = np.bincount(inv, weights=w * net) / tot
    risque = np.bincount(inv, weights=net / sg) / compte
    return bps, risque


def _profil(pnl: np.ndarray, k: int = 3) -> tuple:
    """Le Sharpe par tiers chronologique du holdout.

    Il existe deux facons tres differentes pour une regle de rendre un
    bon Sharpe global, et le chiffre global ne les distingue pas :
    l avantage est present PARTOUT, ou bien il est concentre dans une
    fenetre et absent ailleurs. La difference decide de tout — le premier
    se trade, le second est un mirage de fenetre.

    Mesure qui a impose cette colonne, journal du 24 aout : porter la
    profondeur 1m de trente a soixante jours a fait tomber le sr de
    +0,242 a +0,148 alors que la barre ne tombait que de 0,207 a 0,163.
    La marge est passee negative, la porte a mis son veto. Sans profil,
    impossible de dire si le mois ajoute a DILUE un avantage reel ou si
    les trente jours precedents en montraient un FAUX — et les deux
    appellent des suites opposees.

    pnl arrive trie : _portfolio indexe par np.unique des horodatages.
    """
    n = len(pnl)
    if n < 3 * MIN_TRADES:
        return ()
    bornes = np.linspace(0, n, k + 1).astype(int)
    out = []
    for i in range(k):
        t = pnl[bornes[i]:bornes[i + 1]]
        sd = float(np.std(t, ddof=1)) if len(t) > 1 else 0.0
        out.append(round(float(np.mean(t)) / sd, 3) if sd > 1e-12 else 0.0)
    return tuple(out)


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
        self.thr_k = 0.0        # le même seuil, en sigmas de la prédiction
        self.par_jour = 0.0     # instants de declenchement par jour
        self.profil = ()        # sr par tiers chronologique du holdout
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
        self.net_defl = 0.0    # le net une fois la prime de sélection ôtée
        self.n_cells = (len(ASSETS) * len(BARS) * len(FAMILIES)
                        * len(THRESHOLDS) * len(HORIZONS) * len(STOPS))
        self.variant = "abs"   # brut, ou net de la moyenne du panel
        self.pente = 0.0       # ce que la réalité multiplie à l'annonce
        self.se_pente = float("inf")   # et ce que vaut cette mesure
        self.ecart_sortant = float("nan")  # marge gagnante - sortante
        self.pente_brut = 0.0  # la meme, sur un rendement non stoppe
        self.part_courte = 0.0  # part de trades COURTS du holdout
        self.part_suite = 0.0  # part de declenchements qui PROLONGENT
        self.stop_sig = 3.0    # stop retenu, en sigmas de l'horizon tenu
        self.stop_mode = "fixe"  # "fixe" ou "suiv" (suiveur)
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
            "net_defl": self.net_defl,
            "family": self.family,
            "thr_bps": self.thr_bps, "thr_k": self.thr_k,
            "profil": list(self.profil),
            "n_trades": self.n_trades,
            # Ce que la cellule rapporterait PAR JOUR, et non par trade.
            # La porte classe par MARGE, c est-a-dire par certitude que
            # l avantage est reel — ce qui est son travail. Mais entre
            # deux cellules qui passent toutes les deux, ce n est pas le
            # meme critere que « laquelle gagne le plus » : une cellule
            # qui trade quatre fois plus souvent pour la moitie de
            # l avantage rapporte deux fois plus, et se prouve quatre fois
            # plus vite.
            #
            # Mesure du 25 aout : le seuil retenu est monte a 3-4 sigma et
            # le rythme des fermetures est tombe de 1,5 a 0,29 par heure.
            # A 3 sigma sur vingt jambes il sort 0,054 declenchement par
            # instant — une position toutes les dix-neuf occasions ; a
            # 4 sigma, une sur 789. C est l explication arithmetique de
            # « une seule position a la fois ».
            #
            # On PUBLIE avant de changer quoi que ce soit : si la cellule
            # de plus grande marge n est pas la meilleure payeuse, cela se
            # lira ici, et ce sera un fait mesure plutot qu une intuition.
            "par_jour": self.par_jour,
            "gain_jour_bps": self.par_jour * self.net_defl,
            "horizon_bars": self.horizon_bars,
            "n_assets": self.n_assets, "n_periods": self.n_periods,
            "variant": self.variant, "pente": self.pente,
            "se_pente": self.se_pente,
            "ecart_sortant": self.ecart_sortant,
            "pente_brut": self.pente_brut,
            "part_courte": self.part_courte,
            "part_suite": self.part_suite,
            "stop_sig": self.stop_sig, "stop_mode": self.stop_mode,
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
        prep = []
        for c, btc in series:
            if c is None or len(c) < 250:
                continue
            prep.append({"c": c, "btc": btc, "X": feat_matrix(c),
                         "sig": _sigma(c),
                         "ts": np.asarray(c.ts, dtype=np.int64)})
        # Le facteur de marche est la moyenne du panel privee de soi ; BTC
        # ne sert de repli que lorsqu il n y a personne d autre.
        refs = _mkt_series([(p["ts"], p["X"][:, col("r1")]) for p in prep])
        blocs = []
        for p, mk in zip(prep, refs):
            blocs.append({"c": p["c"],
                          "X": croise(p["X"], _br_serie(p["c"], p["btc"]), mk),
                          "sig": p["sig"], "ts": p["ts"]})
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
        # De COMBIEN la sortante est-elle derriere ? Le journal publiait la
        # marge de la GAGNANTE et jamais celle de la sortante, si bien que
        # la question « la bande d hysteresis est-elle a la bonne largeur »
        # n etait pas decidable sur les donnees publiees.
        #
        # Elle est loin d etre theorique. Compte le 27 aout : sur douze
        # verdicts 1m consecutifs, le mot « gardee » n apparait que QUATRE
        # fois — la cellule change d identite deux fois sur trois, vit 1,5
        # ajustement, et le rodage en exige trente fermetures, soit une
        # quinzaine de changements de regle avant d avoir de quoi juger.
        # `live_rule` ne mesure donc jamais UNE regle.
        #
        # La bande vaut `1/racine(n_per)`, l erreur type d un Sharpe AU
        # SEIN d un ajustement. Ce qu il faudrait comparer, c est la
        # dispersion des marges ENTRE ajustements — une autre quantite,
        # qui inclut le bruit de selection du maximum sur 4 860 cellules.
        # On journalise l ecart pour pouvoir l estimer ; on ne touche a
        # rien avant.
        self.ecart_sortant = float("nan")
        if sortant is not None and meilleur is not None:
            self.ecart_sortant = float(meilleur["marge"] - sortant["marge"])
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
            # Le suiveur ne se deduit pas des excursions extremes : il
            # depend de l ORDRE des barres. Son issue se calcule donc ici,
            # une fois par actif, par largeur et par sens — colonne 0 pour
            # un long, colonne 1 pour un court.
            nb = len(bl["c"])
            st = np.zeros((nb, len(LARGEURS), 2), dtype=bool)
            sgn = np.zeros((nb, len(LARGEURS), 2))
            for j, ks in enumerate(LARGEURS):
                for col, sn in ((0, 1), (1, -1)):
                    t_, g_ = _suiveur(bl["c"], h, ENTREE_DECALEE, ks * sg, sn)
                    st[:, j, col] = t_
                    sgn[:, j, col] = np.nan_to_num(g_, nan=0.0)
            parts.append({"X": bl["X"], "ts": bl["ts"], "idx": idx, "sg": sg,
                          "y": y_r, "up": y_up, "dn": y_dn,
                          "st": st, "sg_suiv": sgn})
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
        sto, sgo2 = [], []
        # Quel INSTRUMENT porte chaque instant du holdout. Les
        # series sont empilees par nom puis par pli, et rien ne
        # disait de qui venait quelle ligne — or « ce declenchement
        # prolonge-t-il le precedent » n a de sens que POUR UN MEME
        # NOM. Sans cette etiquette, deux noms differents se
        # suivraient dans le temps et passeraient pour une reprise.
        insto: list = []
        for k in range(FOLDS):
            t0, t1 = bornes[k], bornes[k + 1]
            if t1 <= t0:
                continue
            Xtr, ytr, Xte, yte, sgte, tste = [], [], [], [], [], []
            upte, dnte, stte, sgte2 = [], [], [], []
            inste: list = []
            # Le pas d echantillonnage se calcule sur le pli entier, pour
            # que chaque actif soit reduit dans la MEME proportion : un pas
            # par actif donnerait plus de poids aux historiques courts.
            # L embargo est EXACTEMENT ajuste, et l inegalite stricte y
            # est pour quelque chose — ne pas la « corriger ».
            #
            # Avec `lag = 0`, l etiquette de l indice i va de l OUVERTURE de
            # la barre i+1 a la CLOTURE de la barre i+h : elle se termine
            # donc a ts[i] + (h+1) x pas. On pourrait croire qu il faut
            # exiger ts[i] <= t0 - (h+1) x pas. Mais les horodatages sont
            # sur une grille de pas constant, et `< t0 - h x pas` admet au
            # plus ts[i] = t0 - (h+1) x pas : l etiquette se termine alors
            # a t0 PILE, c est-a-dire a l ouverture de la premiere barre de
            # test, sans jamais la traverser.
            #
            # Verifie en essayant de le durcir : passer a (h+1) retire une
            # barre d entrainement de plus sans retirer la moindre fuite.
            # Un test ancre l ajustement exact dans les deux sens.
            brut = sum(int((p["ts"][p["idx"]] < t0 - h * pas).sum())
                       for p in parts)
            saut = max(1, -(-brut // BUDGET_TRAIN))
            for i_part, p in enumerate(parts):
                ts, idx, sg = p["ts"], p["idx"], p["sg"]
                # embargo : une étiquette d'entraînement dont la fenêtre de
                # h barres traverse la frontière a vu le pli de test.
                tr = idx[ts[idx] < t0 - h * pas][::saut]
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
                inste.append(np.full(len(te), i_part, dtype=np.int32))
                upte.append(p["up"][te] * 1e4)
                dnte.append(p["dn"][te] * 1e4)
                stte.append(p["st"][te])
                sgte2.append(p["sg_suiv"][te] * 1e4)
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
            insto.append(np.concatenate(inste))
            upo.append(np.concatenate(upte))
            dno.append(np.concatenate(dnte))
            sto.append(np.concatenate(stte))
            sgo2.append(np.concatenate(sgte2))
            del Xtr, Xte
        if not yho:
            return None
        yho = np.concatenate(yho)
        sgo, tso = np.concatenate(sgo), np.concatenate(tso)
        upo, dno = np.concatenate(upo), np.concatenate(dno)
        sto, sgo2 = np.concatenate(sto), np.concatenate(sgo2)
        insto = np.concatenate(insto)
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
            ic_abs = _ic(p_bps, yho)
            ic = ic_abs
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
                # L ic doit etre celui de la serie REELLEMENT choisie.
                # Il etait calcule une fois sur `p_bps`, donc sur la
                # variante « abs », et journalise tel quel meme quand la
                # cellule retenue etait « neu » — le verdict du 27 aout
                # affichait « [ridge/h6/neu] ic=0.010 » pour un ic qui
                # decrivait une autre serie. Toute comparaison d ic entre
                # deux ajustements dont la variante a change comparait
                # alors deux choses differentes, et c est avec cet ic-la
                # que je jugeais si des colonnes neuves payaient.
                #
                # Ce n est pas un assouplissement : la porte teste
                # `ic > 2/racine(n)`, et elle doit le tester sur la serie
                # qu elle selectionne. La tester sur une autre etait
                # simplement faux, dans un sens comme dans l autre.
                ic = _ic(pv, yho) if var != "abs" else ic_abs
                sd_v = float(np.std(pv))
                for mode, ks in STOPS:
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
                        # La part de trades COURTS du holdout.
                        #
                        # « Il doit trader les mouvements long ET short »,
                        # et rien ne permettait de le verifier : le
                        # journal ne dit ni le sens des trades mesures, ni
                        # celui des jambes annoncees. Un releve du 27 aout
                        # montrait dix-huit jambes toutes longues, sans
                        # qu on puisse savoir si c est un moment ou un
                        # biais.
                        #
                        # Ce n est PAS du beta deguise — la cellule
                        # declenche sur 2,6 % des barres, donc elle choisit
                        # ses moments et n est pas « toujours longue ».
                        # Mais une regle qui ne prendrait JAMAIS le sens
                        # court ne repondrait qu a la moitie de ce qu on
                        # lui demande, et c est une chose qui se compte.
                        part_courte = (float(np.mean(sens < 0))
                                       if len(sens) else 0.0)
                        if mode == "suiv":
                            # Le suiveur a ete simule barre par barre, dans
                            # les deux sens : on lit l issue du sens joue.
                            j = LARGEURS.index(ks)
                            col = (sens < 0).astype(int)
                            lig = np.arange(len(sens))
                            touche = sto[m][lig, j, col]
                            gains = sgo2[m][lig, j, col]
                            net = gains - np.where(
                                touche, self.fee,
                                np.where(gains > 0, c_win, self.fee))
                            pnl, rq = _agreger(net, tso[m], sgo[m])
                            n_per = len(pnl)
                            if n_per < MIN_TRADES:
                                continue
                            # `sd` reste en BPS : c est lui qui nourrit
                            # Kelly cote moteur. `sr` se juge en unites de
                            # risque, parce que c est le livre reellement
                            # tenu — voir _en_risque.
                            sd = float(np.std(pnl, ddof=1))
                            sdr = float(np.std(rq, ddof=1))
                            sr = float(np.mean(rq)) / sdr if sdr > 1e-12 else 0.0
                            barre = expected_max_sharpe(self.n_cells, n_per)
                            marge = sr - barre
                            mu = float(np.mean(net))
                            # Contre ce que la strategie REALISE, pas
                            # contre `yho` qu elle ne connait pas — voir
                            # _pente_et_erreur.
                            pente, se_pente = _pente_et_erreur(
                                pv[m], sens * gains)
                            pente_brut, _ = _pente_et_erreur(pv[m], yho[m])
                            cle = (1 if mu > 0 else 0, marge)
                            ident = (fam, h, float(k), var, mode, float(ks))
                            cellule = {
                                "fam": fam, "rr": rr, "nn": nn, "up": up,
                                "dn": dn, "h": h, "pred": pv[m], "y": yho[m],
                                "ts_tr": tso[m], "inst_tr": insto[m],
                                "sens_tr": sens,
                                "ic": ic, "thr": thr, "n_tr": n_tr,
                                "n_per": n_per, "var": var, "ident": ident, "k": float(k),
                                "stop": float(ks), "mode": mode,
                                "n_hold": len(yho), "n_train": n_train,
                                "bps": mu, "sr": sr, "cle": cle, "sd": sd,
                                "barre": barre, "marge": marge, "pente": pente,
                                "se_pente": se_pente,
                                "pente_brut": pente_brut,
                                "part_courte": part_courte,
                            "part_courte": part_courte,
                            }
                            if best is None or cle > best["cle"]:
                                best = cellule
                            if ident == self._precedent:
                                sortant = cellule
                            continue
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
                        pnl, rq = _agreger(net, tso[m], sgo[m])
                        n_per = len(pnl)
                        if n_per < MIN_TRADES:
                            continue
                        # `sd` en bps pour Kelly, `sr` en unites de risque
                        # pour la selection — voir _en_risque.
                        sd = float(np.std(pnl, ddof=1))
                        sdr = float(np.std(rq, ddof=1))
                        sr = float(np.mean(rq)) / sdr if sdr > 1e-12 else 0.0
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
                        # Contre ce que la strategie REALISE, pas contre
                        # `yho` qu elle ne connait pas — voir _pente_et_erreur.
                        pente, se_pente = _pente_et_erreur(pv[m], sens * gains)
                        pente_brut, _ = _pente_et_erreur(pv[m], yho[m])
                        cle = (1 if mu > 0 else 0, marge)
                        ident = (fam, h, float(k), var, mode, float(ks))
                        cellule = {
                            "fam": fam, "rr": rr, "nn": nn, "up": up, "dn": dn,
                            "h": h, "pred": pv[m], "y": yho[m], "ic": ic,
                            "ts_tr": tso[m], "inst_tr": insto[m],
                            "sens_tr": sens,
                            "thr": thr, "n_tr": n_tr, "n_per": n_per,
                            "var": var, "ident": ident, "stop": float(ks), "k": float(k),
                            "mode": mode,
                            "n_hold": len(yho), "n_train": n_train,
                            "bps": mu, "sr": sr, "cle": cle, "sd": sd,
                            # Porter la serie coute quelques centaines de
                            # flottants ; calculer le profil pour trois
                            # mille cellules couterait le balayage. Seule
                            # la cellule retenue est profilee.
                            #
                            # C est la serie EN RISQUE qu on porte, pas
                            # celle en bps : le profil par tiers est un
                            # Sharpe, et il doit se lire dans les memes
                            # unites que le `sr` global qu il decompose.
                            "pnl": rq,
                            "barre": barre, "marge": marge, "pente": pente,
                            "se_pente": se_pente,
                            "pente_brut": pente_brut,
                            "part_courte": part_courte,
                        }
                        if best is None or cle > best["cle"]:
                            best = cellule
                        if ident == self._precedent:
                            sortant = cellule
            # Aucun seuil ne déclenche assez souvent pour cette famille :
            # on retient quand même l'ic, sinon le refus se raconte avec un
            # ic=0.000 qui n'est pas le sien et le lecteur ne peut pas
            # distinguer « aucun signal » de « signal trop petit à payer ».
            # Le repli garde l ic de la serie BRUTE : il repond a
            # « le modele predit-il quoi que ce soit », question qui ne
            # depend pas de la variante. Depuis que `ic` est reaffecte
            # dans la boucle des variantes, le lire ici prendrait la
            # derniere variante essayee, ce qui ne veut rien dire.
            if abs(ic_abs) > abs(muet.get("ic", 0.0)):
                muet.update({"ic": ic_abs, "fam": fam, "h": h})
        if best is not None:
            best["sortant"] = sortant
        return best

    def _retenir(self, b: dict, c_win: float) -> dict:
        """Adopte l'horizon, la famille et le seuil gagnants."""
        self.family, self.horizon_bars = b["fam"], b["h"]
        self.variant = b.get("var", "abs")
        self.ident = b.get("ident")
        self.pente = float(b.get("pente") or 0.0)
        self.se_pente = float(b.get("se_pente") or float("inf"))
        self.pente_brut = float(b.get("pente_brut") or 0.0)
        self.part_courte = float(b.get("part_courte") or 0.0)
        # La part des declenchements qui prolongent le precedent, calculee
        # POUR LA SEULE CELLULE RETENUE : la porter sur les 4 860 cellules
        # couterait le balayage, et la question ne se pose que pour celle
        # qui va trader.
        self.part_suite = _part_prolongee(
            b.get("ts_tr"), b.get("inst_tr"), b.get("sens_tr"),
            float(BAR_MS.get(self.bar, 60_000)), int(b.get("h") or 1))
        self.stop_sig = float(b.get("stop") or 3.0)
        # Le MODE du stop fait partie de la regle validee au meme titre que
        # sa largeur. Le laisser derriere ferait jouer un stop fixe la ou la
        # porte a mesure un suiveur — donc une autre regle que celle qui a
        # ete prouvee, exactement le defaut corrige sur la largeur.
        self.stop_mode = str(b.get("mode") or "fixe")
        self.rr, self.nn, self.up, self.dn = b["rr"], b["nn"], b["up"], b["dn"]
        self.ic = b["ic"]
        self.profil = _profil(b.get("pnl", np.zeros(0)))
        # Frequence et rendement quotidien de la cellule retenue.
        #
        # DEUX facteurs manquaient, et il a fallu deux passes pour les
        # trouver tous les deux.
        #
        # Le PANEL : `n_hold` compte les lignes du holdout de tout le
        # panel. Vingt actifs qui partagent la meme horloge donnent vingt
        # lignes par barre, pas vingt barres.
        #
        # L AMINCISSEMENT : le holdout ne garde qu une barre sur h
        # (etiquettes non chevauchantes). Les lignes gardees ne sont donc
        # pas les barres ECOULEES — il en manque h-1 sur h entre chacune.
        #
        # La premiere correction seule donnait 348 declenchements par jour
        # au 1m, ce qui est impossible : a six minutes d ecart il n en
        # tient que 240 dans une journee. C est ce plafond arithmetique qui
        # a revele le second facteur.
        #
        # Recoupement, la seule facon de savoir que la formule est juste :
        # la duree du holdout doit valoir 60 % de l histoire chargee
        # (DEBUT_TEST = 0,40). Au 1m elle donne 37,3 jours, soit 62,1
        # d histoire pour 62 stockes ; au 3m 38,1 jours, soit 63,6 pour 60.
        # Au 15m elle donne 310 jours, soit 516 impliques pour 365 charges
        # — ce recoupement-la ne tombe PAS juste et la raison n est pas
        # etablie ; on l ecrit plutot que d ajuster la formule pour qu elle
        # tombe bien.
        pas_min = BAR_MS[self.bar] / 60_000.0
        gardees = float(b.get("n_hold") or 0) / max(int(self.n_assets), 1)
        barres = gardees * max(int(b.get("h") or 1), 1)
        jours = max(barres * pas_min / 1440.0, 1e-9)
        self.par_jour = float(b.get("n_per") or 0) / jours
        self.thr_bps = float(b["thr"])
        # Le seuil EN SIGMAS, pas seulement en bps : c est lui qui dit si
        # la grille est tronquee au bon endroit. Un optimum qui colle a la
        # derniere valeur cherchee signale une grille trop courte, et le
        # chiffre en points de base ne peut pas le reveler.
        self.thr_k = float(b.get("k") or 0.0)
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
        # Le net DÉFLATÉ : ce que la cellule rapporte une fois ôtée la part
        # que la seule sélection aurait produite.
        #
        # La barre était déduite pour DÉCIDER (sr > barre) et jamais pour
        # DIMENSIONNER : la taille partait du net brut, c'est-à-dire du
        # maximum d'une recherche sur ~1300 cellules. Or Kelly est
        # proportionnel à mu. Mesuré sur douze ajustements de l'horloge 1m :
        # net brut moyen +14,66 bps/trade, net déflaté +2,97 — et le direct,
        # sur 22 trades, +3,74. Le déflaté prédit le direct à moins d'un bps
        # près, le brut le surestime d'un facteur cinq. C'est tout l'écart
        # entre la porte et le réel, et il valait cinq fois trop de risque.
        #
        # Le Sharpe étant invariant d'échelle, retrancher la barre en Sharpe
        # revient à multiplier le net par marge/sr.
        #
        # Cette déflation remplace la borne basse à une erreur type, elle ne
        # s'y ajoute pas : `barre` vaut déjà ~3,3 erreurs types (elle est
        # l'espérance du MAXIMUM de n_cells tirages de bruit, et décroît
        # comme 1/racine(n) exactement comme l'erreur type). Les cumuler
        # retrancherait quatre fois le même bruit et rendrait un mu négatif
        # sur dix ajustements sur douze — la règle cesserait de trader, donc
        # de se mesurer.
        sr_, marge_ = float(b["sr"]), float(b["marge"])
        self.net_defl = (float(self.holdout_bps) * marge_ / sr_
                         if sr_ > 1e-12 and marge_ > 0.0 else 0.0)
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
            "stop_mode": self.stop_mode,
            "net_bps": self.holdout_bps, "net_sd": self.hold_sd,
            "net_defl": self.net_defl,
            "net_n": self.n_periods,
            "q_bps": self.q * 1e4, "veto": veto, "bar": self.bar,
            "horizon_bars": self.horizon_bars, "variant": self.variant,
            "status": self.status, "ic": self.ic,
        }


def croise(X: np.ndarray, br: np.ndarray | None = None,
           mkt: np.ndarray | None = None) -> np.ndarray:
    """Les colonnes croisées, construites UNE fois pour les deux chemins.

    Trois colonnes, et chacune dit une chose que les deux autres ne disent
    pas : le retour BTC CONTEMPORAIN (le meneur), le RÉSIDU de cet actif —
    mesuré contre la moyenne du panel privée de soi quand elle existe,
    contre BTC sinon — et le retour BTC de la barre PRÉCÉDENTE.

    L'horloge ne voyait du reste du marché que le retour BTC contemporain
    et le résidu de cet actif par rapport à lui. Or le décalage BTC ->
    alts à l'échelle de la minute vit dans la barre PRÉCÉDENTE de BTC, et
    elle n'était nulle part. A/B sur panel synthétique avec un lead-lag
    planté à 0,25 sigma : sans cette colonne 0 horloge sur 4 passe la
    porte, ic +0,018, marge négative ; avec elle 4 sur 4, ic +0,23. Sur du
    bruit pur, les deux refusent toujours 4 fois sur 4 — la colonne ne
    fabrique pas de signal, elle en révèle un.

    UNE colonne, pas sept. Les retards 2 et 3, la poussée cumulée et le
    résidu retardé ont été essayés ensemble : ils n'ajoutent RIEN au
    lead-lag — 3/3 avec comme sans. C'est cette absence de BÉNÉFICE qui
    les tient dehors, et rien d'autre.

    Ce paragraphe portait aussi un coût — « la famille retenue tombe de 5
    succès sur 6 à 2 », d'où la conclusion que quatre colonnes de bruit
    suffiraient à casser une règle vraie. C'était FAUX, et l'erreur vaut
    d'être gardée : la mesure venait d'une fixture de 2 400 barres. Refaite
    proprement, en ajoutant k colonnes de pur bruit à la matrice :

               k=0    k=2    k=4    k=8
      2 400    5/6    4/6    5/6    5/6
      6 000    6/6    6/6    6/6    6/6

    A 2 400 barres le compte oscille sans tendance en k — c'est du bruit
    d'échantillonnage qu'on lisait comme un coût. A 6 000, la matrice
    absorbe HUIT colonnes inutiles sans rien perdre. En production elle
    voit des centaines de milliers de lignes.

    Conséquence pratique : le budget de colonnes est large. Une idée
    prometteuse ne doit pas être écartée sur un coût mesuré trop court —
    elle doit l'être quand elle n'apporte rien, ce qui reste le cas de ces
    quatre-là.

    Tout est en sigmas de CET actif, comme le reste de la matrice, pour
    que six actifs puissent nourrir la même horloge. Toutes les colonnes
    sont strictement causales : la barre i est close quand on prédit i+1.

    Quand BTC manque — pour BTC lui-même, ou si la série est trop courte —
    les colonnes valent zéro : une information absente ne doit pas se
    distinguer d'une information nulle. C'est aussi ce qui garantit que
    l'entraînement et la prédiction voient exactement la même chose : les
    deux chemins passent par cette fonction, jamais par deux empilements
    écrits séparément.
    """
    n = len(X)
    if br is None and mkt is None:
        return np.column_stack([X, np.zeros((n, N_CROISE))])
    z = np.zeros(n)
    br = z if br is None else np.clip(
        np.nan_to_num(np.asarray(br, dtype=np.float64), nan=0.0), -6.0, 6.0)
    # Le RESIDU se mesure contre la moyenne du panel quand elle existe,
    # contre BTC sinon. Une seule colonne dans les deux cas : on remplace
    # un estimateur par un meilleur, on n en ajoute pas un second.
    ref = br if mkt is None else np.clip(
        np.nan_to_num(np.asarray(mkt, dtype=np.float64), nan=0.0), -6.0, 6.0)
    xs = np.clip(X[:, 0] - ref, -6.0, 6.0)

    def d(x, k):
        out = np.zeros(n)
        if n > k:
            out[k:] = x[:-k]
        return out

    return np.column_stack([X, br, xs, d(br, 1)])


def _br_serie(c: Candles, btc: Candles | None) -> np.ndarray | None:
    """Le retour BTC barre à barre, aligné sur c, en sigmas de c."""
    n = len(c)
    if btc is None or len(btc) < n or n < 2:
        return None
    bp = np.asarray(btc.c, dtype=np.float64)[-n:]
    if len(bp) != n:
        return None
    br = np.zeros(n)
    br[1:] = np.where(bp[:-1] > 0, bp[1:] / bp[:-1] - 1.0, 0.0)
    return br / _sigma(c)


def _mkt_series(grilles: list) -> list:
    """La moyenne du panel PRIVEE DE SOI, alignee sur chaque actif.

    L horloge ne voyait du reste du marche que BTC. C est un mauvais
    facteur des que le panel compte vingt jambes, et pour une raison
    precise : BTC porte son propre mouvement idiosyncratique, souvent le
    plus gros du panel. Retrancher BTC laisse donc e_i - e_btc, domine par
    le bruit de BTC ; retrancher la moyenne des dix-neuf autres laisse
    e_i - bruit/racine(19). Ce residu-la EST la quantite tradable de la
    litterature transversale crypto — « ce que ce nom a fait de plus que
    le marche », dont la reversion a court horizon est l effet le mieux
    etabli du domaine.

    Mais elle ne REMPLACE pas BTC, elle remplace seulement le RESIDU.
    BTC contemporain est un MENEUR : son mouvement d aujourd hui predit
    celui des alts demain. La moyenne du panel est faite d alts, donc deja
    en retard d une barre — elle ne peut pas porter cette information-la.
    Le fixture de lead-lag l a montre sans ambiguite : remplacer BTC par
    la moyenne fait tomber la porte de 2/2 a 0/2. Les deux quantites
    disent des choses differentes ; on garde le meneur et on ameliore
    l estimateur du residu, a nombre de colonnes CONSTANT — idio (contre
    BTC) devient xs (contre le panel).

    Mesure, panel synthetique de huit actifs a facteur commun, reversion
    plantee sur la part idiosyncratique, BTC portant trois fois l idio des
    autres. Trois variantes, deux fixtures :

                          lead-lag   reversion k=0,60      k=0,25
      BTC seul (avant)      2/2      ic +0,2242 m +0,3437  ic +0,0847 m -0,2919
      panel a la place      0/2      ic +0,3167 m +0,3749  ic +0,1467 m -0,1908
      BTC + residu panel    2/2      ic +0,3047 m +0,3261  ic +0,1325 m -0,2130

    Le retenu prend 85 % du gain d ic sans rien perdre du lead-lag. A
    k=0,60 sa marge est un cheveu SOUS celle de BTC seul (-0,018) — un
    regime ou tout passe largement ; a k=0,25, le regime marginal qui est
    celui de la production, elle est meilleure de +0,079. C est l ordre de
    grandeur de la marge mesuree en direct (0,035).

    Contre-epreuve sur bruit pur, meme protocole : 0/3 partout, ic -0,006
    a -0,026. Aucune de ces colonnes ne fabrique d avantage.

    PRIVEE DE SOI, et ce n est pas un detail : inclure l actif dans sa
    propre moyenne retrecit mecaniquement son residu d un facteur (N-1)/N
    et melange sa cible a son entree.

    L alignement se fait sur les HORODATAGES et non sur les index — deux
    actifs d historiques differents n ont pas la meme longueur, et un
    alignement par la fin ferait lire a l un la barre de l autre.
    """
    if len(grilles) < 2:
        return [None] * len(grilles)
    tous = np.unique(np.concatenate([t for t, _ in grilles]))
    somme = np.zeros(len(tous))
    compte = np.zeros(len(tous))
    places = []
    for t, u in grilles:
        p = np.searchsorted(tous, t)
        places.append(p)
        somme[p] += u          # horodatages uniques au sein d un actif
        compte[p] += 1.0
    out = []
    for (t, u), p in zip(grilles, places):
        autres = compte[p] - 1.0
        out.append(np.where(autres > 0.5,
                            (somme[p] - u) / np.maximum(autres, 1.0), 0.0))
    return out


def _row(c: Candles, btc: Candles | None) -> np.ndarray:
    X = feat_matrix(c)
    # exactement le chemin de l'entraînement, sur les mêmes tableaux :
    # une colonne construite ici et pas là-bas serait un décalage muet
    return croise(X, _br_serie(c, btc))[-1]


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
                     f"seuil={d['thr_bps']:.1f}bps/{d.get('thr_k', 0.0):.1f}sig "
                     f"stop={d['stop_sig']:.0f}sig/{d.get('stop_mode', 'fixe')} "
                     f"pente={d['pente']:.2f}"
                     + (f"+-{d['se_pente']:.2f}"
                        if np.isfinite(d.get("se_pente", float("inf")))
                        else "+-?")
                     + f"(brut {d.get('pente_brut', 0.0):+.2f})" 
                     # Une pente negative rend un shrink nul, et un shrink
                     # nul rend une cellule INERTE : elle gagne la
                     # recherche, en bloque toutes les autres, et ne
                     # produit jamais une prediction tradable. Le dire ici
                     # est la seule facon de savoir a quelle frequence la
                     # recherche couronne une cellule que le moteur
                     # refusera de dimensionner.
                     + (" INERTE(shrink=0)"
                        if d.get("status") == "live"
                        and float(d.get("alpha") or d.get("shrink") or 0.0) <= 0.0
                        else "") + " "
                     + (("profil=" + "/".join(f"{x:+.2f}"
                                              for x in d.get("profil") or ())
                        + " ") if d.get("profil") else "")
                     + f"{'gardee ' if d.get('garde') else ''}"
                     # L ecart au sortant, et la bande qui le tranche :
                     # sans les deux cote a cote on ne peut pas savoir si
                     # la bande est a la bonne largeur.
                     + ((f"ecart={d['ecart_sortant']:+.3f}"
                         f"/bande={1.0 / math.sqrt(max(d['n_periods'], 1)):.3f} ")
                        if d.get("ecart_sortant") == d.get("ecart_sortant")
                        else "")
                     + f"court={100.0 * d.get('part_courte', 0.0):.0f}% "
                     # La part des declenchements qui PROLONGENT le
                     # precedent, a comparer aux 39-54 % mesures EN DIRECT
                     # sur les reprises de jambe. Si les deux se
                     # ressemblent, la porte facture deja ces
                     # allers-retours ; sinon le moteur rouvre plus
                     # souvent que la regle validee.
                     + (f"suite={100.0 * d['part_suite']:.0f}% "
                        if d.get("part_suite") is not None else "")
                     + f"trades={d['n_trades']}/{d['n_holdout']} "
                     f"instants={d['n_periods']} n={d['n_train']} "
                     f"parjour={d.get('par_jour', 0.0):.1f} "
                     f"gainjour={d.get('gain_jour_bps', 0.0):+.0f}bps")
        self.fit_at = time.time()
        self.log(f"desk live={self.live_bars() or ['none']}")
        return out

    def live_bars(self) -> list[str]:
        return sorted({bar for (inst, bar), m in self.models.items() if m.status == "live"})

    def vote_panel(self, bar: str, candles: dict, btc: Candles | None) -> None:
        """Tout le panel vote d un coup, sur le MEME facteur de marche.

        Le vote se faisait actif par actif, chacun ne voyant que BTC. Or
        l horloge est desormais entrainee contre la moyenne du panel
        privee de soi : voter contre BTC jouerait une regle que personne
        n a validee — le decalage le plus silencieux qui soit, puisque
        rien ne planterait et que les chiffres resteraient plausibles.

        La matrice de chaque actif n est calculee QU UNE FOIS : c est
        exactement le travail que _row faisait deja par actif, redistribue.
        """
        noms = [i for i, c in (candles or {}).items()
                if c is not None and len(c) >= 20]
        mats = {i: feat_matrix(candles[i]) for i in noms}
        refs = _mkt_series([(np.asarray(candles[i].ts, dtype=np.int64),
                             mats[i][:, col("r1")]) for i in noms])
        for i, mk in zip(noms, refs):
            c = candles[i]
            m = self.models.get((i, bar))
            if m is None:
                self.votes[(i, bar)] = {
                    "r_bps": 0.0, "up_bps": 0.0, "dn_bps": 0.0, "q_bps": 0.0,
                    "veto": True, "bar": bar, "status": "unfitted", "ic": 0.0}
                continue
            br = _br_serie(c, None if i.startswith("BTC-") else btc)
            self.votes[(i, bar)] = m.predict_row(
                croise(mats[i], br, mk)[-1], float(_sigma(c)[-1]))

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
            "net_defl": float(dom.get("net_defl") or 0.0),
            "net_n": int(dom.get("net_n") or 0),
            # le garde-fou EST celui qui a été mesuré, pas un autre
            "stop_mesure": float(dom.get("stop_bps") or 0.0),
            "stop_mode": str(dom.get("stop_mode") or "fixe"),
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