/**
 * Collects a snapshot for the next base(s) in the work queue — by default exactly one
 * per invocation.
 *
 * A slow rotation, never a blitz. Trade's rate limits are per-IP, and that IP belongs
 * to a person who also browses the trade site — which rate-limits ordinary players on
 * its own. Emptying the budget in one burst means competing with your own operator
 * for it; it is a shared resource to leave most of alone.
 *
 * Hence: one base per process, ~12 searches, then exit. The *scheduler* supplies the
 * pacing, not a long-running loop in here — which keeps the per-run cost flat and
 * makes the tick interval a knob rather than something baked into this file. A full
 * pass takes hours, which is fine: base prices don't move faster than that.
 *
 * Three things are gathered, each answering a different half of "is this worth
 * crafting?":
 *
 *  1. **Price ladders** — for each of a few exalted-equivalent thresholds, how many
 *     listings are at or above it. These are `total` counts from search, so they
 *     describe the *entire* market rather than a 100-item sample, and they cost no
 *     fetch calls at all. This is where price stats come from now.
 *
 *  2. **A top-stratum sample** — items priced at or above a threshold chosen from the
 *     ladder to capture roughly the dearest quarter of the market.
 *
 *  3. **A baseline sample** — all priced items.
 *
 * (2) vs (3) is what mod-lift is computed from. The earlier design took the top
 * quartile *of a 100-item sample*, which meant ranking mods off ~25 items; worse, the
 * threshold moved with whatever happened to be listed. Slicing by an absolute price
 * that trade computes for us fixes both, and gives each stratum a full 100 items.
 *
 * Bases are chosen from static data, so the set never depends on what's for sale.
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { TradeClient, toListing, itemMods, RateLimitedError, type RawResult } from '../lib/trade.ts';
import { RatesClient, converter } from '../lib/rates.ts';
import { buildQuery, specKey, slugify, type QuerySpec } from '../lib/query.ts';
import { take, complete, peek } from '../lib/queue.ts';
import type { RankedBase } from './bases.ts';

const LEAGUE = process.env.POE2_LEAGUE ?? 'Runes of Aldur';
const UA = process.env.POE2_UA ?? 'poe2-base-trends/0.1 (+https://github.com/addohm/poe2-base-trends)';
const ROOT = process.cwd();
const RAW = path.join(ROOT, 'cache', 'raw');
const PREV = path.join(ROOT, 'cache', 'prev');

/**
 * Item level floor. Mod tiers are ilvl-gated, so mixing levelling drops with endgame
 * items compares things that can't roll the same mods. 70 is the default; the useful
 * range is 60-100.
 */
export const MIN_ILVL = Math.min(100, Math.max(60, Number(process.env.POE2_MIN_ILVL ?? 70)));

/** Size of the tracked set. A full cycle refreshes all of these, one run at a time. */
const BASES_PER_GROUP = Number(process.env.POE2_BASES ?? 6);

/**
 * Bases collected per invocation.
 *
 * Keep this at 1. If a full cycle feels too slow, shorten the *scheduler's* interval
 * instead — that raises the duty cycle gently, where raising this spikes it and
 * rebuilds the burst the rotation exists to avoid. Mainly a lever for a deliberate
 * one-off backfill on an IP you know is idle.
 */
const BATCH = Math.max(1, Number(process.env.POE2_BATCH ?? 1));

/** The vertical slice: pure energy-shield helmets. */
const SLICE = { itemClass: 'Helmet', category: 'armour.helmet', archetype: 'es' };

/** Exalted-equivalent rungs for the rare price ladder. */
const RARE_LADDER = [1, 50, 200, 1000, 5000];
/** Rungs for magic bases, which are far cheaper. */
const MAGIC_LADDER = [1, 5, 20, 100];

/** Fraction of the market the "top" stratum should aim to cover. */
const TOP_TARGET = 0.25;
/** A stratum below this many listings is too thin to sample meaningfully. */
const MIN_STRATUM = 40;

export interface LadderRung {
  minEx: number;
  count: number;
}

