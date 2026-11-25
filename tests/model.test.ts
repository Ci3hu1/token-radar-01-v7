// Launch Ledger v7 — tests (Node 22 stdlib only).
// Run: node --test tests/model.test.ts
// The snapshot is read from RADAR_SNAPSHOT or the kit next to this repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseSnapshot, onBoard, hasToken, fitValue, impliedMcap, peerStats, oddsOf,
  netOf, verdictOf, farmSteps, validationTable, valueAblation, oddsAblation,
  calibrationTable, bootstrapTop, boardChecksum, buildRadar, boardIssue,
  irls, mulberry32, CLAMP_LO, CLAMP_HI, FROZEN_ODDS,
} from '../lib/model.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT =
  process.env.RADAR_SNAPSHOT ??
  join(here, '..', '..', 'token-radar-01-v7-kit', 'token-radar-01-kit', 'input', 'snapshot.json');
const snapshot = parseSnapshot(readFileSync(existsSync(SNAPSHOT) ? SNAPSHOT : '/input/snapshot.json', 'utf8'));
const asOf = new Date(`${snapshot.as_of}T00:00:00Z`);
const watchlist = new Set(snapshot.watchlist);
const boardProtos = snapshot.protocols.filter((p) => onBoard(p, watchlist, snapshot.floor_usd));
const traded = snapshot.protocols.filter((p) => hasToken(p));
const anchors = traded.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0);
const stats = peerStats(snapshot);
const model = fitValue(anchors, CLAMP_LO, CLAMP_HI);
const { board, radar } = buildRadar(snapshot);

