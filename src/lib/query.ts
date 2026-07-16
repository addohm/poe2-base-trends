/**
 * Builds trade2 search payloads.
 *
 * Three filters here do most of the work of making the numbers mean something:
 *
 *  - **ilvl minimum.** Mod tiers are gated by item level, so a market that mixes
 *    ilvl 60 and ilvl 82 items is comparing bases that literally cannot roll the
 *    same mods. Crafting happens at endgame; the floor keeps the sample there.
 *
 *  - **collapse.** One seller listing forty near-identical items would otherwise
 *    dominate a 100-item sample and turn their personal crafting habits into a
 *    "market preference". This asks trade for one listing per account.
 *
 *  - **price, in exalted-equivalent.** Passing `price` with *no* currency option
 *    makes trade convert every listing to an Exalted Orb equivalent itself, using
 *    its own rates. That's what lets us slice the market by real value instead of
 *    guessing a quartile from a sample.
 *
 * Note `sale_type` is deliberately omitted: its null option means "Buyout or Fixed
 * Price", which is what we want. The tempting-looking `priced_with_info` means
 * "price *with a note*" and matches almost nothing.
 */

export type Rarity = 'normal' | 'magic' | 'rare';
export type Sampling = 'price-asc' | 'recent';

export interface QuerySpec {
  key: string;
  category: string;
  /** Exact base name, e.g. "Ancestral Tiara". */
  type?: string;
  rarity: Rarity;
  sampling: Sampling;
  minIlvl?: number;
  /** Exalted-equivalent price bounds. */
  priceMin?: number;
  priceMax?: number;
  /** Ask trade to return one listing per account. */
  collapse?: boolean;
}

export function buildQuery(spec: QuerySpec): unknown {
  const typeFilters: Record<string, unknown> = {
    category: { option: spec.category },
    rarity: { option: spec.rarity },
  };
  if (spec.minIlvl) typeFilters.ilvl = { min: spec.minIlvl };

  const tradeFilters: Record<string, unknown> = {};
  if (spec.collapse) tradeFilters.collapse = { option: 'true' };
  if (spec.priceMin !== undefined || spec.priceMax !== undefined) {
    const price: Record<string, number> = {};
    if (spec.priceMin !== undefined) price.min = spec.priceMin;
    if (spec.priceMax !== undefined) price.max = spec.priceMax;
    // No `option` => "Exalted Orb Equivalent".
    tradeFilters.price = price;
  }

  const filters: Record<string, unknown> = {
    type_filters: { filters: typeFilters },
    // Corrupted items can't be crafted on, so they aren't part of this question.
    misc_filters: { filters: { corrupted: { option: 'false' } } },
  };
  if (Object.keys(tradeFilters).length) filters.trade_filters = { filters: tradeFilters };

  const query: Record<string, unknown> = {
    status: { option: 'online' },
    filters,
    stats: [{ type: 'and', filters: [] }],
  };
  if (spec.type) query.type = spec.type;

  return {
    query,
    sort: spec.sampling === 'price-asc' ? { price: 'asc' } : { indexed: 'desc' },
  };
}

export const slugify = (name: string) => name.replace(/[^A-Za-z0-9]/g, '');

export function specKey(category: string, type: string, rarity: Rarity, tag: string): string {
  return `${category.replace('armour.', '')}:${slugify(type)}:${rarity}:${tag}`;
}
