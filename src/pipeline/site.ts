/**
 * Renders the static site into dist/ for GitHub Pages.
 *
 * The page answers one question per category: what do I craft on, and what do I aim
 * for? Everything else is supporting detail.
 *
 * Deliberately dependency-free: the output is one HTML file with inline CSS, which is
 * all Pages needs and keeps the build reproducible years from now.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { BasesDoc, RankedBase } from './bases.ts';
import type { CategoryAnalysis, RankedMod, Ranked } from './analyze.ts';
import { workUnits } from '../lib/categories.ts';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

const CSS = `
:root {
  --bg:#0f1115; --panel:#171a21; --line:#262b36; --text:#e6e9ef;
  --dim:#99a1b3; --accent:#d8b26a; --good:#6ec28a; --bad:#d97a7a;
  color-scheme: dark;
}
@media (prefers-color-scheme: light) {
  :root { --bg:#faf9f7; --panel:#fff; --line:#e3e0d9; --text:#1b1d22; --dim:#6b7280;
          --accent:#9a6f16; --good:#2f7d4f; --bad:#a33; color-scheme: light; }
}
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text);
  font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
.wrap { max-width:1140px; margin:0 auto; padding:32px 20px 80px; }
h1 { font-size:1.7rem; margin:0 0 4px; letter-spacing:-0.02em; }
h2 { font-size:1.2rem; margin:40px 0 10px; letter-spacing:-0.01em; }
h3 { font-size:1rem; margin:0 0 10px; }
p { color:var(--dim); margin:6px 0 14px; max-width:74ch; }
code { background:var(--panel); padding:1px 5px; border-radius:4px; font-size:0.86em; }
.sub { color:var(--dim); font-size:0.9rem; margin-bottom:22px; }
.pill { display:inline-block; background:var(--panel); border:1px solid var(--line);
  border-radius:999px; padding:2px 10px; font-size:0.76rem; color:var(--dim); margin:0 6px 4px 0; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:10px;
  padding:14px 16px; margin-bottom:14px; scroll-margin-top:96px; }
.cardhead { display:flex; flex-wrap:wrap; align-items:baseline; gap:8px;
  border-bottom:1px solid var(--line); padding-bottom:10px; margin-bottom:12px; }
.cardhead h3 { margin:0; }
.cols { display:grid; grid-template-columns:1fr 1fr 1fr; gap:18px; }
.cols2 { grid-template-columns:1fr 1fr; }
@media (max-width:860px) { .cols, .cols2 { grid-template-columns:1fr; } }
.col h4 { margin:0 0 6px; font-size:0.74rem; text-transform:uppercase;
  letter-spacing:0.06em; color:var(--dim); font-weight:600; }
.rowhead { display:flex; gap:8px; padding:2px 0 4px; border-bottom:1px solid var(--line);
  font-size:0.66rem; text-transform:uppercase; letter-spacing:0.05em; color:var(--dim); }
.rowhead .grow { flex:1; }
.rowhead .num, .rowhead .lift { width:auto; text-align:right; }
.row { display:flex; align-items:baseline; gap:8px; padding:4px 0;
  border-bottom:1px solid var(--line); font-size:0.88rem; }
.row:last-child { border-bottom:none; }
.row .grow { flex:1; min-width:0; }
.row .num { font-variant-numeric:tabular-nums; color:var(--dim); font-size:0.8rem; white-space:nowrap; text-align:right; }
.name { font-weight:600; }
.tier { color:var(--accent); font-weight:600; font-size:0.78rem; }
.stat { color:var(--dim); font-size:0.8rem; display:block; }
.lift { font-variant-numeric:tabular-nums; font-weight:600; white-space:nowrap; min-width:2.6em; text-align:right; }
.up { color:var(--good); } .down { color:var(--bad); } .flat { color:var(--dim); font-weight:400; }
.note { border-left:3px solid var(--accent); padding:10px 14px; background:var(--panel);
  border-radius:0 8px 8px 0; margin:16px 0; }
.note strong { color:var(--accent); }
.empty { color:var(--dim); font-size:0.85rem; padding:6px 0; }

/* Sticky navigation: section tabs + live filter. */
.nav { position:sticky; top:0; z-index:10; background:var(--bg); padding:10px 0;
  border-bottom:1px solid var(--line); margin-bottom:18px;
  display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.tab { background:var(--panel); border:1px solid var(--line); border-radius:8px;
  padding:6px 12px; font-size:0.85rem; color:var(--text); cursor:pointer; font-family:inherit; }
.tab:hover { border-color:var(--accent); }
.tab[aria-selected="true"] { background:var(--accent); color:#141414; border-color:var(--accent); font-weight:600; }
.tab .cnt { opacity:0.6; font-size:0.78em; margin-left:4px; }
.filter { flex:1; min-width:140px; background:var(--panel); border:1px solid var(--line);
  border-radius:8px; padding:6px 12px; font-size:0.85rem; color:var(--text); font-family:inherit; }
.filter:focus { outline:none; border-color:var(--accent); }
.sec[hidden] { display:none; }
.nomatch { color:var(--dim); font-size:0.9rem; padding:20px 4px; }

/* Legend key. */
.legend { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:10px 20px;
  background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin:16px 0; }
.legend .k { font-size:0.84rem; }
.legend .k b { color:var(--text); }
.legend .k span { color:var(--dim); }
.legend .swatch { display:inline-block; font-variant-numeric:tabular-nums; font-weight:600;
  padding:0 5px; border-radius:4px; }
.chiprow { display:flex; flex-wrap:wrap; gap:6px 14px; font-size:0.82rem; color:var(--dim); margin-top:4px; }
.scroll { overflow-x:auto; }
table { border-collapse:collapse; width:100%; font-size:0.85rem; }
th,td { text-align:right; padding:6px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
th:first-child, td:first-child { text-align:left; }
th { color:var(--dim); font-weight:600; font-size:0.72rem; text-transform:uppercase; letter-spacing:0.05em; }
tbody tr:last-child td { border-bottom:none; }
.mono { font-variant-numeric:tabular-nums; }
details { margin-top:10px; }
summary { cursor:pointer; color:var(--dim); font-size:0.82rem; }
footer { margin-top:50px; padding-top:18px; border-top:1px solid var(--line);
  color:var(--dim); font-size:0.82rem; }
a { color:var(--accent); }
`;

/**
 * Client script for the tab + filter navigation.
 *
 * Kept tiny and dependency-free — it only shows/hides pre-rendered cards, so the page
 * is fully usable with JS off (everything is visible, just unfiltered). Tabs pick a
 * section; the filter narrows by group label across whatever section is active.
 */
const NAV_JS = `
(function(){
  var tabs=[].slice.call(document.querySelectorAll('.tab'));
  var secs=[].slice.call(document.querySelectorAll('.sec'));
  var cards=[].slice.call(document.querySelectorAll('.card[data-label]'));
  var filter=document.getElementById('filter');
  var nomatch=document.getElementById('nomatch');
  var section='all';
  function apply(){
    var q=(filter.value||'').trim().toLowerCase();
    var shown=0;
    secs.forEach(function(sec){
      var secOn = section==='all' || sec.getAttribute('data-section')===section;
      var any=false;
      [].slice.call(sec.querySelectorAll('.card[data-label]')).forEach(function(c){
        var on = secOn && (!q || c.getAttribute('data-label').indexOf(q)>-1);
        c.hidden=!on; if(on){any=true;shown++;}
      });
      sec.hidden = !any;
    });
    nomatch.hidden = shown>0;
  }
  tabs.forEach(function(t){ t.addEventListener('click',function(){
    section=t.getAttribute('data-section');
    tabs.forEach(function(x){x.setAttribute('aria-selected', x===t?'true':'false');});
    apply(); window.scrollTo(0,0);
  });});
  filter.addEventListener('input', apply);
  apply();
})();
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head><body><div class="wrap">${body}</div><script>${NAV_JS}</script></body></html>`;
}

/** Lift with its interval. A CI spanning 1 means we can't tell it from chance. */
function liftCell(r: Ranked): string {
  const cls = !r.significant ? 'flat' : r.lift > 1 ? 'up' : 'down';
  const title = `95% CI ${r.ciLow.toFixed(2)}–${r.ciHigh.toFixed(2)} · seen ${r.inDear}/${r.inBase}`;
  return `<span class="lift ${cls}" title="${esc(title)}">${r.lift.toFixed(1)}&times;</span>`;
}

const ROWHEAD = (first: string) =>
  `<div class="rowhead"><span class="grow">${first}</span><span class="num">Share</span><span class="lift">Lift</span></div>`;

function baseRows(bases: Ranked[], statOf: (name: string) => string): string {
  if (!bases.length) return '<div class="empty">Not enough listings sampled yet.</div>';
  return (
    ROWHEAD('Base') +
    bases
      .map(
        (b) => `<div class="row">
      <span class="grow"><span class="name">${esc(b.label)}</span>
        <span class="stat">${esc(statOf(b.label))}</span></span>
      <span class="num">${pct(b.shareBase)}</span>
      ${liftCell(b)}
    </div>`,
      )
      .join('')
  );
}

/**
 * A mod row is the stat line and the tier you're aiming for.
 *
 * The mod family name ("Celestial", "of the Proficient") stays out of the display — it
 * names the mod for the game's benefit, not the crafter's. The stat line is the useful
 * sentence. Where the expensive items carry a better tier than the market at large,
 * that gap is shown ("aim P1, market runs P3") — that difference is the actual craft.
 */
function modRows(mods: RankedMod[]): string {
  if (!mods.length) return '<div class="empty">Not enough evidence yet.</div>';
  return (
    ROWHEAD('Mod &amp; tier to aim for') +
    mods
      .map((m) => {
        const aim =
          m.tierDear && m.tierMarket && m.tierDear !== m.tierMarket
            ? `<span class="tier">aim ${esc(m.tierDear)}</span> <span class="stat">market has ${esc(m.tierMarket)}</span>`
            : m.tierRange
              ? `<span class="tier">tiers ${esc(m.tierRange)}</span>`
              : '';
        return `<div class="row">
      <span class="grow"><span class="name">${esc(m.label)}</span> ${aim}${m.desecrated ? ' <span class="pill">desecrated</span>' : ''}</span>
      <span class="num">${pct(m.shareBase)}</span>
      ${liftCell(m)}
    </div>`;
      })
      .join('')
  );
}

/** Reward-property rows for a waystone: the magnitude to aim above, and the premium. */
function rewardRows(rewards: CategoryAnalysis['rewards']): string {
  if (!rewards.length) return '<div class="empty">Not enough sampled yet.</div>';
  return (
    `<div class="rowhead"><span class="grow">Property</span><span class="num">Aim &gt;</span><span class="lift">Premium</span></div>` +
    rewards
      .map((r) => {
        const gap = r.dearMedian - r.marketMedian;
        const cls = gap > 0 ? 'up' : 'flat';
        return `<div class="row" title="Expensive median ${r.dearMedian} vs market median ${r.marketMedian}">
      <span class="grow"><span class="name">${esc(r.label)}</span></span>
      <span class="num">${r.marketP75}</span>
      <span class="lift ${cls}">${gap > 0 ? '+' : ''}${gap}</span>
    </div>`;
      })
      .join('')
  );
}

function cardHead(c: CategoryAnalysis): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(c.at)) / 60_000));
  const age = mins < 90 ? `${mins}m ago` : mins < 2880 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`;
  return `<div class="cardhead">
    <h3>${esc(c.label)}</h3>
    <span class="pill" title="Rare listings of this type at the tracked item level / tier">${c.total.toLocaleString()} listed</span>
    <span class="pill" title="'Expensive' = listings at or above this price. The % is that slice of the market.">expensive ≥ ${c.dearThresholdEx ?? '?'} ex (${c.dearCount && c.total ? pct(c.dearCount / c.total) : '?'})</span>
    <span class="pill" title="Sample sizes: expensive items vs the whole market">n = ${c.nDear} vs ${c.nBase}</span>
    <span class="pill" title="When this group was last collected">${esc(age)}</span>
  </div>`;
}

function categoryCard(c: CategoryAnalysis, statOf: (name: string) => string): string {
  const anchor = c.key.replace(/[^a-z0-9]/gi, '-');
  const open = `<div class="card" id="c-${anchor}" data-label="${esc(c.label.toLowerCase())}">\n  ${cardHead(c)}`;

  // Waystones invert the model: no base variety (the tier IS the base), value comes
  // from reward magnitudes you want high and mods you want to avoid. The card is
  // "aim above these numbers · these mods ride along on premium ones · avoid these".
  if (c.kind === 'waystone') {
    // Only mods that genuinely ride on premium waystones (lift ≥ 1); the price-sinkers
    // have their own column and shouldn't double-appear here at the bottom.
    const premium = [...c.prefixes, ...c.suffixes].filter((m) => m.lift >= 1).sort((a, b) => b.lift - a.lift).slice(0, 6);
    return `${open}
  <div class="cols">
    <div class="col"><h4>Aim for (reward)</h4>${rewardRows(c.rewards)}</div>
    <div class="col"><h4>Common on premium</h4>${modRows(premium)}</div>
    <div class="col"><h4>Sinks resale — avoid</h4>${modRows(c.sinks)}</div>
  </div>
</div>`;
  }

  // A tablet unit is one base type (affixes are type-specific), so there's no base to
  // rank — just its own prefixes and suffixes.
  if (c.kind === 'tablet') {
    return `${open}
  <div class="cols cols2">
    <div class="col"><h4>Target prefixes</h4>${modRows(c.prefixes)}</div>
    <div class="col"><h4>Target suffixes</h4>${modRows(c.suffixes)}</div>
  </div>
</div>`;
  }

  return `${open}
  <div class="cols">
    <div class="col"><h4>Craft on</h4>${baseRows(c.bases, statOf)}</div>
    <div class="col"><h4>Target prefixes</h4>${modRows(c.prefixes)}</div>
    <div class="col"><h4>Target suffixes</h4>${modRows(c.suffixes)}</div>
  </div>
</div>`;
}

/** The static stat table, kept as annotation behind a fold. */
function statTable(group: string, bases: RankedBase[]): string {
  const rows = bases
    .slice(0, 5)
    .map(
      (b) => `<tr><td>${esc(b.name)}</td>
      <td class="mono">${b.family === 'weapon' ? `${b.pdpsMaxQ} pDPS` : b.family === 'armour' ? `${b.totalDefenceMaxQ} def` : b.family === 'caster' ? (b.cannotRoll.length ? `not ${esc(b.cannotRoll.join('/'))}` : 'any type') : esc(b.implicits[0] ?? '—')}</td>
      <td class="mono">${b.dropLevel}</td></tr>`,
    )
    .join('');
  return `<tr><td colspan="3"><strong>${esc(group)}</strong></td></tr>${rows}`;
}

async function main(): Promise<void> {
  const basesDoc = JSON.parse(await readFile(path.join(ROOT, 'data', 'bases.json'), 'utf8')) as BasesDoc;
  const analysisPath = path.join(ROOT, 'data', 'analysis.json');
  const analysis = existsSync(analysisPath)
    ? (JSON.parse(await readFile(analysisPath, 'utf8')) as {
        generatedAt: string;
        league: string;
        minIlvl: number | null;
        divineRate: number | null;
        categories: CategoryAnalysis[];
      })
    : null;

  // Game-file stats, keyed by base name, so a market row can carry its own annotation.
  const statByName = new Map<string, string>();
  for (const list of Object.values(basesDoc.groups)) {
    for (const b of list) {
      if (statByName.has(b.name)) continue;
      statByName.set(
        b.name,
        b.family === 'armour'
          ? `${b.totalDefenceMaxQ} def @20% · ilvl ${b.dropLevel}`
          : b.family === 'weapon'
            ? `${b.pdpsMaxQ} pDPS @20% · ilvl ${b.dropLevel}`
            : b.family === 'caster'
              ? `${b.cannotRoll.length ? `locked to ${['fire', 'cold', 'lightning', 'chaos', 'physical'].filter((t) => !b.cannotRoll.includes(t)).join('/')}` : 'rolls any spell type'} · ilvl ${b.dropLevel}`
              : `${b.implicits[0] ?? '—'}`,
      );
    }
  }
  const statOf = (name: string) => statByName.get(name) ?? '';

  const UNITS = workUnits(basesDoc.groups, basesDoc.families);
  const bySection = (s: string) => (analysis?.categories ?? []).filter((c) => c.section === s);
  const SECTIONS = ['Armour', 'Weapons', 'Caster weapons', 'Jewellery', 'Maps'] as const;

  const covered = analysis?.categories.length ?? 0;
  const pending = UNITS.length - covered;

  const body = `
<h1>What to craft in PoE2</h1>
<div class="sub">
  <span class="pill">League: ${esc(analysis?.league ?? 'Runes of Aldur')}</span>
  <span class="pill">Item level ≥ ${analysis?.minIlvl ?? '—'}</span>
  <span class="pill">1 divine ≈ ${analysis?.divineRate ? Math.round(analysis.divineRate) : '?'} ex</span>
  <span class="pill">${covered}/${UNITS.length} groups${pending ? ` · ${pending} still collecting` : ''}</span>
  <span class="pill">Updated ${esc((analysis?.generatedAt ?? basesDoc.generatedAt).slice(0, 16).replace('T', ' '))} UTC</span>
</div>

<p>For each equipment group: the bases the market actually uses, and the prefixes and
suffixes worth chasing on them. Pick a section or type to filter.</p>

<details class="note" open>
<summary style="font-weight:600;color:var(--accent)">How to read a card</summary>
<div class="legend">
  <div class="k"><b>Craft on</b><br><span>Bases ranked by <b>share</b> — how much of the
    market lists them. A base nobody lists is a base nobody buys, so this doubles as a
    liquidity check. Grey text is the base's game-file stat, for reference.</span></div>
  <div class="k"><b>Target prefixes / suffixes</b><br><span>Mods ranked by <b>lift</b>. The
    stat line is what you craft toward; the mod's internal name is omitted on purpose.</span></div>
  <div class="k"><b><span class="swatch" style="color:var(--dim)">36%</span> Share</b><br>
    <span>Fraction of listings that carry this base or mod.</span></div>
  <div class="k"><b>Lift
    <span class="swatch up">2.4×</span></b><br><span><span class="up">Green</span> = paid for:
    this much more common on expensive items than on the market, and the evidence holds up.
    <span class="down">Red</span> = actively avoided. <span class="flat">Grey</span> = can't
    tell from chance yet at this sample size — don't act on it. Hover for the interval.</span></div>
  <div class="k"><b>aim <span class="tier">P2</span> · market has <span style="color:var(--dim)">P3</span></b><br>
    <span>Expensive items carry a better tier (P2) than the market average (P3). That gap is
    the craft. <span class="tier">tiers P1-P8</span> alone means no clear tier premium.</span></div>
  <div class="k"><b>Header pills</b><br><span><b>listed</b> = rare listings at endgame item
    level · <b>expensive ≥ N ex</b> = the price cutoff for the "paid-for" comparison ·
    <b>n = A vs B</b> = sample sizes.</span></div>
  <div class="k"><b>Waystones read differently</b><br><span>They have no base variety, so instead
    of "craft on" you get <b>Aim for</b> (reward magnitudes to beat — the number is the market's
    75th percentile, the <span class="up">green</span> is how much higher expensive ones run) and
    <b>Sinks resale</b> (mods concentrated on cheap listings — the build-breakers to avoid).</span></div>
</div>
<div class="chiprow">
  Prices are Exalted Orb equivalent, converted by trade · listings collapsed to one per seller ·
  item level ≥ ${analysis?.minIlvl ?? '—'} · asks, not sales.
</div>
</details>

${
  analysis && covered
    ? `<nav class="nav" id="nav">
    <button class="tab" data-section="all" aria-selected="true">All<span class="cnt">${covered}</span></button>
    ${SECTIONS.filter((s) => bySection(s).length)
      .map(
        (s) =>
          `<button class="tab" data-section="${esc(s)}" aria-selected="false">${esc(s)}<span class="cnt">${bySection(s).length}</span></button>`,
      )
      .join('')}
    <input class="filter" id="filter" type="search" placeholder="Filter… e.g. helmet, energy shield, ring" aria-label="Filter groups">
  </nav>
  <div id="results">
  ${SECTIONS.map((s) => {
    const cats = bySection(s);
    if (!cats.length) return '';
    return `<section class="sec" data-section="${esc(s)}"><h2>${esc(s)}</h2>${cats.map((c) => categoryCard(c, statOf)).join('\n')}</section>`;
  })
    .filter(Boolean)
    .join('\n')}
  <div class="nomatch" id="nomatch" hidden>No group matches that filter.</div>
  </div>`
    : `<div class="card"><div class="empty">No market data collected yet. The rotation gathers one
       group per tick — see <code>docs/collection.md</code>. The reference tables below need no
       market data and are complete.</div></div>`
}

<h2>Reference: base stats from the game files</h2>
<p>Exact and complete — every released base, including ones nobody currently lists, so it
can't be skewed by what's for sale. This is context for the tables above, not the answer to
what to craft: every base gets used by somebody, and the market decides which are worth it.
Rune-forged bases are excluded (they're rune-forging outputs, and up to six share one name
with wildly different stats).</p>
<details><summary>Show all ${Object.values(basesDoc.groups).reduce((n, g) => n + g.length, 0)} bases across ${Object.keys(basesDoc.groups).length} groups</summary>
<div class="card scroll"><table>
  <thead><tr><th>Base</th><th>Stat</th><th>ilvl</th></tr></thead>
  <tbody>${Object.keys(basesDoc.groups).sort().map((g) => statTable(g, basesDoc.groups[g]!)).join('')}</tbody>
</table></div>
</details>

<footer>
Base data from <a href="https://repoe-fork.github.io/poe2/">RePoE (PoE2)</a>. Market data from
the public <code>pathofexile.com/api/trade2</code> endpoints, collected on a slow rotation
within the published rate limits. Listing prices are asks, not sales — no PoE2 API exposes
completed trades, so treat every number as an upper-bound opinion.
Not affiliated with Grinding Gear Games.
</footer>`;

  await mkdir(DIST, { recursive: true });
  await writeFile(path.join(DIST, 'index.html'), page('What to craft in PoE2', body));
  await writeFile(path.join(DIST, '.nojekyll'), '');
  console.log(`Wrote dist/index.html — ${covered}/${UNITS.length} groups with market data`);
}

await main();
