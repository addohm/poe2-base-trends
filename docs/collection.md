# Collection

## Why collection doesn't run in CI

The natural instinct with a GitHub Pages site is to let Actions do everything on a
cron. Don't, for this project:

1. **Rate limits are per-IP, and CI IPs are shared.** GGG limit
   `trade-search-request-limit` by IP. GitHub-hosted runners draw from shared,
   rotating Azure address pools. A snapshot from CI spends budget that belongs to
   whatever else is on that address, and inherits whatever they've already spent.
   Two runs landing on the same IP can trip a limit neither would have hit alone.
2. **A ban would not be ours to serve.** The worst search rule carries a 30 minute
   restriction, applied to the IP. On a shared runner that punishes strangers.
3. **Cloudflare.** `pathofexile.com` sits behind Cloudflare, which treats
   datacenter ranges far more suspiciously than residential ones. A collector that
   works locally can silently start returning 403 in CI.
4. **No secret needs to exist.** The trade2 endpoints currently answer
   unauthenticated, so nothing needs a `POESESSID` — but if that ever changes,
   the session cookie is an account credential and putting it in CI would be a bad
   trade for a page that updates a few times a day.

None of this buys anything: the data changes on the order of hours, and a local
scheduled task publishes just as freshly.

So the split is:

- **Local machine** — `npm run collect` → `npm run analyze` → commit `data/`.
- **GitHub Actions** — checkout, `npm run bases`, `npm run site`, deploy. No network
  calls to trade, no secrets.

## A slow rotation, not a blitz

This is the one design rule that matters. Everything else here is a consequence.

`npm run collect` takes the next base off a persisted queue (`cache/cursor.json`),
collects **only that one** — about a dozen searches, ~4 minutes — and exits. A
scheduled task ticks it over and over, so the tracked set refreshes by rotation.

The reason isn't abstract politeness. Rate limits are **per-IP**, and that IP is
the same one you browse trade from — the site rate-limits ordinary human players
all by itself. A collector that drains the budget in a burst is competing with its
own operator for it. The budget is a shared resource to leave most of alone, not an
obstacle to route around.

Rotation also makes collection resumable for free: a run that aborts on a ban leaves
its base at the head of the queue, and the next tick picks it up. Nothing needs to
track how far the last run got.

## Choosing the interval

**There is no correct interval, and the default is not derived from anything.** Two
quantities are worth reasoning about:

- **Duty cycle** — a run costs ~4 minutes of requests, so at interval `I` we occupy
  roughly `4/I` of the clock. Everything else is left for you. Smaller is politer.
- **Cycle time** — `interval × tracked bases`. This is how stale the oldest row on
  the page can be. It only has to beat the speed prices actually move (hours). It
  does not have to feel fast.

| Interval | Duty cycle | Cycle (6 bases) | Cycle (48 bases) |
|---:|---:|---:|---:|
| 15 min | ~27% | 1.5 h | 12 h |
| 30 min | ~13% | 3 h | 24 h |
| 60 min | ~7% | 6 h | 48 h |

All three are defensible; lean slow. Even a 48-hour cycle beats the timescale base
prices move on, and trends need days of history regardless.

**The one rule: never raise `-Bases`/`POE2_BATCH` to catch up.** That rebuilds the
burst this design exists to avoid. If a cycle feels too slow, shorten the interval —
the per-run cost stays flat either way, and the duty cycle rises gently instead of
spiking.

## Scheduling on Windows

```powershell
.\scripts\register-task.ps1 -IntervalMinutes 30 -Push
```

That wires up `scripts/snapshot.ps1` (collect → analyse → render → commit → push).
Re-run it with a different `-IntervalMinutes` any time; it replaces the task.

Two settings in there matter:

- `-MultipleInstances IgnoreNew` — if a run is slow, the next tick is **dropped**
  rather than started beside it. Two collectors sharing an IP is exactly the burst
  we're avoiding.
- `-ExecutionTimeLimit 20min` — a backstop. A healthy run is ~4 minutes.

Pushing needs credentials the task can use non-interactively — a credential helper
or a deploy key. Run `.\scripts\snapshot.ps1` by hand once (without `-Push`) first.

## Consequences of rotating

