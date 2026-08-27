"""The dashboard is the product's face. These guard what regressed before.

It had drifted into franglais — "Activity log" beside "Aucune position",
"Drawdown from peak" beside "Stop jour" — and it reported a phantom -100%
when the engine had simply not started yet.
"""

import os
import re

import pytest

HTML = os.path.join(os.path.dirname(__file__), "..", "hermes", "dashboard",
                    "index.html")


@pytest.fixture(scope="module")
def page():
    with open(HTML, encoding="utf-8") as f:
        return f.read()


def _visible_text(html: str) -> str:
    """Everything a user reads: element text, plus the strings the script
    writes into the DOM.

    Script blocks are stripped before reading element text, and quoted
    strings are kept only when they can plausibly reach the screen — a
    phrase (it has a space) or a capitalised word. That excludes selectors
    and field names like ``$("equity")`` or ``d.equity_live``, which are
    code, not copy.
    """
    body = html.split("<body", 1)[1]
    scripts = re.findall(r"<script[\s\S]*?</script>", body)
    markup = re.sub(r"<script[\s\S]*?</script>", " ", body)
    markup = re.sub(r"<[^>]*>", " ", markup)
    parts = [markup]
    for sc in scripts:
        for lit in re.findall(r'"([A-Za-zÀ-ÿ][^"]{2,60})"', sc):
            if " " in lit or lit[0].isupper():
                parts.append(lit)
    return " ".join(parts)


# L'interface parle français ; le JARGON de trading garde sa langue.
# « Drawdown », « Equity », « TP/SL », « mark-to-market » sont la langue du
# métier — les traduire (« Repli depuis le pic », « Équité », « Objectif /
# Stop ») gênait au lieu d'aider. Cette liste ne bannit donc que l'anglais
# d'INTERFACE : les phrases d'habillage qui, elles, ont un français naturel.
ANGLAIS = ["Activity log", "Alpha research", "Kill switch",
           "Live scan", "Log is empty", "No orders yet", "Deployed",
           "Genomes evaluated", "Take profit", "Stop loss",
           "Leverage", "Positions open", "Last pass", "Next pass",
           "capital weights", "firing", "gated", "last print",
           "Sharpe ratio", "Holdout", "Selection bar", "Evidence", "Trials"]


def test_no_english_left_on_screen(page):
    txt = _visible_text(page)
    found = [w for w in ANGLAIS if w.lower() in txt.lower()]
    assert not found, f"anglais restant dans l'UI : {found}"


def test_the_page_declares_itself_french(page):
    assert 'lang="fr"' in page


def test_an_absent_engine_is_not_a_total_loss(page):
    """equity 0 with no broker state must read as unknown, not as ruin."""
    assert "en attente du moteur" in page
    assert "n'est pas nulle : elle est inconnue" in page


def test_direction_is_never_colour_alone(page):
    """LONG / SHORT carry their own word beside the colour — the palette is
    a diverging blue/red pair, but colour still never decides alone."""
    assert "LONG" in page and "SHORT" in page
    assert "--long:" in page and "--short:" in page


def test_both_themes_define_the_full_palette(page):
    """Dark is the default; light is a selected palette, not a flip."""
    for jeton in ("--fond", "--surface", "--encre", "--long", "--short"):
        assert page.count(jeton + ":") >= 2, jeton


def test_the_flat_book_explains_which_constraint_binds(page):
    """'Pourquoi ça ne trade pas' has to be answerable from the screen."""
    assert "Corrélation requise" in page
    assert "aller-retour" in page
    for motif in ("cost", "no-ev", "veto", "wait"):
        assert f'"{motif}"' in page


def test_no_stray_template_placeholder(page):
    """A literal ${...} escaping into the markup is the classic template bug."""
    body = page.split("<body", 1)[1]
    markup = re.sub(r"<script[\s\S]*?</script>", "", body)
    assert "${" not in markup


# --- thème et lisibilité ------------------------------------------------ #

