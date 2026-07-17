/**
 * Renders the static site into dist/ for GitHub Pages.
 *
 * Deliberately dependency-free and framework-free: the output is a handful of HTML
 * files with inline CSS, which is all Pages needs and keeps the build reproducible
 * years from now.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { BasesDoc, RankedBase } from './bases.ts';
import type { BaseAnalysis } from './analyze.ts';
import type { Family } from '../lib/types.ts';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');

/** Bases shown per group. The full ranking lives in data/bases.json. */
const TOP_N = Number(process.env.POE2_TOP_N ?? 8);

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const num = (x: number | null, digits = 0): string =>
  x === null || !Number.isFinite(x) ? '—' : x < 10 && digits === 0 ? x.toFixed(1) : x.toFixed(digits);

const CSS = `
:root {
  --bg: #0f1115; --panel: #171a21; --line: #262b36; --text: #e6e9ef;
  --dim: #99a1b3; --accent: #d8b26a; --good: #6ec28a; --bad: #d97a7a;
  color-scheme: dark;
}
@media (prefers-color-scheme: light) {
  :root { --bg:#faf9f7; --panel:#fff; --line:#e3e0d9; --text:#1b1d22; --dim:#6b7280; --accent:#9a6f16; --good:#2f7d4f; --bad:#a33; color-scheme: light; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text);
  font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
.wrap { max-width: 1080px; margin: 0 auto; padding: 32px 20px 80px; }
h1 { font-size: 1.7rem; margin:0 0 4px; letter-spacing:-0.02em; }
h2 { font-size:1.15rem; margin:38px 0 6px; letter-spacing:-0.01em; }
h3 { font-size:0.95rem; margin:22px 0 6px; color:var(--accent); font-weight:600; }
p  { color:var(--dim); margin:6px 0 14px; max-width: 72ch; }
code { background:var(--panel); padding:1px 5px; border-radius:4px; font-size:0.86em; }
.sub { color:var(--dim); font-size:0.9rem; margin-bottom:22px; }
.panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:2px 14px 12px; margin-bottom:14px; }
.scroll { overflow-x:auto; }
table { border-collapse:collapse; width:100%; font-size:0.88rem; }
th, td { text-align:right; padding:7px 9px; border-bottom:1px solid var(--line); white-space:nowrap; }
th:first-child, td:first-child { text-align:left; }
th { color:var(--dim); font-weight:600; font-size:0.76rem; text-transform:uppercase; letter-spacing:0.05em; }
tbody tr:last-child td { border-bottom:none; }
tbody tr:hover { background:rgba(127,127,127,0.06); }
.best td { color:var(--accent); font-weight:600; }
.mono { font-variant-numeric: tabular-nums; }
.lift-hi { color:var(--good); font-weight:600; }
.lift-bad { color:var(--bad); font-weight:600; }
.lift-lo { color:var(--dim); }
.dimcell { color:var(--dim); font-size:0.82rem; }
.tier { color:var(--accent); font-weight:600; font-size:0.8rem; }
.note { border-left:3px solid var(--accent); padding:10px 14px; background:var(--panel);
  border-radius:0 8px 8px 0; margin:16px 0; }
.note strong { color:var(--accent); }
.pill { display:inline-block; background:var(--panel); border:1px solid var(--line);
  border-radius:999px; padding:2px 10px; font-size:0.76rem; color:var(--dim); margin-right:6px; }
footer { margin-top:50px; padding-top:18px; border-top:1px solid var(--line); color:var(--dim); font-size:0.82rem; }
a { color:var(--accent); }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head><body><div class="wrap">${body}</div></body></html>`;
}

/** Requirement string like "115 int" or "82 str / 60 dex". */
function reqOf(b: RankedBase): string {
  const parts: string[] = [];
  if (b.req.str) parts.push(`${b.req.str} str`);
  if (b.req.dex) parts.push(`${b.req.dex} dex`);
  if (b.req.int) parts.push(`${b.req.int} int`);
  return parts.join(' / ') || '—';
}

/**
 * Renders a group with the columns its family actually has.
 *
 * Each family gets different headers because "best" is a different question for each.
 * A shared table would force a lowest common denominator and quietly imply that, say,
 * a ring can be ranked the way a helmet can.
 */
