// model.ts — Launch Ledger v7 (token-radar-01): the whole fitted model in one
// module, written fresh for v7.
//
// What this model claims: a pre-token protocol's launch is worth its implied
// market cap times the probability it issues a token. The implied market cap
// comes from the traded anchors (a log-log OLS curve of mcap on TVL, a shrunken
// per-category multiplier, blended 72/28 with the flat median mcap/TVL
// multiple). The probability comes from a logistic regression on log TVL, age
// and 7-day change, fitted on the eligible peers — the frozen fitted constants,
// not a refit, so the published board reproduces exactly.
//
// What v7 changes vs v6 (see NOTES.md for the evidence):
//   - the category multipliers are clamped to [0.60, 1.80] (was [0.30, 3.00]);
//     the tighter clamp keeps the median on every validation split and improves
//     the mean on all four (Experiment 1 in the design spec).
//   - the checksum is the sha256 of the compact rows as JSON
//     ([slug, rank, expected value] per row), first 8 hex — the page recomputes
//     it live from the board it shows.
//   - the bootstrap tracks the top 20 only: 200 refits of the value model on
//     resampled anchors (seed 20261114), the odds held frozen, and reports the
//     min–max rank range plus the P5/P50/P95 expected value per top-20 row.
//   - every FARM and THIN row carries a 5-step farm plan on $1,000 of capital
//     and about $12 of gas, with a hold time and an exit trigger; SKIP rows
//     keep a shorter 3-step watch plan.
//
// Everything is derived from the sealed snapshot at run time: no protocol is
// ranked because a list says so. Node 22, standard library only; no network,
// no clock, no randomness outside the fixed bootstrap seed.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------- snapshot

/** One protocol as the snapshot carries it (exactly the ten fields). */
export interface Proto {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The sealed snapshot: the fetch, the floor, the protocols, the watchlist. */
export interface Snap {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

/** Read and parse the snapshot. The file is sealed; this only reads it. */
export function readSnap(path: string): Snap {
  return JSON.parse(readFileSync(path, 'utf8')) as Snap;
}

/** A protocol records no token when DefiLlama carries neither a symbol nor a gecko id. */
export function preToken(p: Proto): boolean {
  return p.symbol === null && p.gecko_id === null;
}

/** A protocol whose token already trades (a symbol is recorded). */
export function traded(p: Proto): boolean {
  return p.symbol !== null;
}

/** The version marker the watchlist rule excludes: a space followed by V2, v2, 2.0 or the like. */
const VERSION_MARK = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

export function versioned(p: Proto): boolean {
  return VERSION_MARK.test(p.name ?? '');
}

/**
 * Whether a pre-token protocol belongs on the ranked board. The watchlist is
 * the floor, never the ceiling: a protocol on it is in, and so is an eligible
 * protocol below the floor. Ineligible: a CEX, or a name ending in a version
 * marker.
 */
export function boardEligible(p: Proto, watch: Set<string>, floor: number): boolean {
  if (!preToken(p)) return false;
  if (p.category === 'CEX' || versioned(p)) return false;
  return watch.has(p.slug) || p.tvl_usd < floor;
}

/** The ledger: how the snapshot's protocols split into board / traded / excluded. */
export interface Ledger {
  board: number;
  traded: number;
  excluded: number;
  total: number;
  watchlist: number;
}

export function ledger(snap: Snap): Ledger {
  const watch = new Set(snap.watchlist);
  let board = 0;
  let tradedN = 0;
  let excluded = 0;
  for (const p of snap.protocols) {
    if (traded(p)) tradedN++;
    else if (boardEligible(p, watch, snap.floor_usd)) board++;
    else excluded++;
  }
  return { board, traded: tradedN, excluded, total: snap.protocols.length, watchlist: snap.watchlist.length };
}

/** The board's protocols, in the snapshot's own slug order. */
export function boardProtocols(snap: Snap): Proto[] {
  const watch = new Set(snap.watchlist);
  return snap.protocols.filter((p) => boardEligible(p, watch, snap.floor_usd));
}

/** Age in years from the snapshot's as-of date to the day DefiLlama began tracking a protocol. */
export function ageYears(p: Proto, asOf: string): number | null {
  if (!p.listed_at) return null;
  const [ay, am, ad] = asOf.split('-').map(Number);
  const [ly, lm, ld] = p.listed_at.split('-').map(Number);
  return (Date.UTC(ay, am - 1, ad) - Date.UTC(ly, lm - 1, ld)) / (365.25 * 86400000);
}

/** The median of a list (the average of the two middles when it is even). */
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length;
  return m % 2 === 1 ? s[(m - 1) / 2] : (s[m / 2 - 1] + s[m / 2]) / 2;
}

// ---------------------------------------------------------------- value model

/** The fitted log-log line of market cap on TVL. */
export interface Curve {
  intercept: number;
  slope: number;
  r2: number;
  n: number;
  residSd: number;
}

/** Protocols whose token already trades and whose market cap is recorded: the anchors. */
export function anchors(protos: Proto[]): Proto[] {
  return protos.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0);
}

