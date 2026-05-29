# Deploying the referral worker (Cloudflare)

The referral function is the only custom-engineered component (Build Brief §4).
It runs on Cloudflare Workers — free tier is ample for this campaign.

## Prerequisites

- A Cloudflare account.
- Node.js 18+ locally.
- A MailerLite **API token** with API access (MailerLite → Integrations → API).

## 1. Install & log in

```bash
cd referral-worker
npm install
npx wrangler login
```

## 2. Create the KV namespace

This is the only storage outside MailerLite. It holds **no PII** — just an
opaque `referral_code → subscriber-id` index so we can credit referrers without
scanning the list (§6).

```bash
npx wrangler kv namespace create REFERRALS
npx wrangler kv namespace create REFERRALS --preview
```

Paste the printed `id` and `preview_id` into `wrangler.toml`.

## 3. Set secrets

```bash
npx wrangler secret put MAILERLITE_API_TOKEN   # paste your MailerLite token
npx wrangler secret put WEBHOOK_SECRET         # a long random string you choose
npx wrangler secret put STAFF_TOKEN            # a DIFFERENT random string for the staffer console
```

Generate a good secret with: `openssl rand -hex 24`

## 4. (Optional) set the site origin

`SITE_BASE_URL` in `wrangler.toml` defaults to `https://james4nationwide.co.uk`.
It is used to build share links and to lock CORS so only the live thank-you page
can read the `/referral` endpoint. Change it only if the domain differs.

## 5. Deploy

```bash
npm run deploy
```

Wrangler prints the worker URL, e.g.
`https://james4nationwide-referrals.<account>.workers.dev`.
(Optionally map a custom route like `https://api.james4nationwide.co.uk` in the
Cloudflare dashboard.)

## 6. Wire it up

- **Thank-you page:** in `wordpress/thank-you-page.html`, replace `WORKER_BASE`
  with the deployed worker URL.
- **MailerLite webhook:** point it at
  `https://<worker-domain>/webhook?token=<WEBHOOK_SECRET>` (see
  `docs/mailerlite-setup.md` §6).

## Endpoints

| Method | Path                         | Purpose                                            |
|--------|------------------------------|----------------------------------------------------|
| POST   | `/webhook?token=…`           | MailerLite confirmation → mint code, credit referrer |
| GET    | `/referral?email=…`          | Thank-you page → personal link + live count        |
| GET    | `/leaderboard?code=&limit=`  | Public arcade leaderboard (aliases + caller's rank)|
| POST   | `/staff/opportunities`       | Staff: add an opportunity (public post)            |
| GET    | `/staff/opportunities?status=&assignedTo=` | Staff: queue view                    |
| POST   | `/staff/claim`               | Staff: self-claim next new/rework item             |
| POST   | `/staff/assign`              | Staff: round-robin assign all new items            |
| POST   | `/staff/opportunities/:id`   | Staff: update status/outcome/note/follow-up        |
| GET/POST | `/staff/roster`            | Staff: read/set the on-duty roster                 |
| GET    | `/staff/stats`               | Staff: tracker aggregates                          |
| GET    | `/health`                    | Liveness check                                     |

Staff endpoints require the `STAFF_TOKEN` (header `x-staff-token` or `?token=`).
The leaderboard is public but CORS-locked to `SITE_BASE_URL`.

### Wiring the front-ends
- **`wordpress/leaderboard.html`** — replace `WORKER_BASE`; paste into a BlockArt block.
- **`staffer-console/index.html`** — open it (host anywhere static or locally),
  then enter the worker URL + staff token + your name to connect.

> See `docs/outreach-engine-design.md` for the guardrails the outreach API
> enforces (capped re-work, no profiling fields, follow-up logs no vote data).

## Test locally

```bash
cp .dev.vars.example .dev.vars   # fill in values
npm run dev                      # wrangler dev
npm test                         # runs the unit tests against an in-memory MailerLite + KV
```

## How it behaves (and why)

- **Idempotent:** `pledged_at` is stamped only after a subscriber is fully
  processed (code minted + referrer credited). Re-delivered webhooks are no-ops.
- **Double-opt-in safe:** referrers are credited only when the new subscriber's
  status is `active` — unconfirmed signups never inflate a count.
- **Instant link:** `/referral` lazily mints a code so the supporter's link
  works on the thank-you page even before they confirm — without sealing
  `pledged_at`, so the webhook still credits their referrer later.
