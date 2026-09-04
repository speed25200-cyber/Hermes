"""Hermes — autonomous perpetual-futures trading system for OKX.

Pipeline: data -> features -> strategy genomes -> evolutionary research with
anti-overfitting validation -> adaptive capital allocation -> risk engine ->
execution (paper or live OKX v5 API).
"""

__version__ = "0.1.0"

# Bump whenever the research protocol or the state files change meaning:
# state written by an older engine (strategies validated under a different
# gate, paper books from another risk regime) is archived, never reused.
ENGINE_VERSION = 2