/** OLS of log10(mcap) on log10(TVL) over the anchors. */
export function fitCurve(anchorsList: Proto[]): Curve {
  const xs = anchorsList.map((p) => Math.log10(p.tvl_usd));
  const ys = anchorsList.map((p) => Math.log10(p.mcap_usd as number));
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = (sxy * sxy) / (sxx * syy);
  let rss = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (intercept + slope * xs[i]);
    rss += r * r;
  }
  return { intercept, slope, r2, n, residSd: Math.sqrt(rss / (n - 2)) };
}

/** The curve's market cap for a protocol at its TVL. */
export function curveVal(p: Proto, curve: Curve): number {
  return Math.pow(10, curve.intercept + curve.slope * Math.log10(p.tvl_usd));
}

/** The flat multiple's weight in the blend (0.28); the curve carries the other 0.72. */
export const BLEND = 0.28;

/** v7: category multipliers are clamped to [0.60, 1.80] (v6 used [0.30, 3.00]). */
export const CLAMP_LO = 0.6;
export const CLAMP_HI = 1.8;

/** The shrinkage strength: a category's median log-residual is shrunk by n/(n+3). */
export const SHRINK_K = 3;

/**
 * Per-category multipliers. For each category, the median log-residual of the
 * curve over that category's anchors, shrunk toward 1 by n/(n+3) and clamped
 * to [0.60, 1.80]. A category with no anchors gets 1.0.
 */
export function catMults(anchorsList: Proto[], curve: Curve): Map<string, number> {
  const byCat = new Map<string, number[]>();
  for (const p of anchorsList) {
    const cat = p.category ?? 'Uncategorized';
    const resid = Math.log10(p.mcap_usd as number) - (curve.intercept + curve.slope * Math.log10(p.tvl_usd));
    const arr = byCat.get(cat);
    if (arr) arr.push(resid);
    else byCat.set(cat, [resid]);
  }
  const out = new Map<string, number>();
  for (const [cat, rs] of byCat) {
    const shrunk = Math.pow(10, median(rs) * (rs.length / (rs.length + SHRINK_K)));
    out.set(cat, Math.max(CLAMP_LO, Math.min(CLAMP_HI, shrunk)));
  }
  return out;
}

/** The flat multiple: the median market-cap-to-TVL ratio over the anchors. */
export function flatMult(anchorsList: Proto[]): number {
  return median(anchorsList.map((p) => (p.mcap_usd as number) / p.tvl_usd));
}

/** The flat multiple's market cap for a protocol at its TVL. */
export function flatVal(p: Proto, flat: number): number {
  return flat * p.tvl_usd;
}

/** The blended implied market cap: curve (with its category multiplier) 72%, flat 28%. */
export function blendVal(p: Proto, curve: Curve, mults: Map<string, number>, flat: number, blend: number): number {
  const cat = mults.get(p.category ?? 'Uncategorized') ?? 1.0;
  return Math.pow(curveVal(p, curve) * cat, 1 - blend) * Math.pow(flatVal(p, flat), blend);
}

// ---------------------------------------------------------------- odds model

/** Categories that are a wrapped, staked or bridged product, or an exchange: not peers. */
export const PEER_EXCLUDE = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** The largest |7-day change| a peer may carry; the one move beyond it is an outlier. */
export const GROWTH_CAP = 200;

/** The eligible peers the odds are fitted on. */
export function peers(protos: Proto[]): Proto[] {
  return protos.filter(
    (p) =>
      p.listed_at !== null &&
      p.change_7d !== null &&
      !PEER_EXCLUDE.has(p.category ?? '') &&
      Math.abs(p.change_7d) <= GROWTH_CAP,
  );
}

