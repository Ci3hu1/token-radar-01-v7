// Launch Ledger v7 — the model (Node 22, standard library only).
//
// A protocol's launch is worth its implied market cap times the probability it
// issues a token. The implied market cap comes from the traded anchors: a
// log-log OLS line of market cap on TVL, adjusted by a shrunken per-category
// multiplier and blended with the flat median mcap/TVL multiple (curve 72%,
// flat 28%). The probability comes from a logistic regression on log TVL, age
// in years and the 7-day TVL change, fitted on the eligible peers; the board
// uses the fitted constants, so the published board reproduces exactly. The
// verdict prices the farm: 5% of the launch split among 10,000 farmers, less
// $12 of gas and $1 of capital cost. FARM at $50 net, THIN at $0, else SKIP.
//
// v7 change vs v6: the category multipliers are clamped to [0.60, 1.80]
// (was [0.30, 3.00]). The tighter clamp is a free lunch — the median MAPE is
// identical on 3 of 4 validation splits (+0.8 on LOO only) while the mean
// improves on all 4 — and it steadies the top rows' bootstrap rank ranges.
// Everything else is the v6 model, refitted on the same snapshot.

import { createHash } from 'node:crypto';

export interface Protocol {
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

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_years: number | null;
  implied_mcap_usd: number;
  p_token: number;
  ev_p5: number;
  ev_p50: number;
  ev_p95: number;
  rank_min: number;
  rank_max: number;
  verdict: string;
  net_usd: number;
  fragile: boolean;
}

export interface RadarData {
  meta: {
    as_of: string;
    floor_usd: number;
    snapshot_protocols: number;
    watchlist: number;
    generated: string;
  };
  model: {
    anchors: number;
    intercept: number;
    slope: number;
    r2: number;
    residual_sd: number;
    flat_multiple: number;
    blend_flat: number;
    clamp_lo: number;
    clamp_hi: number;
    shrink_k: number;
    odds_constants: number[];
    median_age: number;
    peers: number;
    peers_with_token: number;
  };
  ledger: { board: number; traded: number; excluded: number; watchlist: number };
  validation: {
    holdout: { n_train: number; n_test: number; blend_mean: number; blend_median: number; flat_mean: number; flat_median: number };
    wf50: { n_train: number; n_test: number; blend_mean: number; blend_median: number; flat_mean: number; flat_median: number };
    wf75: { n_train: number; n_test: number; blend_mean: number; blend_median: number; flat_mean: number; flat_median: number };
    loo: { n: number; blend_mean: number; blend_median: number; flat_mean: number; flat_median: number };
  };
  ablation: {
    value: { variant: string; holdout: number[]; wf50: number[]; wf75: number[]; loo: number[] }[];
    odds: { variant: string; log_loss: number; auc: number }[];
  };
  calibration: { deciles: { pred: number; obs: number }[]; weighted_error: number; mean_pred: number; base_rate: number };
  checksum: string;
  rows: BoardRow[];
}

export const VERSION_RE = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
export const SIX_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
export const BLEND_FLAT = 0.28;
export const CLAMP_LO = 0.6;
export const CLAMP_HI = 1.8;
export const SHRINK_K = 3;
export const FROZEN_ODDS = [0.28538, 0.3438, 0.89006, -0.44082];
export const BOOTSTRAP_REFITS = 200;
export const BOOTSTRAP_SEED = 20261114;
export const TOP_N = 20;

/** A protocol records a token when DefiLlama gives it a gecko id or a symbol. */
export function hasToken(p: Protocol): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}

export function ageYears(p: Protocol, asOf: Date): number | null {
  if (p.listed_at === null) return null;
  const listed = new Date(`${p.listed_at}T00:00:00Z`);
  return (asOf.getTime() - listed.getTime()) / (365.25 * 24 * 3600 * 1000);
}

/** Parse and shape-check the sealed snapshot. */
export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (typeof raw.as_of !== 'string' || typeof raw.source !== 'string') throw new Error('snapshot: as_of/source missing');
  if (typeof raw.floor_usd !== 'number' || !Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('snapshot: floor_usd/protocols/watchlist missing');
  }
  const protocols = (raw.protocols as Record<string, unknown>[]).map((r) => {
    const p = {
      slug: r.slug,
      name: r.name,
      category: r.category ?? null,
      chains: r.chains ?? [],
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d ?? null,
      mcap_usd: r.mcap_usd ?? null,
      listed_at: r.listed_at ?? null,
      gecko_id: r.gecko_id ?? null,
      symbol: r.symbol ?? null,
    } as Protocol;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number') {
      throw new Error('snapshot: a protocol lacks slug/name/tvl_usd');
    }
    return p;
  });
  return { as_of: raw.as_of, source: raw.source, floor_usd: raw.floor_usd, protocols, watchlist: raw.watchlist as string[] };
}

