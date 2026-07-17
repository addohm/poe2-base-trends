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

<#
  Runs a native command and judges it by its EXIT CODE, which is the only thing that
  actually reports success.

  Windows PowerShell 5.1 otherwise turns any stderr output from a native executable
  into a NativeCommandError, and under $ErrorActionPreference='Stop' that terminates
  the script. Node writes console.warn to stderr, so a healthy, expected message like
  "[ratelimit] backing off for 600s" would fail the whole tick and light the task red
  — for the collector doing precisely what it is designed to do.
#>
function Invoke-Step {
  param([string]$Label, [scriptblock]$Command)
  Write-Host "[snapshot] $Label..." -ForegroundColor Cyan
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Command 2>&1 | ForEach-Object { Write-Host $_ }
  } finally {
    $ErrorActionPreference = $prev
  }
  if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE" }
}

# A rate-limited collect exits 0 having written nothing; analyse and render still run
# so the site stays current, and both no-op cleanly when there's nothing new.
Invoke-Step 'collecting' { npm run collect }
Invoke-Step 'analysing'  { npm run analyze }
Invoke-Step 'rendering'  { npm run site }

# git writes progress to stderr routinely, so it gets the same treatment.
Invoke-Step 'staging' { git add data }

$ErrorActionPreference = 'Continue'
$staged = git diff --cached --name-only
$ErrorActionPreference = 'Stop'

if (-not $staged) {
  # The normal outcome for a tick held off by a rate limit, or one whose base hasn't
  # moved. Not a failure.
  Write-Host "[snapshot] no data changes; nothing to commit." -ForegroundColor Yellow
  exit 0
}

$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm')
Invoke-Step 'committing' { git commit -m "data: snapshot $stamp UTC" }

if ($Push) {
  Invoke-Step 'pushing' { git push }
  Write-Host "[snapshot] done; Pages will redeploy." -ForegroundColor Green
} else {
  Write-Host "[snapshot] committed locally. Re-run with -Push to publish." -ForegroundColor Green
}
