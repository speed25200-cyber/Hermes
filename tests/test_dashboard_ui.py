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


# Words that were actually on screen in the previous build.
ANGLAIS = ["Activity log", "Alpha research", "Drawdown", "Kill switch",
           "Live scan", "Log is empty", "No orders yet", "Deployed",
           "Genomes evaluated", "Take profit", "Stop loss", "Equity",
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


def test_chart_levels_never_ride_on_colour_alone(page):
    for etiquette in ('"ENTRÉE"', '"OBJECTIF"', '"STOP"'):
        assert etiquette in page, etiquette