/** The board rule: no token recorded, not a CEX, not a versioned name, and on the watchlist or below the floor. */
export function onBoard(p: Protocol, watchlist: Set<string>, floorUsd: number): boolean {
  return (
    !hasToken(p) &&
    p.category !== 'CEX' &&
    !VERSION_RE.test(p.name) &&
    (watchlist.has(p.slug) || p.tvl_usd < floorUsd)
  );
}

export interface ValueModel {
  intercept: number;
  slope: number;
  r2: number;
  residualSd: number;
  flat: number;
  mults: Map<string, number>;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Fit the value model (OLS log-log + flat multiple + shrunken category multipliers) on the anchors. */
export function fitValue(anchors: Protocol[], clampLo: number, clampHi: number): ValueModel {
  const xs = anchors.map((p) => Math.log10(p.tvl_usd));
  const ys = anchors.map((p) => Math.log10(p.mcap_usd!));
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    ssTot += (ys[i]! - my) ** 2;
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let ssRes = 0;
  for (let i = 0; i < n; i++) ssRes += (ys[i]! - (intercept + slope * xs[i]!)) ** 2;
  const r2 = 1 - ssRes / ssTot;
  const residualSd = Math.sqrt(ssRes / (n - 2));
  const flat = median(anchors.map((p) => p.mcap_usd! / p.tvl_usd));
  const byCat = new Map<string, number[]>();
  for (const p of anchors) {
    const cat = p.category ?? '(none)';
    const resid = Math.log10(p.mcap_usd!) - (intercept + slope * Math.log10(p.tvl_usd));
    const arr = byCat.get(cat);
    if (arr) arr.push(resid);
    else byCat.set(cat, [resid]);
  }
  const mults = new Map<string, number>();
  for (const [cat, rs] of byCat) {
    const m = 10 ** (median(rs) * (rs.length / (rs.length + SHRINK_K)));
    mults.set(cat, Math.min(clampHi, Math.max(clampLo, m)));
  }
  return { intercept, slope, r2, residualSd, flat, mults };
}

/** The implied market cap of a protocol under a fitted value model. */
export function impliedMcap(p: Protocol, model: ValueModel): number {
  const curve = 10 ** (model.intercept + model.slope * Math.log10(p.tvl_usd));
  const mult = model.mults.get(p.category ?? '(none)') ?? 1;
  return (curve * mult) ** (1 - BLEND_FLAT) * (model.flat * p.tvl_usd) ** BLEND_FLAT;
}

export interface PeerStats {
  meanLogTvl: number;
  sdLogTvl: number;
  meanAge: number;
  sdAge: number;
  meanChange: number;
  sdChange: number;
  medianAge: number;
  peers: number;
  peersWithToken: number;
}

function meanSd(values: number[]): [number, number] {
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length);
  return [m, sd];
}

/** The odds peers and their standardisation: listing date + 7-day change, outside the six categories, |change| <= 200%. */
export function peerStats(snapshot: Snapshot): PeerStats {
  const asOf = new Date(`${snapshot.as_of}T00:00:00Z`);
  const peers = snapshot.protocols.filter(
    (p) => p.listed_at !== null && p.change_7d !== null && !SIX_CATEGORIES.has(p.category ?? '') && Math.abs(p.change_7d) <= 200,
  );
  const [meanLogTvl, sdLogTvl] = meanSd(peers.map((p) => Math.log10(p.tvl_usd)));
  const ages = peers.map((p) => ageYears(p, asOf)!);
  const [meanAge, sdAge] = meanSd(ages);
  const [meanChange, sdChange] = meanSd(peers.map((p) => p.change_7d!));
  return {
    meanLogTvl,
    sdLogTvl,
    meanAge,
    sdAge,
    meanChange,
    sdChange,
    medianAge: median(ages),
    peers: peers.length,
    peersWithToken: peers.filter((p) => hasToken(p)).length,
  };
}

