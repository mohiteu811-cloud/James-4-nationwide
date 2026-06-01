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

> **Deploying via the dashboard / Git integration?** Builds deploy **code and
> `vars` only — they do not set secrets.** Add the three secrets once under
> **Settings → Variables and Secrets** (type: *Secret*); adding one rolls out a
> new version automatically, so no rebuild is needed. Until they exist the worker
> fails closed: `/webhook` and `/staff/*` return `401` and MailerLite API calls
> fail. Quick check: `<WORKER_BASE>/webhook?token=WRONG` should return `401`.

## 4. (Optional) set the site origin

`SITE_BASE_URL` in `wrangler.toml` defaults to `https://james4nationwide.co.uk`.
It is used to build share links and to lock CORS on the public `/leaderboard`
endpoint. Change it only if the domain differs. The
`/staff/*` endpoints reflect the request origin instead (they are
token-authenticated and credential-less), so the staffer console works whether
it is hosted elsewhere or opened locally.

## 5. Deploy

```bash
npm run deploy
```

Wrangler prints the worker URL, e.g.
`https://james-4-nationwide.<account>.workers.dev`.
(Optionally map a custom route like `https://api.james4nationwide.co.uk` in the
Cloudflare dashboard.)

### Deploying via Cloudflare's Git integration (Workers Builds)

If instead of the CLI you connect this repo to Cloudflare in the dashboard,
remember the worker lives in the **`referral-worker/` subdirectory** — not the
repo root. Set the build configuration to either:

- **Root directory:** `referral-worker` · **Build:** `npm install` · **Deploy:** `npx wrangler deploy` *(recommended — one field)*, **or**
- leave the root directory at `/` and set the **Deploy command** to `npm run deploy` (the root `package.json` delegates into `referral-worker/`).

A build that runs `npm install` at the repo root with no overrides will fail
with `ENOENT … /repo/package.json` because the worker's `package.json` is in the
subdirectory. Make sure the project type is **Workers** (not Pages) — the
Durable Objects require a Worker.

**Deploy command must be `npx wrangler deploy`, not `npx wrangler versions
upload`.** This worker declares a Durable Object migration (`new_sqlite_classes`
in `wrangler.toml`), and versioned uploads cannot apply migrations — they fail
with `code: 10211`. This applies to **both** the production deploy command **and
the "Non-production branch deploy command"** (Workers Builds defaults the latter
to `versions upload`). So if non-production branch builds are enabled, set that
command to `npx wrangler deploy` too — but note that then **every push to a
non-production branch deploys it to the live Worker.** Once you deploy from
`main`, either disable non-production branch builds or only push deploy-ready
code to connected branches.

> The worker `name` in `wrangler.toml` must match the Workers Builds project
> name, or each build warns about a mismatch and offers to open a reconciling
> PR. This repo uses `james-4-nationwide`.

> Prefer GitHub Actions? The bundled `.github/workflows/deploy-worker.yml`
> already builds from `referral-worker/` with `wrangler deploy`. Enable it by
> setting the repo variable `ENABLE_CF_DEPLOY=true` and the
> `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` repo secrets.

## 6. Wire it up

- **Thank-you page:** in `wordpress/thank-you-page.html`, replace `WORKER_BASE`
  with the deployed worker URL. Set the MailerLite form's after-submit redirect
  to the plain `…/thank-you/` URL (no `?email=` — the link comes from the code
  stored in the browser).
- **Pledge form:** add hidden `referred_by` **and** `referral_code` fields, and
  put the personal link in the confirmation email (see `docs/mailerlite-setup.md`).
- **MailerLite webhook:** point it at
  `https://<worker-domain>/webhook?token=<WEBHOOK_SECRET>` (see
  `docs/mailerlite-setup.md` §6).

## Endpoints

| Method | Path                         | Purpose                                            |
|--------|------------------------------|----------------------------------------------------|
| POST   | `/webhook?token=…`           | MailerLite confirmation → register code, credit referrer |
| GET    | `/leaderboard?code=&limit=`  | Public: anonymised leaderboard + caller's own live count/rank (by referral code). Rate-limited. |
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
npm test                         # in-memory tests against a fake MailerLite + Durable Objects
```

## How it behaves (and why)

- **Atomic + exactly-once:** crediting runs inside the `ReferralLedger` Durable
  Object, keyed on the new subscriber's id. Concurrent confirmations can't lose
  a credit, and duplicate or self-triggered `subscriber.updated` webhooks are
  no-ops. A failed MailerLite mirror write can never double-count (the ledger is
  authoritative; MailerLite fields are a best-effort display mirror).
- **Double-opt-in safe:** referrers are credited only when the new subscriber's
  status is `active` — unconfirmed signups never inflate a count.
- **Instant, lag-free link — and no email on the backend:** each supporter's
  referral code is generated **in their browser** on the pledge page and carried
  through MailerLite as the `referral_code` field. The thank-you page reads the
  same code from local storage and shows the share link instantly, with no
  backend call. On confirmation the ledger registers that code (first-write-wins,
  minting a replacement on the astronomically unlikely collision) and credits the
  referrer. Because the email never reaches the worker, there is **no
  email→data lookup and no email-enumeration oracle** (Codex review #7).
- **No lost credits on out-of-order confirmation:** if a referee confirms before
  their referrer, the credit is buffered (`pending:`) and flushed exactly-once
  the moment the referrer registers their code — never dropped.
- **Single-winner queue:** opportunity creation and claims are serialised in the
  `OutreachQueue` DO — no clobbered index, no two staffers on one item.
- **Privacy:** the only public read endpoint, `/leaderboard`, takes a referral
  *code* (a bearer capability the visitor already holds), never an email, and
  returns only anonymised aliases + counts. It is rate-limited (the bucket key is
  a salted hash of the IP, auto-expired — no raw IPs are stored). **Residual:** a
  valid code returns a `you` object and an invalid one returns `null`, so it is a
  code-validity oracle — but codes are unguessable (~80 bits) and leak no PII, and
  rate-limiting blunts brute force. The email-enumeration oracle is **eliminated**,
  not merely mitigated.
- **Group-scoped credits:** set `PLEDGERS_GROUP_ID` (optional) so only confirmed
  members of the Pledgers group are credited — defends against an account-level
  webhook crediting Weekly/Daily subscribers.
- **No self-referrals:** if `referred_by` resolves to the subscriber's own code,
  the credit is skipped.

### Migrating existing pledgers (optional)
If anyone already has a `referral_code` in MailerLite from before the ledger
existed, register it so their shared links keep crediting:
`POST` to the `ReferralLedger` `register` action with `{ subscriberId, code, count }`.
New pledgers need nothing — their browser proposes a code and the ledger
registers it on first confirmation (minting one if the field is empty).