- **Currency rates are cached 6 hours** (`cache/rates.json`, `POE2_RATES_TTL_H`).
  Exchange is the harshest endpoint (`30:300:1800` → a 30-minute ban); re-querying it
  every tick would make the gentlest part of the job the most abusive. Four calls a
  day is plenty for a ratio that drifts over hours.
- **A run under a known ban costs zero requests.** `collect` preflights the persisted
  ban state before touching the network. Otherwise every tick would spend its ladder
  searches and then be refused at the first fetch, discarding the lot.
- **Unchanged snapshots don't append history.** `analyze` runs every tick but only
  appends for a base whose snapshot timestamp is new. Otherwise the bases that didn't
  move would each gain a duplicate row per tick, inflating pooled mod counts and
  faking a flat price into repeated observations.
- **Rows aren't from the same moment.** The page states each base's age; with a
  rotation that's a real caveat, not a footnote.
- **Delisting resolution follows the cycle, not the interval**, since it compares
  consecutive snapshots *of the same base*.
- **History size.** One JSONL row of a few hundred bytes per collected base — a few
  MB over a league. Raw listings are ~200 KB per base per snapshot, which is why they
  stay in gitignored `cache/`.

## What one run costs

One run = one base:

| | Requests | Notes |
|---|---:|---|
| Rare price ladder | 5 | count-only searches; **no fetches** |
| Magic price ladder | 4 | count-only searches |
| Top-stratum sample | 1 + 10 | search + fetches (100 ids, 10 per call) |
| Baseline sample | 1 + 10 | search + fetches |
| Cheapest magic | 1 + 2 | 20 ids for the blank-base floor |
| Currency rates | 0 (usually) | cached 6h; ~2 exchange calls 4×/day |

**~12 searches, ~22 fetches, ~4 minutes**, then the process exits.

Against the search rule `30:300:1800` (30 per 5 minutes) that's about 12 searches
per 30 minutes — comfortably under, and it deliberately leaves most of the shared
IP allowance for you browsing trade.

**Searches are the scarce resource; fetches are not.** That asymmetry is why price
statistics live on ladders: a rung costs one search and describes the entire
market, where a sampled percentile costs a search *plus* ten fetches and describes
only 100 listings.

`POE2_BATCH` raises bases per run, and `POE2_BASES` sizes the tracked set. Leave
`POE2_BATCH` at 1 outside of a deliberate backfill on a known-idle IP.

## Limit debt, and why iterating hurts

Rate limits are per-IP and live on the server. They do not reset when our process
exits, and GGG escalate penalties for clients that keep pushing — a burst against
the fetch rule's advertised 10s restriction produced a **600s** `Retry-After` in
practice, and the exchange endpoint's `30:300:1800` means a **30 minute** ban.

The practical consequence: **an IP accumulates debt**. Several runs in quick
succession (as happens while developing) saturate the long windows, and each new
run inherits a nearly-exhausted budget, 429s early, and earns a longer ban than
the last. This is invisible in production, where runs sit 6 hours apart and every
window is long empty.

Two mitigations are built in:

- `cache/ratelimit.json` persists the sliding window between runs, so a run that
  starts minutes after another inherits its usage instead of firing blind.
- A ban longer than 120s aborts the run (`RateLimitedError`) rather than sleeping
  through it. Whatever bases were already collected are kept, and the next
  scheduled run continues from there.

If collection keeps aborting: **stop and leave the IP idle for half an hour.**
Retrying immediately is what deepens the hole.

## Extending beyond helmets

`SLICE` in `src/pipeline/collect.ts` names one `{itemClass, category, archetype}`.
Widening it is the intended next step; `data/bases.json` already carries every
class and archetype, so the static half needs no work.

Because collection is queue-driven, widening costs **cycle time, not burst size**.
Every run still touches exactly one base — the tracked set just takes longer to get
all the way around:

| Tracked bases | Full cycle at 30 min/base |
|---:|---|
| 6 (helmets, ES) | 3 hours |
| 24 (4 archetypes) | 12 hours |
| 48 (all armour classes) | 24 hours |

A day-long cycle is still faster than base prices meaningfully move, so the honest
ceiling here is high. If you want a shorter cycle, shorten the *interval* before
raising `POE2_BATCH` — the whole point is to never burst.
