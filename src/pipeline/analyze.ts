/**
 * Turns raw category snapshots into the answer: what to craft on, and what to hit.
 *
 * Everything here is one calculation applied twice. For any feature of an item — the
 * base it's on, or a mod it carries — compare how often it shows up on the dearest
 * slice of the market against how often it shows up on the market as a whole:
 *
 *     lift = P(feature | dear) / P(feature | market)
 *
 * Above 1 means people pay for it. That works identically for "Ancestral Tiara" and
 * for "Unassailable P1", so bases and mods share the same maths and the same caveats.
 *
 * Two things this deliberately does NOT do:
 *
 *  - Rank bases by their game-file stats. Every base gets used by someone; the market
 *    decides which are worth crafting. The static tables are annotation, not the answer.
 *  - Report a lift without an interval. On a thin sample a feature seen a handful of
 *    times shows a lift of 2.0 by luck alone, so anything whose 95% CI spans 1.0 is
 *    marked noise rather than ranked.
 */
import { mkdir, readdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { LadderRung, RawSnapshot, SampledItem } from './collect.ts';

const ROOT = process.cwd();
const RAW = path.join(ROOT, 'cache', 'raw');
const HISTORY = path.join(ROOT, 'data', 'history');
const ANALYSIS = path.join(ROOT, 'data', 'analysis.json');
const LABELS = path.join(ROOT, 'data', 'mod-labels.json');

/** Snapshots pooled for statistics. */
const POOL_SNAPSHOTS = 60;
/** Snapshots back for a trend reading. */
const TREND_LOOKBACK = 14;
/** Minimum sightings in each stratum before a feature may be ranked. */
const MIN_IN_STRATUM = 5;
/** Bases listed on the page per category. */
const TOP_BASES = 3;
/** Prefixes and suffixes listed per unit. */
const TOP_MODS = 6;

export interface ModLabel {
  name: string;
  tier: string;
  desecrated: boolean;
  stats: string[];
}

export interface HistoryRow {
  at: string;
  key: string;
  label: string;
  /** bases.json group, e.g. "Helmet / es" — links a unit to its static stats. */
  group: string;
  section: string;
  minIlvl: number;
  ladder: LadderRung[];
  total: number;
  dearThresholdEx: number | null;
  dearCount: number | null;
  nDear: number;
  nBase: number;
  /** base name -> [count in dear, count in baseline] */
  bases: Record<string, [number, number]>;
  /** mod key -> [count in dear, count in baseline] */
  mods: Record<string, [number, number]>;
  divineRate: number | null;
}

/** Trade wraps game terms as [Display|Link]; unwrap to plain text. */
export function cleanText(s: string): string {
  return s.replace(/\[([^\]|]*)\|?([^\]]*)\]/g, (_, a: string, b: string) => b || a);
}

/** Blanks rolled numbers so a label describes the tier, not one item's roll. */
export function genericLabel(s: string): string {
  return cleanText(s).replace(/[+-]?\d+(\.\d+)?/g, '#');
}

/** Tier "P1" is a prefix, "S3" a suffix — the split the crafter actually needs. */
export function affixOf(tier: string): 'prefix' | 'suffix' | 'other' {
  if (tier.startsWith('P')) return 'prefix';
  if (tier.startsWith('S')) return 'suffix';
  return 'other';
}

function countBy<T>(items: T[], key: (t: T) => string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const it of items) for (const k of new Set(key(it))) out.set(k, (out.get(k) ?? 0) + 1);
  return out;
}

/**
 * Risk-ratio confidence interval on the log scale.
 *
 * The ratio of two proportions is roughly log-normal, so the interval is built around
 * ln(RR) and exponentiated back. An interval spanning 1.0 means the apparent effect is
 * indistinguishable from chance at this sample size.
 */
export function liftCI(a: number, nDear: number, b: number, nBase: number) {
  const pDear = a / nDear;
  const pBase = b / nBase;
  const rr = pDear / pBase;
  const se = Math.sqrt((1 - pDear) / a + (1 - pBase) / b);
  const z = 1.96;
  return { lift: rr, ciLow: rr * Math.exp(-z * se), ciHigh: rr * Math.exp(z * se), pDear, pBase };
}

/** Unit ids look like "armour.chest/ar" — the slash must not become a directory. */
const histPath = (key: string) => path.join(HISTORY, `${key.replace(/[./]/g, '_')}.jsonl`);