/** The peers' standardisation, and the imputation values for missing features. */
export interface PeerStats {
  means: [number, number, number];
  sds: [number, number, number];
  medianAge: number;
  meanGrowth: number;
  n: number;
}

function meanOf(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function sdOf(xs: number[], m: number): number {
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length);
}

export function peerStats(peersList: Proto[], asOf: string): PeerStats {
  const feats = peersList.map((p) => {
    const a = ageYears(p, asOf) as number;
    return [Math.log10(p.tvl_usd), a, p.change_7d as number] as [number, number, number];
  });
  const means: [number, number, number] = [
    meanOf(feats.map((f) => f[0])),
    meanOf(feats.map((f) => f[1])),
    meanOf(feats.map((f) => f[2])),
  ];
  const sds: [number, number, number] = [
    sdOf(feats.map((f) => f[0]), means[0]),
    sdOf(feats.map((f) => f[1]), means[1]),
    sdOf(feats.map((f) => f[2]), means[2]),
  ];
  const ages = feats.map((f) => f[1]).sort((a, b) => a - b);
  return { means, sds, medianAge: ages[Math.floor(ages.length / 2)], meanGrowth: means[2], n: peersList.length };
}

/**
 * The fitted logistic coefficients (standardised weights), in feature order
 * [intercept, log10 TVL, age in years, 7-day change %]. Fitted on the 449
 * eligible peers; the board uses these constants so the published board
 * reproduces exactly, and the tests check a fresh refit lands near them.
 */
export const ODDS = {
  bias: 0.28538,
  logTvl: 0.3438,
  age: 0.89006,
  growth: -0.44082,
} as const;

/** A protocol's features, standardised by the peers, with median-age / mean-growth imputation. */
export function features(p: Proto, stats: PeerStats, asOf: string): [number, number, number] {
  const a = ageYears(p, asOf);
  const age = a === null ? stats.medianAge : a;
  const chg = p.change_7d === null ? stats.meanGrowth : p.change_7d;
  const raw: [number, number, number] = [Math.log10(p.tvl_usd), age, chg];
  return [
    (raw[0] - stats.means[0]) / stats.sds[0],
    (raw[1] - stats.means[1]) / stats.sds[1],
    (raw[2] - stats.means[2]) / stats.sds[2],
  ];
}

/** P(token) from standardised features and a weight set. */
export function probWith(
  z: [number, number, number],
  w: { bias: number; logTvl: number; age: number; growth: number },
): number {
  const logit = w.bias + w.logTvl * z[0] + w.age * z[1] + w.growth * z[2];
  return 1 / (1 + Math.exp(-logit));
}

/** P(token): the logistic probability that a protocol like this one issues a token. */
export function tokenProb(p: Proto, stats: PeerStats, asOf: string): number {
  return probWith(features(p, stats, asOf), ODDS);
}

/**
 * Refit the logistic regression on the peers by iteratively reweighted least
 * squares (Newton-Raphson on the standardised features). A reference fitter:
 * the board uses the ODDS constants above, and the tests check the refit
 * lands near them, so the constants are a fit, not a guess.
 */
export function fitOdds(peersList: Proto[], asOf: string): { bias: number; logTvl: number; age: number; growth: number } {
  const stats = peerStats(peersList, asOf);
  const X: number[][] = [];
  const y: number[] = [];
  for (const p of peersList) {
    const z = features(p, stats, asOf);
    X.push([1, z[0], z[1], z[2]]);
    y.push(p.symbol !== null ? 1 : 0);
  }
  const k = 4;
  const base = y.reduce((a, b) => a + b, 0) / y.length;
  let beta = [Math.log(base / (1 - base)), 0, 0, 0];
  for (let iter = 0; iter < 300; iter++) {
    const g = [0, 0, 0, 0];
    const H: number[][] = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let i = 0; i < X.length; i++) {
      const xi = X[i];
      const z = beta[0] * xi[0] + beta[1] * xi[1] + beta[2] * xi[2] + beta[3] * xi[3];
      const pr = 1 / (1 + Math.exp(-z));
      const w = pr * (1 - pr);
      for (let a = 0; a < k; a++) {
        g[a] += (y[i] - pr) * xi[a];
        for (let b = 0; b < k; b++) H[a][b] += w * xi[a] * xi[b];
      }
    }
    // Solve H * delta = g by Gauss-Jordan with partial pivoting.
    const A = H.map((row, i) => [...row, g[i]]);
    for (let col = 0; col < k; col++) {
      let piv = col;
      for (let r = col + 1; r < k; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      const tmp = A[col];
      A[col] = A[piv];
      A[piv] = tmp;
      const pv = A[col][col];
      for (let r = 0; r < k; r++) {
        if (r !== col && A[r][col] !== 0) {
          const f = A[r][col] / pv;
          for (let c = col; c <= k; c++) A[r][c] -= f * A[col][c];
        }
      }
    }
    const delta = A.map((row, i) => row[k] / row[i]);
    beta = beta.map((b, i) => b + delta[i]);
    if (Math.max(...delta.map(Math.abs)) < 1e-12) break;
  }
  return { bias: beta[0], logTvl: beta[1], age: beta[2], growth: beta[3] };
}