def test_the_light_palette_is_reachable_from_the_system_preference(page):
    """`data-theme="dark"` was hardcoded on <html>, so a viewer whose system
    asks for light got the dark page and no way to know a light one existed
    short of finding the toggle."""
    assert 'data-theme="dark"' not in page.split("<head", 1)[0]
    bloc = re.search(r"@media\s*\(prefers-color-scheme:\s*light\)\s*\{(.+?)\n\s*\}\s*\n\}",
                     page, re.S)
    assert bloc, "aucune règle ne suit la préférence système"
    for jeton in ("--fond", "--surface", "--encre", "--long", "--short"):
        assert jeton + ":" in bloc.group(1), jeton


def test_an_explicit_choice_still_wins_in_both_directions(page):
    """Following the system must not cost the viewer the ability to override
    it — the toggle has to beat the media query either way."""
    assert ':root[data-theme="light"]' in page
    assert ':root:not([data-theme="dark"])' in page


def _contraste(a, b):
    def lin(c):
        c /= 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    def lum(h):
        h = h.lstrip("#")
        r, g, bb = (int(h[i:i + 2], 16) for i in (0, 2, 4))
        return .2126 * lin(r) + .7152 * lin(g) + .0722 * lin(bb)

    la, lb = lum(a), lum(b)
    return (max(la, lb) + .05) / (min(la, lb) + .05)


def test_the_quietest_ink_still_clears_small_text_contrast(page):
    """--encre-3 carries the 10px measure labels and the legends. At 3.3:1 it
    was decoration, not text."""
    fonds = re.findall(r"--surface:(#[0-9a-fA-F]{6})", page)
    encres = re.findall(r"--encre-3:(#[0-9a-fA-F]{6})", page)
    assert fonds and encres
    for encre, fond in zip(encres, fonds):
        r = _contraste(encre, fond)
        assert r >= 4.5, f"{encre} sur {fond} : {r:.2f}:1"


def test_irregular_plurals_are_written_out(page):
    """« signal » fait « signaux ». Coller un s au singulier donnait
    « 2 signals prêts » — la faute est visible dans le titre du verdict,
    la première ligne que quiconque lit."""
    assert "signals" not in page
    assert "signaux prêts" in page and "signal prêt" in page


# --- graphe navigable --------------------------------------------------- #

def test_the_market_chart_ships_with_its_interactions(page):
    """Le graphe est un canvas piloté : zoom molette ancré au curseur,
    glisser à inertie, pincement, unités multiples, pagination arrière."""
    assert 'id="gc"' in page and 'id="gzone"' in page
    assert "touch-action:none" in page
    for geste in ('addEventListener("wheel"', 'addEventListener("pointerdown"',
                  'addEventListener("pointermove"', 'addEventListener("dblclick"'):
        assert geste in page, geste
    assert "has_more" in page and "before=" in page


def test_every_timeframe_the_server_offers_is_reachable(page):
    from hermes.dashboard.server import StateReader
    for tf in StateReader.TFS:
        assert f'["{tf}"' in page, tf


def test_time_axis_format_follows_the_visible_span(page):
    """130 chandelles d'une heure espacées de 25 h étiquetées 23:00, 00:00,
    01:00 se lisaient comme des heures consécutives d'une même nuit."""
    assert "porteeMs" in page
    assert page.count("porteeMs >") >= 2


def test_the_trading_jargon_keeps_its_own_language(page):
    """Le métier se lit en anglais même chez les traders francophones :
    imposer « Repli depuis le pic » ou « Objectif / Stop » obligeait à
    retraduire mentalement vers le terme que tout le monde emploie."""
    assert "Drawdown depuis le pic" in page
    assert "TP / SL" in page
    assert "mark-to-market" in page
    assert "Repli depuis le pic" not in page
    assert "Objectif / stop" not in page


def test_the_paper_badge_is_gone_but_real_money_still_announces_itself(page):
    """« PAPIER » à côté du nom était du bruit — le papier est l'état
    normal. Le mode réel, lui, doit continuer de s'annoncer."""
    assert ">papier<" not in page and "PAPIER" not in page
    assert '"réel"' in page


def test_chart_levels_never_ride_on_colour_alone(page):
    for etiquette in ('"ENTRÉE"', '"TP"', '"SL"'):
        assert etiquette in page, etiquette


