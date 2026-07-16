/**
 * Builds trade2 search payloads.
 *
 * Two sampling strategies, used for different questions:
 *
 *  - `price-asc`  — the cheapest N asks for a base. Used to estimate what the base
 *    is worth. We deliberately never sort descending: the top of the ask
 *    distribution is where price manipulation lives, so reading it would measure
 *    trolls rather than value.
 *
 *  - `recent`     — newest listings first. This is uncorrelated with price, so it
 *    gives an unbiased sample of what's on the market. Mod-lift analysis must use
 *    this: if you sample by price or by a defence stat, you select for the very
 *    thing you're trying to measure and every result is circular.
 */

export type Rarity = 'normal' | 'magic' | 'rare';
export type Sampling = 'price-asc' | 'recent';

export interface QuerySpec {
  /** Stable id used as the history filename, e.g. "helmet:AncestralTiara:rare:recent". */
  key: string;
  category: string;
  /** Exact base name, e.g. "Ancestral Tiara". Omit to search the whole category. */
  type?: string;
  rarity: Rarity;
  sampling: Sampling;
}

export function buildQuery(spec: QuerySpec): unknown {
  const typeFilters: Record<string, unknown> = {
    category: { option: spec.category },
    rarity: { option: spec.rarity },
  };

  const query: Record<string, unknown> = {
    status: { option: 'online' },
    filters: {
      type_filters: { filters: typeFilters },
      // Corrupted items can't be crafted on, so they aren't part of this question.
      misc_filters: { filters: { corrupted: { option: 'false' } } },
    },
    stats: [{ type: 'and', filters: [] }],
  };
  if (spec.type) query.type = spec.type;

  return {
    query,
    sort: spec.sampling === 'price-asc' ? { price: 'asc' } : { indexed: 'desc' },
  };
}

export function specKey(category: string, type: string, rarity: Rarity, sampling: Sampling): string {
  const slug = type.replace(/[^A-Za-z0-9]/g, '');
  return `${category.replace('armour.', '')}:${slug}:${rarity}:${sampling}`;
}