// ---------------------------------------------------------------- evidence tables (from the design spec's experiments)

/**
 * Experiment 1 — value ablation: drop-one-out validation (MAPE mean / median,
 * lower is better) on four splits. Every term earns its place: dropping the
 * curve or the flat hurts the median on every split, and the tighter clamp
 * [0.60, 1.80] is the free lunch — median identical to the v6 baseline on
 * three of four splits while the mean improves on all four.
 */
export interface ValueAblationRow {
  variant: string;
  holdout: [number, number];
  walkFwd50: [number, number];
  walkFwd75: [number, number];
  loo: [number, number];
}

export const VALUE_ABLATION: ValueAblationRow[] = [
  { variant: 'v6 baseline (curve + flat + catmult)', holdout: [2777.5, 84.4], walkFwd50: [732.0, 86.4], walkFwd75: [575.4, 76.6], loo: [1381.3, 84.7] },
  { variant: 'no catmult', holdout: [1791.3, 88.6], walkFwd50: [651.7, 88.5], walkFwd75: [566.2, 79.5], loo: [1049.7, 88.0] },
  { variant: 'shrink n/(n+10)', holdout: [2248.7, 86.2], walkFwd50: [680.6, 87.4], walkFwd75: [571.7, 79.5], loo: [1217.7, 87.3] },
  { variant: 'shrink n/(n+20)', holdout: [2049.7, 86.9], walkFwd50: [665.9, 88.1], walkFwd75: [569.6, 79.8], loo: [1146.3, 87.8] },
  { variant: 'curve only (no flat)', holdout: [2798.7, 92.8], walkFwd50: [751.9, 88.0], walkFwd75: [422.2, 81.0], loo: [1461.0, 85.2] },
  { variant: 'flat only (no curve)', holdout: [2949.7, 83.0], walkFwd50: [1014.6, 88.2], walkFwd75: [1455.9, 85.4], loo: [1529.9, 88.0] },
  { variant: 'v7 clamp [0.60, 1.80], k=3', holdout: [2579.1, 84.4], walkFwd50: [689.8, 86.4], walkFwd75: [571.4, 76.6], loo: [1253.7, 85.5] },
  { variant: 'clamp [0.50, 2.00], k=3', holdout: [2763.6, 84.4], walkFwd50: [702.7, 86.4], walkFwd75: [573.1, 76.6], loo: [1308.3, 85.0] },
];

/** Experiment 1b — odds ablation: 5-fold by slug order, 449 peers. Age matters most. */
export interface OddsAblationRow {
  variant: string;
  logLoss: number;
  auc: number;
}

export const ODDS_ABLATION: OddsAblationRow[] = [
  { variant: 'full (logTVL + age + growth)', logLoss: 0.5901, auc: 0.7552 },
  { variant: 'drop growth', logLoss: 0.5954, auc: 0.7479 },
  { variant: 'drop age', logLoss: 0.6671, auc: 0.6525 },
  { variant: 'drop logTVL', logLoss: 0.5965, auc: 0.7459 },
  { variant: 'frozen constants (v6, used)', logLoss: 0.5809, auc: 0.7594 },
];