def test_a_running_research_pass_explains_the_silence(page):
    """Un moteur volontairement à l'arrêt pendant la recherche affichait
    « Moteur sans données » — l'écran d'une panne. L'état des services est
    maintenant servi par l'API et la page le dit en toutes lettres."""
    assert "Recherche en cours" in page
    assert "démarrera tout seul" in page
    from hermes.dashboard.server import StateReader  # l'API le sert bien
    import inspect
    assert "services" in inspect.getsource(StateReader.snapshot)


def _html():
    import os
    ici = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(ici, "hermes", "dashboard", "index.html"),
              encoding="utf-8") as f:
        return f.read()


def test_a_position_shows_what_cannot_be_reconstructed_afterwards():
    """Le levier auquel une position a été prise et la marge qu'elle
    immobilise ne se retrouvent pas après coup : la cible du desk a changé
    depuis. L'écran montrait une position sans jamais les dire."""
    s = _html()
    for cle in ("b.lev", "b.margin", "b.hold_ms", "b.policy", "b.trail"):
        assert cle in s, f"la carte de position ignore {cle}"
    assert "sortie temps" in s, "la durée restante validée n'est pas affichée"
    assert ".chip{" in s and ".pchips{" in s


def test_the_engine_records_leverage_and_margin_on_every_position():
    """Contre-épreuve côté moteur : l'écran ne peut montrer que ce que le
    bracket porte."""
    import inspect
    from hermes.scalp.engine import ScalpEngine
    src = inspect.getsource(ScalpEngine._arm)
    for cle in ('"lev"', '"margin"', '"notional"', '"hold_ms"', '"policy"'):
        assert cle in src, f"_arm n'enregistre pas {cle}"


def test_the_main_page_answers_why_this_size_without_navigating():
    """Répondre à « pourquoi cette taille » demandait de naviguer entre
    trois onglets : l'equity ici, le frein là, le rodage nulle part. Les
    étages qui multiplient la taille sont maintenant montrés ensemble et
    dans l'ordre où ils s'appliquent, en tête de la page principale."""
    s = _html()
    i_band = s.index('id="bandeau"')
    i_graphe = s.index('id="gzone"')
    assert i_band < i_graphe, "le bandeau doit précéder le graphe"
    i_pos = s.index('id="positions"')
    assert i_pos < i_graphe, "les positions doivent précéder le graphe"
    for cle in ("frein_risque", "confiance", "live_rule", "retard_s"):
        assert cle in s, f"le bandeau ignore {cle}"
    assert "function rendreBandeau" in s and "rendreBandeau(d);" in s


def test_a_trailing_position_shows_the_trail_and_not_a_dead_stop():
    """Le suiveur REMPLACE le stop fixe. Afficher les deux ferait croire à
    deux garde-fous là où la règle validée n'en a qu'un."""
    s = _html()
    assert 'b.stop_mode === "suiv"' in s
    assert 'm(trail,"trail","TRAIL")' in s
    assert ".rail .marq.trail{" in s
    # l'échelle du rail suit le niveau ACTIF, pas un stop inerte
    assert "const bas = suiveur && isFinite(trail)" in s


def test_the_main_page_tells_the_whole_chain():
    """Une position seule ne dit pas si le desk voit dix occasions ou une,
    ni ce que les fermetures précédentes ont rapporté. La page principale
    montre désormais la chaîne entière : ce qu'il PRÉDIT, ce qu'il TIENT,
    ce qu'il a FERMÉ et gagné."""
    s = _html()
    for i in ("panel", "positions", "closes"):
        assert f'id="{i}"' in s, f"la page principale ignore {i}"
    # dans cet ordre, et tous avant le graphe
    assert s.index('id="panel"') < s.index('id="positions"') < \
           s.index('id="closes"') < s.index('id="gzone"')
    assert "function rendrePanel" in s and "function rendreClotures" in s
    assert "rendrePanel(d)" in s and "rendreClotures(d)" in s
    # les fermetures affichent leur RESULTAT, pas seulement un prix
    assert "x.net_bps" in s, "les fermetures n'affichent pas leur net"


