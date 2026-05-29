# Deploy checklist

Everything needed to take this live. The worker runs on **Cloudflare** (it uses
Durable Objects — Cloudflare-only; it will not run on Railway/Vercel). The
staffer console runs on **Cloudflare Pages**. The pages live in **WordPress**;
the emails in **MailerLite**.

## 0. Before you start
- [ ] A Cloudflare account (Workers Free plan is enough).
- [ ] Node.js 18+ installed locally.
- [ ] MailerLite API token: MailerLite → Integrations → API.
- [ ] Two random secrets: run `openssl rand -hex 24` twice (one for
      `WEBHOOK_SECRET`, one for `STAFF_TOKEN`).

## 1. Deploy the worker + console (one command)
```bash
./deploy.sh --console
```
This installs deps, logs you into Cloudflare, prompts for any missing secrets,
runs the tests, deploys the worker (creating the Durable Objects), and deploys
the staffer console to Cloudflare Pages.

> Prefer to do it by hand? See `docs/deployment.md`.

- [ ] Note the printed **worker URL** (e.g. `https://james4nationwide-referrals.<account>.workers.dev`). This is your **`WORKER_BASE`**.
- [ ] Note the printed **Pages URL** for the console (e.g. `https://james4nationwide-console.pages.dev`).

## 2. MailerLite
- [ ] Create the `Pledgers` group + custom fields (see `docs/mailerlite-setup.md`).
- [ ] Build the embedded pledge form (with a hidden `referred_by` field), set its
      success redirect to `https://james4nationwide.co.uk/thank-you/?email={$email}`.
- [ ] Add the webhook: `https://<WORKER_BASE>/webhook?token=<WEBHOOK_SECRET>`,
      event = subscriber confirmed/updated.
- [ ] Author + schedule the 5 reminder emails (and the seed broadcast) from `emails/`.

## 3. WordPress pages (BlockArt → Custom HTML)
- [ ] `/pledge` — paste `wordpress/pledge-page.html`; paste your MailerLite form
      embed into the `<!-- MAILERLITE FORM -->` slot.
- [ ] `/thank-you` — paste `wordpress/thank-you-page.html`; replace `WORKER_BASE`.
- [ ] `/leaderboard` — paste `wordpress/leaderboard.html`; replace `WORKER_BASE`.
- [ ] Point the homepage "ELECT JAMES" CTA and `/how-to-vote` at `/pledge`.

## 4. Staffer console
- [ ] Open the Pages URL, enter the worker URL + `STAFF_TOKEN` + your name.
- [ ] Set the on-duty roster (used by round-robin assign).

## 5. Smoke test
- [ ] Pledge on mobile via `/pledge` → confirm the double-opt-in email → land on
      `/thank-you` and see your personal link + count.
- [ ] Open a second browser, pledge via that personal link, confirm, and check the
      first person's count / the leaderboard go up.
- [ ] In the console, add an opportunity, claim it, mark it converted, see stats.

## Optional: nicer URL
- [ ] Map a route like `api.james4nationwide.co.uk` to the worker (Cloudflare
      dashboard → Workers → your worker → Triggers/Routes), then use that as
      `WORKER_BASE` everywhere.
