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
  /** Names seen for this signature; each is really one tier's label. Diagnostic only. */
  names: string[];
  desecrated: boolean;
  stats: string[];
}

/** Tier counts, e.g. {P1: 4, P3: 9}. Kept per stratum so we can compare them. */
export type TierCounts = Record<string, number>;

export interface HistoryRow {
  at: string;
  key: string;
  label: string;
  /** bases.json group, e.g. "Helmet / es" — links a unit to its static stats. */
  group: string;
  section: string;
  kind: 'gear' | 'tablet' | 'waystone';
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
  /** mod key -> tier counts, per stratum. Says which tier the dear items carry. */
  tiersDear: Record<string, TierCounts>;
  tiersBase: Record<string, TierCounts>;
  /** Waystone reward magnitudes per stratum: property -> observed values. */
  propsDear?: Record<string, number[]>;
  propsBase?: Record<string, number[]>;
  divineRate: number | null;
}

/** "P1" -> 1. Lower is better; the ladder is numbered from the top. */
export const tierRank = (t: string): number => Number.parseInt(t.slice(1), 10) || 99;

/** Linear-interpolated quantile of a pre-sorted array. */
export function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/**
 * The median tier, weighted by how often each was seen.
 *
 * Comparing the dear median against the baseline median is what turns a pooled stat
 * back into crafting advice: "increased Armour is on 40% of everything" is a fact,
 * but "expensive ones carry P1-P2 where the market carries P4" is the instruction.
 */
export function medianTier(counts: TierCounts): string | null {
  const flat: string[] = [];
  for (const [t, n] of Object.entries(counts)) for (let i = 0; i < n; i++) flat.push(t);
  if (!flat.length) return null;
  flat.sort((a, b) => tierRank(a) - tierRank(b));
  return flat[Math.floor(flat.length / 2)]!;
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

  await mkdir(HISTORY, { recursive: true });
  const labelUpdates: Record<string, ModLabel> = {};
  let appended = 0;
  let skipped = 0;

  for (const f of files) {
    const snap = JSON.parse(await readFile(path.join(RAW, f), 'utf8')) as RawSnapshot;

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
        const l = (labelUpdates[m.key] ??= {
          names: [],
          desecrated: m.desecrated,
          stats: m.stats.map(genericLabel),
        });
        for (const n of m.names ?? []) if (!l.names.includes(n)) l.names.push(n);
      }
    }

    const tiersOf = (items: SampledItem[]) => {
      const out: Record<string, TierCounts> = {};
      for (const it of items) {
        for (const m of it.mods) {
          const c = (out[m.key] ??= {});
          for (const t of m.tiers ?? []) c[t] = (c[t] ?? 0) + 1;
        }
      }
      return out;
    };

    const baseKey = (i: SampledItem) => [i.baseName];
    const modKey = (i: SampledItem) => i.mods.map((m) => m.key);

    const pair = (dear: Map<string, number>, base: Map<string, number>) => {
      const out: Record<string, [number, number]> = {};
      for (const k of new Set([...dear.keys(), ...base.keys()])) out[k] = [dear.get(k) ?? 0, base.get(k) ?? 0];
      return out;
    };

    /** Collect each reward property's observed values across a stratum. */
    const propsOf = (items: SampledItem[]): Record<string, number[]> => {
      const out: Record<string, number[]> = {};
      for (const it of items) for (const [k, v] of Object.entries(it.props ?? {})) (out[k] ??= []).push(v);
      return out;
    };
    const isWaystone = snap.kind === 'waystone';

    const row: HistoryRow = {
      at: snap.at,
      key: snap.key,
      label: snap.label,
      group: snap.group,
      section: snap.section,
      kind: snap.kind,
      minIlvl: snap.minIlvl,
      ladder: snap.ladder,
      total: snap.total,
      dearThresholdEx: snap.dearThresholdEx,
      dearCount: snap.dearCount,
      nDear: snap.dearSample.length,
      nBase: snap.baseSample.length,
      bases: pair(countBy(snap.dearSample, baseKey), countBy(snap.baseSample, baseKey)),
      mods: pair(countBy(snap.dearSample, modKey), countBy(snap.baseSample, modKey)),
      tiersDear: tiersOf(snap.dearSample),
      tiersBase: tiersOf(snap.baseSample),
      propsDear: isWaystone ? propsOf(snap.dearSample) : undefined,
      propsBase: isWaystone ? propsOf(snap.baseSample) : undefined,
      divineRate: snap.rates.divine ?? null,
    };

    await appendFile(histPath(snap.key), JSON.stringify(row) + '\n');
    appended++;
  }

  const labels = await mergeLabels(labelUpdates);

  // Build the analysis from EVERY committed history file, not just the categories
  // that happen to have raw snapshots in this machine's cache. Raw cache is local,
  // disposable state; history is the committed record. The distinction bit hard on
  // the first VPS run: its fresh cache held one raw file, so analysis.json — and
  // with it the site — collapsed from 45 categories to 1. Keying off the history
  // directory makes analyze produce the same output on any machine with the repo.
  const history = new Map<string, HistoryRow[]>();
  const histFiles = (await readdir(HISTORY)).filter((f) => f.endsWith('.jsonl'));
  for (const f of histFiles) {
    const rows = (await readFile(path.join(HISTORY, f), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as HistoryRow);
    // The row carries its own key; the filename is just a sanitised rendering of it.
    if (rows.length) history.set(rows[rows.length - 1]!.key, rows);
  }

  if (!history.size) {
    console.log('No history yet — nothing to aggregate. The rotation fills this in one unit per tick.');
    return;
  }

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
  desecrated: boolean;
  /** Tier range across the whole ladder, e.g. "P1-P8". */
  tierRange: string | null;
  /** Median tier on expensive items vs on the market — the crafting instruction. */
  tierDear: string | null;
  tierMarket: string | null;
}

