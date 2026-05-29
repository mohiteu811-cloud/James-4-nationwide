# Referral worker

The referral attribution layer for the Pledge & Remind campaign — the only
custom-engineered component (Build Brief §4). A single Cloudflare Worker.

- **No new PII store.** Per-subscriber state (`referral_code`, `referred_by`,
  `referral_count`, `pledged_at`, `source`) lives in MailerLite custom fields.
  The only extra storage is a Cloudflare KV namespace holding an opaque
  `referral_code → subscriber-id` index — no email, name, or membership data.
- **Two endpoints:** `POST /webhook` (MailerLite confirmation) and
  `GET /referral?email=…` (thank-you page link + live count).

See **`../docs/deployment.md`** for full setup. Quick start:

```bash
npm install
npx wrangler kv namespace create REFERRALS         # paste id into wrangler.toml
npx wrangler kv namespace create REFERRALS --preview
npx wrangler secret put MAILERLITE_API_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npm test            # in-memory tests, no account needed
npm run deploy
```
