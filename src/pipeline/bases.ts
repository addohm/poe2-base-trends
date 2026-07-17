/**
 * Ranks every base item, per category, from static game data.
 *
 * No trade API involved. This half of the site is exact and complete: it covers every
 * released base including ones nobody currently has listed, it can't be skewed by
 * market manipulation, and it doesn't change during a league. It would be correct with
 * trade offline.
 *
 * Each family is ranked by the metric that actually applies to it — see repoe.ts.
 * Within armour, bases are grouped by archetype first, because a pure-ES helmet and a
 * hybrid armour/evasion one aren't competing for the same slot on the same build;
 * ranking them against each other by total defence would be meaningless.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { atMaxQuality, loadBaseItems } from '../lib/repoe.ts';
import type { BaseItem, Family } from '../lib/types.ts';

const OUT = path.join(process.cwd(), 'data', 'bases.json');

export interface RankedBase extends BaseItem {
  armourMaxQ: number;
  evasionMaxQ: number;
  energyShieldMaxQ: number;
  /** Sum of defences at 20% quality — the ranking key within an armour archetype. */
  totalDefenceMaxQ: number;
  /** Physical DPS at 20% quality — the ranking key for weapons. */
  pdpsMaxQ: number;
  /**
   * Where this base sits within its own comparison group, 1 = best. Null when the
   * family has no meaningful ordering (implicit-only bases are a choice, not a rank).
   */
  rank: number | null;
  /** The group this base was ranked within, e.g. "Helmet / es". */
  group: string;
}

/**
 * The group a base competes in. Ranking only means something inside one of these.
 */
export function groupOf(b: BaseItem): string {
  if (b.family === 'armour') return `${b.itemClass} / ${b.archetype}`;
  return b.itemClass;
}

/** Sort key per family. Higher is better; null means the family isn't ordered. */
function scoreOf(b: RankedBase): number | null {
  switch (b.family) {
    case 'armour':
      return b.totalDefenceMaxQ;
    case 'weapon':
      return b.pdpsMaxQ;
    case 'caster':
      // Fewer forbidden spell mod families is strictly better for crafting: an
      // unrestricted base can roll any damage type. Item level breaks ties, since a
      // higher-level base gates higher mod tiers.
      return (4 - b.cannotRoll.length) * 1000 + b.dropLevel;
    case 'implicit':
      // Rings and belts have no stats at all. There is no "best" — you pick the
      // implicit you want — so refusing to rank is the honest answer.
      return null;
  }
}

function enrich(b: BaseItem): RankedBase {
  const armourMaxQ = atMaxQuality(b.armour);
  const evasionMaxQ = atMaxQuality(b.evasion);
  const energyShieldMaxQ = atMaxQuality(b.energyShield);
  return {
    ...b,
    armourMaxQ,
    evasionMaxQ,
    energyShieldMaxQ,
    totalDefenceMaxQ: armourMaxQ + evasionMaxQ + energyShieldMaxQ,
    pdpsMaxQ: Math.round(atMaxQuality(b.pdps) * 10) / 10,
    rank: null,
    group: groupOf(b),
  };
}

export interface BasesDoc {
  generatedAt: string;
  source: string;
  /** Group name -> bases, best first. */
  groups: Record<string, RankedBase[]>;
  /** Group name -> which family it belongs to, so the site knows how to render it. */
  families: Record<string, Family>;
}

/**
 * Collapses entries that are the same base wearing different metadata.
 *
 * The dump holds several kinds of same-name entry, and they are not the same problem:
 *
 *  - **Cosmetic variants** — "Shrouded Mail" a/b/c, identical stats and level. Purely
 *    different art. Showing three identical rows is noise, so they collapse.
 *  - **Roll variants** — one name covering several outcomes you cannot choose between.
 *    "Shrine Sceptre" exists four times at one level granting Purity of Fire / Ice /
 *    Lightning / Impurity; "Two-Stone Ring" comes in Fire+Cold, Fire+Lightning and
 *    Cold+Lightning. Trade calls each set by one name, so you can't target a member.
 *    Merging them into a row that lists every possibility states that honestly, where
 *    picking one would imply a choice you don't get.
 *  - **Level variants** — "Ascetic Garb" at ilvl 51 and at ilvl 45 (a Cruel-difficulty
 *    drop) have genuinely different stats. These stay separate: the item level column
 *    distinguishes them, and collapsing to the better one would repeat the very
 *    mistake rune-forged bases were excluded for.
 *
 * So identity is name + level + whatever *ranks* the family — and the family's variant
 * axis (granted skill, implicit) is merged rather than ranked.
 */