function basesTable(group: string, family: Family, bases: RankedBase[], limit: number): string {
  const shown = bases.slice(0, limit);
  const rowsOf = (cells: (b: RankedBase) => string) =>
    shown.map((b, i) => `<tr${i === 0 && b.rank !== null ? ' class="best"' : ''}>${cells(b)}</tr>`).join('\n');

  if (family === 'armour') {
    const arch = group.split(' / ')[1] ?? '';
    const cols = [
      ['ar', 'Armour', (b: RankedBase) => `${b.armour} / ${b.armourMaxQ}`],
      ['ev', 'Evasion', (b: RankedBase) => `${b.evasion} / ${b.evasionMaxQ}`],
      ['es', 'Energy shield', (b: RankedBase) => `${b.energyShield} / ${b.energyShieldMaxQ}`],
    ].filter(([k]) => arch.includes(k as string)) as [string, string, (b: RankedBase) => string][];

    return `<div class="panel scroll"><table>
      <thead><tr><th>#</th><th>Base</th>${cols.map(([, h]) => `<th>${h} (base / @20%)</th>`).join('')}${cols.length > 1 ? '<th>Total @20%</th>' : ''}<th>Drop lvl</th><th>Requires</th></tr></thead>
      <tbody>${rowsOf(
        (b) =>
          `<td class="mono dimcell">${b.rank}</td><td>${esc(b.name)}</td>` +
          cols.map(([, , f]) => `<td class="mono">${f(b)}</td>`).join('') +
          (cols.length > 1 ? `<td class="mono">${b.totalDefenceMaxQ}</td>` : '') +
          `<td class="mono">${b.dropLevel}</td><td class="dimcell">${reqOf(b)}</td>`,
      )}</tbody></table></div>`;
  }

  if (family === 'weapon') {
    return `<div class="panel scroll"><table>
      <thead><tr><th>#</th><th>Base</th><th>Phys damage</th><th>Atk/sec</th><th>Crit</th><th>pDPS</th><th>pDPS @20%</th><th>Drop lvl</th><th>Requires</th></tr></thead>
      <tbody>${rowsOf(
        (b) =>
          `<td class="mono dimcell">${b.rank}</td><td>${esc(b.name)}</td>
           <td class="mono">${b.physMin}–${b.physMax}</td>
           <td class="mono">${b.aps.toFixed(2)}</td>
           <td class="mono">${b.crit.toFixed(2)}%</td>
           <td class="mono">${Math.round(b.pdps)}</td>
           <td class="mono">${b.pdpsMaxQ}</td>
           <td class="mono">${b.dropLevel}</td><td class="dimcell">${reqOf(b)}</td>`,
      )}</tbody></table></div>`;
  }

  if (family === 'caster') {
    return `<div class="panel scroll"><table>
      <thead><tr><th>#</th><th>Base</th><th>Grants skill</th><th>Can roll spell mods</th><th>Drop lvl</th><th>Requires</th></tr></thead>
      <tbody>${rowsOf((b) => {
        const free = b.cannotRoll.length === 0;
        const cell = free
          ? '<span class="lift-hi">any type</span>'
          : `<span class="lift-lo">not ${esc(b.cannotRoll.join(', '))}</span>`;
        return `<td class="mono dimcell">${b.rank}</td><td>${esc(b.name)}</td>
          <td class="dimcell">${b.skills.length ? esc(b.skills.join(' / ')) : '—'}</td>
          <td>${cell}</td>
          <td class="mono">${b.dropLevel}</td><td class="dimcell">${reqOf(b)}</td>`;
      })}</tbody></table></div>`;
  }

  // implicit
  return `<div class="panel scroll"><table>
    <thead><tr><th>Base</th><th>Implicit</th><th>Drop lvl</th><th>Requires</th></tr></thead>
    <tbody>${rowsOf(
      (b) =>
        `<td>${esc(b.name)}</td>
         <td>${b.implicits.length ? b.implicits.map((i) => esc(i)).join('<br>') : '—'}</td>
         <td class="mono">${b.dropLevel}</td><td class="dimcell">${reqOf(b)}</td>`,
    )}</tbody></table></div>`;
}

/** Share of the rare market at or above a given exalted threshold. */
function ladderCell(b: BaseAnalysis, minEx: number): string {
  const total = b.rareTotal ?? 0;
  const rung = b.rareLadder.find((r) => r.minEx === minEx);
  if (!total || !rung) return '—';
  return `${((rung.count / total) * 100).toFixed(0)}%`;
}

/** Bases refresh on a rotation, so each row states its own age. */
function ageOf(at: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60_000));
  if (mins < 90) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  return hrs < 48 ? `${hrs}h` : `${Math.round(hrs / 24)}d`;
}

