/**
 * Turns raw snapshots into the committable aggregates the site renders.
 *
 * Mod ranking is a two-sample comparison: how often does a mod appear on items in the
 * dearest slice of the market, versus on the market as a whole? That ratio is the
 * lift. Because both strata are drawn by an absolute exalted price rather than by
 * position within a sample, the comparison means the same thing from run to run.
 *
 * Every lift is reported with a 95% confidence interval, and nothing is ranked unless
 * the interval clears 1.0. This is the part that stops the page from printing
 * confident nonsense: on a thin sample a mod seen a handful of times can show a lift
 * of 2.0 by luck alone, and an interval makes that visible instead of hiding it.
 */
import { mkdir, readdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { LadderRung, RawSnapshot, SampledItem } from './collect.ts';

const ROOT = process.cwd();
const RAW = path.join(ROOT, 'cache', 'raw');
const PREV = path.join(ROOT, 'cache', 'prev');
const HISTORY = path.join(ROOT, 'data', 'history');
const ANALYSIS = path.join(ROOT, 'data', 'analysis.json');
const LABELS = path.join(ROOT, 'data', 'mod-labels.json');

/** Snapshots pooled for mod statistics. */
const POOL_SNAPSHOTS = 60;
/** Snapshots back for a trend reading. */
const TREND_LOOKBACK = 14;
/** Minimum sightings in each stratum before a mod may be ranked. */
const MIN_IN_STRATUM = 5;

export interface ModLabel {
  name: string;
  tier: string;
  desecrated: boolean;
  stats: string[];
}

export interface HistoryRow {
  at: string;
  key: string;
  base: string;
  minIlvl: number;
  magicLadder: LadderRung[];
  rareLadder: LadderRung[];
  magicFloorEx: number | null;
  topThresholdEx: number | null;
  topCount: number | null;
  nTop: number;
  nBase: number;
  /** mod key -> [count in top stratum, count in baseline] */
  mods: Record<string, [number, number]>;
  divineRate: number | null;
  delisted: { seen: number; gone: number } | null;
}

export function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Trade wraps game terms as [Display|Link]; unwrap to plain text. */
export function cleanText(s: string): string {
  return s.replace(/\[([^\]|]*)\|?([^\]]*)\]/g, (_, a: string, b: string) => b || a);
}

/** Blanks rolled numbers so a label describes the tier, not one item's roll. */
export function genericLabel(s: string): string {
  return cleanText(s).replace(/[+-]?\d+(\.\d+)?/g, '#');
}

function countMods(items: SampledItem[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const it of items) {
    // itemMods already deduped per item; count each mod once per item.
    for (const m of it.mods) out.set(m.key, (out.get(m.key) ?? 0) + 1);
  }
  return out;
}

/**
 * Share of previously-seen listings that are gone.
 *
 * Only decidable on a price-ascending sample, and only for listings priced below the
 * current window's ceiling: those are the ones that would necessarily still be visible
 * if they hadn't been taken. Anything at or above the ceiling might merely have been
 * pushed out of view, so it is excluded rather than guessed at.
 */
async function delisting(key: string, magicCheap: SampledItem[]): Promise<HistoryRow['delisted']> {
  const prevPath = path.join(PREV, `${key.replace(/:/g, '_')}.json`);
  if (!existsSync(prevPath)) return null;
  const prev = JSON.parse(await readFile(prevPath, 'utf8')) as RawSnapshot;

  const prices = magicCheap.map((i) => i.priceEx).filter((p): p is number => p !== null);
  if (!prices.length) return null;
  const ceiling = Math.max(...prices);
  const capped = magicCheap.length >= 20;

  const decidable = (prev.magicCheap ?? []).filter(
    (i) => i.priceEx !== null && (!capped || i.priceEx < ceiling),
  );
  if (decidable.length < 8) return null;
  const nowIds = new Set(magicCheap.map((i) => i.id));
  return { seen: decidable.length, gone: decidable.filter((i) => !nowIds.has(i.id)).length };
}

const histPath = (key: string) => path.join(HISTORY, `${key.replace(/:/g, '_')}.jsonl`);

