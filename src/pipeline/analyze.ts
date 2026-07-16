/**
 * Turns raw snapshots into the small, committable aggregates the site renders.
 *
 * Three questions, three methods:
 *
 * 1. What is a base worth?  Percentiles of the cheapest asks. Never the mean (one
 *    troll listing at 100 mirrors moves a mean and doesn't move a percentile), and
 *    never the top (that IS the trolls).
 *
 * 2. Which mods are paid for?  Lift — how much more often a mod shows up on the
 *    expensive quartile than on the market as a whole. Computed only over the
 *    price-unbiased `recent` sample, so we aren't measuring our own sort order.
 *
 * 3. Is it actually selling?  Delisting rate between consecutive snapshots. An ask
 *    nobody takes is an opinion; an ask that disappears is closer to a price.
 */
import { mkdir, readdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { RawSnapshot } from './collect.ts';

const ROOT = process.cwd();
const RAW = path.join(ROOT, 'cache', 'raw');
const PREV = path.join(ROOT, 'cache', 'prev');
const HISTORY = path.join(ROOT, 'data', 'history');
const ANALYSIS = path.join(ROOT, 'data', 'analysis.json');
const LABELS = path.join(ROOT, 'data', 'mod-labels.json');

/**
 * Mods seen fewer times than this across the accumulated window are dropped.
 * A lift of 2.0 computed from 4-of-8 sightings is arithmetic, not evidence; this
 * threshold is what stops the page from confidently printing noise.
 */
const MIN_OCCURRENCES = 25;
/** Fraction of the sample treated as "expensive". */
const TOP_FRACTION = 0.25;
/** Snapshots to pool for mod statistics. One snapshot is far too thin to rank mods. */
const POOL_SNAPSHOTS = 60;
/** Snapshots back to look when computing a price trend. */
const TREND_LOOKBACK = 14;

export function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export interface HistoryRow {
  at: string;
  key: string;
  /** Listings matching the query overall — a supply signal independent of price. */
  total: number;
  n: number;
  priced: number;
  p: { min: number | null; p10: number | null; p25: number | null; p50: number | null };
  divineRate: number | null;
  delisted: { seen: number; gone: number } | null;
  /** mod key -> [count in expensive quartile, count in whole priced sample] */
  mods: Record<string, [number, number]>;
  nTop: number;
  modLabels: Record<string, string>;
}

function priceStats(snap: RawSnapshot) {
  const prices = snap.items
    .map((i) => i.priceEx)
    .filter((p): p is number => p !== null && p > 0)
    .sort((a, b) => a - b);
  return {
    priced: prices.length,
    p: {
      min: prices[0] ?? null,
      p10: quantile(prices, 0.1),
      p25: quantile(prices, 0.25),
      p50: quantile(prices, 0.5),
    },
  };
}

/**
 * Counts each mod in the expensive quartile and in the full priced sample.
 * Only meaningful on a `recent` (price-unbiased) snapshot.
 */
function modCounts(snap: RawSnapshot): Pick<HistoryRow, 'mods' | 'nTop' | 'modLabels'> {
  const priced = snap.items.filter((i) => i.priceEx !== null && i.priceEx > 0);
  priced.sort((a, b) => b.priceEx! - a.priceEx!);
  const nTop = Math.max(1, Math.round(priced.length * TOP_FRACTION));
  const top = new Set(priced.slice(0, nTop).map((i) => i.id));

  const mods: Record<string, [number, number]> = {};
  const modLabels: Record<string, string> = {};
  for (const item of priced) {
    // Dedupe within an item: an item with two ES rolls shouldn't double-count.
    const seen = new Set(item.mods.map((m) => m.key));
    for (const m of item.mods) modLabels[m.key] ??= `[${m.tier}] ${genericLabel(m.text)}`;
    for (const key of seen) {
      mods[key] ??= [0, 0];
      mods[key]![1]++;
      if (top.has(item.id)) mods[key]![0]++;
    }
  }
  return { mods, nTop, modLabels };
}

/** Trade wraps game terms as [Display|Link]; unwrap to plain text. */
export function cleanText(s: string): string {
  return s.replace(/\[([^\]|]*)\|?([^\]]*)\]/g, (_, a: string, b: string) => b || a);
}

/**
 * Collapses a rolled mod to its tier's wording: "+49 to maximum Energy Shield"
 * becomes "+# to maximum Energy Shield".
 *
 * Items are grouped by stat hash and tier, so two rolls of the same tier are already
 * one bucket — but the label was taken from whichever item we happened to see first,
 * which made it read as though we were reporting that exact roll. Blanking the
 * numbers makes the label describe the bucket it actually names.
 */
export function genericLabel(s: string): string {
  return cleanText(s).replace(/[+-]?\d+(\.\d+)?/g, '#');
}

