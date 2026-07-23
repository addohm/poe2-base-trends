/**
 * Collects one work unit per run — a category, split by defence archetype for armour.
 *
 * The archetype split is not cosmetic. A pure-energy-shield helmet and an
 * armour/evasion one are different markets serving different builds; asking for "the
 * top 3 helmet bases" across both returns three unrelated items that no build would
 * consider together. So "Helmet / es" and "Helmet / ar/ev" are separate units, and
 * each gets its own top bases and affixes.
 *
 * The question each unit answers is "what should I craft on to make a profit?", which
 * needs two things and gets both from the same sample:
 *
 *  1. **Which bases do people actually use.** Every base type gets used by somebody;
 *     what matters is which ones the market is thick with. That's the frequency of
 *     each base among real listings — not which base has the biggest number in the
 *     game files. A base nobody lists is a base nobody buys.
 *  2. **Which prefixes and suffixes are worth chasing.** Same items, counting mods.
 *
 * Both come from contrasting two samples of the same category:
 *
 *  - **baseline** — every priced listing at endgame item level. What the market is.
 *  - **dear** — listings at or above a price threshold picked from a ladder, roughly
 *    the top quarter. What sells high.
 *
 * A thing more common in `dear` than in `baseline` is a thing people pay for. That
 * ratio works identically for bases and for mods, which is why one sample answers
 * both questions.
 *
 * A run is ~26 requests and a few minutes; the scheduler decides how often. See
 * docs/collection.md — the rate limits are shared with the human at the keyboard.
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { TradeClient, toListing, itemMods, waystoneProps, RateLimitedError, type RawResult } from '../lib/trade.ts';
import { RatesClient, converter } from '../lib/rates.ts';
import { buildQuery, type QuerySpec } from '../lib/query.ts';
import { take, complete, peek } from '../lib/queue.ts';
import { workUnits, archetypeFilter, type WorkUnit } from '../lib/categories.ts';
import type { BasesDoc } from './bases.ts';

const LEAGUE = process.env.POE2_LEAGUE ?? 'Runes of Aldur';
const UA = process.env.POE2_UA ?? 'poe2-base-trends/0.1 (+https://github.com/addohm/poe2-base-trends)';
const ROOT = process.cwd();
const RAW = path.join(ROOT, 'cache', 'raw');
const PREV = path.join(ROOT, 'cache', 'prev');

/**
 * Item level floor. Mod tiers are ilvl-gated, so mixing levelling drops with endgame
 * items compares markets that can't roll the same mods. Useful range 60-100.
 */
export const MIN_ILVL = Math.min(100, Math.max(60, Number(process.env.POE2_MIN_ILVL ?? 70)));

/** Categories per run. Keep at 1; shorten the scheduler interval instead. */
const BATCH = Math.max(1, Number(process.env.POE2_BATCH ?? 1));

/** Exalted-equivalent rungs used to find the "dear" threshold. */
const LADDER = [1, 50, 200, 1000, 5000];
/** Fraction of the market the dear stratum should aim at. */
const TOP_TARGET = 0.25;
/** A stratum below this many listings is too thin to sample. */
const MIN_STRATUM = 40;

export interface LadderRung {
  minEx: number;
  count: number;
}

export interface SampledItem {
  id: string;
  baseName: string;
  priceEx: number | null;
  ilvl: number;
  mods: { key: string; names: string[]; tiers: string[]; desecrated: boolean; stats: string[] }[];
  /** Waystone reward magnitudes (Pack Size, Rarity, …). Absent for non-maps. */
  props?: Record<string, number>;
}

export interface RawSnapshot {
  at: string;
  league: string;
  minIlvl: number;
  /** Work unit id, e.g. "armour.helmet/es". */
  key: string;
  label: string;
  /** The bases.json group this unit corresponds to, e.g. "Helmet / es". */
  group: string;
  section: string;
  kind: import('../lib/categories.ts').UnitKind;
  rates: Record<string, number>;
  ladder: LadderRung[];
  dearThresholdEx: number | null;
  dearCount: number | null;
  /** Total priced listings at this item level. */
  total: number;
  baseSample: SampledItem[];
  dearSample: SampledItem[];
}

function spec(unit: WorkUnit, tag: string, extra: Partial<QuerySpec> = {}): QuerySpec {
  return {
    key: `${unit.id}:${tag}`,
    category: unit.category,
    rarity: 'rare',
    sampling: 'recent',
    collapse: true,
    // Gear uses an item-level floor and a defence archetype; maps use neither, and
    // waystones substitute a tier floor. Applying an ilvl filter to a tablet returns
    // nothing, so these are strictly per-kind.
    minIlvl: unit.kind === 'gear' ? (unit.minIlvl ?? MIN_ILVL) : undefined,
    defence: unit.kind === 'gear' ? archetypeFilter(unit.archetype) : null,
    mapTier: unit.minTier,
    ...extra,
  };
}

/** Count-only searches: they describe the whole market and cost no fetches. */
async function ladder(trade: TradeClient, unit: WorkUnit): Promise<LadderRung[]> {
  const out: LadderRung[] = [];
  for (const minEx of LADDER) {
    const res = await trade.search(buildQuery(spec(unit, `ladder${minEx}`, { priceMin: minEx })));
    out.push({ minEx, count: res.total });
  }
  return out;
}

