# Launch Ledger v7 — notes

## Fitted values (snapshot as of 2026-11-14, 758 protocols, 40 on the watchlist)

- Anchors (protocols with a token and a market cap): 128.
- OLS log10(market cap) on log10(TVL): intercept 3.0247, slope 0.5223,
  R² 0.1939, residual SD 0.9092.
- Flat multiple (median market cap / TVL): 0.2138.
- Blend: implied = (curve × multiplier)^0.72 × (flat × TVL)^0.28.
- Category multipliers: shrunk by n/(n+3), clamped to [0.60, 1.80].
  Raw extremes: Liquid Staking 0.4723× → 0.60, Privacy 2.5089× → 1.80.
- Odds peers: 449 (245 with a token, base rate 0.546), median age 1.6235y.
- Frozen odds constants: intercept 0.28538, log TVL 0.3438, age 0.89006,
  growth −0.44082. A fresh IRLS refit lands at (0.242, 0.329, 0.946, −0.366).
- P(token) for the top row: steakhouse-financial 0.7125.

## The board

- 226 rows. Top 5 expected values: steakhouse-financial $152,994,608;
  gauntlet $95,119,919; veda $54,690,945; usdd $51,256,531; nonce-capital
  $32,726,180. Sum of expected values: $1,335,071,152.
- Verdicts: 20 FARM, 93 THIN, 113 SKIP. Farm plans written for all 113
  FARM + THIN rows.
- Board checksum (sha-256 of the rows, live): db668a77.
- Ledger: 226 board / 416 traded / 116 excluded (53 ineligible + 63 above
  the $50,000,000 floor).

## Validation (v7 clamp, mean / median APE)

Holdout 2579.1 / 84.4; walk-forward 50% 689.8 / 86.4; walk-forward 75%
571.4 / 76.6; leave-one-out 1253.7 / 85.5. The clamp beats the v6 clamp on
the mean of every split and holds every median.

## Evidence tables (computed live, pinned by tests)

- Value ablation: baseline, no category multiplier, curve only, flat only —
  see STRATEGY.md for the full table.
- Odds ablation (5-fold): full 0.5901 / 0.7552; drop growth 0.5954 / 0.7479;
  drop age 0.6671 / 0.6525; drop logTVL 0.5965 / 0.7459; frozen 0.5809 / 0.7554.
- Calibration: weighted error 0.0441; mean predicted 0.557 vs base rate
  0.546; deciles 0.203/0.227, 0.306/0.244, 0.384/0.422, 0.449/0.422,
  0.509/0.489, 0.591/0.556, 0.657/0.644, 0.741/0.622, 0.821/0.911,
  0.899/0.911.
- Bootstrap (200 refits, seed 20261114): steakhouse rank 1–1, gauntlet 2–3,
  veda 2–4, usdd 3–5, nonce-capital 5–13. Fragile: bittensor-dtao 5–23,
  b14g 5–20, r25 16–33.

## Rejected, with the numbers

- Recalibrating the odds (Platt scaling): log-loss worse than the raw
  fitted probabilities, rejected.
- Per-category slope, trimming, Huber loss, capping the implied value:
  each tried on the same four splits; none beat the baseline on the median,
  rejected.
- Chasing the holdout median: the blend's holdout median is 84.4 and no
  variant in the ablation beats it by more than noise; the floor stands.

## A note on the sum of expected values

An earlier Python mirror of the model reported $1,335,070,235 for the same
board; the program reports $1,335,071,152. The $917 difference (0.00007%)
is a rounding artifact in the mirror, not a model difference: the mirror
imputed a missing listing date with the rounded median age 1.6235, while the
program uses the live peer median 1.623545516769336. Eleven rows with no
listing date shift by $20–$162 each; the implied market caps match exactly,
the top 5 and every verdict are identical. The program's number is the
authoritative one.

## Build record

- Program: `main.ts` + `lib/model.ts`, Node 22 standard library only.
- Dashboard: `dashboard/` (index.html + app.css + app.js, ~30 KB total).
- Tests: `node --test tests/model.test.ts` — 18 tests, all passing.
  They pin the ledger, the OLS, the multipliers, the top 5, the verdicts,
  the validation numbers, both ablations, the calibration, the bootstrap
  ranges, the IRLS refit, determinism, and the board tamper check.
- Determinism: two runs of `main.ts` write byte-identical output
  (board.json sha256 adb03342c979fb6d821b6fc71d0f879d2793527e927242930cae4aab66f0f2f7).
- Screenshots: 4 renders of the dashboard (board, filtered Lending,
  Steakhouse detail, evidence), 1440×900 each, under 512 KiB.

## Submission

Not yet submitted. Submit later with source withheld.