export interface SampledItem {
  id: string;
  priceEx: number | null;
  price: { amount: number; currency: string } | null;
  ilvl: number;
  es: number;
  mods: { key: string; name: string; tier: string; desecrated: boolean; stats: string[] }[];
}

export interface RawSnapshot {
  at: string;
  league: string;
  minIlvl: number;
  key: string;
  base: string;
  rates: Record<string, number>;
  /** Whole-market counts by exalted-equivalent price. */
  magicLadder: LadderRung[];
  rareLadder: LadderRung[];
  /** Exalted-equivalent threshold used to define the top stratum. */
  topThresholdEx: number | null;
  topCount: number | null;
  topSample: SampledItem[];
  baseSample: SampledItem[];
  /** Cheapest magic asks, for the blank-base floor. */
  magicCheap: SampledItem[];
}

function targetBases(bases: Record<string, RankedBase[]>): RankedBase[] {
  const pool = (bases[SLICE.itemClass] ?? []).filter((b) => b.archetype === SLICE.archetype);
  return pool.sort((a, b) => b.energyShieldMaxQ - a.energyShieldMaxQ).slice(0, BASES_PER_GROUP);
}

function spec(base: string, rarity: QuerySpec['rarity'], tag: string, extra: Partial<QuerySpec> = {}): QuerySpec {
  return {
    key: specKey(SLICE.category, base, rarity, tag),
    category: SLICE.category,
    type: base,
    rarity,
    sampling: 'recent',
    minIlvl: MIN_ILVL,
    collapse: true,
    ...extra,
  };
}

/** Runs a ladder of count-only searches. Cheap: no fetches. */
async function ladder(
  trade: TradeClient,
  base: string,
  rarity: QuerySpec['rarity'],
  rungs: number[],
): Promise<LadderRung[]> {
  const out: LadderRung[] = [];
  for (const minEx of rungs) {
    const res = await trade.search(buildQuery(spec(base, rarity, `ladder${minEx}`, { priceMin: minEx })));
    out.push({ minEx, count: res.total });
  }
  return out;
}

/**
 * Picks the exalted threshold whose stratum best approximates the dearest TOP_TARGET
 * of the market while still holding enough listings to sample.
 */
export function pickTopThreshold(rungs: LadderRung[]): { minEx: number; count: number } | null {
  const total = rungs.find((r) => r.minEx === 1)?.count ?? rungs[0]?.count ?? 0;
  if (!total) return null;
  const usable = rungs.filter((r) => r.minEx > 1 && r.count >= MIN_STRATUM);
  if (!usable.length) return null;
  let best = usable[0]!;
  for (const r of usable) {
    if (Math.abs(r.count / total - TOP_TARGET) < Math.abs(best.count / total - TOP_TARGET)) best = r;
  }
  return { minEx: best.minEx, count: best.count };
}

async function sample(
  trade: TradeClient,
  s: QuerySpec,
  toEx: (a: number, c: string) => number | null,
  limit = 100,
): Promise<SampledItem[]> {
  const res = await trade.search(buildQuery(s));
  const ids = res.result.slice(0, limit);
  const results: RawResult[] = await trade.fetchAll(ids, res.id);
  return results.map((r) => {
    const l = toListing(r, toEx);
    return {
      id: l.id,
      priceEx: l.priceEx,
      price: l.price ? { amount: l.price.amount, currency: l.price.currency } : null,
      ilvl: l.ilvl,
      es: l.energyShield,
      mods: itemMods(r),
    };
  });
}

