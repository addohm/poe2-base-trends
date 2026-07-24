# Running the rotation on a VPS

The collector's requirements are small: Node, git, an IP whose rate-limit budget is
yours alone, and something to tick it hourly. A VPS satisfies all four and removes
the dependency on a desktop being awake.

One thing a VPS changes: **its IP is a datacenter IP.** pathofexile.com sits behind
Cloudflare, which challenges datacenter ranges far more readily than residential
ones. Unlike GitHub Actions runners the address is dedicated — its reputation is
stable, its budget is not shared with strangers, and any ban lands only on you — so
in practice it may work fine. But it is not guaranteed, which is why step 3 below
comes before any automation: **prove the API answers from this IP before wiring
cron.** If it turns out blocked, nothing else here matters.

## 1. Prerequisites

```bash
# Node 24+ (the pipeline runs TypeScript natively — no build step)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
node --version   # want v24+
```

## 2. Clone and configure

```bash
git clone git@github.com:addohm/poe2-base-trends.git
cd poe2-base-trends
npm ci

# Commit identity. Use the GitHub noreply address — GitHub REJECTS pushes that
# would publish a private email (learned the hard way).
git config user.name  "addohm"
git config user.email "25333107+addohm@users.noreply.github.com"
```

Pushing needs a credential the VPS can use non-interactively. A deploy key is the
narrow option (grants access to this one repo only):

```bash
ssh-keygen -t ed25519 -f ~/.ssh/poe2_deploy -N "" -C "poe2-base-trends vps"
cat ~/.ssh/poe2_deploy.pub
# -> GitHub repo → Settings → Deploy keys → Add key → PASTE → tick "Allow write access"

cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/poe2_deploy
  IdentitiesOnly yes
EOF
```

## 3. The Cloudflare test — do this before anything else

Cheapest possible probe first (a static reference endpoint, no rate-limit cost to
speak of):

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "User-Agent: poe2-base-trends/0.1 (+https://github.com/addohm/poe2-base-trends)" \
  "https://www.pathofexile.com/api/trade2/data/leagues"
```

- **200** — the API answers this IP. Proceed.
- **403**, or a response full of "Just a moment" HTML — Cloudflare is challenging
  the IP. Stop here; this VPS can't collect, and retrying won't change that.

Then one real tick, by hand, watching the output:

```bash
bash scripts/snapshot.sh        # no --push: stays local
```

A healthy first run collects one unit (`... listed=NNNN ... sampled 100/NN`) and
commits. A rate-limited run says so and exits 0 — that's weather, not failure — but
on a *first* run from a fresh IP it more likely means Cloudflare, so check with the
curl above again.

## 4. Cron

```bash
crontab -e
```

```cron
# poe2-base-trends: one unit per hour. The script holds a lock, so an overrunning
# tick makes the next one skip rather than stack.
17 * * * * cd /home/YOU/poe2-base-trends && bash scripts/snapshot.sh --push >> cache/snapshot.log 2>&1
```

The `17` is deliberate — on-the-hour cron jobs across the internet land in the same
second; an offset minute is politer to everyone including us. Watch it with
`tail -f cache/snapshot.log`.

## 5. Cut over — one collector at a time

Two machines collecting doubles the draw and races pushes. Once the VPS has done a
few clean ticks, disable the Windows task (on the desktop):

```powershell
Disable-ScheduledTask -TaskName 'poe2-base-trends rotation'
```

The VPS starts with fresh local state (`cache/` is gitignored): the queue begins a
new cycle and the rate limiter starts from its conservative seeds. That's fine —
history lives in `data/`, which came with the clone.

## 6. Season changes

The league name is baked into queries. On a new league:

```cron
17 * * * * cd ... && POE2_LEAGUE="New League Name" bash scripts/snapshot.sh --push >> cache/snapshot.log 2>&1
```

(Or export it in the crontab header. The default in code tracks whatever league the
repo was last updated for.)
