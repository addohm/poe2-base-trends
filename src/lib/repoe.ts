/**
 * Loads PoE2 base item data from the RePoE fork.
 *
 * This is the authoritative source for "which base has the highest X" — it comes from
 * the game files, so it covers every base including ones nobody is currently selling.
 * Trade search can only ever see what happens to be listed.
 *
 * The awkward part is that "best base" is four different questions:
 *
 *  - **armour** — decided by defence values.
 *  - **weapon** — decided by physical DPS and crit.
 *  - **caster** — wands/sceptres/staves carry *no* defence, damage, or implicits at
 *    all. What distinguishes them is the skill they grant and, for crafting, which
 *    spell mod families they are forbidden from rolling (`no_fire_spell_mods` and
 *    friends). A base with no such tags can roll any spell damage type, which is the
 *    whole reason to want one.
 *  - **implicit** — rings/amulets/belts/quivers have no stats; the base *is* its
 *    implicit, so the choice is which implicit you want.
 *
 * Ranking any of these by another's metric produces confident nonsense.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Archetype, BaseItem, Family } from './types.ts';

const REPOE_BASE_ITEMS = 'https://repoe-fork.github.io/poe2/base_items.json';
const REPOE_MODS = 'https://repoe-fork.github.io/poe2/mods.min.json';
const CACHE_DIR = path.join(process.cwd(), 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'base_items.json');
const MODS_FILE = path.join(CACHE_DIR, 'mods.json');

const ARMOUR_CLASSES = ['Body Armour', 'Helmet', 'Gloves', 'Boots', 'Shield', 'Buckler', 'Focus'];
const WEAPON_CLASSES = [
  'One Hand Mace', 'Two Hand Mace', 'One Hand Sword', 'Two Hand Sword',
  'One Hand Axe', 'Two Hand Axe', 'Dagger', 'Claw', 'Flail', 'Spear',
  'Bow', 'Crossbow', 'Warstaff', 'Talisman',
];
const CASTER_CLASSES = ['Wand', 'Sceptre', 'Staff'];
const IMPLICIT_CLASSES = ['Ring', 'Amulet', 'Belt', 'Quiver'];

export function familyOf(itemClass: string): Family | null {
  if (ARMOUR_CLASSES.includes(itemClass)) return 'armour';
  if (WEAPON_CLASSES.includes(itemClass)) return 'weapon';
  if (CASTER_CLASSES.includes(itemClass)) return 'caster';
  if (IMPLICIT_CLASSES.includes(itemClass)) return 'implicit';
  return null;
}

interface RepoeProperties {
  armour: { min: number; max: number } | null;
  evasion: { min: number; max: number } | null;
  energy_shield: { min: number; max: number } | null;
  ward: { min: number; max: number } | null;
  /** Weapon stats are plain numbers, unlike the {min,max} defences. */
  attack_time: number | null;
  critical_strike_chance: number | null;
  physical_damage_min: number | null;
  physical_damage_max: number | null;
}

interface RepoeEntry {
  name: string;
  item_class: string;
  domain: string;
  release_state: string;
  drop_level: number;
  tags: string[];
  implicits?: string[];
  skills_granted?: string[] | null;
  properties: RepoeProperties;
  requirements?: { level: number; strength: number; dexterity: number; intelligence: number } | null;
}

interface RepoeMod {
  text?: string;
}

/** Defences are stored as {min,max}; for bases the two are always equal. */
function val(p: { min: number; max: number } | null | undefined): number {
  return p?.max ?? 0;
}

/** RePoE and trade both wrap game terms as [Display|Link]. */
export function cleanText(s: string): string {
  return s.replace(/\[([^\]|]*)\|?([^\]]*)\]/g, (_, a: string, b: string) => b || a);
}

export function archetypeOf(armour: number, evasion: number, es: number): Archetype {
  const parts: string[] = [];
  if (armour > 0) parts.push('ar');
  if (evasion > 0) parts.push('ev');
  if (es > 0) parts.push('es');
  return (parts.join('/') || 'none') as Archetype;
}

