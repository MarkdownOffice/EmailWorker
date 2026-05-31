# MarkdownOffice Daily Mailer — Cloudflare Worker

Production-ready Cloudflare Worker that sends a daily scheduled email
via the Brevo transactional API.

```
Cloudflare Cron Trigger (0 9 * * *)
         │
         ▼
Cloudflare Worker (src/index.ts)
   ├─ KV  → daily idempotency lock        (prevents double-sends)
   ├─ D1  → recipients + content rotation (7-day cycle + audit log)
   └─ Brevo API → email delivered
         │
         ▼
  contact@markdownoffice.com → recipients
```

---

## Project layout

```
markdownoffice-mailer/
├── src/
│   └── index.ts          # Single worker file (all logic here)
├── schema.sql             # D1 schema + seed data
├── wrangler.toml          # Worker config (cron, D1, KV, vars)
├── .dev.vars.example      # Local secrets template
├── package.json
├── tsconfig.json
└── .gitignore
```

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 18 + | https://nodejs.org |
| Wrangler CLI | 3 + | `npm i -g wrangler` |
| Cloudflare account | free tier works | https://dash.cloudflare.com/sign-up |
| Brevo account | free tier: 300 emails/day | https://app.brevo.com |

---

## Step-by-step deployment

### 1 — Install dependencies

```bash
npm install
```

### 2 — Log in to Cloudflare

```bash
wrangler login
```

### 3 — Create D1 database

```bash
wrangler d1 create markdownoffice-mailer-db
```

Copy the `database_id` printed in the output, then paste it into `wrangler.toml`:

```toml
[[d1_databases]]
binding       = "DB"
database_name = "markdownoffice-mailer-db"
database_id   = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  # ← here
```

### 4 — Create KV namespace

```bash
wrangler kv namespace create EMAIL_KV
```

Copy the `id` and paste it into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "EMAIL_KV"
id      = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"  # ← here
```

### 5 — Apply database schema

```bash
# Local (for wrangler dev)
npm run db:migrate

# Remote (production) — run this before first deploy
npm run db:migrate:remote
```

### 6 — Set secrets (never stored in code)

```bash
# Your Brevo API key — https://app.brevo.com/settings/keys/api
wrangler secret put BREVO_API_KEY

# Random secret for the POST /trigger endpoint
# Generate: openssl rand -hex 32
wrangler secret put TRIGGER_SECRET
```

### 7 — Configure recipients

**Option A — D1 (recommended for production)**

```bash
wrangler d1 execute markdownoffice-mailer-db --remote \
  --command "INSERT OR IGNORE INTO recipients (email, name) VALUES ('you@example.com', 'Your Name');"
```

**Option B — env var fallback (quick start)**

Edit `wrangler.toml`:

```toml
[vars]
RECIPIENTS_JSON = '["you@example.com","colleague@example.com"]'
```

### 8 — Deploy

```bash
# Default (workers.dev subdomain)
npm run deploy

# Named production environment
npm run deploy:prod
```

---

## Local development

```bash
# 1. Copy secrets template
cp .dev.vars.example .dev.vars
# 2. Fill in .dev.vars with your real keys

# 3. Run locally
npm run dev

# 4. Test the manual trigger
curl -X POST http://localhost:8787/trigger \
  -H "X-Trigger-Secret: your-local-trigger-secret"

# 5. Health check
curl http://localhost:8787/health
```

To simulate the cron locally, Wrangler exposes a hidden endpoint:

```bash
curl "http://localhost:8787/__scheduled?cron=0+9+*+*+*"
```

---

## Manual trigger (production)

```bash
curl -X POST https://<your-worker>.workers.dev/trigger \
  -H "X-Trigger-Secret: $TRIGGER_SECRET"
```

Returns `202 Accepted` with `{ "queued": true }` — the job runs
asynchronously via `ctx.waitUntil`.

---

## Managing recipients

```bash
# List active recipients
wrangler d1 execute markdownoffice-mailer-db --remote \
  --command "SELECT id, email, name, active FROM recipients;"

# Add a recipient
wrangler d1 execute markdownoffice-mailer-db --remote \
  --command "INSERT INTO recipients (email, name) VALUES ('new@example.com', 'New User');"

# Unsubscribe (soft delete — preserves history)
wrangler d1 execute markdownoffice-mailer-db --remote \
  --command "UPDATE recipients SET active = 0 WHERE email = 'old@example.com';"
```

---

## Editing daily content rotation

```bash
# Update Wednesday's message (day_index = 3)
wrangler d1 execute markdownoffice-mailer-db --remote \
  --command "UPDATE email_content SET message = 'New Wednesday message!', updated_at = datetime('now') WHERE day_index = 3;"

# View all 7 day entries
wrangler d1 execute markdownoffice-mailer-db --remote \
  --command "SELECT day_index, subject, message FROM email_content ORDER BY day_index;"
```

Day index mapping (JavaScript `getUTCDay()`):
`0=Sunday  1=Monday  2=Tuesday  3=Wednesday  4=Thursday  5=Friday  6=Saturday`

---

## Viewing audit logs

```bash
# Last 20 send attempts
wrangler d1 execute markdownoffice-mailer-db --remote \
  --command "SELECT sent_at, status, recipient_count, error_message FROM send_log ORDER BY sent_at DESC LIMIT 20;"

# Live Worker logs (streaming)
npm run logs
```

---

## Environment variables reference

| Variable | Type | Required | Description |
|---|---|---|---|
| `BREVO_API_KEY` | **Secret** | ✅ | Brevo API key for SMTP |
| `TRIGGER_SECRET` | **Secret** | ✅ | Protects `POST /trigger` |
| `RECIPIENTS_JSON` | Var | Optional | JSON fallback if D1 is empty |

---

## Feature summary

| Feature | How |
|---|---|
| Scheduled sending | Cron trigger `0 9 * * *` (09:00 UTC) |
| Brevo integration | `POST /v3/smtp/email` |
| Retry on failure | 1 retry on 5xx / network error (2s back-off) |
| Multiple recipients | D1 `recipients` table (active/inactive toggle) |
| Content rotation | 7-day cycle in D1 `email_content` table |
| Double-send protection | KV idempotency lock per UTC date |
| Audit log | D1 `send_log` table (every attempt) |
| Manual trigger | `POST /trigger` with `X-Trigger-Secret` header |
| Health probe | `GET /health` |
| Zero secrets in code | All via `wrangler secret put` + env vars |

---

## Cron schedule reference

| Expression | Meaning |
|---|---|
| `0 9 * * *` | Daily at 09:00 UTC |
| `0 6 * * 1-5` | Weekdays only at 06:00 UTC |
| `0 8 * * 1` | Every Monday at 08:00 UTC |
| `*/5 * * * *` | Every 5 minutes (dev/testing) |