function marketTable(bases: BaseAnalysis[]): string {
  const rows = bases
    .map(
      (b) => `<tr>
      <td>${esc(b.base)} <span class="dimcell">${esc(ageOf(b.at))} ago</span></td>
      <td class="mono">${num(b.magicFloorEx)}</td>
      <td class="mono">${b.magicTotal ?? '—'}</td>
      <td class="mono">${b.rareTotal ?? '—'}</td>
      <td class="mono">${ladderCell(b, 200)}</td>
      <td class="mono">${ladderCell(b, 1000)}</td>
      <td class="mono">${b.delistRate === null ? '—' : (b.delistRate * 100).toFixed(0) + '%'}</td>
      <td class="mono">${trendCell(b.trendPct)}</td>
    </tr>`,
    )
    .join('\n');
  return `<div class="panel scroll"><table>
    <thead><tr>
      <th>Base</th><th>Blank base (ex)</th><th>Magic listed</th><th>Rare listed</th>
      <th>Rares ≥200ex</th><th>Rares ≥1000ex</th><th>Blank turnover</th><th>Base cost trend</th>
    </tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** Trends need history; say so plainly rather than rendering a misleading 0%. */
function trendCell(pct: number | null): string {
  if (pct === null) return '<span class="lift-lo">building…</span>';
  const cls = pct > 0 ? 'lift-hi' : pct < 0 ? 'lift-lo' : '';
  return `<span class="${cls}">${pct > 0 ? '+' : ''}${pct.toFixed(0)}%</span>`;
}

function modsSection(b: BaseAnalysis): string {
  const head = `<h3>${esc(b.base)}
    <span class="pill">top ≥${b.topThresholdEx ?? '?'}ex</span>
    <span class="pill">n = ${b.nTop} vs ${b.nBase}</span>
    <span class="pill">${b.snapshots} snapshot(s)</span></h3>`;

  if (!b.topMods.length) {
    return `${head}<p>No mod has been seen enough times in both strata to compare yet. This fills in as snapshots accumulate.</p>`;
  }

  const rows = b.topMods
    .slice(0, 20)
    .map((m) => {
      const cls = m.significant ? (m.lift > 1 ? 'lift-hi' : 'lift-bad') : 'lift-lo';
      const mark = m.significant ? '' : ' <span class="pill">noise</span>';
      return `<tr>
      <td>${esc(m.name)} <span class="tier">${esc(m.tier)}</span>${m.desecrated ? ' <span class="pill">desecrated</span>' : ''}${mark}</td>
      <td>${esc(m.label)}</td>
      <td class="mono ${cls}">${m.lift.toFixed(2)}&times;</td>
      <td class="mono dimcell">${m.ciLow.toFixed(2)}–${m.ciHigh.toFixed(2)}</td>
      <td class="mono">${(m.shareTop * 100).toFixed(0)}% / ${(m.shareBase * 100).toFixed(0)}%</td>
      <td class="mono">${m.inTop}/${m.inBase}</td>
    </tr>`;
    })
    .join('\n');

  return `${head}
  <div class="panel scroll"><table>
    <thead><tr>
      <th>Mod</th><th>Grants</th><th>Lift</th><th>95% CI</th><th>Top / market</th><th>Sightings</th>
    </tr></thead>
    <tbody>${rows}</tbody></table></div>`;
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
        bases: BaseAnalysis[];
      })
    : null;

  const groups = basesDoc.groups;
  const families = basesDoc.families;
  const total = Object.values(groups).reduce((n, g) => n + g.length, 0);
  const inFamily = (f: Family) => Object.keys(groups).filter((g) => families[g] === f).sort();

  const FAMILY_BLURB: Record<Family, string> = {
    armour: `Ranked by defence at 20% quality, <strong>within an archetype</strong>. A pure-energy-shield
      helmet and an armour/evasion hybrid aren't competing for the same build, so ranking them against
      each other would be meaningless.`,
    weapon: `Ranked by physical DPS — mean hit &times; attacks per second — at 20% quality. Crit and
      attack rate are shown because the highest pDPS base is often not the one you want.`,
    caster: `Wands, sceptres and staves have <strong>no defence, damage or implicit at all</strong>. What
      separates them is the skill they grant and, for crafting, which spell mod families they're barred
      from rolling. A base that can roll <em>any</em> type is the general crafting target; a restricted
      one is locked to its element. That's the ranking here.`,
    implicit: `Rings, amulets, belts and quivers have no base stats. The base <em>is</em> its implicit,
      so there is no "best" — only which implicit you want. Listed by item level, not ranked.`,
  };

  const section = (f: Family, title: string, note?: string) => `
<h2>${title}</h2>
<p>${FAMILY_BLURB[f]}</p>
${note ?? ''}
${inFamily(f)
  .map(
    (g) => `<h3>${esc(g)} <span class="pill">${groups[g]!.length} bases</span></h3>
