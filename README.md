[![token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Ci3hu1/token-radar-01-v7/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Ci3hu1/token-radar-01-v7/reward.svg)](https://make.fun/bounty/token-radar-01)

# Launch Ledger v7 — Token Radar

Which pre-token protocol is worth farming next, and what do I do about it?
Launch Ledger v7 ranks the 226 pre-token protocols in the sealed DefiLlama
snapshot by what their launch would be worth — implied market cap × the odds
they issue a token — and gives each one a concrete farm plan, with the
evidence that every term in the model earned its place.

- **Bounty:** [token-radar-01 — Build the best token launch radar](https://make.fun/bounty/token-radar-01) ($1,325, 10 places)
- **Referral:** `cc7tcnw6`
- **Run it:** `MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>` (Node 22, standard library only; no network, no clock — two runs write the same bytes)
- **Tests:** `node --test tests/model.test.ts` (18/18)

## The board

| | |
| --- | --- |
| Board | 226 protocols (40 watchlist + 186 eligible below the $50M floor) |
| Traded (excluded) | 416 — their tokens already trade; they are the curve's anchors |
| Excluded | 116 — CEX / versioned, or above the floor and off the watchlist |
| Top-1 | Steakhouse Financial — $152,994,608 expected value (P5–P95 $74,418,826–$241,309,207, rank 1–1) |
| Top-5 | steakhouse-financial, gauntlet, veda, usdd, nonce-capital |
| Verdicts | 20 FARM · 93 THIN · 113 SKIP |
| Farm plans | 113 concrete plans ($1,000 capital, ~$12 gas, 30-day hold, exit trigger) |
| Sum of expected values | $1,335,071,152 |
| Checksum | `db668a77` (sha256 of the compact rows as JSON, first 8 hex) |

## The model

Implied market cap: a log-log OLS curve of mcap on TVL over the 128 traded
anchors (intercept 3.0247, slope 0.5223, R² 0.1939), with a shrunken
per-category multiplier clamped to 0.60×–1.80×, blended 72/28 with the flat
median mcap/TVL multiple (0.2138). P(token): a logistic regression on log
TVL, age and 7-day change, fitted on 449 eligible peers. Expected value =
implied mcap × P(token). Verdict: 5% of the launch split among 10,000
farmers, less $12 gas and $1 cost — FARM at $50 net, THIN at $0, else SKIP.

What v7 adds over v6: the tighter clamp (Veda passes USDD into third);
drop-one-out ablation tables for the value and odds terms; the odds
calibration deciles (weighted error 0.0441, Platt recalibration tested and
rejected); bootstrap P5–P95 expected-value intervals and rank ranges on the
top 20, with three fragile ranks flagged; and a concrete farm plan on every
FARM and THIN row.

The dashboard is a field-guide page: the full ranked board (226 rows) with
EV intervals and fragile flags, a filter (try Lending — "Showing 14 of 226"),
a detail view per protocol with factors, comps and a farm plan, compare
mode, pinning, CSV export, a model sandbox, the evidence tables, and a
cover self-check that answers the board's own checks. See
[STRATEGY.md](STRATEGY.md) for the strategy and [NOTES.md](NOTES.md) for the
fitted values and validation.

## Files

- `main.ts` — the entrypoint: reads the snapshot, writes `board.json`,
  `data.js`, `dashboard/`, `screenshots/` and `dossier.json`
- `lib/model.ts` — the whole model: snapshot + ledger, value curve,
  multipliers and blend, logistic odds, evidence tables, board assembly,
  bootstrap, checksum, farm plans
- `dashboard/` — `index.html`, `app.css`, `app.js` (no network)
- `screenshots/` — the board, a filtered view, a detail view, the evidence
- `vendor/makefun-board.ts` — the kit's dossier library, byte for byte
- `tests/model.test.ts` — the fitted numbers, pinned

## Limits

"Records no token" is DefiLlama's record, not proof. Implied values are this
entry's own claim, not make.fun's. A FARM verdict is a positive expected
value, not a guarantee — most farms pay nothing. Not financial advice.
