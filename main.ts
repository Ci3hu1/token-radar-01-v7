// main.ts — Launch Ledger v7 (token-radar-01).
//
// Reads the sealed DefiLlama snapshot, ranks the pre-token protocols by
// expected value, and writes the dashboard: board.json, the dashboard's data
// (data.js), the dashboard/ page, the screenshots/, and dossier.json.
//
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
//
// Node 22, standard library only. No network, no clock, no randomness
// outside the bootstrap's fixed seed: two runs write the same bytes.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSnap } from './lib/model.ts';
import {
  anchors,
  assemble,
  CALIBRATION,
  CALIBRATION_ERROR,
  catMults,
  compsFor,
  fitCurve,
  ODDS_ABLATION,
  VALIDATION_V7,
  VALUE_ABLATION,
} from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

/** This run's arguments: --input <snapshot> and --output <dir>. */
function args(): { input: string; output: string } {
  const argv = process.argv.slice(2);
  let input = '/input/snapshot.json';
  let output = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' && argv[i + 1]) input = argv[++i];
    else if (argv[i] === '--output' && argv[i + 1]) output = argv[++i];
  }
  return { input, output };
}

/** Copy a directory's files (flat) into a destination directory. */
function copyDir(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    copyFileSync(join(src, entry.name), join(dst, entry.name));
  }
}

/**
 * The gate's own invariants, checked on the board this run just wrote: ranks
 * 1..N exactly once, expected value non-increasing with rank, every expected
 * value a positive whole number, the whole watchlist covered, and every row's
 * farm plan the right shape (5 steps for FARM/THIN, 3 for SKIP, each step
 * 20–600 characters). A failure is loud, not silent: the run stops before
 * the dossier is written, so a bad board never ships.
 */
function verifyBoard(boardPath: string, snap: { watchlist: string[] }): void {
  const doc = JSON.parse(readFileSync(boardPath, 'utf8')) as {
    rows: { slug: string; rank: number; implied_value_usd: number; verdict: string; farm_steps: string[] }[];
  };
  const rows = doc.rows;
  const n = rows.length;
  if (n < 100 || n > 4000) throw new Error(`gate self-check: ${n} rows, want 100–4000`);
  const ranks = rows.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < n; i++) {
    if (ranks[i] !== i + 1) throw new Error(`gate self-check: ranks are not 1..${n}`);
  }
  const byRank = [...rows].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < n; i++) {
    if (byRank[i].implied_value_usd > byRank[i - 1].implied_value_usd) {
      throw new Error(`gate self-check: implied value rises at rank ${byRank[i].rank}`);
    }
  }
  for (const r of rows) {
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      throw new Error(`gate self-check: ${r.slug} has implied value ${r.implied_value_usd}`);
    }
    const wantSteps = r.verdict === 'SKIP' ? 3 : 5;
    if (r.farm_steps.length !== wantSteps) {
      throw new Error(`gate self-check: ${r.slug} (${r.verdict}) has ${r.farm_steps.length} farm steps, want ${wantSteps}`);
    }
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) throw new Error(`gate self-check: ${r.slug} has a ${t.length}-char farm step`);
    }
  }
  const have = new Set(rows.map((r) => r.slug));
  for (const w of snap.watchlist) {
    if (!have.has(w)) throw new Error(`gate self-check: watchlist ${w} is not on the board`);
  }
}

/** Where this file lives: the repository root (the grader mounts it read-only). */
function repoRoot(): string {
  const here = new URL(import.meta.url).pathname;
  return here.slice(0, here.lastIndexOf('/'));
}

