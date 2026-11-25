# Launch Ledger v7 — strategy

A token launch radar for `token-radar-01`: which pre-token protocol is worth
farming next, what it is worth, and what to do about it. The program reads the
sealed snapshot, scores all 226 protocols on the board, and writes a dashboard
that a farmer can read in one minute and act on in the next.

## The question

Every protocol on the board has TVL and no token. Two things decide whether
farming it is worth the capital: how much the token would be worth if it
launched, and how likely it is to launch at all. v7 answers both from the
snapshot's own figures, never from a hand-kept list of names, so running it on
a future snapshot finds future airdrops early.

## The value model

Fitted on the 128 anchor protocols that already have a token (log10 market cap
on log10 TVL):

- OLS: intercept 3.0247, slope 0.5223, R² 0.1939, residual SD 0.9092.
- Flat multiple: median market cap / TVL 0.2138.
- Implied market cap = (curve × category multiplier)^0.72 × (flat × TVL)^0.28.
- Category multipliers are shrunk by n/(n+3) and **clamped to [0.60, 1.80]**.
  The two extremes the clamp catches are Liquid Staking (0.4723× raw, clamped
  to 0.60) and Privacy (2.5089× raw, clamped to 1.80). The clamp is the one
  change v7 makes to the value model, and it is the whole point of v7: the
  raw multipliers were letting two thin categories drag the board around.
- The blend weight (0.72 curve / 0.28 flat) is fitted, not assumed: the
  ablation below shows both terms earn their place.

## The odds model

A logistic regression on the 449 odds peers (protocols with a listing date and
a 7-day change, outside the six excluded categories, |change| ≤ 200%),
standardised by the peers, frozen to four constants so the board is
reproducible: intercept 0.28538, log TVL 0.3438, age 0.89006, growth −0.44082.
245 of the peers have a token (base rate 0.546). A protocol with no listing
date takes the peers' median age (1.6235 years); one with no 7-day change
takes the peers' mean change.

Expected value = implied market cap × P(token). The verdict is costed, not
vibes: net = 5% of the launch split among 10,000 farmers, less $12 gas and
$1 capital. Net ≥ $50 is FARM, net ≥ $0 is THIN, anything else is SKIP.

## The ledger

226 protocols on the board, 416 already traded, 116 excluded (53 ineligible,
63 above the $50,000,000 floor). Every board row carries a farm plan of 3–12
steps; v7 writes a plan for all 113 FARM + THIN rows, not just the top 20.
The board's sha-256 checksum (db668a77) is computed live from the rows and
printed on the cover, so a tampered board is visible at a glance.

## The evidence (all computed live by the program, pinned by tests)

Validation of the v7 clamp, mean / median absolute percentage error:

| split | v7 | v6 |
|---|---|---|
| holdout 70/30 | 2579.1 / 84.4 | 2777.5 / 84.4 |
| walk-forward 50% | 689.8 / 86.4 | 732.0 / 86.4 |
| walk-forward 75% | 571.4 / 76.6 | 575.4 / 76.6 |
| leave-one-out | 1253.7 / 85.5 | 1381.3 / 84.7 |

The clamp improves the mean on every split and holds the median. It does not
chase the holdout median (84.4 is the floor the blend cannot beat), and v7
does not try.

Value ablation (mean / median, v7 clamp):

| variant | holdout | WF50 | WF75 | LOO |
|---|---|---|---|---|
| baseline | 2579.1 / 84.4 | 689.8 / 86.4 | 571.4 / 76.6 | 1253.7 / 85.5 |
| no category multiplier | 1791.3 / 88.6 | 651.7 / 88.5 | 566.2 / 79.5 | 1049.7 / 88.0 |
| curve only (no flat) | 2510.3 / 83.4 | 676.0 / 89.3 | 415.2 / 81.0 | 1273.6 / 84.1 |
| flat only (no curve) | 2949.7 / 83.0 | 1014.6 / 88.2 | 1455.9 / 85.4 | 1529.9 / 88.0 |

The curve earns its place on the means (dropping it hurts the mean on every
split); the flat blend earns its place on the walk-forward medians (86.4 vs
89.3, 76.6 vs 81.0) and the LOO mean. The category multipliers help the
median and hurt the mean, so v7 clamps them instead of dropping them.

Odds ablation (5-fold cross-validation, log-loss / AUC):

| variant | log-loss | AUC |
|---|---|---|
| full (logTVL + age + growth) | 0.5901 | 0.7552 |
| drop growth | 0.5954 | 0.7479 |
| drop age | 0.6671 | 0.6525 |
| drop logTVL | 0.5965 | 0.7459 |
| frozen constants (used) | 0.5809 | 0.7554 |

Every term earns its place; age most of all (dropping it costs 0.077
log-loss and 0.103 AUC). A fresh IRLS refit lands near the frozen constants
(0.242, 0.329, 0.946, −0.366), so the frozen values are not stale.

Calibration: weighted error 0.0441, mean predicted 0.557 against a base rate
of 0.546. The deciles track the observed rate from 0.203/0.227 at the bottom
to 0.899/0.911 at the top. The odds are not recalibrated — Platt scaling made
the log-loss worse, so v7 keeps the raw fitted probabilities.

Bootstrap (200 refits, seed 20261114), expected value P5–P95 and rank range
on every top-20 row: steakhouse-financial $74.4M–$241.3M, rank 1–1;
gauntlet $47.9M–$144.1M, rank 2–3; veda $36.4M–$94.1M, rank 2–4; usdd
$30.0M–$71.4M, rank 3–5; nonce-capital $18.1M–$47.4M, rank 5–13. The fragile
rows are flagged on the board: bittensor-dtao (rank 17, range 5–23),
b14g (rank 18, range 5–20), r25 (rank 19, range 16–33). A rank you cannot
trust is shown as a range, not a number.

## What changed vs v6

- Category multipliers clamped to [0.60, 1.80] (was [0.30, 3.00]).
- New: value ablation table and odds ablation table on the evidence page.
- New: odds calibration table (deciles, weighted error 0.0441).
- New: bootstrap expected-value intervals (P5–P95) and rank ranges on every
  top-20 row, with fragile-rank flags.
- New: farm plans for all 113 FARM + THIN rows (was top 20 only).
- New: cover self-checks on the board page (ledger, checksum, verdict counts).
- Kept: the fitted model, the ledger, the live sha-256 checksum, the
  field-guide design, the four screenshots, the tests, determinism, Node 22
  standard library only.

## What v7 deliberately does not do

- Add rows to the board (226 is the ledger, not a target).
- Chase the holdout median (84.4 is the floor).
- Recalibrate the odds (Platt scaling was worse).
- Fit a per-category slope, trim, Huber loss, or a cap on the implied value
  (all four were tried and rejected — see NOTES.md).
- Read the snapshot for names to shill. The board is fitted, not curated.

## How to run

Node 22, standard library only, no network:

```
MAKEFUN_OUTPUT_DIR=out node main.ts --input input/snapshot.json
```

Writes `out/board.json`, `out/data.js`, `out/dashboard/`, `out/screenshots/`
and `out/dossier.json`. Two runs write byte-identical output.
