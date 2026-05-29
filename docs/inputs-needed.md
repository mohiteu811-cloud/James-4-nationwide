# Inputs needed from James (Build Brief §8)

Checklist of everything required to take this from repo → live.

- [ ] **MailerLite API token** — MailerLite → Integrations → API. Confirm the
      plan includes **API access** and **scheduled campaigns/automations**
      (verify current tier limits in the account).
- [ ] **Pledgers Group ID** — once the group is created.
- [ ] **Custom field keys/IDs** — for `referral_code`, `referred_by`,
      `referral_count`, `pledged_at`, `source` (confirm exact keys under Fields).
- [ ] **Data controller details** + privacy policy URL for the email footer
      (privacy policy already exists at `/privacy-policy/`).
- [ ] **Hosting choice for the function** — Cloudflare Worker is built here;
      confirm the account and the subdomain/route to deploy on (e.g.
      `api.james4nationwide.co.uk` or the default `*.workers.dev`).
- [ ] **WEBHOOK_SECRET value** — chosen by the developer; James just needs to
      know it goes in both the worker secret and the webhook URL.

## Decisions already made in this build

- **Function host:** Cloudflare Worker (brief's preferred option over a SaaS).
- **Referral state:** MailerLite custom fields + a non-PII KV index (no new
  PII store; §6 satisfied).
- **Counting policy:** referrers credited on **confirmation** only (double
  opt-in integrity).
