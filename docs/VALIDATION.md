# Why the gates sit where they do

Every threshold in `config.json["research"]` is a number someone can lower
when the book is empty and the temptation is strong. This is the measured
evidence behind each one, so that lowering it is at least an informed
decision rather than an easy one.

All figures were measured on 2026-08-16, on the live book and on edges
planted deliberately so that the right answer was known in advance.

## The deflated Sharpe is a confidence level

`min_dsr` is the probability that a strategy's true Sharpe exceeds what
picking the best of the whole search would produce on noise alone. It is not
a score. A gate at 0.05 admits anything 95% likely to be the luckiest draw of
its own search.

The live book showed exactly what that produces. Eighteen strategies,
out-of-sample Sharpes of 6.5 to 9.5 — and DSRs from 0.050 to 0.175. Not one
was above its own selection bar.

Where the threshold belongs is a measurement, not a preference:

| case | OOS Sharpe | DSR |
| --- | --- | --- |
| planted cross-sectional trend | 6.90 | 0.701 |
| planted lead-lag, 1.8k OOS bars | 4.97 | **0.456** |
| the same edge, 3.6k OOS bars | 4.52 | **0.707** |
| the same edge, 7.2k OOS bars | 4.67 | **0.970** |
| the live book, two-month aux window | 6.5–9.5 | ≤ 0.175 |

Note what does not move down those middle rows: the Sharpe, ~4.7 throughout.
Only the confidence grows. That is the difference between "this looks good"
and "this is established".

The textbook 0.95 is reachable, but only with data — at 6,000 bars it would
reject an edge that is real by construction. **0.5** is the line worth
holding: the true Sharpe more likely than not beats what the search alone
would have produced. It separates every planted edge from the entire live
book by a wide margin.

## Search budget is charged back to what it finds

Selection over `n` trials lifts the Sharpe reachable on noise. On a
21,000-bar scored window:

| trials | selection bar |
| --- | --- |
| 26 (the panel grid) | 2.60 |
| 100 | 3.27 |
| 624 (the per-instrument budget) | 4.03 |
| 2,400 (the old budget) | 4.52 |
| 10,000 | 4.99 |

A per-instrument edge in these families runs Sharpe 1 to 2, so no budget
makes single-name research likely to produce a survivor. The old budget spent
2h34 per pass raising its own bar by half a Sharpe point in order to fail.

This is also why the panel grid is small and fixed rather than evolutionary:
a 10,000-trial panel search would set a bar of 4.99, above the 4.72 a pooled
edge actually measured.

## Breadth beats depth, and by how much

One rule, one planted edge, twenty instruments:

| measured on | Sharpe | verdict against a 3.61 bar |
| --- | --- | --- |
| one instrument alone | 0.93 | rejected |
| pooled across the twenty | 4.72 | accepted |

A 5.1x lift against the sqrt(20) = 4.47 the argument predicts. Same rule,
same data, same gate — only the question changed. This is why
`hermes/research/panel.py` exists and why widening the universe is the lever
that matters.

## Some windows cannot answer the question at all

The bar has a closed form in the sample length, so the length needed for it
to fall below a given Sharpe is computable before any search runs
(`metrics.bars_for_selection_bar`). For a 600-genome search to get its bar
under Sharpe 10 it needs ~70 days of scored history. The exchange serves ~65
days of open interest and taker flow, of which ~20 are scored out of sample.

Those families were being researched on roughly a quarter of the data
required for a survivor to mean anything, and no threshold repairs that after
the fact. `max_selection_bar` refuses the search instead, and says how many
days are missing. The store keeps every row it has ever fetched, so those
windows lengthen on their own.

## What is deliberately looser than it could be

Each gate charges the search that competed for its own selection: a
per-instrument survivor pays that instrument's ~624 genomes, a panel survivor
pays its 26-rule grid. A stricter reading would charge every survivor the
whole pass, since they all land in one book and a person choosing between
them saw all of it. That would raise every bar again. The looser convention
is in force, and it is a choice rather than an oversight.

## If you are about to lower one of these

The failure mode is not subtle and it has already happened once here: the
gate reads as a formality, the book fills with high Sharpes, and every one of
them is the search's own luck. An empty book is the honest outcome most of
the time. `hermes report` prints what the last pass came closest to
deploying and which constraint bound, so "nothing deployed" can be diagnosed
instead of guessed at.
