/**
 * Self-throttling limiter for the PoE trade API.
 *
 * GGG publish their limits per response rather than documenting them:
 *   X-Rate-Limit-Policy:   trade-search-request-limit
 *   X-Rate-Limit-Ip:       5:10:60,15:60:300,30:300:1800
 *   X-Rate-Limit-Ip-State: 1:10:0,1:60:0,1:300:0
 *
 * Rules are `hits:period:restriction` — at most <hits> per <period> seconds, else
 * locked out for <restriction> seconds. State is `current:period:activeRestriction`.
 *
 * The state header matters more than it looks. A purely local sliding window assumes
 * we are the only thing that has ever talked to this API from this IP, which is false
 * after a previous run, a manual request, or another tool on the same connection. The
 * server's counter is the truth, so we reconcile against it after every response and
 * obey any restriction it reports. The search policy's worst rule is a 30 minute ban,
 * so being conservative is cheap by comparison.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

export interface Rule {
  hits: number;
  period: number;
  restriction: number;
}

export function parseRules(header: string | null | undefined): Rule[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part) => part.trim().split(':').map(Number))
    .filter((n) => n.length === 3 && n.every((x) => Number.isFinite(x)))
    .map(([hits, period, restriction]) => ({ hits: hits!, period: period!, restriction: restriction! }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Where the sliding window is persisted between runs.
 *
 * Rate limits live on the server, keyed by IP, and they outlive our process. A limiter
 * that starts each run with an empty window is asserting "nothing has ever called this
 * API from here", which is false for any run that follows a recent one — so its very
 * first request fires blind into a window that may already be full, and the reply is a
 * ban. Runs 6 hours apart never notice; runs minutes apart cascade. Persisting the
 * window closes the gap.
 */
const STATE_FILE = path.join(process.cwd(), 'cache', 'ratelimit.json');

interface PersistedState {
  hits: Record<string, number[]>;
  blockedUntil: Record<string, number>;
}

export class RateLimiter {
  /** Request timestamps (ms) per policy, forming a sliding window. */
  private hits = new Map<string, number[]>();
  private rules = new Map<string, Rule[]>();
  /** Epoch ms until which a policy is server-side restricted. */
  private blockedUntil = new Map<string, number>();
  /** Last request time per policy, for the fixed floor delay. */
  private lastAt = new Map<string, number>();
  private safety: number;
  private minGap: number;

  /**
   * @param safety Fraction of each published limit we allow ourselves to use.
   *   0.5 rather than something tighter because observed penalties do not match the
   *   advertised `restriction` field — a burst against the 12:4:10 fetch rule earned
   *   a 600s Retry-After, not 10s. GGG escalate on clients that push, so the only
   *   sane posture is to stay far away from the edge.
   * @param minGap Floor delay between requests in a policy, in ms. The window logic
   *   alone permits tight bursts that are technically legal but read as abusive;
   *   this smooths them out. A full snapshot is ~200 requests a few times a day, so
   *   spending an extra minute here costs us nothing.
   */
  constructor(safety = 0.5, minGap = 400) {
    this.safety = safety;
    this.minGap = minGap;
    this.load();
  }

  /** Restores the window left by a previous run, dropping anything already expired. */
  private load(): void {
    if (!existsSync(STATE_FILE)) return;
    try {
      const s = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as PersistedState;
      const now = Date.now();
      // Nothing in these rules looks back further than an hour.
      for (const [policy, times] of Object.entries(s.hits ?? {})) {
        const live = times.filter((t) => now - t < 3600_000);
        if (live.length) this.hits.set(policy, live);
      }
      for (const [policy, until] of Object.entries(s.blockedUntil ?? {})) {
        if (until > now) {
          this.blockedUntil.set(policy, until);
          console.warn(`[ratelimit] ${policy} still banned for ${Math.ceil((until - now) / 1000)}s (from a previous run).`);
        }
      }
    } catch {
      // A corrupt state file must not take the run down; worst case we start blind.
    }
  }

  /** Persists the window so the next run inherits it. Best-effort. */
  save(): void {
    try {
      mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      const hits: Record<string, number[]> = {};
      for (const [p, t] of this.hits) hits[p] = t;
      const blockedUntil: Record<string, number> = {};
      for (const [p, u] of this.blockedUntil) blockedUntil[p] = u;
      writeFileSync(STATE_FILE, JSON.stringify({ hits, blockedUntil } satisfies PersistedState));
    } catch {
      // Non-fatal: persistence is an optimisation, not a correctness requirement.
    }
  }

  private budgetFor(rule: Rule): number {
    return Math.max(1, Math.floor(rule.hits * this.safety));
  }

  /** Seed limits before the first request so the opening burst is throttled too. */
  seed(policy: string, header: string): void {
    if (!this.rules.has(policy)) this.rules.set(policy, parseRules(header));
  }

