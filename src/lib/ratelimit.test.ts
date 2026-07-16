/**
 * Backoff behaviour under repeated bans.
 *
 * This exists because politely waiting out `Retry-After` and retrying — textbook
 * good-citizen behaviour against a transient limit — turned out to be the wrong move
 * against a flagged IP, where each attempt re-arms the ban. Three separate 600s bans
 * were earned that way. A fixed retry interval is a slow blitz; only escalating
 * silence converges.
 *
 * Run with: node --test src/lib/ratelimit.test.ts
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'rl-test-'));
process.chdir(dir);
const { RateLimiter, parseRules } = await import('./ratelimit.ts');

const POLICY = 'trade-fetch-request-limit';
const ban = (sec: number) => new Headers({ 'retry-after': String(sec) });

beforeEach(() => {
  rmSync(path.join(dir, 'cache'), { recursive: true, force: true });
});

test('parses the hits:period:restriction rule format', () => {
  assert.deepEqual(parseRules('12:4:10,16:12:300'), [
    { hits: 12, period: 4, restriction: 10 },
    { hits: 16, period: 12, restriction: 300 },
  ]);
});

test('parseRules tolerates junk rather than throwing mid-request', () => {
  assert.deepEqual(parseRules(null), []);
  assert.deepEqual(parseRules('nonsense'), []);
});

test('a single ban is honoured at face value', async () => {
  const rl = new RateLimiter();
  // 600s exceeds maxWait, so it returns rather than sleeping.
  assert.equal(await rl.penalty(POLICY, ban(600)), 600);
});

test('consecutive bans double the wait instead of retrying at a fixed interval', async () => {
  const rl = new RateLimiter();
  assert.equal(await rl.penalty(POLICY, ban(600)), 600);
  assert.equal(await rl.penalty(POLICY, ban(600)), 1200, 'second strike doubles');
  assert.equal(await rl.penalty(POLICY, ban(600)), 2400, 'third strike doubles again');
});

test('backoff is capped so an unattended rotation still recovers', async () => {
  const rl = new RateLimiter();
  let last = 0;
  for (let i = 0; i < 10; i++) last = await rl.penalty(POLICY, ban(600));
  assert.equal(last, 4 * 3600, 'capped at 4h, not unbounded');
  // blockedFor rounds up over the small guard added to the deadline.
  assert.ok(rl.blockedFor(POLICY) <= 4 * 3600 + 2);
});

test('a success clears the strike count', async () => {
  const rl = new RateLimiter();
  await rl.penalty(POLICY, ban(600));
  await rl.penalty(POLICY, ban(600)); // now at 1200
  rl.succeeded(POLICY);
  assert.equal(await rl.penalty(POLICY, ban(600)), 600, 'back to face value after a healthy request');
});

test('strikes are per-policy — a fetch ban does not punish search', async () => {
  const rl = new RateLimiter();
  await rl.penalty(POLICY, ban(600));
  await rl.penalty(POLICY, ban(600));
  // Must exceed maxWaitSec, or penalty() sleeps it out and the test takes that long.
  assert.equal(await rl.penalty('trade-search-request-limit', ban(300)), 300);
});

test('blockedFor reports the live ban and decays to 0', async () => {
  const rl = new RateLimiter();
  assert.equal(rl.blockedFor(POLICY), 0);
  await rl.penalty(POLICY, ban(600));
  assert.ok(rl.blockedFor(POLICY) > 590, 'ban is visible to a preflight check');
});

test('bans and strikes survive a restart, so the next tick inherits the backoff', async () => {
  const rl = new RateLimiter();
  await rl.penalty(POLICY, ban(600));
  await rl.penalty(POLICY, ban(600));

  // A fresh limiter models the next scheduled run reading state off disk.
  const { RateLimiter: Fresh } = await import(`./ratelimit.ts?reload=${Date.now()}`);
  const next = new Fresh();
  assert.ok(next.blockedFor(POLICY) > 1100, 'ban carried over');
  assert.equal(await next.penalty(POLICY, ban(600)), 2400, 'so did the strike count');
});

process.on('exit', () => {
  try {
    process.chdir(tmpdir());
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A stray temp dir is not worth failing the suite over.
  }
});
