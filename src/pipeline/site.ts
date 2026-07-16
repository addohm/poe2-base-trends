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
import type { RankedBase } from './bases.ts';
import type { BaseAnalysis } from './analyze.ts';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');

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
.lift-lo { color:var(--dim); }
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

function basesTable(bases: RankedBase[]): string {
  const rows = bases
    .map((b, i) => {
      const cls = i === 0 ? ' class="best"' : '';
      return `<tr${cls}>
      <td>${esc(b.name)}</td>
      <td class="mono">${b.energyShield}</td>
      <td class="mono">${b.energyShieldMaxQ}</td>
      <td class="mono">${b.dropLevel}</td>
      <td class="mono">${b.req.int || '—'}</td>
    </tr>`;
    })
    .join('\n');
  return `<div class="panel scroll"><table>
    <thead><tr><th>Base</th><th>ES</th><th>ES @20%</th><th>Drop lvl</th><th>Int req</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function marketTable(bases: BaseAnalysis[], name: (slug: string) => string): string {
  const rows = bases
    .map(
      (b) => `<tr>
      <td>${esc(name(b.base))}</td>
      <td class="mono">${num(b.magicFloorEx)}</td>
      <td class="mono">${b.magicListings ?? '—'}</td>
      <td class="mono">${num(b.rareFloorEx)}</td>
      <td class="mono">${num(b.rareMedianEx)}</td>
      <td class="mono">${b.rareListings ?? '—'}</td>
      <td class="mono">${b.delistRate === null ? '—' : (b.delistRate * 100).toFixed(0) + '%'}</td>
      <td class="mono">${trendCell(b.trendPct)}</td>
    </tr>`,
    )
    .join('\n');
  return `<div class="panel scroll"><table>
    <thead><tr>
      <th>Base</th><th>Magic p10 (ex)</th><th>Magic listed</th>
      <th>Rare p10 (ex)</th><th>Rare median (ex)</th><th>Rare listed</th><th>Delisted/run</th><th>Trend</th>
    </tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** Trends need history; say so plainly rather than rendering a misleading 0%. */
function trendCell(pct: number | null): string {
  if (pct === null) return '<span class="lift-lo">building…</span>';
  const cls = pct > 0 ? 'lift-hi' : pct < 0 ? 'lift-lo' : '';
  return `<span class="${cls}">${pct > 0 ? '+' : ''}${pct.toFixed(0)}%</span>`;
}

function modsSection(b: BaseAnalysis, name: (slug: string) => string): string {
  if (!b.topMods.length) {
    return `<h3>${esc(name(b.base))}</h3><p>Not enough evidence to rank mods yet — pooled sample ${b.sampleSize} across ${b.snapshots} snapshot(s). A mod must be seen 25+ times before it's ranked, so this fills in as snapshots accumulate.</p>`;
  }
  const rows = b.topMods
    .slice(0, 12)
    .map((m) => {
      const cls = m.lift >= 1.5 ? 'lift-hi' : m.lift < 1 ? 'lift-lo' : '';
      return `<tr>
      <td>${esc(m.label)}</td>
      <td class="mono ${cls}">${m.lift.toFixed(2)}&times;</td>
      <td class="mono">${(m.share * 100).toFixed(0)}%</td>
      <td class="mono">${m.inTop}/${m.inAll}</td>
    </tr>`;
    })
    .join('\n');
  return `<h3>${esc(name(b.base))} <span class="pill">pooled sample ${b.sampleSize}</span> <span class="pill">${b.snapshots} snapshot(s)</span></h3>
  <div class="panel scroll"><table>
    <thead><tr><th>Mod (tier)</th><th>Lift</th><th>Market share</th><th>Top/All</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

async function main(): Promise<void> {
  const basesDoc = JSON.parse(await readFile(path.join(ROOT, 'data', 'bases.json'), 'utf8')) as {
    generatedAt: string;
    classes: Record<string, RankedBase[]>;
  };
  const analysisPath = path.join(ROOT, 'data', 'analysis.json');
  const analysis = existsSync(analysisPath)
    ? (JSON.parse(await readFile(analysisPath, 'utf8')) as {
        generatedAt: string;
        league: string;
        divineRate: number | null;
        bases: BaseAnalysis[];
      })
    : null;

  const esHelms = (basesDoc.classes['Helmet'] ?? [])
    .filter((b) => b.archetype === 'es')
    .sort((a, b) => b.energyShieldMaxQ - a.energyShieldMaxQ)
    .slice(0, 10);

  // Query keys carry a slug ("AncestralTiara"); restore the real name for display.
  const slugToName = new Map(
    Object.values(basesDoc.classes)
      .flat()
      .map((b) => [b.name.replace(/[^A-Za-z0-9]/g, ''), b.name] as const),
  );
  const name = (slug: string) => slugToName.get(slug) ?? slug;

  const body = `
<h1>PoE2 Base &amp; Mod Trends</h1>
<div class="sub">
  <span class="pill">League: ${esc(analysis?.league ?? 'Runes of Aldur')}</span>
  <span class="pill">1 divine ≈ ${analysis?.divineRate ? Math.round(analysis.divineRate) : '?'} ex</span>
  <span class="pill">Updated ${esc((analysis?.generatedAt ?? basesDoc.generatedAt).slice(0, 16).replace('T', ' '))} UTC</span>
</div>

<h2>Best energy shield helmet bases</h2>
<p>From the game's own base-item table, so this covers every released base — including
ones nobody currently has listed. It is exact, and it does not change during a league.</p>
${basesTable(esHelms)}

<h2>What they cost</h2>
<p>Prices are the 10th percentile of the cheapest asks, normalised to exalted using
GGG's own currency exchange. We never read the top of the price distribution: that
is where manipulation lives, so the mirror-priced troll listings simply never enter
the calculation.</p>
<p><em>Delisted/run</em> is the share of previously-seen listings that are gone —
the closest available proxy for something selling, since no PoE2 API exposes
completed sales. It only counts listings priced below the current window's ceiling,
which are the ones that <em>had</em> to still be visible if they hadn't been taken;
ambiguous ones are excluded rather than guessed at.</p>
${analysis ? marketTable(analysis.bases, name) : '<p>No market snapshot yet. Run <code>npm run collect</code>.</p>'}

<h2>Which mods are actually paid for</h2>
<div class="note">
<strong>Lift</strong> compares how often a mod appears on the most expensive quartile
against how often it appears on the market as a whole. <strong>2.0×</strong> means a mod
is twice as common on expensive items as on average — someone is paying for it.
<strong>1.0×</strong> means it's along for the ride. Sorting items by energy shield and
reading off their mods can't tell you this: that method selects for ES mods by
construction, so it finds them no matter what the market thinks. These samples are
drawn by <em>recency</em> instead, which is uncorrelated with price.
</div>
${analysis ? analysis.bases.map((b) => modsSection(b, name)).join('\n') : ''}

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
  console.log(`Wrote dist/index.html (${esHelms.length} bases, ${analysis?.bases.length ?? 0} priced)`);
}

await main();
