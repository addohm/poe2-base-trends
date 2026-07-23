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

  /**
   * Longest active ban across the endpoints a collection needs, in seconds.
   *
   * Call before doing any work. A run that starts under a fetch ban will spend all
   * its searches on ladders and then throw them away when the first fetch is refused,
   * so checking up front is the difference between costing nothing and costing a
   * dozen requests that a real player could have used.
   */
  bannedFor(): { policy: string; seconds: number } | null {
    const worst = [SEARCH_POLICY, FETCH_POLICY]
      .map((p) => ({ policy: p, seconds: this.limiter.blockedFor(p) }))
      .sort((a, b) => b.seconds - a.seconds)[0]!;
    return worst.seconds > 0 ? worst : null;
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
      this.limiter.succeeded(SEARCH_POLICY);
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
      this.limiter.succeeded(FETCH_POLICY);
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
 * The numeric reward properties trade exposes for a waystone.
 *
 * Unlike gear, a waystone's value is largely these magnitudes — buyers filter for high
 * pack size / rarity / quantity — so they're extracted as numbers rather than parsed
 * out of mod text. The keys match trade's own property labels.
 */
export const WAYSTONE_PROPS = ['Item Quantity', 'Item Rarity', 'Pack Size', 'Monster Rarity', 'Waystone Drop Chance', 'Waystone Experience', 'Waystone Gold'] as const;

export function waystoneProps(r: RawResult): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of r.item.properties ?? []) {
    // Match on the plain label; values look like "+23%" or "23".
    const label = WAYSTONE_PROPS.find((w) => p.name.includes(w));
    if (!label) continue;
    const raw = p.values?.[0]?.[0];
    if (raw == null) continue;
    const n = Number(String(raw).replace(/[^0-9.]/g, ''));
    if (Number.isFinite(n)) out[label] = n;
  }
  return out;
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
  /** Stable identity: origin + the stat signature, e.g. "exp|#% increased Armour". */
  key: string;
  /** Mod names seen for this signature. Each name is really one tier's label. */
  names: string[];
  /** Tiers of this signature present on the item, e.g. ["P1"]. */
  tiers: string[];
  desecrated: boolean;
  /** Stat lines this mod grants, numbers blanked. Hybrids grant more than one. */
  stats: string[];
}

/** Trade wraps game terms as [Display|Link]. */
const clean = (s: string) => s.replace(/\[([^\]|]*)\|?([^\]]*)\]/g, (_, a: string, b: string) => b || a);
/** Blank the rolled numbers so a stat describes the mod, not one item's roll. */
const generic = (s: string) => clean(s).replace(/[+-]?\d+(\.\d+)?/g, '#');
/** P# = prefix, S# = suffix. The letter is the affix. */
const affixLetter = (tier: string): 'p' | 's' | 'x' => (tier[0] === 'P' ? 'p' : tier[0] === 'S' ? 's' : 'x');

/**
 * Extracts the distinct **mods** on an item, keyed by what they grant.
 *
 * Getting this key right took two wrong turns worth recording.
 *
 * **First wrong turn: keying on stat hash + tier.** Trade reports one entry per stat,
 * each naming the mod that granted it. Several unrelated mods grant the same stat, so
 * `stat_4015621042|P1` merged "Unassailable" (92-100% increased ES) with "Celestial"
 * (41%, a hybrid) — a bucket matching no real mod, which is how "[P2] increased Energy
 * Shield" once ranked as a top result.
 *
 * **Second wrong turn: keying on mod name + tier.** This is coherent but shatters the
 * data. The mod *name is essentially the tier's label* — "Unassailable" IS P1 of
 * increased ES — so name+tier splits one stat across its whole ladder. On a 100-item
 * sample, `+ to Spirit` fragmented into eight slivers of 1-8 sightings, every one below
 * the evidence floor: a stat present on 22% of items vanished from the page entirely.
 * Worse, the slivers manufactured fake winners — "S2 Cold Resistance, 2.4x, significant"
 * was small-sample noise, where the stat pooled across tiers is a sober 1.3x.
 *
 * So the key is **affix + stat signature**: every stat the mod grants, numbers
 * blanked, joined, tagged prefix or suffix. That pools a tier ladder into the thing a
 * crafter actually targets, while three things stay correctly separate:
 *
 *  - hybrids ("#% increased Armour / # to maximum Life" vs "#% increased Armour"),
 *    because their signatures differ;
 *  - the same stat as a prefix vs a suffix — "+ to Spirit" exists as both, and they
 *    occupy different affix slots, so an item can carry one of each; folding them
 *    together would both mislabel the column and let a mod appear twice on one item;
 *  - desecrated mods, a different mechanic not craftable the same way.
 *
 * Tiers are kept alongside rather than in the key, so we can still report which tier
 * the expensive items actually carry.
 */
export function itemMods(r: RawResult): ItemMod[] {
  // Group a hybrid's stat lines under (origin, name, affix) first, so its signature is
  // the whole mod. Name alone isn't enough: a stat can be both prefix and suffix.
  const byMod = new Map<string, ItemMod>();
  for (const entry of r.item.explicitMods ?? []) {
    const desecrated = Boolean(entry.flags?.desecrated) || (entry.hash ?? '').includes('.desecrated.');
    const stat = generic(entry.description ?? entry.hash ?? '');
    if (!stat) continue;

    for (const mod of entry.mods ?? []) {
      if (!mod?.name) continue;
      const aff = affixLetter(mod.tier ?? '');
      const id = `${desecrated ? 'des' : 'exp'}|${aff}|${mod.name}`;
      const existing = byMod.get(id);
      if (existing) {
        if (!existing.stats.includes(stat)) existing.stats.push(stat);
      } else {
        byMod.set(id, {
          key: id,
          names: [mod.name],
          tiers: mod.tier ? [mod.tier] : [],
          desecrated,
          stats: [stat],
        });
      }
    }
  }

  // Re-key by affix + stat signature, pooling the tier ladder.
  const bySignature = new Map<string, ItemMod>();
  for (const m of byMod.values()) {
    const aff = affixLetter(m.tiers[0] ?? '');
    // Sort the stats for the KEY so a hybrid folds together regardless of the order
    // trade listed its lines in; `m.stats` keeps its natural display order.
    const sig = [...m.stats].sort().join(' / ');
    const key = `${m.desecrated ? 'des' : 'exp'}|${aff}|${sig}`;
    const existing = bySignature.get(key);
    if (!existing) {
      bySignature.set(key, { ...m, key });
      continue;
    }
    for (const n of m.names) if (!existing.names.includes(n)) existing.names.push(n);
    for (const t of m.tiers) existing.tiers.push(t);
  }
  return [...bySignature.values()];
}
