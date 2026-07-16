/**
 * Minimal client for the PoE2 trade API (pathofexile.com/api/trade2).
 *
 * This API is undocumented and unsanctioned — it's the trade site's own backend.
 * It currently answers unauthenticated, so we send no session cookie. In exchange
 * for using it we identify ourselves honestly and stay well inside the published
 * limits; see RateLimiter.
 */
import { RateLimiter } from './ratelimit.ts';
import type { Listing } from './types.ts';

const HOST = 'https://www.pathofexile.com';
const SEARCH_POLICY = 'trade-search-request-limit';
const FETCH_POLICY = 'trade-fetch-request-limit';

/** Observed limits, seeded so even our first request is throttled. */
const SEED_SEARCH = '5:10:60,15:60:300,30:300:1800';
const SEED_FETCH = '12:4:10,16:12:300';

/** trade2 returns at most this many result ids per search. */
export const SEARCH_RESULT_CAP = 100;
/** trade2 accepts at most this many ids per fetch call. */
export const FETCH_BATCH = 10;

export interface SearchResponse {
  id: string;
  total: number;
  result: string[];
  complexity: number;
}

interface RawMod {
  name: string;
  tier: string | null;
  level: number;
}
interface RawExplicit {
  description?: string;
  hash?: string;
  flags?: { desecrated?: boolean };
  mods?: (RawMod | null)[];
}
export interface RawResult {
  id: string;
  listing: {
    indexed?: string;
    price?: { type: string; amount: number; currency: string } | null;
    account?: { name?: string } | null;
  };
  item: {
    baseType?: string;
    typeLine?: string;
    rarity?: string;
    ilvl?: number;
    corrupted?: boolean;
    identified?: boolean;
    properties?: { name: string; values: [string, number][] }[];
    explicitMods?: RawExplicit[];
    extended?: { ar?: number; ev?: number; es?: number; [k: string]: unknown };
  };
}

/**
 * Thrown when the API bans us for longer than a run should wait. Collection is a
 * scheduled job — failing now with a clear reason beats sleeping half an hour and
 * looking hung. The next scheduled run picks up once the ban has expired.
 */
export class RateLimitedError extends Error {
  retryAfterSec: number;
  constructor(policy: string, retryAfterSec: number) {
    super(
      `${policy} is rate-limited for ${retryAfterSec}s (~${Math.ceil(retryAfterSec / 60)} min). ` +
        `Aborting; retry after that window. If this repeats, the IP is carrying limit debt — leave it idle a while.`,
    );
    this.name = 'RateLimitedError';
    this.retryAfterSec = retryAfterSec;
  }
}

export class TradeClient {
  private limiter = new RateLimiter();
  private league: string;
  private userAgent: string;

  constructor(league: string, userAgent: string) {
    this.league = league;
    this.userAgent = userAgent;
    this.limiter.seed(SEARCH_POLICY, SEED_SEARCH);
    this.limiter.seed(FETCH_POLICY, SEED_FETCH);
  }

  private headers(): Record<string, string> {
    return { 'user-agent': this.userAgent, accept: 'application/json' };
  }

  async search(query: unknown): Promise<SearchResponse> {
    const url = `${HOST}/api/trade2/search/poe2/${encodeURIComponent(this.league)}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.limiter.acquire(SEARCH_POLICY);
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify(query),
      });
      this.limiter.observe(SEARCH_POLICY, res.headers);
      if (res.status === 429) {
        const secs = await this.limiter.penalty(SEARCH_POLICY, res.headers);
        if (secs > 120) throw new RateLimitedError(SEARCH_POLICY, secs);
        continue;
      }
      if (!res.ok) throw new Error(`search failed: ${res.status} ${await res.text().catch(() => '')}`);
      return (await res.json()) as SearchResponse;
    }
    throw new Error('search failed after retries');
  }

  /** Fetches item detail for up to FETCH_BATCH ids. */
  async fetchBatch(ids: string[], queryId: string): Promise<RawResult[]> {
    if (!ids.length) return [];
    const url = `${HOST}/api/trade2/fetch/${ids.join(',')}?query=${encodeURIComponent(queryId)}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.limiter.acquire(FETCH_POLICY);
      const res = await fetch(url, { headers: this.headers() });
      this.limiter.observe(FETCH_POLICY, res.headers);
      if (res.status === 429) {
        const secs = await this.limiter.penalty(FETCH_POLICY, res.headers);
        if (secs > 120) throw new RateLimitedError(FETCH_POLICY, secs);
        continue;
      }
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const body = (await res.json()) as { result: (RawResult | null)[] };
      // Listings sold between search and fetch come back as nulls.
      return body.result.filter((r): r is RawResult => r !== null);
    }
    throw new Error('fetch failed after retries');
  }

  /** Fetches every id from a search, in batches. */
  async fetchAll(ids: string[], queryId: string): Promise<RawResult[]> {
    const out: RawResult[] = [];
    for (let i = 0; i < ids.length; i += FETCH_BATCH) {
      out.push(...(await this.fetchBatch(ids.slice(i, i + FETCH_BATCH), queryId)));
    }
    return out;
  }
}