${basesTable(g, f, groups[g]!, TOP_N)}`,
  )
  .join('\n')}`;

  const body = `
<h1>PoE2 Base &amp; Mod Trends</h1>
<div class="sub">
  <span class="pill">League: ${esc(analysis?.league ?? 'Runes of Aldur')}</span>
  <span class="pill">Item level ≥ ${analysis?.minIlvl ?? '—'}</span>
  <span class="pill">1 divine ≈ ${analysis?.divineRate ? Math.round(analysis.divineRate) : '?'} ex</span>
  <span class="pill">Updated ${esc((analysis?.generatedAt ?? basesDoc.generatedAt).slice(0, 16).replace('T', ' '))} UTC</span>
</div>

<h2>Best base, every category</h2>
<p>Straight from the game's own item table — ${total} bases across ${Object.keys(groups).length} groups.
This covers every released base, including ones nobody currently has listed, so it can't be skewed by
what happens to be for sale. It's exact, and it doesn't change during a league. Top ${TOP_N} shown per
group.</p>
<div class="note">
<strong>"Best" isn't one question.</strong> Armour is decided by defence, weapons by DPS, caster weapons
by which spell mods they can roll, and jewellery not at all — the base <em>is</em> its implicit. Each
table below uses the metric that actually applies to it.
</div>
<div class="note">
<strong>Rune-forged bases are excluded.</strong> They're outputs of rune-forging rather than bases you can
buy and craft on, and up to six of them share one display name with wildly different stats — "Runemastered
Torment Club" covers rolls from 44–73 (identical to the plain base) up to 85–403 physical damage. Ranking
them would mean reporting the luckiest variant as if it were the base, on a name trade can't even search
for. They're 44% of the game data, so including them would put a fiction at the top of every table.
</div>

${section('armour', 'Armour')}
${section('weapon', 'Weapons')}
${section('caster', 'Caster weapons')}
${section('implicit', 'Jewellery &amp; quivers')}

<h2>What they cost, and what they sell for</h2>
<p><em>Blank base</em> is the going rate for an uncrafted magic base. The
<em>≥200ex</em> and <em>≥1000ex</em> columns are the share of the rare market at
those prices — these are exact counts across every listing, not estimates from a
sample, so they say directly how often crafting this base pays off.</p>
<p>All prices are Exalted Orb equivalent, converted by trade itself. Listings are
collapsed to one per seller, so a single person dumping forty items can't tilt the
numbers.</p>
<p>Bases are refreshed <strong>one at a time, on a rotation</strong> — trade's rate
limits are shared with real players, so this collects a trickle rather than a burst.
Each row shows how long ago that base was last read; they are not all from the same
moment.</p>
${analysis ? marketTable(analysis.bases) : '<p>No market snapshot yet. Run <code>npm run collect</code>.</p>'}

<h2>Which mods are actually paid for</h2>
<div class="note">
<p><strong>Lift</strong> compares how often a mod appears on the dearest slice of the
market against how often it appears on the market overall. <strong>2.0×</strong> means
twice as common on expensive items — someone is paying for it. <strong>1.0×</strong>
means it's along for the ride.</p>
<p>The <strong>95% CI</strong> is the range the true lift plausibly sits in. If it
spans 1.0 the mod is marked <span class="pill">noise</span>: the apparent effect can't
be told apart from chance at this sample size. Trust the interval, not the point.</p>
<p>Mods are identified by <strong>family and tier</strong> — "Unassailable P1", not
"increased Energy Shield". This matters: several unrelated mod families grant the same
stat with their own separate tier ladders, so a stat-level reading blends mods that
have nothing to do with each other.</p>
</div>
${analysis ? analysis.bases.map((b) => modsSection(b)).join('\n') : ''}

<footer>
Base data from <a href="https://repoe-fork.github.io/poe2/">RePoE (PoE2)</a>.
Prices from the public <code>pathofexile.com/api/trade2</code> endpoints, collected within
the published rate limits. Listing prices are asks, not sales — treat them accordingly.
Not affiliated with Grinding Gear Games.
</footer>`;

  await mkdir(DIST, { recursive: true });
  await writeFile(path.join(DIST, 'index.html'), page('PoE2 Base & Mod Trends', body));
  // Tell Pages not to run Jekyll over our output.
  await writeFile(path.join(DIST, '.nojekyll'), '');
  console.log(
    `Wrote dist/index.html — ${total} bases in ${Object.keys(groups).length} groups, ${analysis?.bases.length ?? 0} priced`,
  );
}

await main();
