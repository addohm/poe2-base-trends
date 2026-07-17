# poe2-base-trends

Which crafting bases are best, what they cost, and which stat lines the market
actually pays for — for the current Path of Exile 2 league.

Two halves, and they are not the same kind of thing:

| Question | Source | Confidence | Status |
|---|---|---|---|
| Best base, every category | Game data (RePoE) | **Exact.** Every released base, no sampling. | **Done** — 957 bases, 54 groups |
| What does it cost, and what mods are paid for? | Trade listings | **Estimated.** Asks, not sales. | Collecting — ES helmets first |

The static half needs no API and is complete. The market half is gated on trade's
rate limits and refreshes one base per tick; widening it costs cycle time, not burst
size (see [docs/collection.md](docs/collection.md)).

## The three claims this repo makes, and why they hold

### 1. "Best base" is not a market question

The highest-ES helmet is Ancestral Tiara because the game's base-item table says
109 ES. That's static: it can't be manipulated, it doesn't drift during a league,
and it covers bases nobody currently has listed. Trade search can only ever show
you what someone happens to be selling.

So `npm run bases` reads [RePoE](https://repoe-fork.github.io/poe2/) and produces
the complete table offline — **957 bases across 54 groups**. Zero API calls.

#### "Best" is four different questions

Answering them all with one metric would be the same class of error as ranking mods
by the stat you sorted on:

| Family | Categories | Ranked by |
|---|---|---|
| **armour** | Body Armour, Helmet, Gloves, Boots, Shield, Buckler, Focus | defence at 20% quality, **within an archetype** — a pure-ES helmet and an ar/ev hybrid aren't competing for the same build |
| **weapon** | maces, swords, axes, bows, crossbows, spears, daggers, claws, flails, warstaves, talismans | physical DPS (mean hit × attacks/sec) |
| **caster** | Wand, Sceptre, Staff | **which spell mods it can roll** — see below |
| **implicit** | Ring, Amulet, Belt, Quiver | *nothing* — the base **is** its implicit, so there's no "best", only which one you want |

#### Caster weapons have no stats at all

Wands, sceptres and staves carry no defence, no damage, and no implicit. What
distinguishes them is the skill they grant (Withered Wand → Chaos Bolt, Rattling
Sceptre → Skeletal Warrior) and — the part that decides crafting — which spell mod
families they're *barred* from rolling, via `no_fire_spell_mods` tags. A Frigid Wand
can only roll cold; a Dueling Wand can roll **any type**. That's the ranking.

#### Rune-forged bases are excluded

This one isn't obvious, and including them puts a fiction at the top of every table.
`Runeforged`/`Runemastered` bases (metadata `...Verisium*`) are **44% of the dump**.
They're rune-forging *outputs*, not bases you can buy and craft on — and up to six
share one display name with wildly different stats:

| "Runemastered Torment Club" variant | Phys damage |
|---|---|
| Unique2 / 3 / 5 | 44–73 — *identical to the plain base* |
| Unique1 | 44–209 |
| Unique4 | **85–403** |

Ranking them means silently reporting the luckiest variant as though it were the
base's stats, on a name trade can't even search for. Detected three ways (metadata
key, name, tag) because the dump contradicts itself: three bases are *named*
"Runeforged …" without the tag, and one carries the tag without the name.

### 2. Sorting by a stat cannot tell you which mods are valuable

The obvious method — sort rares by energy shield, read off the mods on the
expensive ones — is circular. Sorting by ES selects for ES mods, so ES mods
appear at the top no matter what the market thinks. The confound is easy to see
in live data; three Ancestral Tiaras sampled during development:

| ES | Price | Notable mod |
|---:|---:|---|
| 169 | **13 div** | `of the Proficient` S1 — 35% reduced Attribute Requirements |
| 254 | 3 div | `Unassailable` P1 — 94% increased Energy Shield |
| 452 | 2 div | `Celestial` P2 — +57 to maximum Energy Shield |

The **highest-ES item is the cheapest**. An ES-sorted method would never surface
`reduced Attribute Requirements`, which is what the expensive one is actually
selling on.

Instead we compute **lift**:

```
lift(mod) = P(mod | dearest slice of market) / P(mod | whole market)
```

`2.0×` means a mod is twice as common on expensive items as on the market at
large — someone is paying for it. `1.0×` means it's along for the ride. Every
lift carries a **95% confidence interval**, and a mod whose interval spans 1.0 is
labelled *noise* rather than ranked — on a thin sample a mod seen a handful of
times can show a lift of 2.0 by luck alone.

#### Mods are identified by family and tier, never by stat text

This is the single easiest way to get this analysis wrong, and the first version
of this repo got it wrong. Trade reports one entry per *stat*, each naming the mod
that granted it. Two facts make stat-level keys worthless:

- **Hybrids grant several stats.** `Celestial` P3 emits both `29% increased Energy
  Shield` and `+21 to maximum Mana`. It is one mod; a crafter hits it once.
- **Unrelated families share a stat hash, each with its own tier ladder.** The stat
  `increased Energy Shield` is granted by `Unassailable` (P1 = 92-100%), by
  `Celestial` (P3 = 27-32%, hybrid), and by desecrated `Dauntless` (P3 = 68-79%).

Keying on `stat_hash|tier` merges these into a bucket corresponding to **no real
mod at all**. That bug is what once made "[P2] increased Energy Shield" look like
a top result. The key is now `origin|family|tier` — e.g. `exp|Unassailable|P1`.

#### Item level floor

Mod tiers are ilvl-gated, so a market mixing levelling drops with endgame items
compares bases that cannot roll the same mods. Set `POE2_MIN_ILVL` (default `70`,
useful range `60`-`100`).

### 3. Prices are asks, not sales — so read the distribution carefully

No PoE2 API exposes completed transactions. GGG's public stash tab API, the one
sanctioned bulk feed, is **PoE1 only**. Everything here is what sellers *hope
for*.

Consequences baked into the design:

- **Price stats come from whole-market counts, not samples.** Passing `price` with
  no currency option makes trade convert every listing to an Exalted Orb
  equivalent itself. A handful of count-only searches (`total`, no fetches) then
  yields an exact histogram — "27% of rare Ancestral Tiaras are ≥1000ex" is a fact
  about every listing, not an estimate from 100 of them.
- **We never read the top of the price distribution.** It's tempting to look at
  the top-5 priced items, but the top of a right-skewed ask distribution is
  precisely where manipulation lives — the mirror-priced troll listings. Slicing
  by an absolute threshold (the dearest ~25%) rather than by rank means trolls are
  a rounding error inside a large stratum instead of the whole reading.
- **Listings are collapsed per account**, so one seller dumping forty near-identical
  items can't turn their personal crafting habits into a "market preference".
- **Everything is normalised to exalted.** The divine:exalted ratio moves a lot
  over a league; without deflating, every item appears to trend together and you've
  plotted currency inflation instead of item value. Rates are stored per snapshot
  so past readings stay reproducible.
- **Delisting rate** is tracked between snapshots. An ask nobody takes is an
  opinion; an ask that disappears is closer to a price.
- **Mod counts are pooled across snapshots**, and every lift is reported with a
  confidence interval. The page starts sparse and sharpens rather than starting
  confident and wrong.

## Architecture

```
RePoE dump ──> npm run bases ───> data/bases.json ──┐
                                                    ├──> npm run site ──> dist/ ──> GitHub Pages
trade2 API ──> npm run collect ─> cache/raw/*.json  │
              (ONE base per run)     │              │
              cache/cursor.json <────┘              │
                     └────────── npm run analyze ──> data/history/*.jsonl
                                                     data/analysis.json ─┘
```

**Collection is a slow rotation, not a blitz.** Each run takes one base off a
persisted queue, spends ~12 searches (~4 min), and exits. A scheduled task ticks it
over and over; the tracked set refreshes by rotation.

The reason is that rate limits are **per-IP**, and that IP is the one you browse
trade from — the site rate-limits ordinary human players on its own. A scraper that
drains the budget in a burst is competing with its own operator for it. The budget
is a shared resource to leave most of alone.

The interval is a knob, not a truth — see
[choosing the interval](docs/collection.md#choosing-the-interval). The only rule is
never to raise `POE2_BATCH` to catch up; that rebuilds the burst. Rotation also makes
collection resumable for free: a run aborted by a ban leaves its base at the head of
the queue.

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
npm run collect     # collect ONE base off the queue (~12 searches, ~4 min)
npm run analyze     # aggregate into data/history + data/analysis.json
npm run site        # render dist/
npm run serve       # preview at http://localhost:4173
npm run typecheck && npm test
```

Scheduled use (Windows) — one base per tick, on a rotation:

```powershell
.\scripts\snapshot.ps1                                # one run by hand, local only
.\scripts\register-task.ps1 -IntervalMinutes 30 -Push # wire up the rotation
```

Pick the interval to taste; 15-60 min all work for a six-base set. Slower is politer,
and the cycle only has to beat the speed prices move (hours). See
[docs/collection.md](docs/collection.md#choosing-the-interval).

| Variable | Default | Meaning |
|---|---|---|
| `POE2_LEAGUE` | `Runes of Aldur` | League to query |
| `POE2_MIN_ILVL` | `70` | Item level floor (clamped 60-100) |
| `POE2_BASES` | `6` | Size of the tracked set |
| `POE2_BATCH` | `1` | Bases per run — **leave at 1** |
| `POE2_RATES_TTL_H` | `6` | Hours to cache currency rates |
| `POE2_UA` | repo URL | User-Agent. Point it at your own contact — the API is unsanctioned, and identifying yourself honestly is most of what earns tolerance |

## Rate limits

The trade API is undocumented and unsanctioned — it's the trade site's own
backend. It answers unauthenticated, so no session cookie is sent. It publishes
its limits per response:

```
X-Rate-Limit-Policy:   trade-search-request-limit
X-Rate-Limit-Ip:       5:10:60,15:60:300,30:300:1800     hits:period:restriction
X-Rate-Limit-Ip-State: 1:10:0,1:60:0,1:300:0             current:period:activeRestriction
```

`src/lib/ratelimit.ts` obeys these. Three things it does that a naive limiter
doesn't, each learned the hard way:

- **Reconciles against the `-State` header.** The server reports its live counts;
  a purely local window assumes we're the only thing that has ever called this API
  from this IP, which is false after any recent run.
- **Persists the window to `cache/ratelimit.json`.** Limits live on the server and
  outlive our process. Starting each run with an empty window means the first
  request fires blind into a window that may already be full — invisible when runs
  are 6h apart, a cascade when they're minutes apart.
- **Bounds every 429 wait.** A ban longer than 120s aborts the run with a clear
  message instead of sleeping. An earlier unbounded retry against the exchange
  endpoint's 30-minute ban spun for **37 minutes** looking exactly like a hang.

Penalties escalate well beyond the advertised `restriction`: a burst against the
`12:4:10` fetch rule earned a **600s** `Retry-After`, not 10s. GGG punish clients
that push, so the limiter runs at 50% of published limits with a floor delay. A
full snapshot takes ~15-20 minutes, which is irrelevant for a job that runs a few
times a day.

**Searches are the scarce resource; fetches are not.** That asymmetry drove the
design: price statistics come from count-only search ladders (one search, whole
market) rather than sampled percentiles (one search *plus* ten fetches, 100
listings).

## Caveats

- Listing prices are **asks**. Treat every number as an upper-bound opinion.
- **Ladder counts describe the whole market; mod samples describe new listings.**
  Both mod strata are drawn newest-first, so lift compares the *flow* of expensive
  listings against the flow of all listings. That's a consistent comparison and
  arguably the right one for "what should I craft now", but it is not the same
  population as the ladder counts, which measure standing stock. Expensive items
  sell slower, so stock over-represents them.
- The two mod strata overlap: the top stratum is a subset of the market, so the
  confidence intervals are very slightly optimistic. With the top at ~25% of the
  book and each stratum sampled separately, the effect is small.
- Each query returns at most 100 items (the API's cap), so a stratum is a sample
  of at most 100 listings per snapshot — hence the pooling.
- Trends need history. A fresh clone shows "building…" until snapshots accumulate.
- Not affiliated with Grinding Gear Games.