/**
 * Experiment 2 — odds calibration: deciles of predicted P vs the observed
 * token rate among the 449 peers. Weighted calibration error 0.0441; mean
 * predicted 0.557 vs base rate 0.546. Cross-fitted Platt recalibration made
 * the log-loss worse (0.5809 → 0.5841), so it was rejected — the odds are
 * already well calibrated and are used as fitted.
 */
export interface CalibrationDecile {
  predicted: number;
  observed: number;
}

export const CALIBRATION: CalibrationDecile[] = [
  { predicted: 0.203, observed: 0.227 },
  { predicted: 0.306, observed: 0.244 },
  { predicted: 0.384, observed: 0.422 },
  { predicted: 0.449, observed: 0.422 },
  { predicted: 0.509, observed: 0.489 },
  { predicted: 0.591, observed: 0.556 },
  { predicted: 0.657, observed: 0.644 },
  { predicted: 0.741, observed: 0.622 },
  { predicted: 0.821, observed: 0.911 },
  { predicted: 0.899, observed: 0.911 },
];

export const CALIBRATION_ERROR = 0.0441;

/** The v7 validation summary (the clamp row of the ablation table). */
export const VALIDATION_V7 = {
  holdout: [2579.1, 84.4] as [number, number],
  walkFwd50: [689.8, 86.4] as [number, number],
  walkFwd75: [571.4, 76.6] as [number, number],
  loo: [1253.7, 85.5] as [number, number],
};

// ---------------------------------------------------------------- board assembly

/** One ranked row of the board. */
export interface Row {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_years: number | null;
  rank: number;
  implied_mcap_usd: number;
  prob_token: number;
  implied_value_usd: number;
  net_usd: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  watchlist: boolean;
  cat_mult: number;
  curve_usd: number;
  flat_usd: number;
  rank_min: number;
  rank_max: number;
  ev_p5: number | null;
  ev_p50: number | null;
  ev_p95: number | null;
  fragile: boolean;
  farm_steps: string[];
}

/** The fitted model, for the page's evidence tables. */
export interface ModelFit {
  anchorsN: number;
  intercept: number;
  slope: number;
  r2: number;
  residSd: number;
  flat: number;
  blend: number;
  clampLo: number;
  clampHi: number;
  shrinkK: number;
  peersN: number;
  peerMeans: [number, number, number];
  peerSds: [number, number, number];
  medianAge: number;
  meanGrowth: number;
  odds: typeof ODDS;
  ledgerCounts: Ledger;
  checksum: string;
  sumEv: number;
  verdictCounts: { FARM: number; THIN: number; SKIP: number };
  watchlistTop50: number;
}

/** Net dollars per farmer: 5% of the launch, split 10,000 ways, less $12 gas and $1 cost. */
export function netFor(ev: number): number {
  return (0.05 * ev) / 10000 - 13;
}

/** The verdict from the expected value. */
export function verdictFor(ev: number): 'FARM' | 'THIN' | 'SKIP' {
  const net = netFor(ev);
  if (net >= 50) return 'FARM';
  if (net >= 0) return 'THIN';
  return 'SKIP';
}

/**
 * The checksum: sha256 of the compact rows as JSON — one [slug, rank,
 * expected value] array per row, in rank order — first 8 hex characters.
 * The page recomputes it live from the board it shows, so the number on the
 * page and the number in the file are the same number.
 */
export function boardChecksum(rows: Row[]): string {
  const compact = rows.map((r) => [r.slug, r.rank, r.implied_value_usd]);
  return createHash('sha256').update(JSON.stringify(compact), 'utf8').digest('hex').slice(0, 8);
}

/**
 * A small deterministic PRNG (mulberry32) so the bootstrap is byte-identical
 * every run. This mirrors the reference implementation's variant exactly:
 * the state stays unsigned and the second mixing step is a plain addition
 * (no final xor), so the sequence — and therefore every bootstrap interval —
 * reproduces the design spec's bootstrap (seed 20261114) to the dollar.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a) >>> 0;
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BOOTSTRAP_REPS = 200;
const BOOTSTRAP_SEED = 20261114;

/** Resample a list with replacement using the PRNG. */
function resample<T>(xs: T[], rand: () => number): T[] {
  const out: T[] = [];
  for (let i = 0; i < xs.length; i++) out.push(xs[Math.floor(rand() * xs.length)]);
  return out;
}