function dedupe(list: RankedBase[]): RankedBase[] {
  const byKey = new Map<string, RankedBase>();
  for (const b of list) {
    // Deliberately excludes each family's variant axis: skills for casters, implicits
    // for jewellery. Those get merged below instead of splitting rows.
    const stats =
      b.family === 'armour'
        ? `${b.armour}/${b.evasion}/${b.energyShield}`
        : b.family === 'weapon'
          ? `${b.physMin}-${b.physMax}@${b.aps.toFixed(3)}`
          : b.family === 'caster'
            ? b.cannotRoll.join(',')
            : '';
    const key = `${b.name}|${b.dropLevel}|${stats}`;

    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, { ...b, skills: [...b.skills], implicits: [...b.implicits] });
      continue;
    }
    for (const s of b.skills) if (!seen.skills.includes(s)) seen.skills.push(s);
    for (const i of b.implicits) if (!seen.implicits.includes(i)) seen.implicits.push(i);
  }
  return [...byKey.values()];
}

export function buildGroups(items: BaseItem[]): BasesDoc {
  const enriched = items.map(enrich).filter((b) => {
    // An armour base with no defences at all is a data artefact, not a choice.
    if (b.family === 'armour') return b.archetype !== 'none';
    if (b.family === 'weapon') return b.pdps > 0;
    return true;
  });

  const groups: Record<string, RankedBase[]> = {};
  const families: Record<string, Family> = {};
  for (const b of enriched) {
    (groups[b.group] ??= []).push(b);
    families[b.group] = b.family;
  }

  for (const [group, raw] of Object.entries(groups)) {
    const list = dedupe(raw);
    const ordered = scoreOf(list[0]!) === null;
    if (ordered) {
      // Unranked families read best by level, so the endgame options are together.
      list.sort((a, b) => b.dropLevel - a.dropLevel || a.name.localeCompare(b.name));
    } else {
      list.sort((a, b) => (scoreOf(b) ?? 0) - (scoreOf(a) ?? 0) || a.name.localeCompare(b.name));
      list.forEach((b, i) => (b.rank = i + 1));
    }
    groups[group] = list;
  }

  return {
    generatedAt: new Date().toISOString(),
    source: 'https://repoe-fork.github.io/poe2/',
    groups,
    families,
  };
}

async function main(): Promise<void> {
  const doc = buildGroups(await loadBaseItems());
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(doc, null, 2));

  const total = Object.values(doc.groups).reduce((n, g) => n + g.length, 0);
  console.log(`Wrote ${total} bases in ${Object.keys(doc.groups).length} groups -> ${path.relative(process.cwd(), OUT)}`);

  const byFamily: Record<string, string[]> = {};
  for (const [g, f] of Object.entries(doc.families)) (byFamily[f] ??= []).push(g);
  for (const [family, gs] of Object.entries(byFamily)) {
    console.log(`\n  ${family.toUpperCase()} — ${gs.length} groups`);
    for (const g of gs.sort()) {
      const best = doc.groups[g]![0]!;
      const note =
        family === 'armour'
          ? `${best.totalDefenceMaxQ} def@20%`
          : family === 'weapon'
            ? `${best.pdpsMaxQ} pDPS@20%`
            : family === 'caster'
              ? best.cannotRoll.length
                ? `restricted (${best.cannotRoll.join('/')})`
                : 'unrestricted'
              : `${best.implicits[0]?.slice(0, 34) ?? '—'}`;
      console.log(`    ${g.padEnd(24)} ${String(doc.groups[g]!.length).padStart(3)} bases  best: ${best.name.padEnd(24)} ${note}`);
    }
  }
}

if (import.meta.filename === process.argv[1]) await main();