def test_the_compact_tables_survive_a_narrow_screen():
    """Six colonnes sur un téléphone donnent une bouillie. Les colonnes
    accessoires disparaissent au lieu de comprimer les chiffres."""
    s = _html()
    assert "@media (max-width:560px)" in s
    i = s.index("@media (max-width:560px)")
    fin = s.index("}", s.index(".tab .poids,.tab .motif{display:none}", i))
    assert ".tab .poids,.tab .motif{display:none}" in s[i:fin + 200]


def test_the_page_says_where_the_money_went(page):
    """« Il fait n importe quoi » est une accusation sur l argent, et
    l equite seule ne peut ni la confirmer ni la refuter — elle ne dit pas
    si un recul vient du marche, des frais ou du financement.

    La page principale porte donc la decomposition, et elle la lit dans le
    livre du courtier plutot que de la recalculer a l ecran : deux
    arithmetiques separees finiraient par diverger, et c est exactement ce
    qui rendait le releve ininterpretable.
    """
    assert 'id="carte-livre"' in page, "pas de carte sur la page principale"
    assert "Où part l'argent" in page
    for cle in ("livre", "depart", "brut", "frais", "funding", "avant",
                "notionnel"):
        assert cle in page, f"le poste {cle} nest pas lu"
    # La carte vit dans la vue MARCHE, avant le graphe : la reponse ne
    # doit pas demander de naviguer.
    marche = page.split('id="vue-marche"', 1)[1].split("</section>", 1)[0]
    assert 'id="carte-livre"' in marche
    assert marche.index('id="carte-livre"') < marche.index('class="carte marche"')


def test_the_ledger_identity_is_closed_on_screen_not_approximated(page):
    """Le latent se DEDUIT de l identite plutot que de se lire ailleurs :
    equite moins depart, avant, brut, frais et financement. Si un poste
    manquait, l ecart apparaitrait dans le latent au lieu de disparaitre
    en silence — c est la propriete qui rend le bloc digne de confiance.
    """
    bloc = page.split("function rendreLivre", 1)[1].split("function rendrePositions", 1)[0]
    assert "eq - (dep + avant + brut + frais + fund)" in bloc, \
        "le latent nest plus le residu de lidentite"


def test_the_page_answers_why_the_positions_are_small(page):
    """« Pourquoi les gains et positions ont l air minuscules ? »

    La reponse existait a l ecran mais en pieces detachees : le frein sur
    une tuile, le rodage sur une autre, et la taille que l avantage seul
    justifierait — poids_plein — nulle part. Il fallait multiplier deux
    chiffres puis les comparer a un troisieme, absent. Le bandeau porte
    desormais le rapport en clair, avec les deux montants en dollars.
    """
    assert "Taille jouée" in page
    bloc = page.split("function rendreBandeau", 1)[1].split("function rendrePanel", 1)[0]
    assert "poids_plein" in bloc, "la taille pleine nest pas lue"
    assert "joue / plein" in bloc, "le rapport nest pas calcule"
    # les deux montants doivent etre en dollars, pas en poids abstraits
    assert bloc.count("usdt(") >= 2


def test_the_page_says_what_is_wrong_before_anything_else(page):
    """Deux defauts couteux — un levier bloque a x1, des tailles quarante
    fois trop petites — etaient VISIBLES sur cette page, et c est le
    proprietaire du compte qui les a vus, pas l ecran.

    « LEVIER x1,0 » affiche sans commentaire n apprend rien a qui ne sait
    pas deja que x1 est anormal. Le bandeau doit donc venir AVANT tout le
    reste, et nommer le probleme en toutes lettres.
    """
    assert 'id="alertes"' in page, "pas de bandeau danomalies"
    marche = page.split('id="vue-marche"', 1)[1].split("</section>", 1)[0]
    assert marche.index('id="alertes"') < marche.index('id="bandeau"'), \
        "les alertes passent apres le cockpit"
    assert marche.index('id="alertes"') < marche.index('id="carte-panel"')


