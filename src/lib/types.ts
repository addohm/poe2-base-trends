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

/**
 * How a category's bases can be compared. The question "which base is best" means a
 * genuinely different thing in each family, and answering it with the wrong metric is
 * the same class of error as ranking mods by the stat you sorted on.
 */
export type Family =
  /** Defence decides it: armour / evasion / energy shield. */
  | 'armour'
  /** Damage and speed decide it: physical DPS, crit, attack rate. */
  | 'weapon'
  /**
   * No defence, no damage. The base is defined by the skill it grants and — the part
   * that actually drives crafting — which spell mod families it is forbidden from
   * rolling. Wands, sceptres, staves.
   */
  | 'caster'
  /** No stats; the base *is* its implicit. Rings, amulets, belts, quivers. */
  | 'implicit';

export interface BaseItem {
  /** RePoE metadata path, e.g. Metadata/Items/Armours/Helmets/FourHelmetInt8Endgame */
  id: string;
  name: string;
  itemClass: string;
  family: Family;
  dropLevel: number;

  // Armour family.
  armour: number;
  evasion: number;
  energyShield: number;
  ward: number;
  archetype: Archetype;

  // Weapon family. Zero elsewhere.
  physMin: number;
  physMax: number;
  /** Attacks per second, derived from attack_time (ms). */
  aps: number;
  /** Critical hit chance as a percent, e.g. 5. */
  crit: number;
  /** Mean physical hit x attacks per second. */
  pdps: number;

  // Caster family.
  /** Skills the base grants, e.g. ["Chaosbolt"]. */
  skills: string[];
  /**
   * Spell mod families this base can NEVER roll, e.g. ["fire","cold"]. Derived from
   * `no_*_spell_mods` tags. An empty list is the valuable case: the base can roll any
   * spell damage type, which is what makes it a general crafting target.
   */
  cannotRoll: string[];

  // Implicit family.
  /** Resolved implicit text, e.g. "+(20-30)% to Fire Resistance". */
  implicits: string[];

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
