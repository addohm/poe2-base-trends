/**
 * Currency exchange rates, in exalted-equivalent, from GGG's own currency exchange.
 *
 * Deliberately minimal. Trade converts prices to Exalted Orb equivalent *itself* when
 * a `price` filter carries no currency option, so the price ladders in collect.ts need
 * no rates at all. The only thing left that needs conversion is the handful of sampled
 * listings behind the blank-base floor, plus the "1 divine ≈ N ex" readout.
 *
 * That matters because the exchange endpoint is the most punishing of the three:
 * `30:300:1800` means thirty calls in five minutes earns a **thirty minute** ban. An
 * earlier version queried ten currencies per run and retried 429s without a bound; it
 * spun for 37 minutes against a ban it had itself caused. Hence: two calls, capped
 * retries, and failure that degrades instead of blocking.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { RateLimiter } from './ratelimit.ts';

const HOST = 'https://www.pathofexile.com';
const POLICY = 'trade-exchange-request-limit';
const SEED = '5:15:60,10:90:300,30:300:1800';

const CACHE_FILE = path.join(process.cwd(), 'cache', 'rates.json');

/**
 * How long a rate stays usable. Collection runs every half hour, but currency ratios
 * drift over hours, not minutes — and exchange is the harshest endpoint we touch
 * (`30:300:1800`, a thirty-minute ban). Re-querying it every run would make the
 * gentlest part of the job the most abusive. Six hours keeps it to ~4 calls a day.
 */
const TTL_MS = Number(process.env.POE2_RATES_TTL_H ?? 6) * 3600_000;

interface CachedRates {
  at: string;
  rates: Record<string, number>;
}

function readCache(): CachedRates | null {
  if (!existsSync(CACHE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as CachedRates;
  } catch {
    return null;
  }
}

function writeCache(rates: Record<string, number>): void {
  try {
    mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ at: new Date().toISOString(), rates } satisfies CachedRates));
  } catch {
    // Non-fatal; we just pay for a re-query next run.
  }
}

/**
 * Currencies worth a call. Exalted is the unit; divine is what dear items are priced
 * in; chaos shows up mid-market. Anything else yields priceEx = null, which excludes
 * that listing from price stats rather than silently scoring it wrong.
 */
export const TRACKED = ['divine', 'chaos'] as const;

interface ExchangeOffer {
  listing: {
    offers: { exchange: { currency: string; amount: number }; item: { currency: string; amount: number } }[];
  };
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export class RatesClient {
  private limiter = new RateLimiter();
  private league: string;
  private userAgent: string;

  constructor(league: string, userAgent: string) {
    this.league = league;
    this.userAgent = userAgent;
    this.limiter.seed(POLICY, SEED);
  }

  /** Exalted per one unit of `currency`; null if unavailable. Retries are bounded. */
  private async rateOf(currency: string): Promise<number | null> {
    const url = `${HOST}/api/trade2/exchange/poe2/${encodeURIComponent(this.league)}`;
    const body = {
      query: { status: { option: 'online' }, have: ['exalted'], want: [currency] },
      sort: { have: 'asc' },
      engine: 'new',
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      await this.limiter.acquire(POLICY);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': this.userAgent },
        body: JSON.stringify(body),
      });
      this.limiter.observe(POLICY, res.headers);

      if (res.status === 429) {
        const retry = Number(res.headers.get('retry-after') ?? '0');
        // A long ban is not something to wait out mid-run: the rest of the snapshot
        // uses a different limit bucket and can proceed without rates.
        if (retry > 120) {
          console.warn(`[rates] exchange is banned for ${retry}s — skipping rates for this run.`);
          return null;
        }
        await this.limiter.penalty(POLICY, res.headers);
        continue;
      }
      if (!res.ok) return null;

      const json = (await res.json()) as { result: Record<string, ExchangeOffer> };
      const ratios: number[] = [];
      // Offers come best-first; a median of a handful shrugs off one troll offer.
      for (const entry of Object.values(json.result ?? {}).slice(0, 8)) {
        const o = entry.listing?.offers?.[0];
        if (!o || !o.item?.amount) continue;
        ratios.push(o.exchange.amount / o.item.amount);
      }
      return median(ratios);
    }
    return null;
  }

  /**
   * Returns the exalted-equivalent table, from cache when it's fresh enough.
   *
   * Never throws: if exchange is unavailable we fall back to a stale cache, and
   * failing that to `{exalted: 1}` so collection still proceeds. Listings priced in
   * an unknown currency are then excluded from price stats rather than mis-scored.
   */
  async fetchRates(): Promise<Record<string, number>> {
    const cached = readCache();
    const ageMs = cached ? Date.now() - Date.parse(cached.at) : Infinity;
    if (cached && ageMs < TTL_MS) {
      console.log(`  rates from cache (${Math.round(ageMs / 60_000)} min old); no exchange calls`);
      return cached.rates;
    }

    const rates: Record<string, number> = { exalted: 1 };
    for (const c of TRACKED) {
      try {
        const r = await this.rateOf(c);
        if (r && Number.isFinite(r) && r > 0) rates[c] = r;
        else console.warn(`[rates] no rate for ${c}; listings priced in it are excluded`);
      } catch (err) {
        console.warn(`[rates] ${c} failed (${(err as Error).message}); continuing without it`);
      }
    }

    // A lookup that found nothing beyond the unit is worse than yesterday's numbers.
    if (Object.keys(rates).length === 1 && cached) {
      console.warn(`  exchange unavailable; reusing rates from ${cached.at}`);
      return cached.rates;
    }
    writeCache(rates);
    return rates;
  }
}

/** Builds a converter that returns null for currencies we couldn't price. */
export function converter(rates: Record<string, number>) {
  return (amount: number, currency: string): number | null => {
    const r = rates[currency];
    return r === undefined ? null : amount * r;
  };
}