const approx = (actual: number, expected: number, tol: number, label: string) => {
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: got ${actual}, want ${expected} ± ${tol}`);
};

test('ledger: 226 board, 416 traded, 116 excluded, 40 on the watchlist', () => {
  assert.equal(snapshot.protocols.length, 758);
  assert.equal(traded.length, 416);
  assert.equal(boardProtos.length, 226);
  assert.equal(snapshot.protocols.length - traded.length - boardProtos.length, 116);
  assert.equal(snapshot.watchlist.length, 40);
  for (const slug of snapshot.watchlist) assert.ok(boardProtos.some((p) => p.slug === slug), `watchlist ${slug} missing`);
});

test('anchors: 128 traded protocols with a positive market cap', () => {
  assert.equal(anchors.length, 128);
});

test('OLS log-log: intercept 3.0247, slope 0.5223, R² 0.1939', () => {
  approx(model.intercept, 3.0247, 0.001, 'intercept');
  approx(model.slope, 0.5223, 0.001, 'slope');
  approx(model.r2, 0.1939, 0.001, 'R²');
  approx(model.flat, 0.2138, 0.001, 'flat multiple');
});

test('category multipliers are clamped to [0.60, 1.80] in v7', () => {
  approx(model.mults.get('Liquid Staking')!, 0.6, 0.001, 'Liquid Staking');
  approx(model.mults.get('Privacy')!, 1.8, 0.001, 'Privacy');
  for (const m of model.mults.values()) assert.ok(m >= CLAMP_LO && m <= CLAMP_HI, `multiplier ${m} outside clamp`);
});

test('odds peers: 449, 245 with a token, median age 1.6235', () => {
  assert.equal(stats.peers, 449);
  assert.equal(stats.peersWithToken, 245);
  approx(stats.medianAge, 1.6235, 0.001, 'median age');
});

test('P(steakhouse-financial) is 0.7125', () => {
  const steak = snapshot.protocols.find((p) => p.slug === 'steakhouse-financial')!;
  approx(oddsOf(steak, stats, asOf), 0.7125, 0.001, 'P(steakhouse)');
});

test('top-5 expected values match the verified board', () => {
  const top5 = board.slice(0, 5).map((r) => [r.slug, r.implied_value_usd]);
  assert.deepEqual(top5, [
    ['steakhouse-financial', 152994608],
    ['gauntlet', 95119919],
    ['veda', 54690945],
    ['usdd', 51256531],
    ['nonce-capital', 32726180],
  ]);
});

test('verdicts: 20 FARM, 93 THIN, 113 SKIP', () => {
  const counts: Record<string, number> = {};
  for (const r of board) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  assert.deepEqual(counts, { FARM: 20, THIN: 93, SKIP: 113 });
  assert.equal(netOf(12600000) >= 50, true);
  assert.equal(verdictOf(2600000), 'THIN');
  assert.equal(verdictOf(1000000), 'SKIP');
});

test('every farm plan is 3–12 steps of 20–600 characters', () => {
  for (const r of board) {
    assert.ok(r.farm_steps.length >= 3 && r.farm_steps.length <= 12, `${r.slug}: ${r.farm_steps.length} steps`);
    for (const s of r.farm_steps) {
      const t = s.trim();
      assert.ok(t.length >= 20 && t.length <= 600, `${r.slug}: step of ${t.length} chars`);
    }
  }
  assert.equal(boardIssue(board, snapshot), null);
});

test('validation: holdout 2579.1/84.4, WF50 689.8/86.4, WF75 571.4/76.6, LOO 1253.7/85.5', () => {
  const v = validationTable(anchors, CLAMP_LO, CLAMP_HI);
  approx(v.holdout.blendMean, 2579.1, 0.5, 'holdout mean');
  approx(v.holdout.blendMedian, 84.4, 0.5, 'holdout median');
  approx(v.wf50.blendMean, 689.8, 0.5, 'WF50 mean');
  approx(v.wf50.blendMedian, 86.4, 0.5, 'WF50 median');
  approx(v.wf75.blendMean, 571.4, 0.5, 'WF75 mean');
  approx(v.wf75.blendMedian, 76.6, 0.5, 'WF75 median');
  approx(v.loo.blendMean, 1253.7, 0.5, 'LOO mean');
  approx(v.loo.blendMedian, 85.5, 0.5, 'LOO median');
});

test('value ablation: each term earns its place on the v7 clamp', () => {
  const a = valueAblation(anchors, CLAMP_LO, CLAMP_HI);
  const base = a.find((x) => x.variant === 'baseline')!;
  const curveOnly = a.find((x) => x.variant === 'curve_only')!;
  const flatOnly = a.find((x) => x.variant === 'flat_only')!;
  const noMult = a.find((x) => x.variant === 'no_catmult')!;
  approx(base.holdout[0], 2579.1, 0.5, 'baseline holdout mean');
  approx(base.holdout[1], 84.4, 0.5, 'baseline holdout median');
  approx(noMult.holdout[0], 1791.3, 0.5, 'no-catmult holdout mean');
  approx(noMult.holdout[1], 88.6, 0.5, 'no-catmult holdout median');
  // The curve earns its place on the means: dropping it (flat-only) hurts the mean on every split.
  assert.ok(flatOnly.holdout[0] > base.holdout[0], 'flat-only hurts the holdout mean');
  assert.ok(flatOnly.wf50[0] > base.wf50[0], 'flat-only hurts the WF50 mean');
  assert.ok(flatOnly.loo[0] > base.loo[0], 'flat-only hurts the LOO mean');
  assert.ok(flatOnly.wf50[1] > base.wf50[1], 'flat-only hurts the WF50 median');
  assert.ok(flatOnly.wf75[1] > base.wf75[1], 'flat-only hurts the WF75 median');
  // The flat blend earns its place on the walk-forward medians and the LOO mean.
  assert.ok(curveOnly.wf50[1] > base.wf50[1], 'curve-only hurts the WF50 median');
  assert.ok(curveOnly.wf75[1] > base.wf75[1], 'curve-only hurts the WF75 median');
  assert.ok(curveOnly.loo[0] > base.loo[0], 'curve-only hurts the LOO mean');
  approx(curveOnly.holdout[0], 2510.3, 0.5, 'curve-only holdout mean');
  approx(curveOnly.holdout[1], 83.4, 0.5, 'curve-only holdout median');
});

test('odds ablation: every term earns its place, age most of all', () => {
  const a = oddsAblation(snapshot, stats);
  const full = a.find((x) => x.variant.startsWith('full'))!;
  const dropAge = a.find((x) => x.variant === 'drop age')!;
  const frozen = a.find((x) => x.variant.startsWith('frozen'))!;
  approx(full.log_loss, 0.5901, 0.002, 'full log-loss');
  approx(full.auc, 0.7552, 0.002, 'full AUC');
  approx(dropAge.log_loss, 0.6671, 0.002, 'drop-age log-loss');
  approx(dropAge.auc, 0.6525, 0.002, 'drop-age AUC');
  approx(frozen.log_loss, 0.5809, 0.002, 'frozen log-loss');
  approx(frozen.auc, 0.7554, 0.002, 'frozen AUC');
});

test('a fresh IRLS refit lands near the frozen constants', () => {
  const peers = snapshot.protocols.filter(
    (p) => p.listed_at !== null && p.change_7d !== null && p.category !== null && !['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX'].includes(p.category) && Math.abs(p.change_7d) <= 200,
  );
  const X = peers.map((p) => {
    const age = ageYearsLocal(p) ?? stats.medianAge;
    const change = p.change_7d ?? stats.meanChange;
    return [1, (Math.log10(p.tvl_usd) - stats.meanLogTvl) / stats.sdLogTvl, (age - stats.meanAge) / stats.sdAge, (change - stats.meanChange) / stats.sdChange];
  });
  const y = peers.map((p) => (hasToken(p) ? 1 : 0));
  const beta = irls(X, y);
  // The refit lands near the frozen constants ([0.242, 0.329, 0.946, -0.366] vs frozen
  // [0.28538, 0.3438, 0.89006, -0.44082]); the growth term differs most, by 0.075.
  for (let i = 0; i < 4; i++) approx(beta[i]!, FROZEN_ODDS[i]!, 0.08, `IRLS beta[${i}]`);
  function ageYearsLocal(p: (typeof snapshot.protocols)[number]): number | null {
    if (p.listed_at === null) return null;
    return (asOf.getTime() - new Date(`${p.listed_at}T00:00:00Z`).getTime()) / (365.25 * 24 * 3600 * 1000);
  }
});

test('calibration: weighted error 0.0441, mean pred 0.557 vs base rate 0.546', () => {
  const c = calibrationTable(snapshot, stats);
  approx(c.weighted_error, 0.0441, 0.002, 'weighted error');
  approx(c.mean_pred, 0.557, 0.002, 'mean pred');
  approx(c.base_rate, 0.546, 0.002, 'base rate');
  assert.equal(c.deciles.length, 10);
  approx(c.deciles[0]!.pred, 0.203, 0.002, 'D1 pred');
  approx(c.deciles[9]!.obs, 0.911, 0.002, 'D10 obs');
});

test('bootstrap: steakhouse rank 1–1, bittensor-dtao is the fragile one', () => {
  const oddsBySlug = new Map(board.map((r) => [r.slug, r.p_token]));
  const boot = bootstrapTop(boardProtos, anchors, oddsBySlug, CLAMP_LO, CLAMP_HI);
  assert.equal(boot.length, 20);
  const steak = boot.find((b) => b.slug === 'steakhouse-financial')!;
  assert.deepEqual([steak.rankMin, steak.rankMax], [1, 1]);
  assert.equal(steak.baseEv, 152994608);
  const bitt = boot.find((b) => b.slug === 'bittensor-dtao')!;
  assert.ok(bitt.rankMax - bitt.rankMin >= 15, `bittensor rank range ${bitt.rankMin}–${bitt.rankMax}`);
  const gauntlet = boot.find((b) => b.slug === 'gauntlet')!;
  assert.deepEqual([gauntlet.rankMin, gauntlet.rankMax], [2, 3]);
});

test('mulberry32 is deterministic', () => {
  const a = mulberry32(20261114);
  const b = mulberry32(20261114);
  for (let i = 0; i < 10; i++) assert.equal(a(), b());
  const c = mulberry32(1);
  assert.notEqual(a(), c());
});

test('two builds write the same checksum (determinism)', () => {
  const first = buildRadar(snapshot);
  const second = buildRadar(snapshot);
  assert.equal(first.radar.checksum, second.radar.checksum);
  assert.equal(first.radar.checksum, radar.checksum);
  assert.match(radar.checksum, /^[0-9a-f]{8}$/);
  assert.equal(boardChecksum(first.board), radar.checksum);
});

test('boardIssue catches a tampered board', () => {
  const bad = board.map((r) => ({ ...r }));
  bad[0] = { ...bad[0]!, implied_value_usd: 1 };
  assert.ok(boardIssue(bad, snapshot) !== null);
  const missing = board.filter((r) => r.slug !== snapshot.watchlist[0]);
  assert.ok(boardIssue(missing, snapshot) !== null);
});