function main(): void {
  const { input, output } = args();
  const root = repoRoot();
  const snap = readSnap(input);
  const { rows, fit } = assemble(snap);

  // The value-model pieces the dashboard's evidence tables need.
  const anchorList = anchors(snap.protocols);
  const curve = fitCurve(anchorList);
  const mults = catMults(anchorList, curve);
  const catRows = [...mults.entries()]
    .map(([category, mult]) => ({
      category,
      n: anchorList.filter((a) => (a.category ?? 'Uncategorized') === category).length,
      mult,
    }))
    .sort((a, b) => b.mult - a.mult);
  const comps: Record<string, { slug: string; name: string; tvl_usd: number; mcap_usd: number; mult: number }[]> = {};
  for (const r of rows) {
    const p = snap.protocols.find((x) => x.slug === r.slug)!;
    comps[r.slug] = compsFor(p, snap);
  }

  mkdirSync(output, { recursive: true });

  // board.json — the gate's rows, plus the run's own record.
  const boardDoc = {
    generated_from: snap.source,
    as_of: snap.as_of,
    ledger: fit.ledgerCounts,
    checksum: fit.checksum,
    sum_expected_value_usd: fit.sumEv,
    verdicts: fit.verdictCounts,
    rows,
  };
  writeFileSync(join(output, 'board.json'), JSON.stringify(boardDoc, null, 2) + '\n', 'utf8');
  verifyBoard(join(output, 'board.json'), snap);

  // data.js — the dashboard's data, beside the page (not inside dashboard/,
  // so the dossier's text stays the page's own source).
  const dataDoc = {
    meta: { as_of: snap.as_of, source: snap.source, floor_usd: snap.floor_usd },
    fit,
    catMults: catRows,
    comps,
    rows,
    evidence: {
      valueAblation: VALUE_ABLATION,
      oddsAblation: ODDS_ABLATION,
      calibration: CALIBRATION,
      calibrationError: CALIBRATION_ERROR,
      validation: VALIDATION_V7,
    },
  };
  writeFileSync(join(output, 'data.js'), 'window.LAUNCH_LEDGER = ' + JSON.stringify(dataDoc) + ';\n', 'utf8');

  // dashboard/ and screenshots/ — copied from the repository.
  copyDir(join(root, 'dashboard'), join(output, 'dashboard'));
  if (existsSync(join(root, 'screenshots'))) copyDir(join(root, 'screenshots'), join(output, 'screenshots'));

  // dossier.json — byte for byte what the kit's library writes.
  const dossier = buildDossier(output, { text_max_bytes: 65536 });
  writeFileSync(join(output, 'dossier.json'), dossier);

  // A short run summary on stdout (not part of the output).
  const top = rows[0];
  console.log(`Launch Ledger v7 — ${snap.as_of} snapshot, ${snap.protocols.length} protocols`);
  console.log(`ledger board=${fit.ledgerCounts.board} traded=${fit.ledgerCounts.traded} excluded=${fit.ledgerCounts.excluded}`);
  console.log(`anchors=${fit.anchorsN} intercept=${fit.intercept.toFixed(4)} slope=${fit.slope.toFixed(4)} R2=${fit.r2.toFixed(4)} flat=${fit.flat.toFixed(4)} blend=${fit.blend} clamp=[${fit.clampLo}, ${fit.clampHi}]`);
  console.log(`peers=${fit.peersN} verdicts FARM=${fit.verdictCounts.FARM} THIN=${fit.verdictCounts.THIN} SKIP=${fit.verdictCounts.SKIP}`);
  console.log(`top1=${top.slug} $${top.implied_value_usd.toLocaleString('en-US')} sum=$${fit.sumEv.toLocaleString('en-US')} watchlistTop50=${fit.watchlistTop50}`);
  console.log(`top20 bootstrap: ${rows[0].slug} EV P5–P95 $${(rows[0].ev_p5 as number).toLocaleString('en-US')}–$${(rows[0].ev_p95 as number).toLocaleString('en-US')}, fragile rows: ${rows.filter((r) => r.fragile).map((r) => r.slug).join(', ') || 'none'}`);
  console.log(`checksum=${fit.checksum}`);
  console.log(`gate self-check: PASS (${rows.length} rows, watchlist covered, farm plans 5 steps FARM/THIN, 3 steps SKIP)`);
}

main();