/** A waystone reward property: what the expensive stratum carries vs the market. */
export interface RewardStat {
  label: string;
  dearMedian: number;
  marketMedian: number;
  /** 75th percentile of the market — a concrete "aim above this" number. */
  marketP75: number;
  n: number;
}

export interface CategoryAnalysis {
  key: string;
  label: string;
  group: string;
  section: string;
  /**
   * `tablet-shared` is a synthetic card, not a collected unit: the pooled prefix
   * analysis across every tablet type. See buildAnalysis.
   */
  kind: 'gear' | 'tablet' | 'waystone' | 'tablet-shared';
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
  /** Waystone reward-property targets — the magnitudes that command a premium. */
  rewards: RewardStat[];
  /** Waystone mods that sink resale — over-represented on the cheap stratum. */
  sinks: RankedMod[];
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
  /**
   * Per-tablet-type mod counts, stashed so prefixes can be pooled afterwards.
   *
   * Map prefixes are shared across every tablet type — Breach, Ritual and the rest all
   * draw from the same generic pool (Gold found, Monster Rarity, Experience, Pack
   * Size…). Only suffixes are type-specific (Wombgifts and Rare Breach Monsters only
   * roll on Breach). Ranking prefixes per type would therefore split one pool of ~800
   * observations into eight thin slices of ~100 and estimate the same quantity eight
   * times, badly — the exact fragmentation that made the tier analysis meaningless.
   * Pooling keeps each type's own dear/baseline definition and just sums the counts,
   * which is a stratified estimate: it controls for type rather than ignoring it.
   */
  const tabletPools: { agg: Map<string, [number, number]>; nDear: number; nBase: number; total: number; at: string }[] =
    [];