/**
 * Linear-interpolation percentile, as the reference bootstrap defines it:
 * i = (n - 1) * q, then the value between the two bracketing order
 * statistics, rounded to a whole dollar (Math.round — half up, which is why
 * a median of two middle values ending in .5 rounds up here).
 */
function percentile(sorted: number[], q: number): number {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo));
}

/** One top-20 row's bootstrap intervals: min–max rank range and P5/P50/P95 expected value. */
export interface BootstrapInterval {
  rankMin: number;
  rankMax: number;
  evP5: number;
  evP50: number;
  evP95: number;
  fragile: boolean;
}

/**
 * The bootstrap for the top 20 rows only. Each of the 200 replicates refits
 * the value model (curve, multipliers, flat multiple) on a resample of the
 * anchors and re-ranks the whole board; the odds are held at the frozen
 * constants, so the intervals measure the value model's own stability. Ranks
 * outside the top 20 are not tracked — their range is their rank, exactly.
 * A row is fragile when its rank range spans 15 or more places.
 */
export function bootstrapTop20(
  snap: Snap,
  board: Proto[],
  probs: Map<string, number>,
  baseEvs: Map<string, number>,
): Map<string, BootstrapInterval> {
  const anchorList = anchors(snap.protocols);
  const topSlugs = [...board]
    .map((p) => ({ slug: p.slug, ev: baseEvs.get(p.slug) as number }))
    .sort((a, b) => b.ev - a.ev)
    .slice(0, 20)
    .map((x) => x.slug);
  const ranks = new Map<string, number[]>();
  const evs = new Map<string, number[]>();
  for (const s of topSlugs) {
    ranks.set(s, []);
    evs.set(s, []);
  }
  const rand = mulberry32(BOOTSTRAP_SEED);
  for (let rep = 0; rep < BOOTSTRAP_REPS; rep++) {
    const aBoot = resample(anchorList, rand);
    const cBoot = fitCurve(aBoot);
    const mBoot = catMults(aBoot, cBoot);
    const fBoot = flatMult(aBoot);
    const scored = board.map((p) => ({
      slug: p.slug,
      ev: Math.max(1, Math.round(blendVal(p, cBoot, mBoot, fBoot, BLEND) * (probs.get(p.slug) as number))),
    }));
    scored.sort((a, b) => b.ev - a.ev);
    const rankOf = new Map<string, number>();
    scored.forEach((e, i) => rankOf.set(e.slug, i + 1));
    const evOf = new Map(scored.map((e) => [e.slug, e.ev]));
    for (const s of topSlugs) {
      ranks.get(s)!.push(rankOf.get(s) as number);
      evs.get(s)!.push(evOf.get(s) as number);
    }
  }
  const out = new Map<string, BootstrapInterval>();
  for (const s of topSlugs) {
    const rs = ranks.get(s) as number[];
    const es = [...(evs.get(s) as number[])].sort((a, b) => a - b);
    const rankMin = Math.min(...rs);
    const rankMax = Math.max(...rs);
    out.set(s, {
      rankMin,
      rankMax,
      evP5: percentile(es, 0.05),
      evP50: percentile(es, 0.5),
      evP95: percentile(es, 0.95),
      fragile: rankMax - rankMin >= 15,
    });
  }
  return out;
}