def test_the_screen_renders_the_diagnosis_it_does_not_recompute_it(page):
    """Le moteur diagnostique, l ecran rend. Deux arithmetiques separees
    finiraient par se contredire — et c est precisement ce qui rend un
    tableau de bord ininterpretable.

    La seule exception est le moteur MUET : s il ne publie plus, son
    diagnostic est fige avec le reste et il ne peut pas se signaler
    lui-meme. Ce controle-la doit vivre a l ecran."""
    bloc = page.split("function rendreAlertes", 1)[1].split("function rendreBandeau", 1)[0]
    assert "scalp || {}).anomalies" in bloc, "lecran ne lit pas le diagnostic du moteur"
    assert "Moteur muet" in bloc, "le seul controle qui doit vivre ici manque"
    # aucun seuil metier recalcule ici : pas de comparaison de levier ni de
    # taille dans l ecran
    for interdit in ("lev_ech_min", "poids_plein", "round_trip"):
        assert interdit not in bloc, f"{interdit} recalcule a lecran"


def test_the_hourly_clock_is_not_invisible_on_screen(page):
    """« 1H » manquait à la liste des échelles de la carte des preuves.

    `const ordre = ["1m", "3m", "5m", "15m"]` — écrite à la main quand il
    n'y avait que quatre échelles, et jamais mise à jour quand le 1H a
    rejoint `BARS`. L'horloge horaire était donc INVISIBLE à l'écran
    depuis sa création.

    C'est exactement le même défaut que la clé « 1H » absente de
    `BAR_MS` côté moteur, et il a la même racine : une liste écrite à la
    main qui doit rester synchrone avec une autre. Le correctif ne se
    contente donc pas d'ajouter « 1H » — il prend l'ordre voulu PUIS tout
    ce que le moteur envoie, pour qu'une échelle neuve apparaisse même si
    personne ne pense à la rajouter ici.
    """
    assert '"1m", "3m", "5m", "15m", "1H"' in page, \
        "la liste des echelles ne contient toujours pas le 1H"
    assert '["1m", "3m", "5m", "15m"]' not in page, \
        "lancienne liste tronquee subsiste"
    # La partie qui compte vraiment : ce que le moteur envoie et qui n est
    # pas dans la liste doit quand meme s afficher.
    assert "prefere.indexOf(b) < 0" in page, \
        "une echelle inconnue de la liste resterait invisible"


def test_the_main_page_says_what_is_blocking(page):
    """« Je peux savoir ce qu'il se passe, ce que tu fais et ce qui bloque,
    car je comprends rien. »

    La réponse demandait jusqu'ici de lire des journaux en SSH : le
    Sharpe par échelle vit dans `_echelles`, que l'écran n'affichait que
    dans un autre onglet ; le rodage vit dans le bandeau sans jamais dire
    combien de fermetures il manque ; et le rythme de déclenchement
    n'était nulle part.

    Gagner de l'argent demande cinq choses dans l'ordre, et il suffit
    qu'une seule manque. La carte les montre toutes, sur la page
    principale, et nomme celle qui arrête la chaîne.
    """
    import re

    # Elle existe, elle est rendue, et elle est sur la page PRINCIPALE.
    assert 'id="carte-chaine"' in page
    assert "function rendreChaine" in page
    assert "rendreChaine(d);" in page, "la carte nest jamais rendue"

    marche = page.split('id="vue-marche"')[1].split("</section>")[0]
    assert 'id="carte-chaine"' in marche, \
        "la carte nest pas sur la page principale"

    # Les cinq maillons, dans lordre.
    for n, mot in ((1, "horloge"), (2, "annonce"), (3, "position"),
                   (4, "direct"), (5, "taille")):
        assert re.search(rf'"{n} · [^"]*{mot}', page), \
            f"le maillon {n} ({mot}) manque"

    # Chacun doit dire COMBIEN il manque, pas seulement que ca bloque.
    assert "fermetures de plus avant que la mesure" in page, \
        "le rodage ne dit pas combien de fermetures il manque"
    assert "il lui manque " in page, \
        "la marge ne dit pas combien de Sharpe il manque"
    assert "fois par heure en moyenne" in page, \
        "le rythme de declenchement nest pas dit"

    # Et le barème du rodage est expliqué par la mesure qui l'a imposé,
    # pas presente comme une regle arbitraire.
    assert "609" in page, \
        "la raison du rodage au dixieme nest pas donnee au lecteur"


