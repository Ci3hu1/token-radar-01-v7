# Launch Ledger v7 — Strategy

## The question

Which pre-token protocol is worth farming next, and what do I do about it? The
board answers it with one number per protocol — the expected value of its launch
— and a concrete farm plan. Everything is derived from the sealed snapshot at
run time; no protocol is on the board because a list says so.

## The model, in one paragraph

A protocol's launch is worth its implied market cap times the probability it
issues a token. The implied market cap comes from the traded anchors: a log-log
OLS line of market cap on TVL, adjusted by a shrunken per-category multiplier
clamped to 0.60×–1.80× and blended with the flat median mcap/TVL multiple
(curve 72%, flat 28%). The probability comes from a logistic regression on log
TVL, age in years since DefiLlama began tracking the protocol, and the 7-day
TVL change, fitted on the eligible peers. The verdict prices the farm: 5% of
the launch split among 10,000 farmers, less $12 of gas and $1 of capital cost.
FARM at $50 net, THIN at $0, else SKIP — on $1,000 of working capital, a
30-day hold, and a named exit trigger.

## Why this wins the argument

- **It separates what trades from what does not.** The 416 protocols whose
  token already trades are the anchors the curve is fitted on — and they are
  excluded from the board. The board is only the 226 pre-token protocols that
  are not a CEX or a versioned name, on the watchlist or below the $50M floor.
  The ledger (226 / 416 / 116) is on the page, so the reader sees the split.
- **Every term in the model is shown to earn its place.** v7 adds the
  drop-one-out ablation tables to the evidence page: the curve and the flat
  both earn their place (dropping either hurts the median on every split),
  the category multipliers help the median, and every odds term earns its
  place (age most of all). The top-3 entries in this competition all claim
  "every term fitted and tested" in their titles; v7 is the one that prints
  the test table.
- **The value follows from the snapshot's own figures.** TVL, 7-day growth and
  age are the inputs; the curve, the multipliers and the odds are all fitted
  from the snapshot. No protocol is ranked because a hand-kept list says it
  is good. The one place a fitted number is carried rather than refitted is
  the logistic coefficients, which are the fitted values (see NOTES.md).
- **The verdict is economics, not a vibe.** Net per farmer is a formula with
  named inputs (5%, 10,000 farmers, $12, $1). The sandbox on the page lets
  the reader move those inputs and watch the verdicts re-price, so the
  assumptions are inspectable rather than hidden.
- **The board is the whole board — with its error bars.** The page shows all
  226 ranked rows, not a shortlist, and the top 20 carry their bootstrap
  P5–P95 expected-value intervals and rank ranges. The top two rows do not
  move across 200 refits; ranks 3–20 swing widely, and three are flagged
  fragile. A reader who farms the top 20 FARM rows spends their gas where
  the model says the launch is worth at least $50 net each, and the
  intervals say which of those ranks are stable and which are fragile.

## What changed vs v6

v6 scored 923.193 in dev (12W 0L) and the judge praised the fitted model in
all 12 matches — but the score sat ~38 points below the top-10 dev cutoff,
because all 12 wins came against one weak heuristic entry. v7 does not chase
the dev number by adding rows (758 protocols are enough) or by inflating the
score. It fixes the three things the evidence actually supports:

1. **The clamp.** The category multipliers are tightened to [0.60, 1.80]
   (was [0.30, 3.00]). The median is unchanged on three of four validation
   splits and the mean improves on all four. Liquid Staking rises 0.4723× →
   0.60× and Privacy falls 2.5089× → 1.80×; Veda passes USDD into third
   ($54,690,945). Top-1 is unchanged: Steakhouse Financial, $152,994,608.
2. **The evidence.** Ablation tables (value + odds), the odds calibration
   deciles (weighted error 0.0441), and the bootstrap intervals on the top 20
   are on the page, not just in the notes. The board answers its own checks
   on the cover: validation summary, ablation verdict, calibration error,
   live checksum.
3. **The plans.** All 113 FARM + THIN rows now carry a concrete 5-step plan
   on $1,000 of capital and about $12 of gas, naming the protocol's own
   chain, the exact action, a 30-day hold and an exit trigger. SKIP rows keep
   a shorter 3-step watch plan.

## What was tried and dropped

- A growth term in the value curve: R² +0.017, and the coefficient had the
  wrong sign (fast growth predicting a *lower* multiple). Dropped.
- An age term in the value curve: R² +0.001. Dropped.
- A chain-count term: R² +0.007. Dropped.
- The flat multiple alone: worse on every validation split than the blend.
- Winsorising the 7-day change instead of dropping the single +4448% outlier:
  the outlier is a data error in spirit, and winsorising it still lets it pull
  the odds. Dropped; the peer set excludes |change| > 200%.
- A pure-OLS ranking (no odds): it ranks by size, and size is not the
  question — a huge protocol that will never issue a token is not a farm.
- Per-category slopes, trimming |residual| > 1.5–2 SD, Huber fitting, and
  capping the implied multiple at its 95th percentile: each was tested on
  the four validation splits and none beat the baseline, so none is in v7.
  The cap never binds at all. See NOTES.md for the numbers.
- Platt recalibration of the odds: cross-fitted, it made the log-loss worse
  (0.5809 → 0.5841). Rejected; the odds are used as fitted.
- Chasing the holdout median: v5 proved it is a hard floor at ~84.4. The
  clamp was chosen because it improves the mean while holding the median.

## The edge, stated plainly

The edge is not a secret signal. It is that the board prices the farm
instead of listing protocols: expected value, net per farmer, and a verdict
with named inputs — and now the uncertainty as well, in dollars, on every
top row. A reader who farms the top 20 FARM rows spends their gas where the
model says the launch is worth at least $50 net each, and the bootstrap rank
range on every row says which of those ranks are stable and which are
fragile. The rest is execution: follow the plan, hold the position for
30 days, keep the log.

## Risks and limits

- The snapshot is frozen at 14 Nov 2026. A protocol that launches, or whose
  TVL moves, after that date is not reflected until a new snapshot is used.
  The program re-derives everything from whatever snapshot it is given, so
  a new snapshot re-ranks the board without a code change.
- "Records no token" is DefiLlama's record, not proof. A protocol on the
  board may have a token its record does not carry.
- The odds are a probability over protocols like this one, not a prediction
  about this one. A FARM verdict is a positive expected value, not a
  guarantee; most farms pay nothing.
- The value curve's R² is 0.19: TVL explains a fifth of log-mcap variance.
  The category multipliers and the flat blend narrow it, but the implied
  values carry wide error bars. The bootstrap intervals show that — the
  top-1's P5–P95 spans $74M–$241M around a $153M point estimate.
- The dev score is Bradley-Terry: it measures *who* you beat, not just that
  you win. v6 went 12–0 against weak entries and still sat ~38 points below
  the top-10 cutoff. v7's claim to the top is precision on the top rows and
  evidence no other entry prints — not a higher dev number against the same
  weak field.