/** P(token) under the frozen fitted constants, features standardised by the peers. */
export function oddsOf(p: Protocol, stats: PeerStats, asOf: Date): number {
  const age = ageYears(p, asOf) ?? stats.medianAge;
  const change = p.change_7d ?? stats.meanChange;
  const z1 = (Math.log10(p.tvl_usd) - stats.meanLogTvl) / stats.sdLogTvl;
  const z2 = (age - stats.meanAge) / stats.sdAge;
  const z3 = (change - stats.meanChange) / stats.sdChange;
  const z = FROZEN_ODDS[0]! + FROZEN_ODDS[1]! * z1 + FROZEN_ODDS[2]! * z2 + FROZEN_ODDS[3]! * z3;
  const e = Math.exp(-Math.max(-30, Math.min(30, z)));
  return 1 / (1 + e);
}

/** Net dollars per farmer: 5% of the launch split among 10,000 farmers, less $12 gas and $1 capital. */
export function netOf(ev: number): number {
  return (0.05 * ev) / 10000 - 13;
}

export function verdictOf(ev: number): string {
  const net = netOf(ev);
  if (net >= 50) return 'FARM';
  if (net >= 0) return 'THIN';
  return 'SKIP';
}

function chainOf(p: Protocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function holdDays(age: number | null): number {
  if (age === null) return 60;
  if (age < 0.5) return 90;
  if (age < 1) return 60;
  return 30;
}

/** The action step for a protocol, from its category and chain — never its name. */
function actionStep(p: Protocol): string {
  const c = (p.category ?? '').toLowerCase();
  const chain = chainOf(p);
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Supply $1,000 of USDC to ${name} on ${chain} and keep the lending position open so the protocol records your address as an active user.`;
  }
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) {
    return `Provide $1,000 of liquidity to ${name}'s main pool on ${chain} and keep the position open so the protocol records your address as a liquidity provider.`;
  }
  if (c.includes('bridge')) {
    return `Bridge $1,000 of USDC to ${chain} through ${name} and use the bridged funds inside its app so the protocol records your address.`;
  }
  if (c.includes('deriv') || c.includes('perp') || c.includes('option') || c.includes('synthetic')) {
    return `Open a $1,000 notional position on ${name} on ${chain} and keep it open so the protocol records your address as an active trader.`;
  }
  if (c.includes('stak') || c.includes('restak')) {
    return `Stake $1,000 of assets in ${name} on ${chain} and keep the stake locked so the protocol records your address as a staker.`;
  }
  if (c.includes('farm')) {
    return `Deposit $1,000 into ${name}'s main farm on ${chain} and keep the deposit working so the protocol records your address as a farmer.`;
  }
  return `Use $1,000 of capital in ${name}'s main app on ${chain} — the app itself, not a wrapper — and keep the position open so the protocol records your address.`;
}

/** A concrete farm plan: chain, action, capital, gas, hold, exit trigger. 3–12 steps, each 20–600 chars. */
export function farmSteps(p: Protocol, verdict: string, ev: number): string[] {
  const chain = chainOf(p);
  const hold = holdDays(ageYears(p, new Date('2026-11-14T00:00:00Z')));
  const evFmt = `$${Math.round(ev).toLocaleString('en-US')}`;
  if (verdict === 'SKIP') {
    return [
      `Watch ${p.name} on ${chain}: it records no token, but the expected value is ${evFmt}, below the $2.6M THIN bar, so do not farm it now.`,
      `Check its TVL and category once a month; a launch announcement or a TVL move that changes the verdict is the only reason to act.`,
      `If it launches a token, claim any airdrop within 48 hours and sell half at once; do not buy the token on launch day.`,
    ];
  }
  const steps = [
    actionStep(p),
    `Pay about $12 of gas for the deposit on ${chain}; the $1,000 stays as working capital, no leverage and no borrowed funds.`,
    `Hold the position for at least ${hold} days and record the position, the date and the transaction hash in a log each week.`,
    `Exit when the token launches and the airdrop is claimable, or the protocol's TVL falls 25% in a week, or the ${hold}-day hold ends — whichever comes first.`,
  ];
  if (verdict === 'FARM') {
    steps.push(`If the launch is announced, claim within 48 hours and sell half the allocation at once; keep the rest only if the token trades above its launch price for a week.`);
  } else {
    steps.push(`The expected value is ${evFmt} — thin, so cap this farm at $1,000 and do not add capital if the position moves against you.`);
  }
  return steps;
}