def test_the_blocking_card_does_not_shadow_the_bps_formatter(page):
    """`bps` est le formateur global. Une variable locale du même nom le
    masquerait, et l'appel `bps(...)` planterait la page entière au
    premier rendu — un écran blanc, pas un chiffre faux.

    Le défaut a été introduit puis corrigé dans la même passe ; ce test
    empêche qu'il revienne.
    """
    import re

    chaine = page.split("function rendreChaine")[1].split("\nfunction ")[0]
    # Frontiere de mot : `moy_bps = Number(` est legitime, `bps = Number(`
    # ne lest pas. Sans le \b le test passe sur le defaut quil doit voir.
    assert not re.search(r"(?<![\w_])bps\s*=\s*Number\(", chaine), \
        "une variable locale masque le formateur global bps()"
    assert "moy_bps" in chaine
    # Contre-epreuve : la forme fautive DOIT etre reconnue, sinon le test
    # ne prouve rien.
    assert re.search(r"(?<![\w_])bps\s*=\s*Number\(",
                     "const n = 0, bps = Number(reg.bps);")


def test_a_pending_signal_shows_the_position_it_would_become(page):
    """La carte des positions porte tout — mais seulement quand il y a
    une position, et il ne s'en est ouvert aucune de la journée.

    Une page qui ne montre le levier, la marge, le TP et le SL que
    lorsqu'une position existe ne les montre jamais au moment où on en a
    le plus besoin : avant. Le panneau des prédictions porte donc, pour
    chaque signal non plat, ce que la position SERA si elle part.

    Les quatre valeurs existaient déjà dans `preds` — `tp_bps`,
    `sl_bps`, `margin` et le levier d'échange — mais la dernière était
    écrasée en chemin : l'instantané réutilisait la clé `lev` pour le
    POIDS notionnel, deux grandeurs sans rapport sous le même nom, alors
    que la marge affichée avait été calculée avec l'autre.
    """
    assert "const lch = Number(p.lev_ech)" in page, \
        "le levier dechange nest pas lu"
    assert 'class="prevu"' in page, "la ligne prevue nest pas rendue"
    for mot in ("levier", "marge", "TP"):
        assert f"<i>{mot}</i>" in page, f"la ligne prevue ne porte pas {mot}"
    # En mode suiveur c'est un trail, pas un stop fixe : le nommer « SL »
    # laisserait croire a un garde-fou immobile.
    assert '"suiv" ? "trail" : "SL"' in page, \
        "la ligne prevue appelle SL ce qui est un suiveur"
    # Et elle ne s'affiche que pour un signal reel, pas pour une ligne plate.
    assert 'p.dir && p.dir !== "flat" ? `<span class="prevu">' in page, \
        "la ligne prevue safficherait sur un actif plat"


def test_the_exchange_leverage_is_not_overwritten_by_the_notional_weight():
    """Deux grandeurs sans rapport portaient le même nom.

    `_snapshot` réutilisait `lev` pour le poids notionnel visé — ce dont
    l'écran a besoin pour une taille en dollars — et écrasait au passage
    le levier d'échange calculé par `_levier_echange`. La marge exposée
    à côté avait pourtant été calculée avec le levier écrasé, si bien
    que `margin` et `lev` ne se répondaient plus.

    Le levier d'échange a désormais son propre nom.
    """
    import os

    src = os.path.join(os.path.dirname(__file__), "..", "hermes", "scalp",
                       "engine.py")
    with open(src, encoding="utf-8") as f:
        code = f.read()
    i = code.index("preds = []")
    bloc = code[i:i + 1600]
    assert 'q["lev_ech"] = float(p.get("lev") or 0.0)' in bloc, \
        "le levier dechange est encore perdu dans linstantane"
    # L'ordre compte : lire AVANT d'ecraser.
    assert bloc.index('q["lev_ech"]') < bloc.index('q["lev"] = float(tg'), \
        "le levier dechange est lu apres avoir ete ecrase"