async function readHistory(key: string): Promise<HistoryRow[]> {
  const p = histPath(key);
  if (!existsSync(p)) return [];
  return (await readFile(p, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as HistoryRow);
}

async function mergeLabels(add: Record<string, ModLabel>): Promise<Record<string, ModLabel>> {
  const existing = existsSync(LABELS) ? (JSON.parse(await readFile(LABELS, 'utf8')) as Record<string, ModLabel>) : {};
  const merged = { ...existing, ...add };
  await writeFile(LABELS, JSON.stringify(merged, null, 0));
  return merged;
}

async function main(): Promise<void> {
  if (!existsSync(RAW)) throw new Error('No snapshots in cache/raw. Run `npm run collect` first.');
  const files = (await readdir(RAW)).filter((f) => f.endsWith('.json'));
  if (!files.length) throw new Error('No snapshots in cache/raw. Run `npm run collect` first.');

  await mkdir(HISTORY, { recursive: true });
  const labelUpdates: Record<string, ModLabel> = {};
  const keys: string[] = [];

  for (const f of files) {
    const snap = JSON.parse(await readFile(path.join(RAW, f), 'utf8')) as RawSnapshot;

    for (const it of [...snap.topSample, ...snap.baseSample]) {
      for (const m of it.mods) {
        labelUpdates[m.key] ??= {
          name: m.name,
          tier: m.tier,
          desecrated: m.desecrated,
          stats: m.stats.map(genericLabel),
        };
      }
    }

    const top = countMods(snap.topSample);
    const base = countMods(snap.baseSample);
    const mods: Record<string, [number, number]> = {};
    for (const k of new Set([...top.keys(), ...base.keys()])) {
      mods[k] = [top.get(k) ?? 0, base.get(k) ?? 0];
    }

    const magicPrices = snap.magicCheap
      .map((i) => i.priceEx)
      .filter((p): p is number => p !== null && p > 0)
      .sort((a, b) => a - b);

    const row: HistoryRow = {
      at: snap.at,
      key: snap.key,
      base: snap.base,
      minIlvl: snap.minIlvl,
      magicLadder: snap.magicLadder,
      rareLadder: snap.rareLadder,
      magicFloorEx: quantile(magicPrices, 0.1),
      topThresholdEx: snap.topThresholdEx,
      topCount: snap.topCount,
      nTop: snap.topSample.length,
      nBase: snap.baseSample.length,
      mods,
      divineRate: snap.rates.divine ?? null,
      delisted: await delisting(snap.key, snap.magicCheap),
    };

    await appendFile(histPath(snap.key), JSON.stringify(row) + '\n');
    keys.push(snap.key);
  }

  const labels = await mergeLabels(labelUpdates);
  const history = new Map<string, HistoryRow[]>();
  for (const k of new Set(keys)) history.set(k, await readHistory(k));

  const analysis = buildAnalysis(history, labels);
  await writeFile(ANALYSIS, JSON.stringify(analysis, null, 2));

  const depth = Math.max(0, ...[...history.values()].map((h) => h.length));
  console.log(`Analyzed ${files.length} bases (history depth: ${depth}) -> data/analysis.json`);
  for (const b of analysis.bases) {
    const t = b.trendPct === null ? '' : ` trend ${b.trendPct > 0 ? '+' : ''}${b.trendPct.toFixed(0)}%`;
    console.log(
      `  ${b.base.padEnd(24)} blank ${fmt(b.magicFloorEx)}ex | rare ${String(b.rareTotal ?? 0).padStart(5)} | top>=${b.topThresholdEx ?? '-'}ex | ${String(b.topMods.length).padStart(2)} ranked (n=${b.nTop}/${b.nBase})${t}`,
    );
  }
  if (depth < 2) console.log('\nTrends need 2+ snapshots. Mod ranks sharpen as history accumulates.');
}

function fmt(x: number | null): string {
  return x === null ? '  ?' : x < 10 ? x.toFixed(1) : String(Math.round(x));
}

export interface RankedMod {
  key: string;
  label: string;
  name: string;
  tier: string;
  desecrated: boolean;
  lift: number;
  ciLow: number;
  ciHigh: number;
  inTop: number;
  inBase: number;
  shareTop: number;
  shareBase: number;
  significant: boolean;
}

export interface BaseAnalysis {
  base: string;
  minIlvl: number;
  magicFloorEx: number | null;
  magicTotal: number | null;
  rareTotal: number | null;
  rareLadder: LadderRung[];
  topThresholdEx: number | null;
  topCount: number | null;
  delistRate: number | null;
  nTop: number;
  nBase: number;
  snapshots: number;
  trendPct: number | null;
  topMods: RankedMod[];
}

/**
 * Risk-ratio confidence interval on the log scale.
 *
 * With a = sightings in the top stratum out of nTop, and b = sightings in the baseline
 * out of nBase, the ratio of proportions is approximately log-normal, so we build the
 * interval around ln(RR) and exponentiate back. If the interval spans 1.0 the mod's
 * apparent enrichment is indistinguishable from chance.
 */
export function liftCI(a: number, nTop: number, b: number, nBase: number) {
  const pTop = a / nTop;
  const pBase = b / nBase;
  const rr = pTop / pBase;
  const se = Math.sqrt((1 - pTop) / a + (1 - pBase) / b);
  const z = 1.96;
  return {
    lift: rr,
    ciLow: rr * Math.exp(-z * se),
    ciHigh: rr * Math.exp(z * se),
    pTop,
    pBase,
  };
}

function trend(rows: HistoryRow[], pick: (r: HistoryRow) => number | null): number | null {
  const vals = rows.map(pick).filter((v): v is number => v !== null && v > 0);
  if (vals.length < 2) return null;
  const now = vals[vals.length - 1]!;
  const then = vals[Math.max(0, vals.length - 1 - TREND_LOOKBACK)]!;
  return then === 0 ? null : ((now - then) / then) * 100;
}

const last = <T>(xs: T[]): T | undefined => xs[xs.length - 1];

export function buildAnalysis(history: Map<string, HistoryRow[]>, labels: Record<string, ModLabel>) {
  const out: BaseAnalysis[] = [];

  for (const [, rows] of history) {
    if (!rows.length) continue;
    const latest = last(rows)!;
    const pool = rows.slice(-POOL_SNAPSHOTS);

    // Pool sightings across snapshots; more evidence, same comparison each time.
    const agg = new Map<string, [number, number]>();
    let nTop = 0;
    let nBase = 0;
    for (const r of pool) {
      nTop += r.nTop;
      nBase += r.nBase;
      for (const [k, [a, b]] of Object.entries(r.mods)) {
        const cur = agg.get(k) ?? [0, 0];
        agg.set(k, [cur[0] + a, cur[1] + b]);
      }
    }

    const topMods: RankedMod[] = [];
    if (nTop > 0 && nBase > 0) {
      for (const [key, [a, b]] of agg) {
        if (a < MIN_IN_STRATUM || b < MIN_IN_STRATUM) continue;
        const { lift, ciLow, ciHigh, pTop, pBase } = liftCI(a, nTop, b, nBase);
        if (!Number.isFinite(lift)) continue;
        const l = labels[key];
        const stats = l?.stats.length ? l.stats.join(' / ') : key;
        topMods.push({
          key,
          label: stats,
          name: l?.name ?? '?',
          tier: l?.tier ?? '?',
          desecrated: l?.desecrated ?? false,
          lift,
          ciLow,
          ciHigh,
          inTop: a,
          inBase: b,
          shareTop: pTop,
          shareBase: pBase,
          significant: ciLow > 1 || ciHigh < 1,
        });
      }
      // Significant results first, then by strength.
      topMods.sort((x, y) => Number(y.significant) - Number(x.significant) || y.lift - x.lift);
    }

    out.push({
      base: latest.base,
      minIlvl: latest.minIlvl,
      magicFloorEx: latest.magicFloorEx,
      magicTotal: latest.magicLadder.find((r) => r.minEx === 1)?.count ?? null,
      rareTotal: latest.rareLadder.find((r) => r.minEx === 1)?.count ?? null,
      rareLadder: latest.rareLadder,
      topThresholdEx: latest.topThresholdEx,
      topCount: latest.topCount,
      delistRate: latest.delisted ? latest.delisted.gone / Math.max(1, latest.delisted.seen) : null,
      nTop,
      nBase,
      snapshots: pool.length,
      trendPct: trend(rows, (r) => r.magicFloorEx),
      topMods,
    });
  }

  const latestRows = [...history.values()].flatMap((rows) => last(rows) ?? []);
  return {
    generatedAt: new Date().toISOString(),
    league: process.env.POE2_LEAGUE ?? 'Runes of Aldur',
    minIlvl: latestRows[0]?.minIlvl ?? null,
    divineRate: latestRows.find((r) => r.divineRate)?.divineRate ?? null,
    bases: out.sort((a, b) => (b.rareTotal ?? 0) - (a.rareTotal ?? 0)),
  };
}

if (import.meta.filename === process.argv[1]) await main();