  for (const [, rows] of history) {
    if (!rows.length) continue;
    const latest = last(rows)!;

    // Pool only snapshots that defined "dear" the same way; a market move that shifts
    // the threshold would otherwise average two different questions together.
    const pool = rows.filter((r) => r.dearThresholdEx === latest.dearThresholdEx).slice(-POOL_SNAPSHOTS);

    const aggBases = new Map<string, [number, number]>();
    const aggMods = new Map<string, [number, number]>();
    const aggTiersDear = new Map<string, TierCounts>();
    const aggTiersBase = new Map<string, TierCounts>();
    let nDear = 0;
    let nBase = 0;
    const addTiers = (into: Map<string, TierCounts>, from: Record<string, TierCounts>) => {
      for (const [k, counts] of Object.entries(from)) {
        const c = into.get(k) ?? {};
        for (const [t, n] of Object.entries(counts)) c[t] = (c[t] ?? 0) + n;
        into.set(k, c);
      }
    };
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
      addTiers(aggTiersDear, r.tiersDear ?? {});
      addTiers(aggTiersBase, r.tiersBase ?? {});
    }

    // Bases are ordered by how much of the market they are: that IS "popular", and a
    // base nobody lists is a base nobody buys, however good its stats look.
    const bases = rankFeatures(aggBases, nDear, nBase, (k) => k).sort((a, b) => b.shareBase - a.shareBase);

    const modLabel = (k: string) => {
      const l = labels[k];
      return l?.stats.length ? l.stats.join(' / ') : k;
    };
    const tierSpread = (counts: TierCounts | undefined): string | null => {
      const ts = Object.keys(counts ?? {}).sort((a, b) => tierRank(a) - tierRank(b));
      if (!ts.length) return null;
      return ts.length > 1 ? `${ts[0]}-${ts[ts.length - 1]}` : ts[0]!;
    };
    const mods: RankedMod[] = rankFeatures(aggMods, nDear, nBase, modLabel).map((r) => {
      const dearTiers = aggTiersDear.get(r.key);
      const baseTiers = aggTiersBase.get(r.key);
      return {
        ...r,
        desecrated: labels[r.key]?.desecrated ?? false,
        // Spread over the ladder, plus the typical tier each stratum carries — the
        // difference between the two is the actual crafting instruction.
        tierRange: tierSpread(baseTiers) ?? tierSpread(dearTiers),
        tierDear: medianTier(dearTiers ?? {}),
        tierMarket: medianTier(baseTiers ?? {}),
      };
    });

    // The affix is the middle segment of the key ("exp|p|..."), so it's authoritative
    // per mod and can't be contaminated by the same stat's other-affix twin elsewhere.
    const affixFor = (k: string): 'prefix' | 'suffix' | 'other' => {
      const seg = k.split('|')[1];
      return seg === 'p' ? 'prefix' : seg === 's' ? 'suffix' : 'other';
    };

    // Order by the LOWER bound of the interval, not the point estimate.
    //
    // Sorting by lift itself surfaces noise preferentially: a mod seen 6 times can
    // show 2.2x on luck alone, and its variance is exactly why it floats to the top,
    // so the "best" three affixes would be the three least-evidenced ones. Ranking by
    // ciLow asks "what lift can we actually stand behind?", which rewards a solid 1.6x
    // from 40 sightings over a wild 2.2x from 6 and needs no arbitrary cutoff. Same
    // idea as a Wilson lower bound for rating sorts.
    const byEvidence = (x: RankedMod, y: RankedMod) => y.ciLow - x.ciLow || y.lift - x.lift;

