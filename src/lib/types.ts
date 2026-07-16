/** Shared types for the base-trends pipeline. */

/** Which defence stats a base actually rolls. Derived from values, not tags. */
export type Archetype =
  | 'ar'
  | 'ev'
  | 'es'
  | 'ar/ev'
  | 'ar/es'
  | 'ev/es'
  | 'ar/ev/es'
  | 'none';

export interface BaseItem {
  /** RePoE metadata path, e.g. Metadata/Items/Armours/Helmets/FourHelmetInt8Endgame */
  id: string;
  name: string;
  itemClass: string;
  dropLevel: number;
  armour: number;
  evasion: number;
  energyShield: number;
  ward: number;
  archetype: Archetype;
  req: { level: number; str: number; dex: number; int: number };
  tags: string[];
}

/** A single listing observed on trade, normalised. */
export interface Listing {
  /** Trade result id. Stable per listing — this is what lets us measure delisting. */
  id: string;
  baseName: string;
  itemClass: string;
  rarity: 'normal' | 'magic' | 'rare' | 'unique';
  ilvl: number;
  corrupted: boolean;
  quality: number;
  /** Realised defence values on the item as listed. */
  armour: number;
  evasion: number;
  energyShield: number;
  /** Explicit mod texts, as shown. */
  explicits: string[];
  /** Price as listed. */
  price: { amount: number; currency: string } | null;
  /** Price converted to exalted-equivalent. Null when currency is unknown. */
  priceEx: number | null;
  accountName: string | null;
  indexedAt: string | null;
}

/** One collection run against trade for one query. */
export interface Snapshot {
  /** ISO timestamp of collection. */
  at: string;
  league: string;
  /** The query key this snapshot answers, e.g. "helmet:es:magic". */
  queryKey: string;
  listings: Listing[];
  /** Exchange rates used to compute priceEx, for reproducibility. */
  rates: Record<string, number>;
}
