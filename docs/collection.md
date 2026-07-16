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

Per run, for the 6-base helmet slice:

| | Requests | Notes |
|---|---:|---|
| Currency rates | 10 | one exchange call per tracked currency |
| Searches | 18 | 6 bases × (magic price-asc, rare price-asc, rare recent) |
| Fetches | ~180 | 100 ids per search, 10 ids per fetch call |

Roughly 210 requests, ~10 minutes at 50% of published limits. The binding
constraint is the search rule `30:300:1800` — 30 searches per 5 minutes — which
means the slice could grow to ~5× its current size before cadence has to change.

## Extending beyond helmets

`SLICE` in `src/pipeline/collect.ts` names one `{itemClass, category, archetype}`.
Widening it is the intended next step; `data/bases.json` already carries every
class and archetype, so the static half needs no work. Watch the search budget:
each additional base is 3 more searches and ~30 more fetches.