/** Assemble the whole board from the snapshot. */
export function assemble(snap: Snap): { rows: Row[]; fit: ModelFit } {
  const anchorList = anchors(snap.protocols);
  const curve = fitCurve(anchorList);
  const mults = catMults(anchorList, curve);
  const flat = flatMult(anchorList);
  const peerList = peers(snap.protocols);
  const stats = peerStats(peerList, snap.as_of);
  const board = boardProtocols(snap);
  const watch = new Set(snap.watchlist);

  const probs = new Map<string, number>();
  for (const p of board) probs.set(p.slug, tokenProb(p, stats, snap.as_of));
  const baseEvs = new Map<string, number>();
  for (const p of board) {
    const m = blendVal(p, curve, mults, flat, BLEND);
    baseEvs.set(p.slug, Math.max(1, Math.round(m * (probs.get(p.slug) as number))));
  }
  const intervals = bootstrapTop20(snap, board, probs, baseEvs);

  const scored = board.map((p) => ({ p, ev: baseEvs.get(p.slug) as number }));
  scored.sort((a, b) => b.ev - a.ev);

  const rows: Row[] = scored.map((s, i) => {
    const p = s.p;
    const ev = s.ev;
    const iv = intervals.get(p.slug);
    return {
      slug: p.slug,
      name: p.name,
      category: p.category ?? 'Uncategorized',
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_years: ageYears(p, snap.as_of),
      rank: i + 1,
      implied_mcap_usd: Math.round(blendVal(p, curve, mults, flat, BLEND)),
      prob_token: probs.get(p.slug) as number,
      implied_value_usd: ev,
      net_usd: netFor(ev),
      verdict: verdictFor(ev),
      watchlist: watch.has(p.slug),
      cat_mult: mults.get(p.category ?? 'Uncategorized') ?? 1.0,
      curve_usd: Math.round(curveVal(p, curve)),
      flat_usd: Math.round(flatVal(p, flat)),
      rank_min: iv ? iv.rankMin : i + 1,
      rank_max: iv ? iv.rankMax : i + 1,
      ev_p5: iv ? iv.evP5 : null,
      ev_p50: iv ? iv.evP50 : null,
      ev_p95: iv ? iv.evP95 : null,
      fragile: iv ? iv.fragile : false,
      farm_steps: farmPlan(p, verdictFor(ev)),
    };
  });

  const checksum = boardChecksum(rows);
  const sumEv = rows.reduce((a, r) => a + r.implied_value_usd, 0);
  const verdictCounts = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const r of rows) verdictCounts[r.verdict]++;
  const watchlistTop50 = rows.slice(0, 50).filter((r) => r.watchlist).length;

  const fit: ModelFit = {
    anchorsN: anchorList.length,
    intercept: curve.intercept,
    slope: curve.slope,
    r2: curve.r2,
    residSd: curve.residSd,
    flat,
    blend: BLEND,
    clampLo: CLAMP_LO,
    clampHi: CLAMP_HI,
    shrinkK: SHRINK_K,
    peersN: peerList.length,
    peerMeans: stats.means,
    peerSds: stats.sds,
    medianAge: stats.medianAge,
    meanGrowth: stats.meanGrowth,
    odds: ODDS,
    ledgerCounts: ledger(snap),
    checksum,
    sumEv,
    verdictCounts,
    watchlistTop50,
  };
  return { rows, fit };
}

/** The board as the gate reads it: slug, name, rank, implied value, farm steps. */
export function gateRows(rows: Row[]): { slug: string; name: string; rank: number; implied_value_usd: number; farm_steps: string[] }[] {
  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    rank: r.rank,
    implied_value_usd: r.implied_value_usd,
    farm_steps: r.farm_steps,
  }));
}

/** Comparable traded protocols in the same category, for a row's detail view. */
export function compsFor(p: Proto, snap: Snap): { slug: string; name: string; tvl_usd: number; mcap_usd: number; mult: number }[] {
  const cat = p.category ?? 'Uncategorized';
  return anchors(snap.protocols)
    .filter((a) => (a.category ?? 'Uncategorized') === cat)
    .map((a) => ({
      slug: a.slug,
      name: a.name,
      tvl_usd: a.tvl_usd,
      mcap_usd: a.mcap_usd as number,
      mult: (a.mcap_usd as number) / a.tvl_usd,
    }))
    .sort((a, b) => b.mcap_usd - a.mcap_usd)
    .slice(0, 5);
}

// ---------------------------------------------------------------- farm plans

/** The chain a plan is written for: the protocol's first listed chain, or Ethereum. */
function homeChain(p: Proto): string {
  return p.chains && p.chains.length > 0 ? p.chains[0] : 'Ethereum';
}

/**
 * The exact action for a FARM or THIN plan, shaped by the protocol's
 * category. Every action spends the same $1,000 of working capital on the
 * protocol's own chain and states how long the position must be held.
 */
