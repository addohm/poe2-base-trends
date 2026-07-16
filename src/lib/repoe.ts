/**
 * Loads PoE2 base item data from the RePoE fork.
 *
 * This is the authoritative source for "which base has the highest X" — it comes
 * from the game files, so it covers every base including ones nobody is currently
 * selling. Trade search can only ever see what happens to be listed.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Archetype, BaseItem } from './types.ts';

const REPOE_BASE_ITEMS = 'https://repoe-fork.github.io/poe2/base_items.json';
const CACHE_DIR = path.join(process.cwd(), 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'base_items.json');

interface RepoeProperties {
  armour: { min: number; max: number } | null;
  evasion: { min: number; max: number } | null;
  energy_shield: { min: number; max: number } | null;
  ward: { min: number; max: number } | null;
}

interface RepoeEntry {
  name: string;
  item_class: string;
  domain: string;
  release_state: string;
  drop_level: number;
  tags: string[];
  properties: RepoeProperties;
  requirements?: { level: number; strength: number; dexterity: number; intelligence: number } | null;
}

/** RePoE stores defence as {min,max}; for bases these are always equal. */
function val(p: { min: number; max: number } | null | undefined): number {
  return p?.max ?? 0;
}

export function archetypeOf(armour: number, evasion: number, es: number): Archetype {
  const parts: string[] = [];
  if (armour > 0) parts.push('ar');
  if (evasion > 0) parts.push('ev');
  if (es > 0) parts.push('es');
  return (parts.join('/') || 'none') as Archetype;
}

/** Downloads base_items.json once and caches it. Pass force to re-fetch. */
export async function fetchRepoe(force = false): Promise<string> {
  if (!force && existsSync(CACHE_FILE)) return readFile(CACHE_FILE, 'utf8');
  const res = await fetch(REPOE_BASE_ITEMS, {
    headers: { 'user-agent': 'poe2-base-trends (static data fetch)' },
  });
  if (!res.ok) throw new Error(`RePoE fetch failed: ${res.status} ${res.statusText}`);
  const text = await res.text();
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_FILE, text);
  return text;
}

/**
 * Returns every released, obtainable base item.
 *
 * `domain === 'item'` excludes currency/monster/etc; `release_state === 'released'`
 * excludes unimplemented bases that would otherwise pollute the "best base" tables.
 */
export async function loadBaseItems(force = false): Promise<BaseItem[]> {
  const raw = JSON.parse(await fetchRepoe(force)) as Record<string, RepoeEntry>;
  const out: BaseItem[] = [];

  for (const [id, e] of Object.entries(raw)) {
    if (e.domain !== 'item' || e.release_state !== 'released') continue;
    if (!e.name) continue;

    const armour = val(e.properties?.armour);
    const evasion = val(e.properties?.evasion);
    const energyShield = val(e.properties?.energy_shield);
    const ward = val(e.properties?.ward);

    out.push({
      id,
      name: e.name,
      itemClass: e.item_class,
      dropLevel: e.drop_level ?? 0,
      armour,
      evasion,
      energyShield,
      ward,
      archetype: archetypeOf(armour, evasion, energyShield),
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

/** Quality scales base defences linearly; 20% quality is the practical max. */
export function atMaxQuality(value: number, quality = 20): number {
  return Math.round(value * (1 + quality / 100));
}
