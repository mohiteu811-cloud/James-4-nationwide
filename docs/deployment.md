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

## 2. Storage (Durable Objects — nothing to create)

State lives in two **Durable Objects** (`ReferralLedger`, `OutreachQueue`),
declared in `wrangler.toml`. They are strongly consistent and single-threaded,
so referral counts and the outreach queue update **atomically** — no
lost-update or eventual-consistency races. The migration in `wrangler.toml`
creates them automatically on first `deploy`; there is no namespace to
provision by hand.

They hold **no extra PII**: opaque referral codes + counts, and references to
**public** posts only (§6). SQLite-backed Durable Objects are available on the
Workers Free plan.

## 3. Set secrets

```bash
npx wrangler secret put MAILERLITE_API_TOKEN   # paste your MailerLite token
npx wrangler secret put WEBHOOK_SECRET         # a long random string you choose
npx wrangler secret put STAFF_TOKEN            # a DIFFERENT random string for the staffer console
```

Generate a good secret with: `openssl rand -hex 24`

## 4. (Optional) set the site origin

`SITE_BASE_URL` in `wrangler.toml` defaults to `https://james4nationwide.co.uk`.
It is used to build share links and to lock CORS on the public endpoints
(`/referral`, `/leaderboard`). Change it only if the domain differs. The
`/staff/*` endpoints reflect the request origin instead (they are
token-authenticated and credential-less), so the staffer console works whether
it is hosted elsewhere or opened locally.

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
npm test                         # 13 tests against an in-memory MailerLite + Durable Objects
```

## How it behaves (and why)

- **Atomic + exactly-once:** crediting runs inside the `ReferralLedger` Durable
  Object, keyed on the new subscriber's id. Concurrent confirmations can't lose
  a credit, and duplicate or self-triggered `subscriber.updated` webhooks are
  no-ops. A failed MailerLite mirror write can never double-count (the ledger is
  authoritative; MailerLite fields are a best-effort display mirror).
- **Double-opt-in safe:** referrers are credited only when the new subscriber's
  status is `active` — unconfirmed signups never inflate a count.
- **Instant, lag-free link:** `/referral` lazily mints a code in the DO
  (strongly consistent, so a just-minted referrer code is immediately creditable
  with no KV propagation delay). Lazy mint does not seal idempotency, so the
  webhook still credits the referrer on confirmation.
- **Single-winner queue:** opportunity creation and claims are serialised in the
  `OutreachQueue` DO — no clobbered index, no two staffers on one item.
- **Privacy:** `/referral` is rate-limited and returns the same `pending`
  response for unknown and not-yet-visible emails, so it isn't a clean
  pledged/not-pledged oracle.

### Migrating existing pledgers (optional)
If anyone already has a `referral_code` in MailerLite from before the ledger
existed, register it so their shared links keep crediting:
`POST` to the `ReferralLedger` `register` action with `{ subscriberId, code, count }`.
New pledgers need nothing — their code is minted on first confirmation.
