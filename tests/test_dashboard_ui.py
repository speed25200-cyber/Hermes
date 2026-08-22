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
ANGLAIS = ["Activity log", "Alpha research", "Drawdown from peak", "Kill switch",
           "Live scan", "Log is empty", "No orders yet", "Deployed",
           "Genomes evaluated", "Take profit", "Stop loss", "Equity",
           "Leverage", "Positions open", "Last pass", "Next pass",
           "capital weights", "firing", "gated", "last print"]


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
