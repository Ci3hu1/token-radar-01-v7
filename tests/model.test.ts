// model.test.ts — the v7 fitted model, pinned to the numbers the snapshot produces.
// Run: node --test tests/model.test.ts  (Node 24 runs the .ts directly.)
// Every number below is a value the code derives from the sealed snapshot at run
// time; the test pins it so a regression in the fit is caught, not hidden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  anchors,
  assemble,
  BLEND,
  boardChecksum,
  boardProtocols,
  CALIBRATION,
  CALIBRATION_ERROR,
  catMults,
  CLAMP_HI,
  CLAMP_LO,
  farmPlan,
  fitCurve,
  fitOdds,
  flatMult,
  gateRows,
  ledger,
  netFor,
  ODDS,
  ODDS_ABLATION,
  peers,
  peerStats,
  preToken,
  readSnap,
  SHRINK_K,
  tokenProb,
  VALIDATION_V7,
  VALUE_ABLATION,
  verdictFor,
} from '../lib/model.ts';

const SNAP = '/home/hatch/workspace/tools/makefun/token-radar-01-v7-kit/token-radar-01-kit/input/snapshot.json';
const snap = readSnap(SNAP);

function close(actual: number, expected: number, tol: number, label: string): void {
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: got ${actual}, want ${expected} ± ${tol}`);
}

test('snapshot: the sealed file is what the field guide says', () => {
  assert.equal(snap.as_of, '2026-11-14');
  assert.equal(snap.floor_usd, 50_000_000);
  assert.equal(snap.protocols.length, 758);
  assert.equal(snap.watchlist.length, 40);
});

test('ledger: 226 board, 416 traded, 116 excluded', () => {
  const L = ledger(snap);
  assert.equal(L.board, 226);
  assert.equal(L.traded, 416);
  assert.equal(L.excluded, 116);
  assert.equal(L.total, 758);
  assert.equal(L.board + L.traded + L.excluded, 758);
});

test('board rule: the watchlist is covered and the versioned are out', () => {
  const board = boardProtocols(snap);
  const slugs = new Set(board.map((p) => p.slug));
  for (const w of snap.watchlist) assert.ok(slugs.has(w), `watchlist ${w} missing from the board`);
  assert.ok(!slugs.has('rysk-v12'), 'Rysk V12 is versioned and must be excluded');
  assert.ok(board.every((p) => preToken(p)), 'every board row records no token');
  assert.ok(board.every((p) => p.category !== 'CEX'), 'no CEX on the board');
});

test('value model: OLS on 128 anchors', () => {
  const al = anchors(snap.protocols);
  assert.equal(al.length, 128);
  const curve = fitCurve(al);
  close(curve.intercept, 3.0247, 0.0005, 'intercept');
  close(curve.slope, 0.5223, 0.0005, 'slope');
  close(curve.r2, 0.1939, 0.0005, 'R2');
  close(curve.residSd, 0.9092, 0.0005, 'residual SD');
  close(flatMult(al), 0.2138, 0.0005, 'flat multiple');
  assert.equal(BLEND, 0.28);
});

test('value model: category multipliers are clamped to [0.60, 1.80]', () => {
  const al = anchors(snap.protocols);
  const curve = fitCurve(al);
  const mults = catMults(al, curve);
  assert.equal(CLAMP_LO, 0.6);
  assert.equal(CLAMP_HI, 1.8);
  assert.equal(SHRINK_K, 3);
  for (const [, m] of mults) {
    assert.ok(m >= 0.6 && m <= 1.8, `multiplier ${m} outside the 0.60–1.80 clamp`);
  }
  // The clamp binds exactly at both ends: Liquid Staking was 0.4723×, Privacy 2.5089×.
  assert.equal(mults.get('Liquid Staking'), 0.6);
  assert.equal(mults.get('Privacy'), 1.8);
});

test('odds: 449 eligible peers and the fitted weights', () => {
  const pl = peers(snap.protocols);
  assert.equal(pl.length, 449);
  const stats = peerStats(pl, snap.as_of);
  assert.equal(stats.n, 449);
  close(stats.medianAge, 1.6235, 0.001, 'median age');
  // The refit lands near the constants the board uses.
  const refit = fitOdds(pl, snap.as_of);
  close(refit.bias, ODDS.bias, 0.06, 'odds bias');
  close(refit.logTvl, ODDS.logTvl, 0.06, 'odds logTvl');
  close(refit.age, ODDS.age, 0.12, 'odds age');
  close(refit.growth, ODDS.growth, 0.09, 'odds growth');
});

test('odds: steakhouse is the most likely top protocol', () => {
  const pl = peers(snap.protocols);
  const stats = peerStats(pl, snap.as_of);
  const sh = snap.protocols.find((p) => p.slug === 'steakhouse-financial')!;
  const pr = tokenProb(sh, stats, snap.as_of);
  close(pr, 0.7125, 0.002, 'P(steakhouse)');
});

test('board: 226 rows, ranked by expected value, top-1 steakhouse', () => {
  const { rows, fit } = assemble(snap);
  assert.equal(rows.length, 226);
  assert.equal(rows[0].slug, 'steakhouse-financial');
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[0].implied_value_usd, 152_994_608);
  assert.equal(fit.sumEv, 1_335_071_152);
  assert.deepEqual(fit.verdictCounts, { FARM: 20, THIN: 93, SKIP: 113 });
  assert.equal(fit.watchlistTop50, 34);
  assert.equal(fit.ledgerCounts.board, 226);
  // Ranks are 1..226 exactly once, and implied value does not rise with rank.
  const ranks = rows.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < 226; i++) assert.equal(ranks[i], i + 1);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].implied_value_usd <= rows[i - 1].implied_value_usd, `row ${i + 1} rises above row ${i}`);
  }
  // The clamp moves Veda past USDD: the v7 top five, in order.
  assert.deepEqual(rows.slice(0, 5).map((r) => r.slug), [
    'steakhouse-financial',
    'gauntlet',
    'veda',
    'usdd',
    'nonce-capital',
  ]);
  assert.equal(rows[2].implied_value_usd, 54_690_945);
});

test('board: verdict thresholds are the farm economics', () => {
  assert.equal(verdictFor(12_600_000), 'FARM');
  assert.equal(verdictFor(12_599_999), 'THIN');
  assert.equal(verdictFor(2_600_000), 'THIN');
  assert.equal(verdictFor(2_599_999), 'SKIP');
  close(netFor(152_994_608), 751.97, 0.01, 'net for the top-1');
});

test('board: every FARM/THIN row carries a concrete 5-step plan, SKIP rows 3 steps', () => {
  const { rows } = assemble(snap);
  const planned = rows.filter((r) => r.verdict !== 'SKIP');
  assert.equal(planned.length, 113);
  for (const r of rows) {
    const want = r.verdict === 'SKIP' ? 3 : 5;
    assert.equal(r.farm_steps.length, want, `${r.slug}: ${r.farm_steps.length} steps, want ${want}`);
    for (const s of r.farm_steps) {
      const t = s.trim();
      assert.ok(t.length >= 20 && t.length <= 600, `${r.slug}: step ${t.length} chars`);
    }
    if (r.verdict !== 'SKIP') {
      const joined = r.farm_steps.join(' ');
      assert.ok(joined.includes('$1,000'), `${r.slug}: plan names the $1,000 capital`);
      assert.ok(joined.includes('$12'), `${r.slug}: plan names the $12 gas`);
      assert.ok(/30 day/i.test(joined), `${r.slug}: plan names the 30-day hold`);
      assert.ok(/exit/i.test(joined), `${r.slug}: plan names the exit trigger`);
      assert.ok(joined.includes(r.chains[0] ?? 'Ethereum'), `${r.slug}: plan names its chain`);
    }
  }
  // Plans differ by protocol (they name the protocol and its chain).
  const plans = new Set(rows.map((r) => r.farm_steps.join('|')));
  assert.ok(plans.size > 200, 'plans are mostly distinct');
});

test('board: gate rows are the shape the scorer reads', () => {
  const { rows } = assemble(snap);
  const gate = gateRows(rows);
  assert.equal(gate.length, 226);
  for (const g of gate) {
    assert.ok(g.slug && !/\s/.test(g.slug));
    assert.ok(g.name.length > 0);
    assert.ok(Number.isInteger(g.rank) && g.rank >= 1);
    assert.ok(Number.isInteger(g.implied_value_usd) && g.implied_value_usd > 0);
    assert.ok(g.farm_steps.length === 3 || g.farm_steps.length === 5);
  }
});

test('board: checksum is db668a77 and the run is deterministic', () => {
  const a = assemble(snap);
  const b = assemble(snap);
  assert.equal(a.fit.checksum, 'db668a77');
  assert.equal(a.fit.checksum, b.fit.checksum);
  assert.equal(a.fit.checksum, boardChecksum(a.rows));
  assert.equal(a.rows[0].implied_value_usd, b.rows[0].implied_value_usd);
  assert.deepEqual(
    a.rows.map((r) => [r.slug, r.implied_value_usd]),
    b.rows.map((r) => [r.slug, r.implied_value_usd]),
  );
});

test('board: checksum is the sha256 of the compact rows as JSON', () => {
  const { rows } = assemble(snap);
  const compact = rows.map((r) => [r.slug, r.rank, r.implied_value_usd]);
  const hex = createHash('sha256').update(JSON.stringify(compact), 'utf8').digest('hex').slice(0, 8);
  assert.equal(hex, 'db668a77');
  assert.match(hex, /^[0-9a-f]{8}$/);
});

test('board: bootstrap intervals are sane and pin the top rows', () => {
  const { rows } = assemble(snap);
  const top = rows[0];
  assert.equal(top.rank_min, 1);
  assert.equal(top.rank_max, 1);
  assert.equal(top.ev_p5, 74_418_826);
  assert.equal(top.ev_p50, 134_856_894);
  assert.equal(top.ev_p95, 241_309_207);
  const fragile = rows.filter((r) => r.fragile).map((r) => r.slug).sort();
  assert.deepEqual(fragile, ['b14g', 'bittensor-dtao', 'r25']);
  const bit = rows.find((r) => r.slug === 'bittensor-dtao')!;
  assert.equal(bit.rank_min, 5);
  assert.equal(bit.rank_max, 23);
  for (const r of rows) {
    assert.ok(r.rank_min >= 1 && r.rank_min <= r.rank, `${r.slug}: lo ${r.rank_min} above rank ${r.rank}`);
    assert.ok(r.rank_max >= r.rank && r.rank_max <= 226, `${r.slug}: hi ${r.rank_max} out of range`);
    if (r.rank <= 20) {
      assert.ok(r.ev_p5 !== null && r.ev_p50 !== null && r.ev_p95 !== null, `${r.slug}: top-20 row lacks EV intervals`);
      assert.ok((r.ev_p5 as number) <= (r.ev_p50 as number), `${r.slug}: P5 above P50`);
      assert.ok((r.ev_p50 as number) <= (r.ev_p95 as number), `${r.slug}: P50 above P95`);
    } else {
      assert.equal(r.ev_p5, null);
      assert.equal(r.rank_min, r.rank);
      assert.equal(r.rank_max, r.rank);
    }
  }
});

test('evidence: the v7 clamp improves the mean on every validation split', () => {
  const base = VALUE_ABLATION.find((a) => a.variant.startsWith('v6 baseline'))!;
  const v7 = VALUE_ABLATION.find((a) => a.variant.startsWith('v7 clamp'))!;
  assert.deepEqual(v7.holdout, VALIDATION_V7.holdout);
  assert.deepEqual(v7.walkFwd50, VALIDATION_V7.walkFwd50);
  assert.deepEqual(v7.walkFwd75, VALIDATION_V7.walkFwd75);
  assert.deepEqual(v7.loo, VALIDATION_V7.loo);
  // Mean improves on all four splits; the median holds on three of four.
  assert.ok(v7.holdout[0] < base.holdout[0], 'holdout mean');
  assert.ok(v7.walkFwd50[0] < base.walkFwd50[0], 'walk-forward 50% mean');
  assert.ok(v7.walkFwd75[0] < base.walkFwd75[0], 'walk-forward 75% mean');
  assert.ok(v7.loo[0] < base.loo[0], 'leave-one-out mean');
  assert.equal(v7.holdout[1], base.holdout[1]);
  assert.equal(v7.walkFwd50[1], base.walkFwd50[1]);
  assert.equal(v7.walkFwd75[1], base.walkFwd75[1]);
  // Dropping the category multipliers hurts the median on every split: they earn their place.
  const noCat = VALUE_ABLATION.find((a) => a.variant === 'no catmult')!;
  assert.ok(noCat.holdout[1] > base.holdout[1]);
  assert.ok(noCat.walkFwd50[1] > base.walkFwd50[1]);
  assert.ok(noCat.walkFwd75[1] > base.walkFwd75[1]);
  assert.ok(noCat.loo[1] > base.loo[1]);
});

test('evidence: odds ablation keeps every term, calibration error is 0.0441', () => {
  const full = ODDS_ABLATION.find((a) => a.variant.startsWith('full'))!;
  const dropAge = ODDS_ABLATION.find((a) => a.variant === 'drop age')!;
  assert.ok(dropAge.logLoss > full.logLoss + 0.07, 'age is the most important odds term');
  assert.ok(dropAge.auc < full.auc - 0.09, 'dropping age costs AUC');
  assert.equal(CALIBRATION.length, 10);
  assert.equal(CALIBRATION_ERROR, 0.0441);
  for (const d of CALIBRATION) {
    assert.ok(d.predicted >= 0 && d.predicted <= 1);
    assert.ok(d.observed >= 0 && d.observed <= 1);
  }
  assert.ok(CALIBRATION[0].predicted < CALIBRATION[9].predicted, 'deciles are ordered');
});

test('plan: a lending plan reads like lending, a bridge plan like a bridge', () => {
  const lending = snap.protocols.find((p) => p.category === 'Lending' && preToken(p))!;
  const bridge = snap.protocols.find((p) => p.category === 'Bridge' && preToken(p))!;
  const lp = farmPlan(lending, 'FARM').join(' ');
  const bp = farmPlan(bridge, 'FARM').join(' ');
  assert.ok(/lend|borrow/i.test(lp), 'lending plan mentions lending');
  assert.ok(/bridge/i.test(bp), 'bridge plan mentions bridging');
  assert.ok(lp.includes(lending.name), 'plan names the protocol');
  assert.ok(lp.includes('$1,000') && lp.includes('$12'), 'lending plan carries the capital and gas');
});

test('model: the frozen odds constants are the documented fit', () => {
  assert.equal(ODDS.bias, 0.28538);
  assert.equal(ODDS.logTvl, 0.3438);
  assert.equal(ODDS.age, 0.89006);
  assert.equal(ODDS.growth, -0.44082);
});