/**
 * Share of the previous snapshot's listings that are no longer there.
 *
 * The naive version of this — "how many prior ids are missing now" — is wrong,
 * because a listing can leave our view two ways: it sold, or it got pushed out of
 * the 100-item window the API caps us at. Only the first is interesting.
 *
 * The `price-asc` sample makes the two separable. Our window is "the 100 cheapest",
 * so it has a price ceiling: the dearest item we can see. Any prior listing priced
 * *below* that ceiling would necessarily still be in the window if it were still
 * listed — nothing can push it out except its own removal. Prior listings at or
 * above the ceiling are ambiguous, so they're excluded from the denominator
 * entirely rather than being scored as sales.
 *
 * This is why delisting is measured on `price-asc` and never on `recent`: the
 * recent window has no such anchor. Items fall out of "newest 100" purely because
 * 100 newer listings appeared, so a delisting rate computed there would measure
 * how fast people list, not how fast things sell.
 */
async function delisting(key: string, snap: RawSnapshot): Promise<HistoryRow['delisted']> {
  if (snap.sampling !== 'price-asc') return null;

  const prevPath = path.join(PREV, `${key.replace(/:/g, '_')}.json`);
  if (!existsSync(prevPath)) return null;
  const prev = JSON.parse(await readFile(prevPath, 'utf8')) as RawSnapshot;

  const nowPrices = snap.items.map((i) => i.priceEx).filter((p): p is number => p !== null);
  if (!nowPrices.length) return null;
  const ceiling = Math.max(...nowPrices);

  // If the book didn't fill our window, nothing could have been pushed out and the
  // ceiling doesn't bind — every prior listing is decidable.
  const capped = snap.items.length >= 100;
  const decidable = prev.items.filter((i) => i.priceEx !== null && (!capped || i.priceEx < ceiling));
  if (decidable.length < 10) return null;

  const nowIds = new Set(snap.items.map((i) => i.id));
  return { seen: decidable.length, gone: decidable.filter((i) => !nowIds.has(i.id)).length };
}

const histPath = (key: string) => path.join(HISTORY, `${key.replace(/:/g, '_')}.jsonl`);

async function readHistory(key: string): Promise<HistoryRow[]> {
  const p = histPath(key);
  if (!existsSync(p)) return [];
  const text = await readFile(p, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as HistoryRow);
}

/** Mod labels live in one shared file rather than being repeated on every history row. */
async function mergeLabels(add: Record<string, string>): Promise<Record<string, string>> {
  const existing = existsSync(LABELS) ? (JSON.parse(await readFile(LABELS, 'utf8')) as Record<string, string>) : {};
  const merged = { ...existing, ...add };
  await writeFile(LABELS, JSON.stringify(merged, null, 0));
  return merged;
}

async function main(): Promise<void> {
  if (!existsSync(RAW)) throw new Error('No snapshots in cache/raw. Run `npm run collect` first.');
  const files = (await readdir(RAW)).filter((f) => f.endsWith('.json'));
  if (!files.length) throw new Error('No snapshots in cache/raw. Run `npm run collect` first.');

  await mkdir(HISTORY, { recursive: true });
  const labelUpdates: Record<string, string> = {};
  const keys: string[] = [];

  for (const f of files) {
    const snap = JSON.parse(await readFile(path.join(RAW, f), 'utf8')) as RawSnapshot;
    const { priced, p } = priceStats(snap);
    const { mods, nTop, modLabels } =
      snap.sampling === 'recent' ? modCounts(snap) : { mods: {}, nTop: 0, modLabels: {} };
    Object.assign(labelUpdates, modLabels);

    const row: HistoryRow = {
      at: snap.at,
      key: snap.key,
      total: snap.total,
      n: snap.items.length,
      priced,
      p,
      divineRate: snap.rates.divine ?? null,
      delisted: await delisting(snap.key, snap),
      mods,
      nTop,
      modLabels: {},
    };

    // Appending, never rewriting: history is the only thing here that can't be
    // rebuilt from scratch, since trade exposes no way to look backwards.
    await appendFile(histPath(snap.key), JSON.stringify(row) + '\n');
    keys.push(snap.key);
  }

  const labels = await mergeLabels(labelUpdates);
  const history = new Map<string, HistoryRow[]>();
  for (const k of new Set(keys)) history.set(k, await readHistory(k));

  const analysis = buildAnalysis(history, labels);
  await writeFile(ANALYSIS, JSON.stringify(analysis, null, 2));

  const depth = Math.max(0, ...[...history.values()].map((h) => h.length));
  console.log(`Analyzed ${files.length} snapshots (history depth: ${depth}) -> data/analysis.json`);
  for (const b of analysis.bases) {
    const t = b.trendPct === null ? '' : ` | trend ${b.trendPct > 0 ? '+' : ''}${b.trendPct.toFixed(0)}%`;
    console.log(
      `  ${b.base.padEnd(22)} magic ${fmt(b.magicFloorEx)}ex | rare ${fmt(b.rareFloorEx)}ex | ${String(b.topMods.length).padStart(2)} mods (pooled n=${b.sampleSize})${t}`,
    );
  }
  if (depth < 2) console.log('\nTrends need at least 2 snapshots; mod ranks sharpen as history accumulates.');
}