async function main(): Promise<void> {
  const basesDoc = JSON.parse(await readFile(path.join(ROOT, 'data', 'bases.json'), 'utf8')) as {
    classes: Record<string, RankedBase[]>;
  };
  const targets = targetBases(basesDoc.classes);
  const byName = new Map(targets.map((b) => [b.name, b]));

  // Take only this run's share of the work; the rest waits for later runs.
  const { batch, state } = take(
    targets.map((b) => b.name),
    BATCH,
  );
  const queue = batch.map((n) => byName.get(n)!).filter(Boolean);

  console.log(`League: ${LEAGUE} | ilvl >= ${MIN_ILVL}`);
  console.log(`Tracking ${targets.length} bases; ${state.pending.length} left in this cycle (cycle ${state.cycles + 1}).`);
  console.log(`This run: ${queue.map((b) => b.name).join(', ')}\n`);

  const trade = new TradeClient(LEAGUE, UA);

  // Preflight, before a single request. A ban known from a previous run means this
  // run cannot finish a base, and starting anyway would burn a dozen searches on
  // ladders only to be refused at the first fetch. Those requests are shared with a
  // human using the trade site; spending them on work we know will be discarded is
  // the exact opposite of what a trickle collector is for.
  const ban = trade.bannedFor();
  if (ban) {
    console.log(`${ban.policy} is banned for ${ban.seconds}s (~${Math.ceil(ban.seconds / 60)} min).`);
    console.log(`Nothing requested. ${queue[0]?.name ?? 'The queue'} stays queued for the next run.`);
    return;
  }

  console.log('Currency rates...');
  const rates = await new RatesClient(LEAGUE, UA).fetchRates();
  const toEx = converter(rates);
  console.log(`  1 divine = ${rates.divine?.toFixed(0) ?? '?'} ex\n`);

  const at = new Date().toISOString();
  await mkdir(RAW, { recursive: true });
  await mkdir(PREV, { recursive: true });

  let done = 0;
  for (const base of queue) {
    const key = `${SLICE.category.replace('armour.', '')}:${slugify(base.name)}`;
    const file = `${key.replace(/:/g, '_')}.json`;
    const rawPath = path.join(RAW, file);
    if (existsSync(rawPath)) await rename(rawPath, path.join(PREV, file));

    try {
      const rareLadder = await ladder(trade, base.name, 'rare', RARE_LADDER);
      const magicLadder = await ladder(trade, base.name, 'magic', MAGIC_LADDER);

      const top = pickTopThreshold(rareLadder);
      const topSample = top
        ? await sample(trade, spec(base.name, 'rare', 'top', { priceMin: top.minEx }), toEx)
        : [];
      const baseSample = await sample(trade, spec(base.name, 'rare', 'base', { priceMin: 1 }), toEx);
      // 20 cheapest magic asks is plenty to place a blank-base floor.
      const magicCheap = await sample(
        trade,
        spec(base.name, 'magic', 'cheap', { priceMin: 1, sampling: 'price-asc' }),
        toEx,
        20,
      );

      const snap: RawSnapshot = {
        at,
        league: LEAGUE,
        minIlvl: MIN_ILVL,
        key,
        base: base.name,
        rates,
        magicLadder,
        rareLadder,
        topThresholdEx: top?.minEx ?? null,
        topCount: top?.count ?? null,
        topSample,
        baseSample,
        magicCheap,
      };
      // Written per base, so a ban partway through keeps everything already gathered.
      await writeFile(rawPath, JSON.stringify(snap));
      done++;

      const total = rareLadder.find((r) => r.minEx === 1)?.count ?? 0;
      const pct = top && total ? ((top.count / total) * 100).toFixed(0) : '?';
      // Only now is this base off the cycle's list; an abort leaves it at the head
      // of the queue and the next scheduled run picks it up.
      complete([base.name]);
      console.log(
        `  ${base.name.padEnd(24)} rare=${String(total).padStart(5)}  top>=${String(top?.minEx ?? '-').padStart(4)}ex (${pct}%)  sampled top=${String(topSample.length).padStart(3)} base=${String(baseSample.length).padStart(3)}`,
      );
    } catch (err) {
      if (err instanceof RateLimitedError) {
        console.error(`\n${err.message}`);
        console.error(`${base.name} stays queued for the next run; ${done} base(s) collected this run.`);
        process.exitCode = 0; // A ban is expected weather, not a build failure.
        return;
      }
      throw err;
    }
  }

  const left = peek()?.pending.length ?? 0;
  console.log(`\nCollected ${done} base(s) at ${at}.`);
  console.log(left ? `${left} left in this cycle.` : 'Cycle complete — next run starts a fresh pass.');
  console.log(`Run 'npm run analyze' to fold this into the aggregates.`);
}

// Guarded so tests can import the pure helpers without triggering a collection.
if (import.meta.filename === process.argv[1]) await main();
