<#
.SYNOPSIS
  Registers (or re-registers) the rotation task in Windows Task Scheduler.

.DESCRIPTION
  Collection is a slow rotation: each run refreshes ONE base and exits. This script
  only decides how often that rotation ticks.

  There is no magic interval. The two things that actually matter:

    1. Duty cycle — a run costs ~4 minutes of requests. At interval I, we occupy
       roughly 4/I of the time, and the rest of the shared per-IP budget is left for
       you actually playing. Smaller is politer.
    2. Cycle time — interval x tracked bases. This is how stale the oldest row on
       the page can be. It only has to beat the speed prices actually move (hours),
       not feel fast.

  Anything in the 15-60 minute range satisfies both for a six-base set:

    Interval   Duty cycle   Cycle (6 bases)   Cycle (48 bases)
    15 min     ~27%         1.5 h             12 h
    30 min     ~13%         3 h               24 h
    60 min     ~7%          6 h               48 h

  Lean slow. The one thing never to do is raise -Bases to "catch up" — that rebuilds
  the burst this whole design exists to avoid. If a cycle feels too slow, shorten the
  interval instead; the per-run cost stays flat either way.

.PARAMETER IntervalMinutes
  How often the rotation ticks. Default 30 — a middle setting, not a derived truth.

.PARAMETER Bases
  Bases per run. Leave at 1 unless deliberately backfilling on a known-idle IP.

.PARAMETER Push
  Push after each successful collection, which triggers the Pages deploy.

.EXAMPLE
  .\scripts\register-task.ps1                          # every 30 min, local only
  .\scripts\register-task.ps1 -IntervalMinutes 60 -Push
  .\scripts\register-task.ps1 -IntervalMinutes 20 -Push
#>
[CmdletBinding()]
param(
  [ValidateRange(5, 720)]
  [int]$IntervalMinutes = 30,
  [ValidateRange(1, 10)]
  [int]$Bases = 1,
  [switch]$Push,
  [string]$TaskName = 'poe2-base-trends rotation'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$script = Join-Path $repo 'scripts\snapshot.ps1'

if (-not (Test-Path $script)) { throw "snapshot.ps1 not found at $script" }

$argList = "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -Bases $Bases"
if ($Push) { $argList += ' -Push' }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argList -WorkingDirectory $repo

# Omit -RepetitionDuration: that means "repeat indefinitely". Do NOT pass
# [TimeSpan]::MaxValue -- it serialises to P99999999DT23H59M59S, which the Task
# Scheduler service rejects as out of range.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

# IgnoreNew matters: if one run is slow, the next tick is dropped rather than started
# beside it. Two collectors sharing an IP is precisely the burst we avoid.
# The time limit is a backstop -- a healthy run takes ~4 min.
$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
  -StartWhenAvailable `
  -DontStopOnIdleEnd

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "[register] replaced existing task" -ForegroundColor Yellow
}

# Register-ScheduledTask surfaces service errors as NON-terminating CIM errors, which
# sail straight past $ErrorActionPreference='Stop'. Without -ErrorAction Stop this
# script will happily print a success summary for a task that was never created.
try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description "Refresh one PoE2 base per run on a slow rotation (every $IntervalMinutes min)" `
    -ErrorAction Stop | Out-Null
} catch {
  throw "Register-ScheduledTask failed: $($_.Exception.Message)"
}

# Trust the scheduler, not the return value: read the task back.
$registered = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $registered) { throw "Task '$TaskName' is not present after registration." }

$cycle = [math]::Round(($IntervalMinutes * 6) / 60.0, 1)
$duty = [math]::Round(100 * 4.0 / $IntervalMinutes, 0)
Write-Host "[register] '$TaskName' registered ($($registered.State)): every $IntervalMinutes min, $Bases base/run." -ForegroundColor Green
Write-Host "[register] ~$duty% duty cycle; a 6-base cycle completes about every $cycle h." -ForegroundColor Green
if (-not $Push) { Write-Host "[register] Local commits only. Re-run with -Push to publish." -ForegroundColor Yellow }
