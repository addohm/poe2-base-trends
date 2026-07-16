/**
 * Currency exchange rates, in exalted-equivalent, from GGG's own currency exchange.
 *
 * Why this matters more than it looks: listing prices are quoted in whatever orb the
 * seller likes, and the divine:exalted ratio moves a great deal over a league. If we
 * charted raw numbers, every item would appear to trend together and we'd be plotting
 * currency inflation rather than item value. Everything is normalised to exalted here,
 * and the rates used are stored alongside each snapshot so a past reading can be
 * recomputed or re-deflated later.
 */
import { RateLimiter } from './ratelimit.ts';

const HOST = 'https://www.pathofexile.com';
const POLICY = 'trade-exchange-request-limit';
const SEED = '5:15:60,10:90:300,30:300:1800';

/** Currencies worth pricing. Anything not listed here yields priceEx = null. */
export const TRACKED = [
  'divine',
  'chaos',
  'annul',
  'regal',
  'alch',
  'vaal',
  'aug',
  'transmute',
  'exotic',
  'mirror',
] as const;

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

  /** Exalted per one unit of `currency`, or null when nobody is trading it. */
  private async rateOf(currency: string): Promise<number | null> {
    const url = `${HOST}/api/trade2/exchange/poe2/${encodeURIComponent(this.league)}`;
    const body = {
      query: { status: { option: 'online' }, have: ['exalted'], want: [currency] },
      sort: { have: 'asc' },
      engine: 'new',
    };
    await this.limiter.acquire(POLICY);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': this.userAgent },
      body: JSON.stringify(body),
    });
    this.limiter.observe(POLICY, res.headers);
    if (res.status === 429) {
      await this.limiter.penalty(POLICY, res.headers);
      return this.rateOf(currency);
    }
    if (!res.ok) return null;

    const json = (await res.json()) as { result: Record<string, ExchangeOffer> };
    const ratios: number[] = [];
    // Offers are sorted best-first; a handful is plenty and the median of them
    // shrugs off a single troll offer at the top of the book.
    for (const entry of Object.values(json.result ?? {}).slice(0, 8)) {
      const o = entry.listing?.offers?.[0];
      if (!o || !o.item?.amount) continue;
      ratios.push(o.exchange.amount / o.item.amount);
    }
    return median(ratios);
  }

  /** Builds the full exalted-equivalent table. `exalted` is 1 by definition. */
  async fetchRates(): Promise<Record<string, number>> {
    const rates: Record<string, number> = { exalted: 1 };
    for (const c of TRACKED) {
      const r = await this.rateOf(c);
      if (r && Number.isFinite(r) && r > 0) rates[c] = r;
      else console.warn(`[rates] no rate for ${c}; listings priced in it will be excluded`);
    }
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