/** The rung whose stratum is closest to the dearest TOP_TARGET while still samplable. */
export function pickDearThreshold(rungs: LadderRung[]): { minEx: number; count: number } | null {
  const total = rungs.find((r) => r.minEx === 1)?.count ?? 0;
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
  withProps = false,
): Promise<SampledItem[]> {
  const res = await trade.search(buildQuery(s));
  const results: RawResult[] = await trade.fetchAll(res.result.slice(0, 100), res.id);
  return results.map((r) => {
    const l = toListing(r, toEx);
    const item: SampledItem = { id: l.id, baseName: l.baseName, priceEx: l.priceEx, ilvl: l.ilvl, mods: itemMods(r) };
    if (withProps) item.props = waystoneProps(r);
    return item;
  });
}

async function main(): Promise<void> {
  // The work list is derived from the static tables, so a unit exists only if the game
  // actually has bases for it — no querying trade for an evasion Focus.
  const basesDoc = JSON.parse(await readFile(path.join(ROOT, 'data', 'bases.json'), 'utf8')) as BasesDoc;
  const UNITS = workUnits(basesDoc.groups, basesDoc.families);
  const byId = new Map(UNITS.map((u) => [u.id, u]));

  // POE2_ONLY targets specific unit ids (comma-separated), bypassing the queue. For a
  // deliberate backfill or validating one unit — not the scheduled path.
  const only = (process.env.POE2_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  let queue: WorkUnit[];
  let state: { pending: string[]; done: string[]; cycles: number };
  if (only.length) {
    queue = only.map((id) => byId.get(id)).filter((u): u is WorkUnit => Boolean(u)).slice(0, BATCH);
    state = { pending: [], done: [], cycles: 0 };
    console.log(`POE2_ONLY: ${queue.map((u) => u.id).join(', ')}`);
  } else {
    const taken = take(
      UNITS.map((u) => u.id),
      BATCH,
    );
    queue = taken.batch.map((id) => byId.get(id)!).filter(Boolean);
    state = taken.state;
  }

  console.log(`League: ${LEAGUE} | ilvl >= ${MIN_ILVL}`);
  console.log(`${UNITS.length} units tracked; ${state.pending.length} left this cycle (cycle ${state.cycles + 1}).`);
  console.log(`This run: ${queue.map((u) => u.label).join(', ')}\n`);

  const trade = new TradeClient(LEAGUE, UA);

  // Before spending anything: a ban known from a previous run means this run can't
  // finish, and starting would burn searches only to be refused at the first fetch.
  const ban = trade.bannedFor();
  if (ban) {
    console.log(`${ban.policy} banned for ${ban.seconds}s (~${Math.ceil(ban.seconds / 60)} min).`);
    console.log(`Nothing requested. ${queue[0]?.label ?? 'The queue'} stays queued.`);
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
  for (const unit of queue) {
    const file = `${unit.id.replace(/[./]/g, '_')}.json`;
    const rawPath = path.join(RAW, file);
    if (existsSync(rawPath)) await rename(rawPath, path.join(PREV, file));

    try {
      const wantProps = unit.kind === 'waystone';
      const rungs = await ladder(trade, unit);
      const dear = pickDearThreshold(rungs);
      const baseSample = await sample(trade, spec(unit, 'base', { priceMin: 1 }), toEx, wantProps);
      const dearSample = dear ? await sample(trade, spec(unit, 'dear', { priceMin: dear.minEx }), toEx, wantProps) : [];

      const snap: RawSnapshot = {
        at,
        league: LEAGUE,
        minIlvl: MIN_ILVL,
        key: unit.id,
        label: unit.label,
        group: unit.group,
        section: unit.section,
        kind: unit.kind,
        rates,
        ladder: rungs,
        dearThresholdEx: dear?.minEx ?? null,
        dearCount: dear?.count ?? null,
        total: rungs.find((r) => r.minEx === 1)?.count ?? 0,
        baseSample,
        dearSample,
      };
      // Written per unit, so a ban partway through keeps what's already gathered.
      await writeFile(rawPath, JSON.stringify(snap));
      if (!only.length) complete([unit.id]);
      done++;

      const pct = dear && snap.total ? ((dear.count / snap.total) * 100).toFixed(0) : '?';
      console.log(
        `  ${unit.label.padEnd(32)} listed=${String(snap.total).padStart(5)}  dear>=${String(dear?.minEx ?? '-').padStart(4)}ex (${pct}%)  sampled ${baseSample.length}/${dearSample.length}`,
      );
    } catch (err) {
      if (err instanceof RateLimitedError) {
        console.error(`\n${err.message}`);
        console.error(`${unit.label} stays queued; ${done} unit(s) collected this run.`);
        process.exitCode = 0; // A ban is expected weather, not a build failure.
        return;
      }
      throw err;
    }
  }

  const left = peek()?.pending.length ?? 0;
  console.log(`\nCollected ${done} unit${done === 1 ? '' : 's'} at ${at}.`);
  console.log(left ? `${left} left this cycle.` : 'Cycle complete — next run starts a fresh pass.');
}

if (import.meta.filename === process.argv[1]) await main();