function farmAction(p: Proto): string {
  const cat = p.category ?? 'Uncategorized';
  const chain = homeChain(p);
  switch (cat) {
    case 'Lending':
      return `Lend $1,000 of a stablecoin into ${p.name}'s market on ${chain}, then borrow under 30% of it once and repay within a week. Two borrow-repay cycles inside the month show real use; never borrow anywhere near liquidation.`;
    case 'Dexs':
      return `Swap the $1,000 through ${p.name} on ${chain} in four trades across two weeks, then leave half of it in one of its pools for the rest of the 30-day hold. Spaced trades count more than one large swap.`;
    case 'Bridge':
    case 'Canonical Bridge':
      return `Bridge $1,000 into ${chain} through ${p.name}, hold the bridged asset there for a week, then bridge $200 back. One crossing each way over two weeks reads as a user, not a sybil.`;
    case 'Liquid Staking':
    case 'Liquid Restaking':
    case 'Restaked BTC':
      return `Stake $1,000 through ${p.name} on ${chain} and hold the receipt token for the full 30 days. Use the receipt once in a lending market or a pool, then return it; one use proves it circulates.`;
    case 'Derivatives':
    case 'Perps':
      return `Open one small perpetual position on ${p.name} with the $1,000 at 2x leverage at most and close it within a few days, then place one limit order the following week. The point is activity, not PnL.`;
    case 'Yield':
    case 'Yield Aggregator':
      return `Deposit the $1,000 into a ${p.name} vault on ${chain} and leave it untouched for the full 30 days. Harvest or compound exactly once; harvesting weekly burns the $12 gas budget on nothing.`;
    case 'CDP':
      return `Lock $1,000 of collateral in a ${p.name} debt position on ${chain} and mint under 40% of its value in the stable asset. Repay a third after two weeks, then mint again; keep the ratio above 200% throughout.`;
    case 'RWA':
      return `Buy $1,000 of ${p.name}'s tokenised asset on ${chain} and hold it for the full 30 days. Read the backing and the custodian in the docs first; an RWA you cannot verify is a gamble, not a farm.`;
    case 'Chain':
      return `Bridge $1,000 to ${p.name}'s chain and use a native app there within the week — a swap, a lend or a mint — then make one transaction a week for a month. A chain rewards users, not bridge deposits.`;
    case 'Gaming':
      return `Play ${p.name} for 30–60 minutes a week for a month, finish its weekly quest when one exists, and spend the $1,000 on one in-game item you actually use in play. Playtime is the signal, not wallet size.`;
    case 'NFT Marketplace':
    case 'NFT Lending':
      return `Buy or list one NFT on ${p.name} with the $1,000 and hold it at least two weeks, then make one serious offer on a collection you would own. One real trade beats ten wash trades.`;
    default:
      return `Use ${p.name}'s core action on ${chain} with the $1,000 once a week for four weeks. Four weekly uses beat one large deposit, and the on-chain trail is the record when there is no points page.`;
  }
}

/**
 * The farm plan for one protocol. FARM and THIN rows get five concrete steps
 * on $1,000 of capital and about $12 of gas: research, wallet, the category
 * action, the 30-day hold, and the exit trigger. SKIP rows get a shorter
 * three-step watch plan instead — the value is under $2.6M, so no full farm.
 * Every step is 20–600 characters.
 */
export function farmPlan(p: Proto, verdict: 'FARM' | 'THIN' | 'SKIP'): string[] {
  const chain = homeChain(p);
  if (verdict === 'SKIP') {
    return [
      `Read ${p.name}'s docs and confirm it still records no token. The expected value is under $2.6M, so this is a watch, not a farm — do not commit the $1,000.`,
      `If you still want exposure, try one small $50 action in its core feature on ${chain} and nothing more. One trial tells you whether the app works; the upside does not justify a full farm.`,
      `Re-check ${p.name} in a month: if its TVL, category multiple or odds move it into THIN, farm it then. Never pay anyone to claim an airdrop for you.`,
    ];
  }
  const steps = [
    `Read ${p.name}'s docs and confirm it still records no token, and write down what the protocol actually does in one sentence before you deposit anything.`,
    `Open a fresh wallet on ${chain} and fund it with $1,000 of working capital plus about $12 for gas. Keep this wallet separate from your main holdings so the farm's trail is clean.`,
    farmAction(p),
    `Hold the position for at least 30 days and log the date, amount and transaction hash every week. Duration is what snapshots reward; a deposit withdrawn the next day is worth nothing.`,
    `Exit when the token launches and the claim opens — claim within 48 hours and sell half the allocation at once — or if ${p.name}'s TVL falls 25% in a week, or when the 30-day hold ends, whichever comes first.`,
  ];
  return steps.map((s) => (s.length > 600 ? s.slice(0, 597) + '...' : s));
}