  /**
   * Reconcile against what the server just told us.
   *
   * If the server counts more hits in a window than we do, we adopt its number by
   * backdating synthetic timestamps into that window. That makes us back off for
   * usage we didn't perform ourselves rather than blowing through the limit.
   */
  observe(policy: string, headers: Headers): void {
    const rules = parseRules(headers.get('x-rate-limit-ip') ?? headers.get('x-rate-limit-client'));
    if (rules.length) this.rules.set(policy, rules);

    const state = parseRules(headers.get('x-rate-limit-ip-state') ?? headers.get('x-rate-limit-client-state'));
    if (!state.length) return;

    // `restriction` in a state entry is the currently-active lockout, if any.
    const active = Math.max(0, ...state.map((s) => s.restriction));
    if (active > 0) {
      const until = Date.now() + active * 1000 + 500;
      this.blockedUntil.set(policy, Math.max(this.blockedUntil.get(policy) ?? 0, until));
      console.warn(`[ratelimit] ${policy} is restricted for ${active}s; holding off.`);
      this.save();
    }

    const now = Date.now();
    const live = this.hits.get(policy) ?? [];
    for (const s of state) {
      // `hits` on a state entry is the server's current count for that window.
      const ours = live.filter((t) => now - t < s.period * 1000).length;
      const missing = s.hits - ours;
      if (missing > 0) {
        // Backdate to the far edge of the window: they'll expire soonest, which is
        // the least pessimistic assumption consistent with the server's count.
        for (let i = 0; i < missing; i++) live.push(now - s.period * 1000 + 1000);
      }
    }
    live.sort((a, b) => a - b);
    this.hits.set(policy, live);
  }

  /**
   * Seconds remaining on a server-side ban for `policy`, or 0 if clear.
   *
   * Lets a caller check before spending anything. Without this, a run discovers a
   * fetch ban only after paying for the searches that precede the first fetch — and
   * throws that work away. Repeated every half hour, that's real load on a shared IP
   * bought for nothing.
   */
  blockedFor(policy: string): number {
    const until = this.blockedUntil.get(policy) ?? 0;
    return Math.max(0, Math.ceil((until - Date.now()) / 1000));
  }

  /** Blocks until a request under `policy` is safe to send, then records it. */
  async acquire(policy: string): Promise<void> {
    const rules = this.rules.get(policy) ?? [];
    for (;;) {
      const blocked = this.blockedUntil.get(policy) ?? 0;
      if (blocked > Date.now()) {
        await sleep(blocked - Date.now());
        continue;
      }

      const now = Date.now();
      const longest = Math.max(0, ...rules.map((r) => r.period)) * 1000;
      const live = (this.hits.get(policy) ?? []).filter((t) => now - t < longest);

      // Fixed floor delay, independent of the window maths.
      const since = now - (this.lastAt.get(policy) ?? 0);
      let waitMs = since < this.minGap ? this.minGap - since : 0;

      for (const rule of rules) {
        const budget = this.budgetFor(rule);
        const inWindow = live.filter((t) => now - t < rule.period * 1000);
        if (inWindow.length >= budget) {
          // Wait for the oldest hit that is holding us at the cap to age out.
          const blocker = inWindow[inWindow.length - budget]!;
          waitMs = Math.max(waitMs, blocker + rule.period * 1000 - now + 50);
        }
      }

      this.hits.set(policy, live);
      if (waitMs <= 0) {
        live.push(now);
        this.hits.set(policy, live);
        this.lastAt.set(policy, now);
        // Persist per request, not at exit: a killed or crashed run must still leave
        // an accurate window behind, since that is exactly when the next run is close.
        this.save();
        return;
      }
      await sleep(Math.min(waitMs, 60_000));
    }
  }

  /**
   * Honour an explicit 429. With correct pacing this should never fire.
   *
   * Returns the ban length. Waits it out only when it's short: GGG escalate
   * penalties well past the advertised `restriction` (a fetch burst once earned
   * 600s against a rule claiming 10s), and silently sleeping through that looks
   * exactly like a hung process. Anything longer is the caller's to decide about.
   */
  async penalty(policy: string, headers: Headers, maxWaitSec = 120): Promise<number> {
    const retry = Number(headers.get('retry-after') ?? '60');
    const secs = Number.isFinite(retry) ? retry : 60;
    this.blockedUntil.set(policy, Date.now() + secs * 1000 + 500);
    this.save();
    if (secs > maxWaitSec) {
      console.warn(`[ratelimit] 429 on ${policy}; banned for ${secs}s — too long to wait out.`);
      return secs;
    }
    console.warn(`[ratelimit] 429 on ${policy}; sleeping ${secs}s.`);
    await sleep(secs * 1000 + 500);
    return secs;
  }
}
