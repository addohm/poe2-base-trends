# poe2-base-trends

Which crafting bases are best, what they cost, and which stat lines the market
actually pays for — for the current Path of Exile 2 league.

Two halves, and they are not the same kind of thing:

| Question | Source | Confidence |
|---|---|---|
| Which base has the highest energy shield? | Game data (RePoE) | **Exact.** Every released base, no sampling. |
| What does it cost, and what mods are paid for? | Trade listings | **Estimated.** Asks, not sales. |

## The three claims this repo makes, and why they hold

### 1. "Best base" is not a market question

The highest-ES helmet is Ancestral Tiara because the game's base-item table says
109 ES. That's static: it can't be manipulated, it doesn't drift during a league,
and it covers bases nobody currently has listed. Trade search can only ever show
you what someone happens to be selling.

So `npm run bases` reads [RePoE](https://repoe-fork.github.io/poe2/) and produces
the complete table offline. Zero API calls.

### 2. Sorting by a stat cannot tell you which mods are valuable

The obvious method — sort rares by energy shield, read off the mods on the
expensive ones — is circular. Sorting by ES selects for ES mods, so ES mods
appear at the top no matter what the market thinks. The confound is easy to see
in live data; three Ancestral Tiaras sampled during development:

| ES | Price | Notable mod |
|---:|---:|---|
| 169 | **13 div** | `35% reduced Attribute Requirements` |
| 254 | 3 div | `P1 94% increased Energy Shield` |
| 452 | 2 div | `P2 +57 to maximum Energy Shield` |

The **highest-ES item is the cheapest**. An ES-sorted method would never surface
`reduced Attribute Requirements`, which is what the expensive one is actually
selling on.

Instead we compute **lift**:

```
lift(mod) = P(mod | expensive quartile) / P(mod | whole sample)
```

`2.0×` means a mod is twice as common on expensive items as on the market at
large — someone is paying for it. `1.0×` means it's along for the ride. The
sample is drawn by **recency** (`sort: {indexed: desc}`), which is uncorrelated
with price, so we aren't measuring our own sort order.

### 3. Prices are asks, not sales — so read the distribution carefully

No PoE2 API exposes completed transactions. GGG's public stash tab API, the one
sanctioned bulk feed, is **PoE1 only**. Everything here is what sellers *hope
for*.

Consequences baked into the design:

- **We never read the top of the price distribution.** It's tempting to look at
  the top-5 priced items, but the top of a right-skewed ask distribution is
  precisely where manipulation lives — the mirror-priced troll listings. We
  report the **10th percentile of the cheapest asks** instead. This kills both
  the bait listings and the trolls without needing any heuristic to detect them.
- **Everything is normalised to exalted**, using GGG's own currency exchange. The
  divine:exalted ratio moves a lot over a league; without deflating, every item
  appears to trend together and you've plotted currency inflation instead of item
  value. The rates used are stored with each snapshot so past readings stay
  reproducible.
- **Delisting rate** is tracked between snapshots. An ask nobody takes is an
  opinion; an ask that disappears is closer to a price. It's the best available
  proxy for a sale.
- **Mod counts are pooled across snapshots.** One snapshot yields a top quartile
  of ~25 items, where a mod seen 8 times can show `2.0×` lift by chance alone. A
  mod must be seen 25+ times before the site will rank it, so the page starts
  sparse and sharpens.

## Architecture

```
RePoE dump ──> npm run bases ───> data/bases.json ──┐
                                                    ├──> npm run site ──> dist/ ──> GitHub Pages
trade2 API ──> npm run collect ─> cache/raw/*.json  │
                     └────────── npm run analyze ──> data/history/*.jsonl
                                                     data/analysis.json ─┘
```

**Collection runs on a real machine, not in CI.** Trade rate limits are per-IP,
and CI runners use shared, rotating datacenter addresses behind Cloudflare.
Scraping from Actions would mean sharing a rate-limit bucket — and any resulting
ban — with every unrelated project on the same runner IP. So a scheduled local
task collects and commits aggregates; GitHub Actions only renders and deploys.
That also means no `POESESSID` or secret ever goes near CI. See
[docs/collection.md](docs/collection.md).

Only aggregates are committed. Raw listings are megabytes per snapshot and live
in gitignored `cache/`.

## Usage

```bash
npm install
npm run bases       # exact base tables from game data — no network beyond one CDN fetch
npm run collect     # one trade snapshot (slow on purpose; see rate limits)
npm run analyze     # aggregate into data/history + data/analysis.json
npm run site        # render dist/
npm run serve       # preview at http://localhost:4173
npm run typecheck
```

Scheduled use (Windows):

```powershell
.\scripts\snapshot.ps1          # collect, analyse, render, commit locally
.\scripts\snapshot.ps1 -Push    # ...and push, which triggers the Pages deploy
```

Set `POE2_LEAGUE` to target a different league (defaults to `Runes of Aldur`).

## Rate limits

The trade API is undocumented and unsanctioned — it's the trade site's own
backend. It answers unauthenticated, so no session cookie is sent. It publishes
its limits per response:

```
X-Rate-Limit-Policy:   trade-search-request-limit
X-Rate-Limit-Ip:       5:10:60,15:60:300,30:300:1800     hits:period:restriction
X-Rate-Limit-Ip-State: 1:10:0,1:60:0,1:300:0             current:period:activeRestriction
```

`src/lib/ratelimit.ts` obeys these, and — importantly — reconciles against the
**state** header rather than trusting a purely local window. A local window
assumes we're the only thing that has ever talked to this API from this IP, which
is false after a previous run or a manual request. Getting this wrong is not
theoretical: during development, a burst against the `12:4:10` fetch rule earned a
**600s** `Retry-After`, not the 10s the rule advertises. GGG escalate on clients
that push, so the limiter runs at 50% of published limits with a floor delay
between requests. A full snapshot takes ~10 minutes, which is irrelevant for a
job that runs a few times a day.

## Caveats

- Listing prices are **asks**. Treat every number as an upper-bound opinion.
- The site samples the first 100 results per query (the API's cap), so
  percentiles describe the sampled window, not the entire book.
- Trends need history. A fresh clone shows "building…" until snapshots accumulate.
- Not affiliated with Grinding Gear Games.
