# Referral worker

The referral attribution layer for the Pledge & Remind campaign — the only
custom-engineered component (Build Brief §4). A single Cloudflare Worker.

- **No new PII store.** State lives in two **Durable Objects** (`ReferralLedger`,
  `OutreachQueue`) — strongly consistent, so referral counts and the outreach
  queue update atomically with no races. They hold only opaque codes + counts
  and references to *public* posts. MailerLite custom fields mirror the counts
  for display/segmentation.
- **No email ever reaches the backend.** Each supporter's referral code is
  generated in their browser and carried through MailerLite, so there is no
  email→data lookup and therefore no email-enumeration oracle (Codex review #7).
- **Endpoints:** `POST /webhook` (MailerLite confirmation), `GET /leaderboard`
  (anonymised top list + the caller's own live count/rank, keyed on the referral
  code they already hold), and the token-protected `/staff/*` outreach API.

See **`../docs/deployment.md`** for full setup. Quick start:

```bash
npm install
npx wrangler secret put MAILERLITE_API_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put STAFF_TOKEN
npm test            # in-memory tests, no account needed
npm run deploy      # Durable Objects are created by the migration in wrangler.toml
```
