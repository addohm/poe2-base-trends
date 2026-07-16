<#
.SYNOPSIS
  Takes one trade snapshot, re-analyses, and commits the aggregates.

.DESCRIPTION
  Intended to run from Windows Task Scheduler a few times a day. Pushing is what
  triggers the Pages deploy, so a successful run updates the public site.

  Only aggregates are committed. Raw listings stay in cache/ (gitignored): a full
  snapshot of raw listings is megabytes, and committing it every few hours would
  bloat the repo into the hundreds of megabytes within a league for data we have
  already reduced to what the site actually reads.

.PARAMETER Push
  Push to origin after committing. Without this the run stays local, which is the
  safe default for a first manual run.

.EXAMPLE
  .\scripts\snapshot.ps1
  .\scripts\snapshot.ps1 -Push
#>
[CmdletBinding()]
param(
  [switch]$Push,
  [string]$League = $env:POE2_LEAGUE
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

if ($League) { $env:POE2_LEAGUE = $League }

Write-Host "[snapshot] collecting..." -ForegroundColor Cyan
npm run collect
if ($LASTEXITCODE -ne 0) { throw "collect failed with exit code $LASTEXITCODE" }

Write-Host "[snapshot] analysing..." -ForegroundColor Cyan
npm run analyze
if ($LASTEXITCODE -ne 0) { throw "analyze failed with exit code $LASTEXITCODE" }

Write-Host "[snapshot] rendering..." -ForegroundColor Cyan
npm run site
if ($LASTEXITCODE -ne 0) { throw "site failed with exit code $LASTEXITCODE" }

# Only data/ is versioned; dist/ is rebuilt by CI and cache/ is disposable.
git add data
$staged = git diff --cached --name-only
if (-not $staged) {
  Write-Host "[snapshot] no data changes; nothing to commit." -ForegroundColor Yellow
  exit 0
}

$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm')
git commit -m "data: snapshot $stamp UTC"
if ($LASTEXITCODE -ne 0) { throw "commit failed with exit code $LASTEXITCODE" }

if ($Push) {
  Write-Host "[snapshot] pushing..." -ForegroundColor Cyan
  git push
  if ($LASTEXITCODE -ne 0) { throw "push failed with exit code $LASTEXITCODE" }
  Write-Host "[snapshot] done; Pages will redeploy." -ForegroundColor Green
} else {
  Write-Host "[snapshot] committed locally. Re-run with -Push to publish." -ForegroundColor Green
}
