#!/usr/bin/env bash
#
# One tick of the rotation, for Linux (VPS) — the counterpart of snapshot.ps1.
#
# Collects exactly ONE unit (~12 searches, ~4 min), re-analyses, renders, commits,
# and pushes. This script has no opinion about how often it runs; that belongs to
# cron (see docs/vps.md). A rate-limit abort is NOT a failure — the unit stays
# queued and the next tick picks it up, so this exits 0 either way.
#
# Guarded by flock so a slow run and the next cron tick can never collect
# concurrently — two collectors on one IP is exactly the burst the rotation exists
# to avoid (the Task Scheduler equivalent was -MultipleInstances IgnoreNew).
#
# Usage:  scripts/snapshot.sh          # collect, analyse, render, commit locally
#         scripts/snapshot.sh --push   # ...and push, which triggers the Pages deploy
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

LOCK="$REPO/cache/snapshot.lock"
mkdir -p "$REPO/cache"

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "[snapshot] previous run still active; skipping this tick."
  exit 0
fi

echo "[snapshot] collecting..."
npm run --silent collect

echo "[snapshot] analysing..."
npm run --silent analyze

echo "[snapshot] rendering..."
npm run --silent site

git add data
if git diff --cached --quiet; then
  # The normal outcome for a tick held off by a rate limit, or one whose unit
  # hasn't moved. Not a failure.
  echo "[snapshot] no data changes; nothing to commit."
  exit 0
fi

STAMP="$(date -u '+%Y-%m-%d %H:%M')"
git commit -m "data: snapshot $STAMP UTC"

if [[ "${1:-}" == "--push" ]]; then
  echo "[snapshot] pushing..."
  # Rebase first so a push from another machine (or a code push from the desktop)
  # doesn't turn into a rejected non-fast-forward and a stuck rotation.
  git pull --rebase --quiet
  git push --quiet
  echo "[snapshot] done; Pages will redeploy."
else
  echo "[snapshot] committed locally. Run with --push to publish."
fi
