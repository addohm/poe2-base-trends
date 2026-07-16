# Collection

## Why collection doesn't run in CI

Deploying the *site* from GitHub Actions is exactly right, and that's what
`.github/workflows/pages.yml` does. Moving *collection* there is the tempting next
step — especially when your own IP is in a penalty box — but it trades a problem you
can see for several you can't:

1. **Cloudflare is hostile to datacenter IPs.** `pathofexile.com` sits behind
   Cloudflare, and GitHub runners are Azure ranges — the most-challenged address space
   there is. An automated browser gets a "Performing security verification" interstitial
   even from a *residential* IP. Expect 403s or challenges, not data. Getting past that
   would mean defeating bot detection, which isn't on the table.
2. **Rate limits are per-IP, and CI IPs are shared and rotating.** A run spends budget
   belonging to whatever else is on that address, and inherits whatever they've already
   spent. Two runs landing on one IP can trip a limit neither would hit alone.
3. **The 4xx spiral would land on strangers.** See above: bans accrue to the IP. On a
   shared runner, ours is served by whoever draws that address next — and theirs by us.
   The whole point of the rotation is to be a small, well-behaved fraction of a shared
   budget; anonymising ourselves into someone else's pool is the opposite.
4. **It would need a secret to be worth it.** If the answer to Cloudflare is "send a
   session cookie", that's an account credential in CI, for a page that updates hourly.
   Bad trade.

And it buys nothing: the data moves over hours, and a local scheduled rotation
publishes just as freshly. A flagged IP is a *timing* problem that resolves itself with
silence; routing around it via someone else's address is a citizenship problem that
doesn't.

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

## The 4xx spiral — why retrying makes it worse

GGG's developer docs contain the sentence that explains everything:

> Applications that make too many invalid requests in a short period of time will be
> restricted from further access, where **invalid requests include any response codes
> in the HTTP 4xx range**.

A `429` is a 4xx. So **every rate-limit rejection is itself an invalid request that
deepens the restriction.** Waiting exactly `Retry-After` and trying again — textbook
good-citizen behaviour against a transient limit — is precisely wrong here: the retry
gets 429'd, that 429 counts against you, and the restriction extends. It never
converges. During development this produced three separate 600s bans, each earned
immediately after politely waiting out the last.

The only escape is to **stop making requests entirely** and let the invalid-request
window drain. Hence the exponential backoff in `ratelimit.ts`: consecutive bans double
the wait (capped at 4h), and any success resets it. One 429 is weather; four in a row
means the server is saying something `Retry-After` doesn't express.

Corollary: a rejected request is not free. A run must never "just try and see" — that
is what the preflight ban check is for.

## Is the trade *site* banned too?

No, and that distinction confuses the diagnosis. The website may work perfectly in
your browser while the API refuses this client, because:

- The site's own calls ride an authenticated session with its own budget.
- Your browsing hasn't produced a burst of 4xx responses; the collector has.
- Cloudflare fingerprints clients, and treats a scripted one very differently from
  Chrome. (An automated browser pointed at `pathofexile.com` gets a bot challenge even
  from a residential IP.)

So "I can still browse trade" does **not** mean the API is clear, and it is not
evidence the collector is safe to restart. Check `cache/ratelimit.json` instead — it
records the real state, and a preflight run reports it without spending anything.

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
