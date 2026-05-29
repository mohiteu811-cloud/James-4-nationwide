# Referral worker

The referral attribution layer for the Pledge & Remind campaign — the only
custom-engineered component (Build Brief §4). A single Cloudflare Worker.

- **No new PII store.** State lives in two **Durable Objects** (`ReferralLedger`,
  `OutreachQueue`) — strongly consistent, so referral counts and the outreach
  queue update atomically with no races. They hold only opaque codes + counts
  and references to *public* posts. MailerLite custom fields mirror the counts
  for display/segmentation.
- **Endpoints:** `POST /webhook` (MailerLite confirmation), `GET /referral`
  (thank-you link + count), `GET /leaderboard`, and the token-protected
  `/staff/*` outreach API.

See **`../docs/deployment.md`** for full setup. Quick start:

```bash
npm install
npx wrangler secret put MAILERLITE_API_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put STAFF_TOKEN
npm test            # 13 in-memory tests, no account needed
npm run deploy      # Durable Objects are created by the migration in wrangler.toml
```
