/**
 * The equipment categories worth crafting on, as trade names them.
 *
 * These are the tradeable `type_filters.category` ids. Deliberately excluded: the
 * "Any One-Handed Melee Weapon" style umbrellas (they overlap the specific ones and
 * would double-count), unarmed, fishing rods, and everything that isn't gear you craft
 * — gems, flasks, maps, currency, relics.
 */
export interface Category {
  /** trade's category id, e.g. "armour.helmet". */
  id: string;
  /** Display name, e.g. "Helmet". */
  label: string;
  /** Rough grouping for the page. */
  group: 'Armour' | 'Weapons' | 'Caster weapons' | 'Jewellery';
}

export const CATEGORIES: Category[] = [
  { id: 'armour.helmet', label: 'Helmet', group: 'Armour' },
  { id: 'armour.chest', label: 'Body Armour', group: 'Armour' },
  { id: 'armour.gloves', label: 'Gloves', group: 'Armour' },
  { id: 'armour.boots', label: 'Boots', group: 'Armour' },
  { id: 'armour.shield', label: 'Shield', group: 'Armour' },
  { id: 'armour.focus', label: 'Focus', group: 'Armour' },
  { id: 'armour.buckler', label: 'Buckler', group: 'Armour' },
  { id: 'armour.quiver', label: 'Quiver', group: 'Armour' },

  { id: 'weapon.onemace', label: 'One-Handed Mace', group: 'Weapons' },
  { id: 'weapon.twomace', label: 'Two-Handed Mace', group: 'Weapons' },
  { id: 'weapon.onesword', label: 'One-Handed Sword', group: 'Weapons' },
  { id: 'weapon.twosword', label: 'Two-Handed Sword', group: 'Weapons' },
  { id: 'weapon.oneaxe', label: 'One-Handed Axe', group: 'Weapons' },
  { id: 'weapon.twoaxe', label: 'Two-Handed Axe', group: 'Weapons' },
  { id: 'weapon.dagger', label: 'Dagger', group: 'Weapons' },
  { id: 'weapon.claw', label: 'Claw', group: 'Weapons' },
  { id: 'weapon.flail', label: 'Flail', group: 'Weapons' },
  { id: 'weapon.spear', label: 'Spear', group: 'Weapons' },
  { id: 'weapon.bow', label: 'Bow', group: 'Weapons' },
  { id: 'weapon.crossbow', label: 'Crossbow', group: 'Weapons' },
  { id: 'weapon.warstaff', label: 'Quarterstaff', group: 'Weapons' },
  { id: 'weapon.talisman', label: 'Talisman', group: 'Weapons' },

  { id: 'weapon.wand', label: 'Wand', group: 'Caster weapons' },
  { id: 'weapon.sceptre', label: 'Sceptre', group: 'Caster weapons' },
  { id: 'weapon.staff', label: 'Staff', group: 'Caster weapons' },

  { id: 'accessory.ring', label: 'Ring', group: 'Jewellery' },
  { id: 'accessory.amulet', label: 'Amulet', group: 'Jewellery' },
  { id: 'accessory.belt', label: 'Belt', group: 'Jewellery' },
];

export const categoryById = (id: string): Category | undefined => CATEGORIES.find((c) => c.id === id);
