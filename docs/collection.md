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

## Scheduling on Windows

`scripts/snapshot.ps1` does collect → analyse → render → commit, and pushes with
`-Push`. Register it with Task Scheduler:

```powershell
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\Users\addohm\Documents\poe2-base-trends\scripts\snapshot.ps1" -Push'
$trigger = New-ScheduledTaskTrigger -Daily -At 6am
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At 6am `
  -RepetitionInterval (New-TimeSpan -Hours 6) -RepetitionDuration (New-TimeSpan -Days 3650)).Repetition

Register-ScheduledTask -TaskName 'poe2-base-trends snapshot' `
  -Action $action -Trigger $trigger -Description 'Snapshot PoE2 trade prices and publish'
```

Pushing needs credentials the task can use non-interactively — a credential helper
or a deploy key. Run it once by hand first (without `-Push`) to confirm the
collection half works before wiring up the schedule.

## Cadence

Every 6 hours is a good default.

- **Faster doesn't help.** A snapshot takes ~10 minutes at safe rates, and base
  prices don't move meaningfully inside an hour.
- **History size.** Each snapshot appends one JSONL row per query. At 18 queries,
  4×/day, that's ~72 rows/day of a few hundred bytes — a few MB over a league.
  Raw listings would be ~2 MB *per snapshot*, which is why they stay in `cache/`.
- **Delisting resolution.** The delisting rate is measured between consecutive
  snapshots, so the interval defines the window. Six hours reads as "share of
  listings that vanished within 6 hours" — long enough to be a signal, short
  enough that the 100-item sample still overlaps.

## What a snapshot costs

Per base:

| | Requests | Notes |
|---|---:|---|
| Rare price ladder | 5 | count-only searches; **no fetches** |
| Magic price ladder | 4 | count-only searches |
| Top-stratum sample | 1 + 10 | search + fetches (100 ids, 10 per call) |
| Baseline sample | 1 + 10 | search + fetches |
| Cheapest magic | 1 + 2 | 20 ids for the blank-base floor |

So ~12 searches and ~22 fetches per base, plus ~10 exchange calls per run for
currency rates (a separate limit bucket). For the default 6-base slice that's
roughly **72 searches and 130 fetches**, about 15-20 minutes at 50% of published
limits.

The binding constraint is the search rule `30:300:1800` — 30 searches per 5
minutes, and we use half of that. **Searches are the scarce resource, fetches are
not**, which is why price statistics were moved onto ladders: a rung costs one
search and describes the entire market, where a sampled percentile costs a search
*plus* ten fetches and only describes 100 listings.

Set `POE2_BASES=2` for a cheap first run to confirm the IP is clear before
committing to a full snapshot.

## Extending beyond helmets

`SLICE` in `src/pipeline/collect.ts` names one `{itemClass, category, archetype}`.
Widening it is the intended next step; `data/bases.json` already carries every
class and archetype, so the static half needs no work. Watch the search budget:
each additional base is 3 more searches and ~30 more fetches.
