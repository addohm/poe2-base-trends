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

export interface WorkUnit {
  /** Stable id, e.g. "armour.helmet/es" or "weapon.bow". */
  id: string;
  /** The group key in bases.json, e.g. "Helmet / es". */
  group: string;
  category: string;
  itemClass: string;
  /** Null for non-armour: they have no defence split. */
  archetype: Archetype | null;
  /** Display, e.g. "Helmet — Energy Shield". */
  label: string;
  /** Page grouping. */
  section: string;
}

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
      archetype: (archetype as Archetype) ?? null,
      label: archetype ? `${itemClass} — ${ARCHETYPE_LABEL[archetype] ?? archetype}` : itemClass,
      section: SECTION_OF[family] ?? 'Other',
    });
  }
  return out.sort((a, b) => a.section.localeCompare(b.section) || a.label.localeCompare(b.label));
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
