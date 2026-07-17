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
  padding:14px 16px; margin-bottom:14px; }
.cardhead { display:flex; flex-wrap:wrap; align-items:baseline; gap:8px;
  border-bottom:1px solid var(--line); padding-bottom:10px; margin-bottom:12px; }
.cardhead h3 { margin:0; }
.cols { display:grid; grid-template-columns:1fr 1fr 1fr; gap:18px; }
@media (max-width:860px) { .cols { grid-template-columns:1fr; } }
.col h4 { margin:0 0 8px; font-size:0.74rem; text-transform:uppercase;
  letter-spacing:0.06em; color:var(--dim); font-weight:600; }
.row { display:flex; align-items:baseline; gap:8px; padding:4px 0;
  border-bottom:1px solid var(--line); font-size:0.88rem; }
.row:last-child { border-bottom:none; }
.row .grow { flex:1; min-width:0; }
.row .num { font-variant-numeric:tabular-nums; color:var(--dim); font-size:0.8rem; white-space:nowrap; }
.name { font-weight:600; }
.tier { color:var(--accent); font-weight:600; font-size:0.78rem; }
.stat { color:var(--dim); font-size:0.8rem; display:block; }
.lift { font-variant-numeric:tabular-nums; font-weight:600; white-space:nowrap; }
.up { color:var(--good); } .down { color:var(--bad); } .flat { color:var(--dim); font-weight:400; }
.note { border-left:3px solid var(--accent); padding:10px 14px; background:var(--panel);
  border-radius:0 8px 8px 0; margin:16px 0; }
.note strong { color:var(--accent); }
.empty { color:var(--dim); font-size:0.85rem; padding:6px 0; }
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

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head><body><div class="wrap">${body}</div></body></html>`;
}

/** Lift with its interval. A CI spanning 1 means we can't tell it from chance. */
function liftCell(r: Ranked): string {
  const cls = !r.significant ? 'flat' : r.lift > 1 ? 'up' : 'down';
  const title = `95% CI ${r.ciLow.toFixed(2)}–${r.ciHigh.toFixed(2)} · seen ${r.inDear}/${r.inBase}`;
  return `<span class="lift ${cls}" title="${esc(title)}">${r.lift.toFixed(1)}&times;</span>`;
}

function baseRows(bases: Ranked[], statOf: (name: string) => string): string {
  if (!bases.length) return '<div class="empty">Not enough listings sampled yet.</div>';
  return bases
    .map(
      (b) => `<div class="row">
      <span class="grow"><span class="name">${esc(b.label)}</span>
        <span class="stat">${esc(statOf(b.label))}</span></span>
      <span class="num">${pct(b.shareBase)} of market</span>
      ${liftCell(b)}
    </div>`,
    )
    .join('');
}

/**
 * A mod row is the stat line and its tier — what you actually craft toward.
 *
 * The mod family name ("Celestial", "of the Proficient") stays out of the display: it
 * names the mod for the game's benefit, not the crafter's, and "#% increased Energy
 * Shield P1" is the useful sentence. The name is kept on the tooltip because it's what
 * makes the identity unambiguous underneath — several families grant the same stat.
 */
function modRows(mods: RankedMod[]): string {
  if (!mods.length) return '<div class="empty">Not enough evidence yet.</div>';
  return mods
    .map(
      (m) => `<div class="row">
      <span class="grow" title="${esc(m.name)}"><span class="name">${esc(m.label)}</span>
        <span class="tier">${esc(m.tier)}</span>${m.desecrated ? ' <span class="pill">desecrated</span>' : ''}</span>
      <span class="num">${pct(m.shareBase)}</span>
      ${liftCell(m)}
    </div>`,
    )
    .join('');
}

function categoryCard(c: CategoryAnalysis, statOf: (name: string) => string): string {
  const age = (() => {
    const mins = Math.max(0, Math.round((Date.now() - Date.parse(c.at)) / 60_000));
    if (mins < 90) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    return hrs < 48 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
  })();

  return `<div class="card">
  <div class="cardhead">
    <h3>${esc(c.label)}</h3>
    <span class="pill">${c.total.toLocaleString()} listed</span>
    <span class="pill">dear = ≥${c.dearThresholdEx ?? '?'} ex (${c.dearCount && c.total ? pct(c.dearCount / c.total) : '?'})</span>
    <span class="pill">n = ${c.nDear} vs ${c.nBase}</span>
    <span class="pill">${esc(age)}</span>
  </div>
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
  const SECTIONS = ['Armour', 'Weapons', 'Caster weapons', 'Jewellery'] as const;

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

<p>For each equipment category: the bases the market actually uses, and the prefixes and
suffixes worth chasing on them.</p>

<div class="note">
<p><strong>Share</strong> is how much of the market a base or mod is — popularity, and a
liquidity check: a base nobody lists is a base nobody buys.</p>
<p><strong>Lift</strong> is how much more often it appears on the dearest quarter of
listings than on the market overall. <strong>2.0×</strong> means twice as common on
expensive items — someone is paying for it. <strong>1.0×</strong> means it's along for
the ride. Greyed-out means the 95% confidence interval spans 1.0: at this sample size we
can't tell it from chance, so don't act on it. Hover any lift for the interval and counts.</p>
<p>Bases are ordered by share (what people use), mods by lift (what earns the premium).
Prices are Exalted Orb equivalent, converted by trade; listings are collapsed to one per
seller so a single dumper can't tilt the numbers.</p>
</div>

${
  analysis && covered
    ? SECTIONS.map((s) => {
        const cats = bySection(s);
        if (!cats.length) return '';
        return `<h2>${esc(s)}</h2>${cats.map((c) => categoryCard(c, statOf)).join('\n')}`;
      })
        .filter(Boolean)
        .join('\n')
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