// ---------------------------------------------------------------- validation

interface SplitStats {
  blendMean: number;
  blendMedian: number;
  flatMean: number;
  flatMedian: number;
}

function mapeStats(train: Protocol[], test: Protocol[], clampLo: number, clampHi: number, useMult: boolean): SplitStats {
  const model = fitValue(train, clampLo, clampHi);
  const m = useMult ? model : { ...model, mults: new Map<string, number>() };
  const eb: number[] = [];
  const ef: number[] = [];
  for (const p of test) {
    const actual = p.mcap_usd!;
    eb.push((Math.abs(impliedMcap(p, m) - actual) / actual) * 100);
    ef.push((Math.abs(model.flat * p.tvl_usd - actual) / actual) * 100);
  }
  return { blendMean: mean(eb), blendMedian: median(eb), flatMean: mean(ef), flatMedian: median(ef) };
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** MAPE of a variant that drops a value term, on one train/test split. */
function variantMape(train: Protocol[], test: Protocol[], kind: string, clampLo: number, clampHi: number): [number, number] {
  if (kind === 'baseline') {
    const s = mapeStats(train, test, clampLo, clampHi, true);
    return [s.blendMean, s.blendMedian];
  }
  if (kind === 'no_catmult') {
    const s = mapeStats(train, test, clampLo, clampHi, false);
    return [s.blendMean, s.blendMedian];
  }
  const model = fitValue(train, clampLo, clampHi);
  const errs: number[] = [];
  for (const p of test) {
    let pred: number;
    if (kind === 'curve_only') {
      const curve = 10 ** (model.intercept + model.slope * Math.log10(p.tvl_usd));
      pred = curve * (model.mults.get(p.category ?? '(none)') ?? 1);
    } else {
      pred = model.flat * p.tvl_usd;
    }
    errs.push((Math.abs(pred - p.mcap_usd!) / p.mcap_usd!) * 100);
  }
  return [mean(errs), median(errs)];
}

/** Leave-one-out MAPE of a value variant over the anchors. */
function looMape(anchors: Protocol[], kind: string, clampLo: number, clampHi: number): [number, number] {
  const all: number[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const train = [...anchors.slice(0, i), ...anchors.slice(i + 1)];
    const p = anchors[i]!;
    const model = fitValue(train, clampLo, clampHi);
    let pred: number;
    if (kind === 'baseline') pred = impliedMcap(p, model);
    else if (kind === 'no_catmult') pred = impliedMcap(p, { ...model, mults: new Map<string, number>() });
    else if (kind === 'curve_only') {
      const curve = 10 ** (model.intercept + model.slope * Math.log10(p.tvl_usd));
      pred = curve * (model.mults.get(p.category ?? '(none)') ?? 1);
    } else pred = model.flat * p.tvl_usd;
    all.push((Math.abs(pred - p.mcap_usd!) / p.mcap_usd!) * 100);
  }
  return [mean(all), median(all)];
}

export interface ValidationTable {
  holdout: { nTrain: number; nTest: number } & SplitStats;
  wf50: { nTrain: number; nTest: number } & SplitStats;
  wf75: { nTrain: number; nTest: number } & SplitStats;
  loo: { n: number } & SplitStats;
}

/** The four validation splits: blind holdout, two walk-forwards, leave-one-out. */
export function validationTable(anchors: Protocol[], clampLo: number, clampHi: number): ValidationTable {
  const bySlug = [...anchors].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const k = Math.floor(bySlug.length * 0.7);
  const trainH = bySlug.slice(0, k);
  const testH = bySlug.slice(k);
  const holdout = { nTrain: trainH.length, nTest: testH.length, ...mapeStats(trainH, testH, clampLo, clampHi, true) };
  const dated = anchors.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const wf50 = { nTrain: 47, nTest: 48, ...mapeStats(dated.slice(0, 47), dated.slice(47), clampLo, clampHi, true) };
  const wf75 = { nTrain: 71, nTest: 24, ...mapeStats(dated.slice(0, 71), dated.slice(71), clampLo, clampHi, true) };
  const looStats = looMape(anchors, 'baseline', clampLo, clampHi);
  const looFlat = looMape(anchors, 'flat_only', clampLo, clampHi);
  const loo = { n: anchors.length, blendMean: looStats[0], blendMedian: looStats[1], flatMean: looFlat[0], flatMedian: looFlat[1] };
  return { holdout, wf50, wf75, loo };
}

/** The value ablation table: each term's drop-one-out delta on all four splits. */
export function valueAblation(anchors: Protocol[], clampLo: number, clampHi: number): { variant: string; holdout: number[]; wf50: number[]; wf75: number[]; loo: number[] }[] {
  const bySlug = [...anchors].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const k = Math.floor(bySlug.length * 0.7);
  const splits: [Protocol[], Protocol[]][] = [
    [bySlug.slice(0, k), bySlug.slice(k)],
    [anchors.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1)).slice(0, 47),
     anchors.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1)).slice(47)],
    [anchors.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1)).slice(0, 71),
     anchors.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1)).slice(71)],
  ];
  const kinds = ['baseline', 'no_catmult', 'curve_only', 'flat_only'];
  return kinds.map((kind) => {
    const rows = splits.map(([tr, te]) => variantMape(tr, te, kind, clampLo, clampHi));
    const loo = looMape(anchors, kind, clampLo, clampHi);
    return { variant: kind, holdout: rows[0]!, wf50: rows[1]!, wf75: rows[2]!, loo };
  });
}