    // Waystone reward properties: pool each property's values across snapshots and
    // compare the expensive stratum's median to the market's. The market 75th
    // percentile is the concrete "aim above this to sell high" number.
    const rewards: RewardStat[] = [];
    if (latest.kind === 'waystone') {
      const dearVals: Record<string, number[]> = {};
      const baseVals: Record<string, number[]> = {};
      for (const r of pool) {
        for (const [k, vs] of Object.entries(r.propsDear ?? {})) (dearVals[k] ??= []).push(...vs);
        for (const [k, vs] of Object.entries(r.propsBase ?? {})) (baseVals[k] ??= []).push(...vs);
      }
      for (const k of Object.keys(baseVals)) {
        const b = [...baseVals[k]!].sort((x, y) => x - y);
        const d = [...(dearVals[k] ?? [])].sort((x, y) => x - y);
        if (b.length < MIN_IN_STRATUM) continue;
        rewards.push({
          label: k,
          dearMedian: Math.round(quantile(d, 0.5) ?? 0),
          marketMedian: Math.round(quantile(b, 0.5) ?? 0),
          marketP75: Math.round(quantile(b, 0.75) ?? 0),
          n: b.length,
        });
      }
      // Show the properties whose premium is largest first (biggest dear-vs-market gap).
      rewards.sort((a, b) => b.dearMedian - b.marketMedian - (a.dearMedian - a.marketMedian));
    }

    // Waystone mods that SINK resale: over-represented on the cheap stratum, i.e. lift
    // clearly below 1. These are the "affixes you don't want" — the build-breakers.
    const sinks =
      latest.kind === 'waystone'
        ? mods
            .filter((m) => m.significant && m.lift < 1)
            .sort((a, b) => a.ciHigh - b.ciHigh)
            .slice(0, TOP_MODS)
        : [];

    if (latest.kind === 'tablet') {
      tabletPools.push({ agg: aggMods, nDear, nBase, total: latest.total, at: latest.at });
    }

    out.push({
      key: latest.key,
      label: latest.label,
      group: latest.group,
      section: latest.section,
      kind: latest.kind,
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
      // For waystones, mods sorted by lift descending are the "tolerated / profitable"
      // ones; gear/tablets keep the evidence sort. Both use the same field.
      prefixes: mods.filter((m) => affixFor(m.key) === 'prefix').sort(byEvidence).slice(0, TOP_MODS),
      suffixes: mods.filter((m) => affixFor(m.key) === 'suffix').sort(byEvidence).slice(0, TOP_MODS),
      rewards,
      sinks,
    });
  }

  // Pooled tablet prefixes: one card standing in for all types, with ~8x the evidence
  // of any single type's estimate.
  if (tabletPools.length > 1) {
    const agg = new Map<string, [number, number]>();
    let nDear = 0;
    let nBase = 0;
    let total = 0;
    for (const p of tabletPools) {
      nDear += p.nDear;
      nBase += p.nBase;
      total += p.total;
      for (const [k, [a, b]] of p.agg) {
        const c = agg.get(k) ?? [0, 0];
        agg.set(k, [c[0] + a, c[1] + b]);
      }
    }
    const modLabel = (k: string) => {
      const l = labels[k];
      return l?.stats.length ? l.stats.join(' / ') : k;
    };
    const pooled: RankedMod[] = rankFeatures(agg, nDear, nBase, modLabel)
      .filter((r) => r.key.split('|')[1] === 'p')
      .map((r) => ({
        ...r,
        desecrated: labels[r.key]?.desecrated ?? false,
        tierRange: null,
        tierDear: null,
        tierMarket: null,
      }))
      .sort((a, b) => b.ciLow - a.ciLow || b.lift - a.lift)
      .slice(0, TOP_MODS);

    if (pooled.length) {
      out.push({
        key: 'map.tablet/_shared',
        label: 'Tablet prefixes — shared by every type',
        group: 'Tablet (shared)',
        section: 'Maps',
        kind: 'tablet-shared',
        // Oldest contributor, so the age pill doesn't overstate freshness: the pooled
        // view is only complete as of its stalest component.
        at: tabletPools.map((p) => p.at).sort()[0]!,
        minIlvl: 0,
        total,
        ladder: [],
        dearThresholdEx: null,
        dearCount: null,
        nDear,
        nBase,
        snapshots: tabletPools.length,
        trendPct: null,
        bases: [],
        prefixes: pooled,
        suffixes: [],
        rewards: [],
        sinks: [],
      });
    }
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
