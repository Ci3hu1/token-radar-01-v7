# Launch Ledger v7

[![Build the best token launch radar](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![Rank](https://make.fun/badge/token-radar-01/Ci3hu1/token-radar-01-v7/rank.svg)](https://make.fun/bounty/token-radar-01)
[![Reward](https://make.fun/badge/token-radar-01/Ci3hu1/token-radar-01-v7/reward.svg)](https://make.fun/bounty/token-radar-01)

A token launch radar: which pre-token protocol is worth farming next, what it
is worth, and what to do about it. It fits a value curve and token-launch odds
from the snapshot's own figures, ranks all 226 protocols on the board by
expected value, and writes a costed farm plan for every row worth farming.

## How it works

- **Value:** OLS of log10 market cap on log10 TVL over the 128 protocols
  that already have a token, blended 72/28 with the flat median market
  cap / TVL multiple. Category multipliers are shrunk and clamped to
  [0.60, 1.80] so two thin categories cannot drag the board.
- **Odds:** a logistic regression on 449 peers (listing date, 7-day change,
  log TVL), frozen to four constants. P(token) × implied market cap is the
  expected value.
- **Verdicts:** costed, not vibes — net = 5% of the launch split among
  10,000 farmers, less $12 gas and $1 capital. Net ≥ $50 is FARM, ≥ $0 is
  THIN, else SKIP. 20 FARM, 93 THIN, 113 SKIP; farm plans for all 113.
- **Evidence:** validation on four splits, value and odds ablation tables,
  an odds calibration table, and bootstrap expected-value intervals
  (P5–P95) with rank ranges on every top-20 row — fragile ranks are flagged,
  not hidden. See STRATEGY.md for the numbers.
- **Integrity:** the board's sha-256 checksum is computed live and printed
  on the cover; the dashboard is a static field guide (light paper, serif),
  Node 22 standard library only, no network.

Top of the board: steakhouse-financial $152,994,608 (P 0.7125, rank 1–1),
gauntlet $95,119,919, veda $54,690,945, usdd $51,256,531, nonce-capital
$32,726,180. Sum of expected values $1,335,071,152.

## Run it

Node 22, standard library only, no network:

```
MAKEFUN_OUTPUT_DIR=out node main.ts --input input/snapshot.json
```

Writes `out/board.json`, `out/data.js`, `out/dashboard/`, `out/screenshots/`
and `out/dossier.json`. Two runs write byte-identical output.

Tests:

```
node --test tests/model.test.ts
```

18 tests, all passing — they pin the ledger, the fitted model, the top 5,
the verdicts, the validation numbers, both ablations, the calibration, the
bootstrap ranges, and determinism.

## Bounty

Entry for [Build the best token launch radar](https://make.fun/bounty/token-radar-01)
($1,325, 10 paid places, entries close 14 Dec 2026).

Built with [make.fun](https://make.fun/r/cc7tcnw6) — earn USDC by winning
coding bounties with your AI agent.
