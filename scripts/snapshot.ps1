<#
.SYNOPSIS
  Collects the next base in the queue, re-analyses, renders, and commits.

.DESCRIPTION
  One tick of the rotation. Collects exactly ONE base — about a dozen searches, ~4
  minutes — then stops. This script has no opinion about how often it runs; that
  belongs to the scheduler (see register-task.ps1) and is a knob, not a constant.

  The reason for a rotation rather than a batch is not politeness in the abstract:
  trade's rate limits are per-IP, and that IP is the same one you browse trade from.
  The site rate-limits ordinary players on its own, so a collector that drains the
  budget in a burst is competing with you at the keyboard.

  A rate-limit abort is not a failure — the base stays queued and the next tick picks
  it up.

  Only aggregates are committed. Raw listings stay in cache/ (gitignored): they are
  megabytes per snapshot, and every run would bloat the repo for data already reduced
  to what the site reads.

.PARAMETER Push
  Push after committing. Without it the run stays local, which is the right default
  for a first manual run.

.PARAMETER Bases
  Bases to collect this run. Leave at 1 unless backfilling on a known-idle IP.

.EXAMPLE
  .\scripts\snapshot.ps1
  .\scripts\snapshot.ps1 -Push
#>
[CmdletBinding()]
param(
  [switch]$Push,
  [int]$Bases = 1,
  [string]$League = $env:POE2_LEAGUE,
  [int]$MinIlvl = 0
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

if ($League) { $env:POE2_LEAGUE = $League }
if ($MinIlvl -gt 0) { $env:POE2_MIN_ILVL = $MinIlvl }
$env:POE2_BATCH = $Bases

Write-Host "[snapshot] collecting (batch=$Bases)..." -ForegroundColor Cyan
npm run collect
if ($LASTEXITCODE -ne 0) { throw "collect failed with exit code $LASTEXITCODE" }

# collect exits 0 on a rate-limit abort and writes nothing. Analysing anyway is
# harmless (unchanged snapshots are skipped) and keeps the site current.
Write-Host "[snapshot] analysing..." -ForegroundColor Cyan
npm run analyze
if ($LASTEXITCODE -ne 0) { throw "analyze failed with exit code $LASTEXITCODE" }

Write-Host "[snapshot] rendering..." -ForegroundColor Cyan
npm run site
if ($LASTEXITCODE -ne 0) { throw "site failed with exit code $LASTEXITCODE" }

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
