/**
 * The unit of work: a category *and*, for armour, a defence archetype.
 *
 * "Best helmet base" is not one question. A pure-energy-shield helmet and an
 * armour/evasion hybrid are not competing — no build shops for both — so pooling them
 * produces a top-3 list of three unrelated items, which is what happened when the unit
 * was the bare category. Armour splits into the seven ways defences combine; weapons,
 * caster weapons and jewellery have no such split.
 *
 * The archetype maps onto trade's `equipment_filters` exactly, and it holds up on rare
 * items despite mods adding to defences: an int-based ES helmet can't roll armour, so
 * `ar max 0, ev max 0, es min 1` returns Tiaras and nothing else. Verified live.
 */
import type { Archetype } from './types.ts';

/** RePoE item class -> trade category id. */
const CLASS_TO_CATEGORY: Record<string, string> = {
  Helmet: 'armour.helmet',
  'Body Armour': 'armour.chest',
  Gloves: 'armour.gloves',
  Boots: 'armour.boots',
  Shield: 'armour.shield',
  Focus: 'armour.focus',
  Buckler: 'armour.buckler',
  Quiver: 'armour.quiver',

  'One Hand Mace': 'weapon.onemace',
  'Two Hand Mace': 'weapon.twomace',
  'One Hand Sword': 'weapon.onesword',
  'Two Hand Sword': 'weapon.twosword',
  'One Hand Axe': 'weapon.oneaxe',
  'Two Hand Axe': 'weapon.twoaxe',
  Dagger: 'weapon.dagger',
  Claw: 'weapon.claw',
  Flail: 'weapon.flail',
  Spear: 'weapon.spear',
  Bow: 'weapon.bow',
  Crossbow: 'weapon.crossbow',
  Warstaff: 'weapon.warstaff',
  Talisman: 'weapon.talisman',

  Wand: 'weapon.wand',
  Sceptre: 'weapon.sceptre',
  Staff: 'weapon.staff',

  Ring: 'accessory.ring',
  Amulet: 'accessory.amulet',
  Belt: 'accessory.belt',
};

export const categoryForClass = (itemClass: string): string | undefined => CLASS_TO_CATEGORY[itemClass];

/** Human labels for the defence archetypes. */
export const ARCHETYPE_LABEL: Record<string, string> = {
  ar: 'Armour',
  ev: 'Evasion',
  es: 'Energy Shield',
  'ar/ev': 'Armour + Evasion',
  'ar/es': 'Armour + Energy Shield',
  'ev/es': 'Evasion + Energy Shield',
  'ar/ev/es': 'Armour + Evasion + ES',
};

/**
 * What kind of thing a unit is, which decides how it's queried and rendered.
 *
 *  - `gear`     — armour/weapons/jewellery: ilvl floor, optional defence archetype,
 *                 ranked by base share + mod lift.
 *  - `tablet`   — tower tablets: real base variety (Breach, Ritual, …), explicit mods
 *                 all rewards, so the gear model applies unchanged.
 *  - `waystone` — one "base" per tier and value inverts (numeric reward properties you
 *                 want, danger mods you avoid); needs its own extraction and card.
 */
export type UnitKind = 'gear' | 'tablet' | 'waystone';

export interface WorkUnit {
  /** Stable id, e.g. "armour.helmet/es", "weapon.bow", "map.tablet/ritual". */
  id: string;
  /** The group key in bases.json for gear; for maps, a synthetic label. */
  group: string;
  category: string;
  itemClass: string;
  kind: UnitKind;
  /** Null for non-armour: they have no defence split. */
  archetype: Archetype | null;
  /** Exact base-name filter (tablets: one type per unit; affixes are type-specific). */
  type?: string;
  /** Endgame item-level floor (gear) — maps use tier instead. */
  minIlvl?: number;
  /** Waystone tier floor. */
  minTier?: number;
  /** Display, e.g. "Helmet — Energy Shield". */
  label: string;
  /** Page grouping. */
  section: string;
}

/**
 * The tablet base types. Each is its own unit, not one pooled "tablet" category.
 *
 * The reason is that affixes are tied to the type — "Ritual Favours in Map" only rolls
 * on a Ritual Tablet — so pooling would dilute a type-specific mod across eight types
 * and mix their price ladders (a Ritual tablet and a Breach tablet aren't the same
 * market). Per-type units give each its own dear/baseline split and its own mod lift.
 */