function fmt(x: number | null): string {
  return x === null ? '  ?' : x < 10 ? x.toFixed(1) : String(Math.round(x));
}

export interface BaseAnalysis {
  base: string;
  magicFloorEx: number | null;
  magicListings: number | null;
  rareFloorEx: number | null;
  rareMedianEx: number | null;
  rareListings: number | null;
  delistRate: number | null;
  /** Pooled count of priced listings behind the mod ranking. */
  sampleSize: number;
  /** Percent change in the magic price floor over the lookback, or null if too new. */
  trendPct: number | null;
  snapshots: number;
  topMods: { label: string; lift: number; inTop: number; inAll: number; share: number }[];
}

/**
 * Percent change between the newest reading and the one TREND_LOOKBACK snapshots back.
 * Both readings are in exalted, so this is a real move in the item's value rather than
 * a move in the currency it happened to be quoted in.
 */
function trend(rows: HistoryRow[], pick: (r: HistoryRow) => number | null): number | null {
  const vals = rows.map(pick).filter((v): v is number => v !== null && v > 0);
  if (vals.length < 2) return null;
  const now = vals[vals.length - 1]!;
  const then = vals[Math.max(0, vals.length - 1 - TREND_LOOKBACK)]!;
  if (then === 0) return null;
  return ((now - then) / then) * 100;
}

const last = <T>(xs: T[]): T | undefined => xs[xs.length - 1];

export function buildAnalysis(history: Map<string, HistoryRow[]>, labels: Record<string, string>) {
  const bases = new Set([...history.keys()].map((k) => k.split(':')[1]!));
  const out: BaseAnalysis[] = [];

  for (const slug of bases) {
    const magicRows = history.get([...history.keys()].find((k) => k.includes(`:${slug}:magic:price-asc`)) ?? '') ?? [];
    const rareCheapRows = history.get([...history.keys()].find((k) => k.includes(`:${slug}:rare:price-asc`)) ?? '') ?? [];
    const rareRecentRows = history.get([...history.keys()].find((k) => k.includes(`:${slug}:rare:recent`)) ?? '') ?? [];

    // Pool mod counts across recent snapshots. One snapshot yields a top quartile of
    // ~25 items, where a mod seen 8 times can show a lift of 2.0 by chance alone.
    // Pooling is what turns this from a suggestive number into a measurement.
    const pool = rareRecentRows.slice(-POOL_SNAPSHOTS);
    const agg = new Map<string, [number, number]>();
    let nTopPool = 0;
    let nAllPool = 0;
    for (const r of pool) {
      nTopPool += r.nTop;
      nAllPool += r.priced;
      for (const [k, [inTop, inAll]] of Object.entries(r.mods)) {
        const cur = agg.get(k) ?? [0, 0];
        agg.set(k, [cur[0] + inTop, cur[1] + inAll]);
      }
    }

    const topMods: BaseAnalysis['topMods'] = [];
    if (nAllPool > 0 && nTopPool > 0) {
      for (const [key, [inTop, inAll]] of agg) {
        if (inAll < MIN_OCCURRENCES) continue;
        const pTop = inTop / nTopPool;
        const pAll = inAll / nAllPool;
        if (pAll === 0) continue;
        topMods.push({ label: labels[key] ?? key, lift: pTop / pAll, inTop, inAll, share: pAll });
      }
      topMods.sort((a, b) => b.lift - a.lift);
    }

    const magic = last(magicRows);
    const rareCheap = last(rareCheapRows);
    const rareRecent = last(rareRecentRows);

    out.push({
      base: slug,
      magicFloorEx: magic?.p.p10 ?? null,
      magicListings: magic?.total ?? null,
      rareFloorEx: rareCheap?.p.p10 ?? null,
      rareMedianEx: rareRecent?.p.p50 ?? null,
      rareListings: rareCheap?.total ?? null,
      // From price-asc only; see delisting() for why `recent` can't answer this.
      delistRate: rareCheap?.delisted ? rareCheap.delisted.gone / Math.max(1, rareCheap.delisted.seen) : null,
      sampleSize: nAllPool,
      trendPct: trend(magicRows, (r) => r.p.p10),
      snapshots: pool.length,
      topMods,
    });
  }

  const latest = [...history.values()].flatMap((rows) => last(rows) ?? []);
  return {
    generatedAt: new Date().toISOString(),
    league: process.env.POE2_LEAGUE ?? 'Runes of Aldur',
    divineRate: latest.find((r) => r.divineRate)?.divineRate ?? null,
    bases: out.sort((a, b) => (b.rareListings ?? 0) - (a.rareListings ?? 0)),
  };
}

if (import.meta.filename === process.argv[1]) await main();
