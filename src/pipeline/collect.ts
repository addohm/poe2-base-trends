/**
 * Collects one snapshot of trade listings for the tracked bases.
 *
 * Which bases we track is decided by the static data, not by trade: bases.json
 * already knows every pure-ES helmet and their exact rolls, so we simply price the
 * top ones. That ordering can't be skewed by what happens to be listed.
 *
 * Raw listings are written to cache/ (gitignored — far too large to version).
 * Only the aggregates that analyze.ts derives are committed.
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { TradeClient, toListing, modKeys, type RawResult } from '../lib/trade.ts';
import { RatesClient, converter } from '../lib/rates.ts';
import { buildQuery, specKey, type QuerySpec } from '../lib/query.ts';
import type { RankedBase } from './bases.ts';

const LEAGUE = process.env.POE2_LEAGUE ?? 'Runes of Aldur';
const UA = process.env.POE2_UA ?? 'poe2-base-trends/0.1 (+https://github.com/addohm/poe2-base-trends)';
const ROOT = process.cwd();
const RAW = path.join(ROOT, 'cache', 'raw');
const PREV = path.join(ROOT, 'cache', 'prev');

/**
 * How many bases per (class, archetype) group to price. Override with POE2_BASES —
 * a small first run (e.g. 2) is a cheap way to confirm the IP is not carrying
 * leftover rate-limit debt before committing to a full ~10-minute snapshot.
 */
const BASES_PER_GROUP = Number(process.env.POE2_BASES ?? 6);

/** The vertical slice: pure energy-shield helmets. */
const SLICE = { itemClass: 'Helmet', category: 'armour.helmet', archetype: 'es' };

export interface RawSnapshot {
  at: string;
  league: string;
  key: string;
  base: string;
  rarity: string;
  sampling: string;
  /** Total listings matching the query, not just the 100 we sampled. */
  total: number;
  rates: Record<string, number>;
  items: {
    id: string;
    priceEx: number | null;
    price: { amount: number; currency: string } | null;
    ilvl: number;
    es: number;
    ar: number;
    ev: number;
    mods: { key: string; hash: string; tier: string; text: string }[];
  }[];
}

function targetBases(bases: Record<string, RankedBase[]>): RankedBase[] {
  const pool = (bases[SLICE.itemClass] ?? []).filter((b) => b.archetype === SLICE.archetype);
  return pool.sort((a, b) => b.energyShieldMaxQ - a.energyShieldMaxQ).slice(0, BASES_PER_GROUP);
}

function specsFor(base: RankedBase): QuerySpec[] {
  const c = SLICE.category;
  return [
    // What does a blank/near-blank base cost? Cheapest asks answer that.
    { key: specKey(c, base.name, 'magic', 'price-asc'), category: c, type: base.name, rarity: 'magic', sampling: 'price-asc' },
    // What does a finished item cost, and what's actually on the market?
    { key: specKey(c, base.name, 'rare', 'price-asc'), category: c, type: base.name, rarity: 'rare', sampling: 'price-asc' },
    { key: specKey(c, base.name, 'rare', 'recent'), category: c, type: base.name, rarity: 'rare', sampling: 'recent' },
  ];
}

async function main(): Promise<void> {
  const basesDoc = JSON.parse(await readFile(path.join(ROOT, 'data', 'bases.json'), 'utf8')) as {
    classes: Record<string, RankedBase[]>;
  };
  const targets = targetBases(basesDoc.classes);
  const specs = targets.flatMap(specsFor);

  console.log(`League: ${LEAGUE}`);
  console.log(`Tracking ${targets.length} bases -> ${specs.length} queries`);
  console.log(`  ${targets.map((b) => `${b.name} (ES ${b.energyShieldMaxQ})`).join(', ')}\n`);

  console.log('Fetching currency rates...');
  const rates = await new RatesClient(LEAGUE, UA).fetchRates();
  const toEx = converter(rates);
  console.log(`  1 divine = ${rates.divine?.toFixed(0) ?? '?'} ex | tracked: ${Object.keys(rates).length} currencies\n`);

  const trade = new TradeClient(LEAGUE, UA);
  const at = new Date().toISOString();
  await mkdir(RAW, { recursive: true });
  await mkdir(PREV, { recursive: true });

  for (const spec of specs) {
    const rawPath = path.join(RAW, `${spec.key.replace(/:/g, '_')}.json`);
    const prevPath = path.join(PREV, `${spec.key.replace(/:/g, '_')}.json`);
    // Keep the previous run so analyze.ts can measure which listings disappeared.
    if (existsSync(rawPath)) await rename(rawPath, prevPath);

    const search = await trade.search(buildQuery(spec));
    const results: RawResult[] = await trade.fetchAll(search.result, search.id);

    const snap: RawSnapshot = {
      at,
      league: LEAGUE,
      key: spec.key,
      base: spec.type ?? '',
      rarity: spec.rarity,
      sampling: spec.sampling,
      total: search.total,
      rates,
      items: results.map((r) => {
        const l = toListing(r, toEx);
        return {
          id: l.id,
          priceEx: l.priceEx,
          price: l.price ? { amount: l.price.amount, currency: l.price.currency } : null,
          ilvl: l.ilvl,
          es: l.energyShield,
          ar: l.armour,
          ev: l.evasion,
          mods: modKeys(r),
        };
      }),
    };

    await writeFile(rawPath, JSON.stringify(snap));
    const priced = snap.items.filter((i) => i.priceEx !== null).length;
    console.log(`  ${spec.key.padEnd(42)} total=${String(snap.total).padStart(5)}  sampled=${String(snap.items.length).padStart(3)}  priced=${String(priced).padStart(3)}`);
  }

  console.log(`\nSnapshot ${at} complete. Run 'npm run analyze' to aggregate.`);
}

await main();