function propValue(r: RawResult, name: RegExp): number {
  const p = r.item.properties?.find((x) => name.test(x.name));
  const v = p?.values?.[0]?.[0];
  return v ? Number(v.replace(/[^0-9.]/g, '')) || 0 : 0;
}

/** Quality is a property like "Quality" with value "+13%". */
function quality(r: RawResult): number {
  return propValue(r, /Quality/i);
}

/**
 * Flattens a trade result into our Listing shape.
 * `toEx` converts a listed currency amount into exalted-equivalent; it returns
 * null for currencies we have no rate for, which keeps unpriceable listings out
 * of the statistics rather than silently scoring them as zero.
 */
export function toListing(r: RawResult, toEx: (amount: number, currency: string) => number | null): Listing {
  const price = r.listing.price ?? null;
  const rarity = (r.item.rarity ?? 'normal').toLowerCase() as Listing['rarity'];
  return {
    id: r.id,
    baseName: r.item.baseType ?? r.item.typeLine ?? 'unknown',
    itemClass: r.item.properties?.[0]?.name ?? 'unknown',
    rarity,
    ilvl: r.item.ilvl ?? 0,
    corrupted: Boolean(r.item.corrupted),
    quality: quality(r),
    armour: r.item.extended?.ar ?? 0,
    evasion: r.item.extended?.ev ?? 0,
    energyShield: r.item.extended?.es ?? 0,
    explicits: (r.item.explicitMods ?? []).map((m) => m.description ?? '').filter(Boolean),
    price,
    priceEx: price ? toEx(price.amount, price.currency) : null,
    accountName: r.listing.account?.name ?? null,
    indexedAt: r.listing.indexed ?? null,
  };
}

export interface ItemMod {
  /** Stable identity: origin + mod family name + tier, e.g. "exp|Unassailable|P1". */
  key: string;
  /** The mod family's name as the game shows it, e.g. "Unassailable", "of the Proficient". */
  name: string;
  /** Tier within that family's own ladder, e.g. "P1" (prefix 1) or "S3" (suffix 3). */
  tier: string;
  desecrated: boolean;
  /** Stat lines this one mod grants. Hybrids grant more than one. */
  stats: string[];
}

/**
 * Extracts the distinct **mods** on an item.
 *
 * The unit here is the mod family + tier, not the stat line, and the distinction is
 * not cosmetic — it's the difference between a real measurement and nonsense.
 *
 * Trade reports one entry per *stat*, each naming the mod that granted it. Two facts
 * make stat-level keys useless:
 *
 *  - **Hybrids grant several stats.** "Celestial" P3 emits both `29% increased Energy
 *    Shield` and `+21 to maximum Mana` as separate entries. It is one mod, and a
 *    crafter hits it once.
 *  - **Unrelated families share stat hashes, and each has its own tier ladder.**
 *    `stat_4015621042` (increased ES) is granted by "Unassailable" (P1 = 92-100%),
 *    by "Celestial" (P3 = 27-32%, hybrid), and by desecrated "Dauntless" (P3 = 68-79%).
 *    Keying on hash+tier merges these into a bucket that corresponds to no mod at all —
 *    which is exactly how "[P2] increased Energy Shield" became a top result.
 *
 * So we key on the family name and its own tier, and keep desecrated mods separate
 * since they come from a different mechanic and cannot be crafted the same way.
 */
export function itemMods(r: RawResult): ItemMod[] {
  const byKey = new Map<string, ItemMod>();
  for (const entry of r.item.explicitMods ?? []) {
    const desecrated = Boolean(entry.flags?.desecrated) || (entry.hash ?? '').includes('.desecrated.');
    for (const mod of entry.mods ?? []) {
      if (!mod?.name) continue;
      const tier = mod.tier ?? '?';
      const key = `${desecrated ? 'des' : 'exp'}|${mod.name}|${tier}`;
      const existing = byKey.get(key);
      const stat = entry.description ?? entry.hash ?? '';
      if (existing) {
        if (stat && !existing.stats.includes(stat)) existing.stats.push(stat);
      } else {
        byKey.set(key, { key, name: mod.name, tier, desecrated, stats: stat ? [stat] : [] });
      }
    }
  }
  return [...byKey.values()];
}
