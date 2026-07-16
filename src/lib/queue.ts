/**
 * A persisted round-robin work queue over the tracked bases.
 *
 * This is what turns collection into a slow rotation instead of a blitz. Trade's
 * rate limits are per-IP, and that IP is also the one a human browses the site
 * from — trade rate-limits ordinary players all by itself, so a scraper that empties
 * the budget in a burst is competing with its own operator for it.
 *
 * So each run takes one base and exits, and the scheduler decides how often that
 * happens. Keeping the cadence out here rather than in a long-running loop is what
 * makes the interval a knob: per-run cost stays flat whatever it's set to.
 *
 * The queue also makes collection resumable for free: a run that aborts on a ban
 * simply leaves its base at the head for next time, and nothing has to know how far
 * a previous run got.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const STATE_FILE = path.join(process.cwd(), 'cache', 'cursor.json');

export interface QueueState {
  /** Names still to be collected in the current cycle, in order. */
  pending: string[];
  /**
   * Names already collected in this cycle.
   *
   * Needed to tell "already done" from "newly tracked": without it, a base added to
   * the tracked set mid-cycle is indistinguishable from one just collected, so it
   * either gets ignored for hours or re-collected on every run.
   */
  done: string[];
  /** When the current cycle began — a full pass is one refresh of every base. */
  cycleStartedAt: string;
  /** Completed cycles, for the "how fresh is this?" readout. */
  cycles: number;
}

function load(): QueueState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as QueueState;
    return Array.isArray(s.pending) ? s : null;
  } catch {
    return null;
  }
}

function save(s: QueueState): void {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

/**
 * Returns the next `count` names to collect, refilling the cycle when it runs dry.
 *
 * `all` is the authoritative list from static data. Comparing against it on every
 * call means adding or removing a tracked base takes effect immediately: new names
 * join the current cycle, and stale ones drop out rather than being collected for a
 * base we no longer care about.
 */
export function take(all: string[], count: number): { batch: string[]; state: QueueState } {
  let s = load();

  if (s) {
    // Drop anything no longer tracked, from both lists, so a removed base can't
    // strand the queue or inflate the cycle.
    s.pending = s.pending.filter((n) => all.includes(n));
    s.done = (s.done ?? []).filter((n) => all.includes(n));
    // Anything tracked but neither pending nor done is new: fold it into this cycle
    // rather than making it wait out a pass it was never part of.
    const fresh = all.filter((n) => !s!.pending.includes(n) && !s!.done.includes(n));
    s.pending.push(...fresh);
  }

  if (!s || !s.pending.length) {
    s = {
      pending: [...all],
      done: [],
      cycleStartedAt: new Date().toISOString(),
      cycles: (s?.cycles ?? 0) + (s ? 1 : 0),
    };
  }

  const batch = s.pending.slice(0, Math.max(1, count));
  save(s);
  return { batch, state: s };
}

/** Marks names collected, moving them out of the pending list for this cycle. */
export function complete(names: string[]): QueueState | null {
  const s = load();
  if (!s) return null;
  s.pending = s.pending.filter((n) => !names.includes(n));
  s.done = [...new Set([...(s.done ?? []), ...names])];
  save(s);
  return s;
}

export function peek(): QueueState | null {
  return load();
}