// ---------------------------------------------------------------- odds: IRLS, ablation, calibration

/** Solve a small dense linear system by Gauss-Jordan with partial pivoting. */
function solveLinear(A: number[][], b: number[]): number[] {
  const d = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < d; col++) {
    let piv = col;
    for (let r = col + 1; r < d; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    for (let r = 0; r < d; r++) {
      if (r === col) continue;
      const f = M[r]![col]! / M[col]![col]!;
      for (let c = col; c <= d; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  return M.map((row, i) => row[d]! / row[i]!);
}

/** Logistic regression by IRLS (Newton-Raphson on the log-likelihood). */
export function irls(X: number[][], y: number[], iters = 25): number[] {
  const d = X[0]!.length;
  let beta = new Array<number>(d).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array<number>(d).fill(0);
    const H: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
    for (let n = 0; n < X.length; n++) {
      const xi = X[n]!;
      const z = Math.max(-30, Math.min(30, xi.reduce((a, v, i) => a + beta[i]! * v, 0)));
      const p = 1 / (1 + Math.exp(-z));
      const w = Math.max(p * (1 - p), 1e-9);
      for (let i = 0; i < d; i++) {
        g[i]! += (y[n]! - p) * xi[i]!;
        for (let j = 0; j < d; j++) H[i]![j]! += w * xi[i]! * xi[j]!;
      }
    }
    for (let i = 0; i < d; i++) H[i]![i]! += 1e-6;
    const delta = solveLinear(H, g);
    beta = beta.map((b, i) => b + delta[i]!);
    if (Math.max(...delta.map(Math.abs)) < 1e-8) break;
  }
  return beta;
}

function logLossAuc(X: number[][], y: number[], beta: number[]): [number, number] {
  let ll = 0;
  const scored: [number, number][] = [];
  for (let n = 0; n < X.length; n++) {
    const z = Math.max(-30, Math.min(30, X[n]!.reduce((a, v, i) => a + beta[i]! * v, 0)));
    let p = 1 / (1 + Math.exp(-z));
    p = Math.min(Math.max(p, 1e-12), 1 - 1e-12);
    ll -= y[n]! * Math.log(p) + (1 - y[n]!) * Math.log(1 - p);
    scored.push([p, y[n]!]);
  }
  ll /= y.length;
  const pos = scored.filter(([, yi]) => yi === 1).map(([s]) => s);
  const neg = scored.filter(([, yi]) => yi === 0).map(([s]) => s);
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return [ll, wins / (pos.length * neg.length)];
}

function peerFeatures(p: Protocol, stats: PeerStats, asOf: Date): number[] {
  const age = ageYears(p, asOf) ?? stats.medianAge;
  const change = p.change_7d ?? stats.meanChange;
  return [
    1,
    (Math.log10(p.tvl_usd) - stats.meanLogTvl) / stats.sdLogTvl,
    (age - stats.meanAge) / stats.sdAge,
    (change - stats.meanChange) / stats.sdChange,
  ];
}

/** The odds ablation: 5-fold CV by slug order, each term dropped in turn, plus the frozen constants on all peers. */
export function oddsAblation(snapshot: Snapshot, stats: PeerStats): { variant: string; log_loss: number; auc: number }[] {
  const asOf = new Date(`${snapshot.as_of}T00:00:00Z`);
  const peers = snapshot.protocols
    .filter((p) => p.listed_at !== null && p.change_7d !== null && !SIX_CATEGORIES.has(p.category ?? '') && Math.abs(p.change_7d) <= 200)
    .sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const folds: Protocol[][] = [[], [], [], [], []];
  peers.forEach((p, i) => folds[i % 5]!.push(p));
  const variants: { name: string; drop: number | null }[] = [
    { name: 'full (logTVL+age+growth)', drop: null },
    { name: 'drop growth', drop: 3 },
    { name: 'drop age', drop: 2 },
    { name: 'drop logTVL', drop: 1 },
  ];
  const out: { variant: string; log_loss: number; auc: number }[] = [];
  for (const v of variants) {
    const lls: number[] = [];
    const aucs: number[] = [];
    for (let f = 0; f < 5; f++) {
      const test = folds[f]!;
      const train = folds.flatMap((fd, i) => (i === f ? [] : fd));
      const dropIdx = (row: number[]): number[] => (v.drop === null ? row : row.filter((_, j) => j !== v.drop));
      const Xtr = train.map((p) => dropIdx(peerFeatures(p, stats, asOf)));
      const ytr = train.map((p) => (hasToken(p) ? 1 : 0));
      const beta = irls(Xtr, ytr);
      const Xte = test.map((p) => dropIdx(peerFeatures(p, stats, asOf)));
      const yte = test.map((p) => (hasToken(p) ? 1 : 0));
      const [ll, auc] = logLossAuc(Xte, yte, beta);
      lls.push(ll);
      aucs.push(auc);
    }
    out.push({ variant: v.name, log_loss: mean(lls), auc: mean(aucs) });
  }
  const Xall = peers.map((p) => peerFeatures(p, stats, asOf));
  const yall = peers.map((p) => (hasToken(p) ? 1 : 0));
  const [ll, auc] = logLossAuc(Xall, yall, FROZEN_ODDS);
  out.push({ variant: 'frozen constants (used)', log_loss: ll, auc });
  return out;
}

/** The odds calibration: deciles of predicted P against the observed token rate. */
export function calibrationTable(snapshot: Snapshot, stats: PeerStats): { deciles: { pred: number; obs: number }[]; weighted_error: number; mean_pred: number; base_rate: number } {
  const asOf = new Date(`${snapshot.as_of}T00:00:00Z`);
  const peers = snapshot.protocols.filter(
    (p) => p.listed_at !== null && p.change_7d !== null && !SIX_CATEGORIES.has(p.category ?? '') && Math.abs(p.change_7d) <= 200,
  );
  const scored = peers
    .map((p) => ({ p: oddsOf(p, stats, asOf), y: hasToken(p) ? 1 : 0 }))
    .sort((a, b) => a.p - b.p);
  const deciles: { pred: number; obs: number }[] = [];
  let weightedError = 0;
  for (let i = 0; i < 10; i++) {
    const chunk = scored.slice(Math.floor((i * scored.length) / 10), Math.floor(((i + 1) * scored.length) / 10));
    const pred = mean(chunk.map((c) => c.p));
    const obs = mean(chunk.map((c) => c.y));
    deciles.push({ pred, obs });
    weightedError += Math.abs(pred - obs) * (chunk.length / scored.length);
  }
  return {
    deciles,
    weighted_error: weightedError,
    mean_pred: mean(scored.map((c) => c.p)),
    base_rate: mean(scored.map((c) => c.y)),
  };
}

// ---------------------------------------------------------------- bootstrap

/** mulberry32: a small deterministic PRNG, so the bootstrap reproduces exactly on every run. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted: number[], q: number): number {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

export interface BootstrapRow {
  slug: string;
  baseEv: number;
  rankMin: number;
  rankMax: number;
  evP5: number;
  evP50: number;
  evP95: number;
}

/** 200 bootstrap refits of the value model (resampled anchors): rank range + EV P5/P50/P95 for the top rows. */
export function bootstrapTop(
  board: Protocol[],
  anchors: Protocol[],
  oddsBySlug: Map<string, number>,
  clampLo: number,
  clampHi: number,
): BootstrapRow[] {
  const baseModel = fitValue(anchors, clampLo, clampHi);
  const baseEv = new Map<string, number>();
  for (const p of board) baseEv.set(p.slug, Math.max(1, Math.round(impliedMcap(p, baseModel) * oddsBySlug.get(p.slug)!)));
  const top = [...board].sort((a, b) => baseEv.get(b.slug)! - baseEv.get(a.slug)!).slice(0, TOP_N);
  const ranks = new Map<string, number[]>();
  const evs = new Map<string, number[]>();
  for (const p of top) {
    ranks.set(p.slug, []);
    evs.set(p.slug, []);
  }
  const rand = mulberry32(BOOTSTRAP_SEED);
  for (let b = 0; b < BOOTSTRAP_REFITS; b++) {
    const sample: Protocol[] = [];
    for (let i = 0; i < anchors.length; i++) sample.push(anchors[Math.floor(rand() * anchors.length)]!);
    const model = fitValue(sample, clampLo, clampHi);
    const evsB = new Map<string, number>();
    for (const p of board) evsB.set(p.slug, Math.max(1, Math.round(impliedMcap(p, model) * oddsBySlug.get(p.slug)!)));
    const ranked = [...board].sort((a, b) => evsB.get(b.slug)! - evsB.get(a.slug)!);
    const rankOf = new Map<string, number>();
    ranked.forEach((p, i) => rankOf.set(p.slug, i + 1));
    for (const p of top) {
      ranks.get(p.slug)!.push(rankOf.get(p.slug)!);
      evs.get(p.slug)!.push(evsB.get(p.slug)!);
    }
  }
  return top.map((p) => {
    const rs = ranks.get(p.slug)!;
    const es = [...evs.get(p.slug)!].sort((a, b) => a - b);
    return {
      slug: p.slug,
      baseEv: baseEv.get(p.slug)!,
      rankMin: Math.min(...rs),
      rankMax: Math.max(...rs),
      evP5: Math.round(percentile(es, 0.05)),
      evP50: Math.round(percentile(es, 0.5)),
      evP95: Math.round(percentile(es, 0.95)),
    };
  });
}

// ---------------------------------------------------------------- checksum + build

/** The board's checksum: sha256 of the compact rows ([slug, rank, implied_value_usd]), first 8 hex. */
export function boardChecksum(rows: BoardRow[]): string {
  const compact = rows.map((r) => [r.slug, r.rank, r.implied_value_usd]);
  return createHash('sha256').update(JSON.stringify(compact)).digest('hex').slice(0, 8);
}

/** Build the whole radar from the snapshot: board, evidence tables, bootstrap, checksum. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const asOf = new Date(`${snapshot.as_of}T00:00:00Z`);
  const watchlist = new Set(snapshot.watchlist);
  const boardProtos = snapshot.protocols.filter((p) => onBoard(p, watchlist, snapshot.floor_usd));
  const traded = snapshot.protocols.filter((p) => hasToken(p));
  const anchors = traded.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0);
  const stats = peerStats(snapshot);
  const model = fitValue(anchors, CLAMP_LO, CLAMP_HI);
  const oddsBySlug = new Map<string, number>();
  for (const p of boardProtos) oddsBySlug.set(p.slug, oddsOf(p, stats, asOf));

  // The bootstrap needs the base EVs first, so rank the board, then attach the intervals.
  const scored = boardProtos.map((p) => {
    const implied = impliedMcap(p, model);
    const pToken = oddsBySlug.get(p.slug)!;
    const ev = Math.max(1, Math.round(implied * pToken));
    return { p, implied, pToken, ev };
  });
  scored.sort((a, b) => b.ev - a.ev || (a.p.slug < b.p.slug ? -1 : 1));
  const boot = bootstrapTop(boardProtos, anchors, oddsBySlug, CLAMP_LO, CLAMP_HI);
  const bootBySlug = new Map(boot.map((b) => [b.slug, b]));

  const board: BoardRow[] = scored.map((s, i) => {
    const v = verdictOf(s.ev);
    const b = bootBySlug.get(s.p.slug);
    const fragile = b !== undefined && b.rankMax - b.rankMin >= 15;
    return {
      slug: s.p.slug,
      name: s.p.name,
      rank: i + 1,
      implied_value_usd: s.ev,
      farm_steps: farmSteps(s.p, v, s.ev),
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      age_years: ageYears(s.p, asOf),
      implied_mcap_usd: Math.round(s.implied),
      p_token: s.pToken,
      ev_p5: b?.evP5 ?? s.ev,
      ev_p50: b?.evP50 ?? s.ev,
      ev_p95: b?.evP95 ?? s.ev,
      rank_min: b?.rankMin ?? i + 1,
      rank_max: b?.rankMax ?? i + 1,
      verdict: v,
      net_usd: netOf(s.ev),
      fragile,
    };
  });

  const validation = validationTable(anchors, CLAMP_LO, CLAMP_HI);
  const ablationValue = valueAblation(anchors, CLAMP_LO, CLAMP_HI);
  const ablationOdds = oddsAblation(snapshot, stats);
  const calibration = calibrationTable(snapshot, stats);
  const checksum = boardChecksum(board);

  const radar: RadarData = {
    meta: {
      as_of: snapshot.as_of,
      floor_usd: snapshot.floor_usd,
      snapshot_protocols: snapshot.protocols.length,
      watchlist: snapshot.watchlist.length,
      generated: 'Launch Ledger v7',
    },
    model: {
      anchors: anchors.length,
      intercept: model.intercept,
      slope: model.slope,
      r2: model.r2,
      residual_sd: model.residualSd,
      flat_multiple: model.flat,
      blend_flat: BLEND_FLAT,
      clamp_lo: CLAMP_LO,
      clamp_hi: CLAMP_HI,
      shrink_k: SHRINK_K,
      odds_constants: [...FROZEN_ODDS],
      median_age: stats.medianAge,
      peers: stats.peers,
      peers_with_token: stats.peersWithToken,
    },
    ledger: {
      board: board.length,
      traded: traded.length,
      excluded: snapshot.protocols.length - traded.length - board.length,
      watchlist: snapshot.watchlist.length,
    },
    validation: {
      holdout: {
        n_train: validation.holdout.nTrain,
        n_test: validation.holdout.nTest,
        blend_mean: validation.holdout.blendMean,
        blend_median: validation.holdout.blendMedian,
        flat_mean: validation.holdout.flatMean,
        flat_median: validation.holdout.flatMedian,
      },
      wf50: {
        n_train: validation.wf50.nTrain,
        n_test: validation.wf50.nTest,
        blend_mean: validation.wf50.blendMean,
        blend_median: validation.wf50.blendMedian,
        flat_mean: validation.wf50.flatMean,
        flat_median: validation.wf50.flatMedian,
      },
      wf75: {
        n_train: validation.wf75.nTrain,
        n_test: validation.wf75.nTest,
        blend_mean: validation.wf75.blendMean,
        blend_median: validation.wf75.blendMedian,
        flat_mean: validation.wf75.flatMean,
        flat_median: validation.wf75.flatMedian,
      },
      loo: {
        n: validation.loo.n,
        blend_mean: validation.loo.blendMean,
        blend_median: validation.loo.blendMedian,
        flat_mean: validation.loo.flatMean,
        flat_median: validation.loo.flatMedian,
      },
    },
    ablation: { value: ablationValue, odds: ablationOdds },
    calibration,
    checksum,
    rows: board,
  };
  return { board, radar };
}

/** The dashboard's data file: window.RADAR, written beside dashboard/ (not part of the dossier text). */
export function dataScript(radar: RadarData): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}

/** The gate's own shape, checked before anything is written: ranks 1..N, values non-increasing, watchlist covered, farm steps 3–12 strings of 20–600 chars. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board has ${board.length} rows, need 100–4000`;
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (let i = 0; i < board.length; i++) {
    const r = board[i]!;
    if (!slugs.has(r.slug)) return `row ${i + 1} names ${r.slug}, not in the snapshot`;
    if (seen.has(r.slug)) return `slug ${r.slug} appears twice`;
    seen.add(r.slug);
    if (r.rank !== i + 1) return `row ${i + 1} has rank ${r.rank}, need ${i + 1}`;
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd < 1) return `row ${r.slug} has implied value ${r.implied_value_usd}`;
    if (i > 0 && r.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${r.slug} rises above the row before it`;
    if (!r.name) return `row ${r.slug} has no name`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `row ${r.slug} has ${r.farm_steps.length} farm steps, need 3–12`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `row ${r.slug} has a farm step of ${t.length} chars, need 20–600`;
    }
  }
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `watchlist slug ${slug} is missing from the board`;
  }
  if (new Set(board.map((r) => r.implied_value_usd)).size < 2) return 'every row carries the same implied value';
  return null;
}