async function readHistory(key: string): Promise<HistoryRow[]> {
  const p = histPath(key);
  if (!existsSync(p)) return [];
  return (await readFile(p, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as HistoryRow);
}

async function mergeLabels(add: Record<string, ModLabel>): Promise<Record<string, ModLabel>> {
  const existing = existsSync(LABELS) ? (JSON.parse(await readFile(LABELS, 'utf8')) as Record<string, ModLabel>) : {};
  const merged = { ...existing, ...add };
  await writeFile(LABELS, JSON.stringify(merged, null, 0));
  return merged;
}

const last = <T>(xs: T[]): T | undefined => xs[xs.length - 1];

async function main(): Promise<void> {
  const files = existsSync(RAW) ? (await readdir(RAW)).filter((f) => f.endsWith('.json')) : [];

  // Nothing collected yet is a normal state, not a failure: the rotation does one
  // category per tick and early ticks may be held off by a rate limit. Throwing here
  // would mark every tick red until the first category lands.
  if (!files.length) {
    console.log('No snapshots in cache/raw yet — nothing to aggregate.');
    console.log('The rotation collects one category per tick; this resolves once one lands.');
    return;
  }

  await mkdir(HISTORY, { recursive: true });
  const labelUpdates: Record<string, ModLabel> = {};
  const keys: string[] = [];
  let appended = 0;
  let skipped = 0;

  for (const f of files) {
    const snap = JSON.parse(await readFile(path.join(RAW, f), 'utf8')) as RawSnapshot;
    keys.push(snap.key);

    // One category refreshes per run, so most raw files are unchanged. Re-appending
    // them would fabricate history: duplicate rows inflate pooled counts and make a
    // flat market look like repeated observations.
    const existing = await readHistory(snap.key);
    if (existing.length && last(existing)!.at === snap.at) {
      skipped++;
      continue;
    }

    for (const it of [...snap.dearSample, ...snap.baseSample]) {
      for (const m of it.mods) {
        labelUpdates[m.key] ??= {
          name: m.name,
          tier: m.tier,
          desecrated: m.desecrated,
          stats: m.stats.map(genericLabel),
        };
      }
    }

    const baseKey = (i: SampledItem) => [i.baseName];
    const modKey = (i: SampledItem) => i.mods.map((m) => m.key);

    const pair = (dear: Map<string, number>, base: Map<string, number>) => {
      const out: Record<string, [number, number]> = {};
      for (const k of new Set([...dear.keys(), ...base.keys()])) out[k] = [dear.get(k) ?? 0, base.get(k) ?? 0];
      return out;
    };

    const row: HistoryRow = {
      at: snap.at,
      key: snap.key,
      label: snap.label,
      group: snap.group,
      section: snap.section,
      minIlvl: snap.minIlvl,
      ladder: snap.ladder,
      total: snap.total,
      dearThresholdEx: snap.dearThresholdEx,
      dearCount: snap.dearCount,
      nDear: snap.dearSample.length,
      nBase: snap.baseSample.length,
      bases: pair(countBy(snap.dearSample, baseKey), countBy(snap.baseSample, baseKey)),
      mods: pair(countBy(snap.dearSample, modKey), countBy(snap.baseSample, modKey)),
      divineRate: snap.rates.divine ?? null,
    };

    await appendFile(histPath(snap.key), JSON.stringify(row) + '\n');
    appended++;
  }

  const labels = await mergeLabels(labelUpdates);
  const history = new Map<string, HistoryRow[]>();
  for (const k of new Set(keys)) history.set(k, await readHistory(k));

  const analysis = buildAnalysis(history, labels);
  await writeFile(ANALYSIS, JSON.stringify(analysis, null, 2));

  console.log(`${appended} new, ${skipped} unchanged. ${analysis.categories.length} categories -> data/analysis.json`);
  for (const c of analysis.categories) {
    const top = c.bases[0];
    console.log(
      `  ${c.label.padEnd(20)} ${String(c.total).padStart(5)} listed | top base: ${(top ? `${top.label} (${(top.shareBase * 100).toFixed(0)}%)` : '—').padEnd(30)} ${c.prefixes.length}P/${c.suffixes.length}S ranked`,
    );
  }
}

export interface Ranked {
  key: string;
  label: string;
  lift: number;
  ciLow: number;
  ciHigh: number;
  inDear: number;
  inBase: number;
  shareDear: number;
  shareBase: number;
  significant: boolean;
}

export interface RankedMod extends Ranked {
  name: string;
  tier: string;
  desecrated: boolean;
}

export interface CategoryAnalysis {
  key: string;
  label: string;
  group: string;
  section: string;
  at: string;
  minIlvl: number;
  total: number;
  ladder: LadderRung[];
  dearThresholdEx: number | null;
  dearCount: number | null;
  nDear: number;
  nBase: number;
  snapshots: number;
  trendPct: number | null;
  /** Most-listed bases, i.e. what the market actually uses. */
  bases: Ranked[];
  prefixes: RankedMod[];
  suffixes: RankedMod[];
}

function rankFeatures(
  agg: Map<string, [number, number]>,
  nDear: number,
  nBase: number,
  label: (k: string) => string,
): Ranked[] {
  const out: Ranked[] = [];
  if (!nDear || !nBase) return out;
  for (const [key, [a, b]] of agg) {
    if (a < MIN_IN_STRATUM || b < MIN_IN_STRATUM) continue;
    const { lift, ciLow, ciHigh, pDear, pBase } = liftCI(a, nDear, b, nBase);
    if (!Number.isFinite(lift)) continue;
    out.push({
      key,
      label: label(key),
      lift,
      ciLow,
      ciHigh,
      inDear: a,
      inBase: b,
      shareDear: pDear,
      shareBase: pBase,
      significant: ciLow > 1 || ciHigh < 1,
    });
  }
  return out;
}

function trend(rows: HistoryRow[], pick: (r: HistoryRow) => number | null): number | null {
  const vals = rows.map(pick).filter((v): v is number => v !== null && v > 0);
  if (vals.length < 2) return null;
  const now = vals[vals.length - 1]!;
  const then = vals[Math.max(0, vals.length - 1 - TREND_LOOKBACK)]!;
  return then === 0 ? null : ((now - then) / then) * 100;
}

export function buildAnalysis(history: Map<string, HistoryRow[]>, labels: Record<string, ModLabel>) {
  const out: CategoryAnalysis[] = [];

  for (const [, rows] of history) {
    if (!rows.length) continue;
    const latest = last(rows)!;

    // Pool only snapshots that defined "dear" the same way; a market move that shifts
    // the threshold would otherwise average two different questions together.
    const pool = rows.filter((r) => r.dearThresholdEx === latest.dearThresholdEx).slice(-POOL_SNAPSHOTS);

    const aggBases = new Map<string, [number, number]>();
    const aggMods = new Map<string, [number, number]>();
    let nDear = 0;
    let nBase = 0;
    for (const r of pool) {
      nDear += r.nDear;
      nBase += r.nBase;
      for (const [k, [a, b]] of Object.entries(r.bases)) {
        const c = aggBases.get(k) ?? [0, 0];
        aggBases.set(k, [c[0] + a, c[1] + b]);
      }
      for (const [k, [a, b]] of Object.entries(r.mods)) {
        const c = aggMods.get(k) ?? [0, 0];
        aggMods.set(k, [c[0] + a, c[1] + b]);
      }
    }

    // Bases are ordered by how much of the market they are: that IS "popular", and a
    // base nobody lists is a base nobody buys, however good its stats look.
    const bases = rankFeatures(aggBases, nDear, nBase, (k) => k).sort((a, b) => b.shareBase - a.shareBase);

    const modLabel = (k: string) => {
      const l = labels[k];
      return l?.stats.length ? l.stats.join(' / ') : k;
    };
    const mods: RankedMod[] = rankFeatures(aggMods, nDear, nBase, modLabel).map((r) => ({
      ...r,
      name: labels[r.key]?.name ?? '?',
      tier: labels[r.key]?.tier ?? '?',
      desecrated: labels[r.key]?.desecrated ?? false,
    }));

    // Order by the LOWER bound of the interval, not the point estimate.
    //
    // Sorting by lift itself surfaces noise preferentially: a mod seen 6 times can
    // show 2.2x on luck alone, and its variance is exactly why it floats to the top,
    // so the "best" three affixes would be the three least-evidenced ones. Ranking by
    // ciLow asks "what lift can we actually stand behind?", which rewards a solid 1.6x
    // from 40 sightings over a wild 2.2x from 6 and needs no arbitrary cutoff. Same
    // idea as a Wilson lower bound for rating sorts.
    const byEvidence = (x: RankedMod, y: RankedMod) => y.ciLow - x.ciLow || y.lift - x.lift;

    out.push({
      key: latest.key,
      label: latest.label,
      group: latest.group,
      section: latest.section,
      at: latest.at,
      minIlvl: latest.minIlvl,
      total: latest.total,
      ladder: latest.ladder,
      dearThresholdEx: latest.dearThresholdEx,
      dearCount: latest.dearCount,
      nDear,
      nBase,
      snapshots: pool.length,
      trendPct: trend(rows, (r) => r.total),
      bases: bases.slice(0, TOP_BASES),
      prefixes: mods.filter((m) => affixOf(m.tier) === 'prefix').sort(byEvidence).slice(0, TOP_MODS),
      suffixes: mods.filter((m) => affixOf(m.tier) === 'suffix').sort(byEvidence).slice(0, TOP_MODS),
    });
  }

  const latestRows = [...history.values()].flatMap((rows) => last(rows) ?? []);
  return {
    generatedAt: new Date().toISOString(),
    league: process.env.POE2_LEAGUE ?? 'Runes of Aldur',
    minIlvl: latestRows[0]?.minIlvl ?? null,
    divineRate: latestRows.find((r) => r.divineRate)?.divineRate ?? null,
    categories: out.sort((a, b) => b.total - a.total),
  };
}

if (import.meta.filename === process.argv[1]) await main();