const TABLET_TYPES = ['Breach', 'Expedition', 'Delirium', 'Ritual', 'Irradiated', 'Overseer', 'Abyss', 'Temple'] as const;

/**
 * Map work units, added regardless of the static base tables (maps aren't gear). One
 * unit per tablet type, plus the waystone over the T14-16 band the user tracks.
 */
export const MAP_UNITS: WorkUnit[] = [
  ...TABLET_TYPES.map(
    (t): WorkUnit => ({
      id: `map.tablet/${t.toLowerCase()}`,
      group: `${t} Tablet`,
      category: 'map.tablet',
      itemClass: 'Tablet',
      kind: 'tablet',
      archetype: null,
      type: `${t} Tablet`,
      label: `${t} Tablet`,
      section: 'Maps',
    }),
  ),
  {
    id: 'map.waystone/t14',
    group: 'Waystone (T14-16)',
    category: 'map.waystone',
    itemClass: 'Waystone',
    kind: 'waystone',
    archetype: null,
    minTier: 14,
    label: 'Waystone (Tier 14–16)',
    section: 'Maps',
  },
];

const SECTION_OF: Record<string, string> = {
  armour: 'Armour',
  weapon: 'Weapons',
  caster: 'Caster weapons',
  implicit: 'Jewellery',
};

/**
 * Builds the work list from the static base tables.
 *
 * Deriving it rather than hand-listing it means a group only exists if real bases
 * exist for it — no querying trade for an armour/evasion Focus that the game has no
 * bases for.
 */
export function workUnits(groups: Record<string, string[] | unknown[]>, families: Record<string, string>): WorkUnit[] {
  const out: WorkUnit[] = [];
  for (const group of Object.keys(groups)) {
    const family = families[group]!;
    const [itemClass, archetype] = group.split(' / ') as [string, string | undefined];
    const category = categoryForClass(itemClass);
    if (!category) continue;

    out.push({
      id: archetype ? `${category}/${archetype}` : category,
      group,
      category,
      itemClass,
      kind: 'gear',
      archetype: (archetype as Archetype) ?? null,
      minIlvl: 70,
      label: archetype ? `${itemClass} — ${ARCHETYPE_LABEL[archetype] ?? archetype}` : itemClass,
      section: SECTION_OF[family] ?? 'Other',
    });
  }
  // Maps lead the order. The collector does one unit per tick and the queue follows
  // this order, so with ~28 gear classes even round-robin leaves maps a day out. Only
  // two map units exist, so putting them first costs gear almost nothing and gets the
  // freshly-added feature visible in the next couple of ticks.
  return [...MAP_UNITS, ...interleave(out)];
}

/**
 * Orders the work list breadth-first: one unit from each item class before any class
 * gets a second.
 *
 * The collector takes one unit per tick, so this order *is* the order results appear.
 * Sorted naturally, the list runs Body Armour ar, ar/es, ar/ev, ar/ev/es, es, ev,
 * ev/es... — seven hours of body armour before the first helmet, and two days before
 * the page has any breadth. Round-robin instead: a helmet, a bow, a ring, a chest,
 * then back around. Same total time to finish, but the page is useful from the first
 * few ticks instead of the last.
 */
function interleave(units: WorkUnit[]): WorkUnit[] {
  const byClass = new Map<string, WorkUnit[]>();
  for (const u of [...units].sort((a, b) => a.label.localeCompare(b.label))) {
    (byClass.get(u.itemClass) ?? byClass.set(u.itemClass, []).get(u.itemClass)!).push(u);
  }
  // Classes with the most archetypes go first within a round, so the widest markets
  // (body armour, helmets) are covered early rather than trailing.
  const queues = [...byClass.values()].sort((a, b) => b.length - a.length || a[0]!.label.localeCompare(b[0]!.label));

  const out: WorkUnit[] = [];
  for (let round = 0; out.length < units.length; round++) {
    for (const q of queues) if (q[round]) out.push(q[round]!);
  }
  return out;
}

/**
 * The equipment filter for an archetype: present defences need min 1, absent ones
 * max 0. That exactness is what keeps a hybrid out of a pure group.
 */
export function archetypeFilter(archetype: Archetype | null): Record<string, { min?: number; max?: number }> | null {
  if (!archetype || archetype === 'none') return null;
  const has = archetype.split('/');
  return {
    ar: has.includes('ar') ? { min: 1 } : { max: 0 },
    ev: has.includes('ev') ? { min: 1 } : { max: 0 },
    es: has.includes('es') ? { min: 1 } : { max: 0 },
  };
}
