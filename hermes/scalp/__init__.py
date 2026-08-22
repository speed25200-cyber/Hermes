"""1-minute order-flow scalp engine.

Not a candle-color oracle. Predicted edge is a few bps from bid-ask bounce,
book imbalance and BTC lead-lag. Trades fire only when that edge clears
round-trip costs; otherwise the book stays flat.
"""
from .engine import ScalpEngine
