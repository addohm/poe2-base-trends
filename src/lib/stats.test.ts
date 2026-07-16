/**
 * Checks on the two calculations the mod ranking rests on.
 *
 * Run with: node --test src/lib/stats.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { liftCI } from '../pipeline/analyze.ts';
import { pickTopThreshold } from '../pipeline/collect.ts';
import { itemMods, type RawResult } from './trade.ts';

test('lift is 1.0 when a mod is equally common in both strata', () => {
  const { lift, ciLow, ciHigh } = liftCI(20, 100, 20, 100);
  assert.equal(lift, 1);
  assert.ok(ciLow < 1 && ciHigh > 1, 'interval must span 1 — this is a non-result');
});

test('a strong, well-sampled enrichment is significant', () => {
  // 40% of the dear stratum vs 10% of the market: lift 4, and it should hold up.
  const { lift, ciLow } = liftCI(40, 100, 10, 100);
  assert.equal(lift, 4);
  assert.ok(ciLow > 1, 'CI should exclude 1 for a strong effect');
});

test('the same ratio on a thin sample is NOT significant', () => {
  // Also lift 4.0, but from 4 sightings vs 1. This is the failure mode the CI exists
  // to catch: identical point estimate, no evidence behind it.
  const { lift, ciLow } = liftCI(4, 10, 1, 10);
  assert.equal(lift, 4);
  assert.ok(ciLow < 1, 'a lift of 4 from 4-vs-1 sightings must not read as real');
});

test('depletion is detected as well as enrichment', () => {
  const { lift, ciHigh } = liftCI(5, 100, 40, 100);
  assert.ok(lift < 1);
  assert.ok(ciHigh < 1, 'CI should exclude 1 below for a depleted mod');
});

test('pickTopThreshold targets roughly the dearest quarter', () => {
  const rungs = [
    { minEx: 1, count: 1000 },
    { minEx: 50, count: 800 },
    { minEx: 200, count: 600 },
    { minEx: 1000, count: 260 }, // 26% — closest to the 25% target
    { minEx: 5000, count: 30 }, // 3%, and below the minimum stratum size
  ];
  assert.deepEqual(pickTopThreshold(rungs), { minEx: 1000, count: 260 });
});

test('pickTopThreshold refuses a stratum too thin to sample', () => {
  const rungs = [
    { minEx: 1, count: 100 },
    { minEx: 50, count: 10 },
    { minEx: 200, count: 2 },
  ];
  assert.equal(pickTopThreshold(rungs), null);
});

test('pickTopThreshold returns null on an empty market', () => {
  assert.equal(pickTopThreshold([{ minEx: 1, count: 0 }]), null);
});

/** Builds a minimal trade result carrying the given explicitMods. */
function fake(explicitMods: unknown[]): RawResult {
  return { id: 'x', listing: {}, item: { explicitMods } } as RawResult;
}

test('a hybrid mod granting two stats counts as ONE mod', () => {
  // "Celestial" P3 emits increased ES and +max Mana as separate stat entries.
  const mods = itemMods(
    fake([
      { description: '29% increased Energy Shield', hash: 'stat.explicit.stat_4015621042', mods: [{ name: 'Celestial', tier: 'P3', level: 46 }] },
      { description: '+21 to maximum Mana', hash: 'stat.explicit.stat_1050105434', mods: [{ name: 'Celestial', tier: 'P3', level: 46 }] },
    ]),
  );
  assert.equal(mods.length, 1);
  assert.equal(mods[0]!.key, 'exp|Celestial|P3');
  assert.deepEqual(mods[0]!.stats.length, 2, 'both granted stats are kept on the one mod');
});

test('different families sharing a stat hash stay separate', () => {
  // The bug this replaces: keying on hash+tier merged these into one bucket.
  const mods = itemMods(
    fake([
      { description: '94% increased Energy Shield', hash: 'stat.explicit.stat_4015621042', mods: [{ name: 'Unassailable', tier: 'P1', level: 65 }] },
      { description: '41% increased Energy Shield', hash: 'stat.explicit.stat_4015621042', mods: [{ name: 'Celestial', tier: 'P1', level: 46 }] },
    ]),
  );
  assert.equal(mods.length, 2);
  assert.deepEqual(mods.map((m) => m.key).sort(), ['exp|Celestial|P1', 'exp|Unassailable|P1']);
});

test('desecrated mods are distinct from explicit ones of the same family', () => {
  const mods = itemMods(
    fake([
      { description: '71% increased Energy Shield', hash: 'stat.desecrated.stat_4015621042', flags: { desecrated: true }, mods: [{ name: 'Dauntless', tier: 'P3', level: 54 }] },
      { description: '30% increased Energy Shield', hash: 'stat.explicit.stat_4015621042', mods: [{ name: 'Dauntless', tier: 'P3', level: 54 }] },
    ]),
  );
  assert.equal(mods.length, 2);
  assert.ok(mods.some((m) => m.desecrated && m.key.startsWith('des|')));
  assert.ok(mods.some((m) => !m.desecrated && m.key.startsWith('exp|')));
});