/** "Metadata/Items/Gems/SkillGemSkeletalWarrior" -> "Skeletal Warrior". */
export function skillName(metadataPath: string): string {
  const leaf = metadataPath.split('/').pop() ?? metadataPath;
  return leaf
    .replace(/^SkillGem/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
}

/** Spell mod families a base is barred from, from its `no_*_spell_mods` tags. */
export function cannotRollFrom(tags: string[]): string[] {
  return tags
    .filter((t) => /^no_[a-z]+_spell_mods$/.test(t))
    .map((t) => t.replace(/^no_/, '').replace(/_spell_mods$/, ''))
    .sort();
}

async function cachedFetch(url: string, file: string, force: boolean): Promise<string> {
  if (!force && existsSync(file)) return readFile(file, 'utf8');
  const res = await fetch(url, { headers: { 'user-agent': 'poe2-base-trends (static data fetch)' } });
  if (!res.ok) throw new Error(`fetch failed for ${url}: ${res.status} ${res.statusText}`);
  const text = await res.text();
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(file, text);
  return text;
}

export const fetchRepoe = (force = false) => cachedFetch(REPOE_BASE_ITEMS, CACHE_FILE, force);
export const fetchMods = (force = false) => cachedFetch(REPOE_MODS, MODS_FILE, force);

/**
 * Returns every released, targetable base item in a family we can describe.
 *
 * Three exclusions, each load-bearing:
 *
 *  - `domain`/`release_state` drop currency, monster entries, and unimplemented bases.
 *  - `[DNT]` names are developer scaffolding ("do not trade").
 *  - **Rune-forged bases** are excluded, and this one is not obvious. They are the
 *    outputs of rune-forging (metadata `...Verisium*`), not bases you can buy and
 *    craft on — and crucially, up to six of them share a single display name with
 *    wildly different stats. "Runemastered Torment Club" covers variants rolling
 *    44-73 (identical to the plain base) through 85-403 physical damage. Ranking them
 *    means silently reporting the luckiest variant as though it were the base's stats,
 *    and the name can't even be searched for on trade. They are 44% of the dump, so
 *    leaving them in puts a fiction at the top of every single table.
 */

/**
 * Is this a rune-forged base?
 *
 * Checked three ways because the dump contradicts itself: three bases are *named*
 * "Runeforged ..." without carrying the `runeforged` tag, and one carries the tag
 * without the name. The metadata key is the only signal that catches all 788 on its
 * own, but trusting a single field after watching the others disagree would be
 * optimistic — so any of the three disqualifies.
 */
export function isRuneforged(id: string, name: string, tags: string[]): boolean {
  return /Verisium/i.test(id) || /^Rune(forged|mastered)\s/.test(name) || tags.includes('runeforged');
}
export async function loadBaseItems(force = false): Promise<BaseItem[]> {
  const raw = JSON.parse(await fetchRepoe(force)) as Record<string, RepoeEntry>;
  const mods = JSON.parse(await fetchMods(force)) as Record<string, RepoeMod>;
  const out: BaseItem[] = [];

  for (const [id, e] of Object.entries(raw)) {
    if (e.domain !== 'item' || e.release_state !== 'released') continue;
    if (!e.name || e.name.includes('[DNT]')) continue;
    if (isRuneforged(id, e.name, e.tags ?? [])) continue;

    const family = familyOf(e.item_class);
    if (!family) continue;

    const p = e.properties ?? ({} as RepoeProperties);
    const armour = val(p.armour);
    const evasion = val(p.evasion);
    const energyShield = val(p.energy_shield);

    const physMin = p.physical_damage_min ?? 0;
    const physMax = p.physical_damage_max ?? 0;
    // attack_time is milliseconds per swing; crit is scaled by 100 (500 => 5.00%).
    const aps = p.attack_time ? 1000 / p.attack_time : 0;
    const crit = (p.critical_strike_chance ?? 0) / 100;
    const pdps = aps ? ((physMin + physMax) / 2) * aps : 0;

    out.push({
      id,
      name: e.name,
      itemClass: e.item_class,
      family,
      dropLevel: e.drop_level ?? 0,
      armour,
      evasion,
      energyShield,
      ward: val(p.ward),
      archetype: archetypeOf(armour, evasion, energyShield),
      physMin,
      physMax,
      aps,
      crit,
      pdps,
      skills: (e.skills_granted ?? []).map(skillName),
      cannotRoll: cannotRollFrom(e.tags ?? []),
      implicits: (e.implicits ?? []).map((k) => cleanText(mods[k]?.text ?? k)),
      req: {
        level: e.requirements?.level ?? 0,
        str: e.requirements?.strength ?? 0,
        dex: e.requirements?.dexterity ?? 0,
        int: e.requirements?.intelligence ?? 0,
      },
      tags: e.tags ?? [],
    });
  }
  return out;
}

/** Quality scales base defences and physical damage linearly; 20% is the practical max. */
export function atMaxQuality(value: number, quality = 20): number {
  return Math.round(value * (1 + quality / 100));
}
