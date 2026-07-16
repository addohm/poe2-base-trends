/**
 * Generates the ranked base-item tables from static game data.
 *
 * No trade API involved: this half of the site is exact and complete, and would be
 * correct even if trade were offline. Output is committed so the site can build
 * without network access.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { atMaxQuality, loadBaseItems } from '../lib/repoe.ts';
import type { BaseItem } from '../lib/types.ts';

const OUT = path.join(process.cwd(), 'data', 'bases.json');

/** Classes with a defence roll, i.e. the ones where "best base" means highest defence. */
const DEFENCE_CLASSES = ['Helmet', 'Body Armour', 'Gloves', 'Boots', 'Shield', 'Focus', 'Buckler'];

export interface RankedBase extends BaseItem {
  armourMaxQ: number;
  evasionMaxQ: number;
  energyShieldMaxQ: number;
  /** Sum of defences at 20% quality — the ranking key for hybrids. */
  totalDefenceMaxQ: number;
}

function rank(b: BaseItem): RankedBase {
  const armourMaxQ = atMaxQuality(b.armour);
  const evasionMaxQ = atMaxQuality(b.evasion);
  const energyShieldMaxQ = atMaxQuality(b.energyShield);
  return {
    ...b,
    armourMaxQ,
    evasionMaxQ,
    energyShieldMaxQ,
    totalDefenceMaxQ: armourMaxQ + evasionMaxQ + energyShieldMaxQ,
  };
}

async function main(): Promise<void> {
  const all = await loadBaseItems();
  const ranked = all
    .filter((b) => DEFENCE_CLASSES.includes(b.itemClass))
    .filter((b) => b.archetype !== 'none')
    .map(rank)
    .sort((a, b) => b.totalDefenceMaxQ - a.totalDefenceMaxQ);

  const byClass: Record<string, RankedBase[]> = {};
  for (const b of ranked) (byClass[b.itemClass] ??= []).push(b);

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: 'https://repoe-fork.github.io/poe2/base_items.json',
        classes: byClass,
      },
      null,
      2,
    ),
  );

  console.log(`Wrote ${ranked.length} bases across ${Object.keys(byClass).length} classes -> ${path.relative(process.cwd(), OUT)}`);
  for (const [cls, items] of Object.entries(byClass)) {
    const arch = new Set(items.map((i) => i.archetype));
    console.log(`  ${cls.padEnd(12)} ${String(items.length).padStart(3)} bases  archetypes: ${[...arch].sort().join(' ')}`);
  }
}

await main();
