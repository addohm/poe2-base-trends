/**
 * The work queue decides what each half-hourly run touches. Its failure modes are
 * quiet ones — a stuck cursor silently stops refreshing a base, and a queue that
 * doesn't survive a ban silently drops it — so they're pinned here.
 *
 * Run with: node --test src/lib/queue.test.ts
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// queue.ts resolves its state file from cwd, so each test gets a fresh directory.
const dir = mkdtempSync(path.join(tmpdir(), 'queue-test-'));
process.chdir(dir);
const { take, complete, peek } = await import('./queue.ts');

const ALL = ['A', 'B', 'C'];

beforeEach(() => {
  rmSync(path.join(dir, 'cache'), { recursive: true, force: true });
});

test('hands out one base at a time, in order', () => {
  assert.deepEqual(take(ALL, 1).batch, ['A']);
  complete(['A']);
  assert.deepEqual(take(ALL, 1).batch, ['B']);
  complete(['B']);
  assert.deepEqual(take(ALL, 1).batch, ['C']);
});

test('a base not completed stays at the head — an aborted run loses nothing', () => {
  assert.deepEqual(take(ALL, 1).batch, ['A']);
  // Run dies here (rate limited) without calling complete().
  assert.deepEqual(take(ALL, 1).batch, ['A'], 'A must be retried, not skipped');
});

test('refills for a new cycle once every base is done', () => {
  for (const n of ALL) {
    take(ALL, 1);
    complete([n]);
  }
  assert.equal(peek()?.pending.length, 0);
  const { batch, state } = take(ALL, 1);
  assert.deepEqual(batch, ['A'], 'a fresh cycle starts over');
  assert.equal(state.pending.length, 3);
  assert.equal(state.cycles, 1, 'completed cycles are counted');
});

test('adding a tracked base lets it join the current cycle', () => {
  take(ALL, 1);
  complete(['A']);
  const { state } = take([...ALL, 'D'], 1);
  assert.ok(state.pending.includes('D'), 'new base is picked up without a reset');
});

test('a reordered work list re-prioritises the rest of the cycle', () => {
  // The caller's order decides which results land first. A stored queue must not pin
  // yesterday's ordering: changing the priority should take effect on the next tick,
  // not at the start of the next cycle.
  take(ALL, 1);
  complete(['A']);
  const reordered = ['C', 'B', 'A'];
  assert.deepEqual(take(reordered, 1).batch, ['C'], 'follows the new order immediately');
  assert.deepEqual(peek()?.pending, ['C', 'B'], 'and A stays done rather than being redone');
});

test('untracking a base drops it from the queue', () => {
  take(ALL, 1);
  const { batch, state } = take(['B', 'C'], 1);
  assert.ok(!state.pending.includes('A'));
  assert.deepEqual(batch, ['B'], 'work moves on rather than stranding on a dead base');
});

test('batch size larger than the remaining cycle is clamped to what is left', () => {
  take(ALL, 1);
  complete(['A']);
  complete(['B']);
  assert.deepEqual(take(ALL, 5).batch, ['C']);
});

test('state survives a process restart', async () => {
  take(ALL, 1);
  complete(['A']);
  // A fresh import mimics the next scheduled run reading state off disk.
  const again = await import(`./queue.ts?reload=${Date.now()}`);
  assert.deepEqual(again.take(ALL, 1).batch, ['B'], 'the cycle resumes where it stopped');
});

// Leave the temp cwd before removing it; Windows will not unlink a directory that
// is any process's working directory.
process.on('exit', () => {
  try {
    process.chdir(tmpdir());
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A stray temp dir is not worth failing the suite over.
  }
});
