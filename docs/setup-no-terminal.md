# Set up without a terminal (web UI only)

You can deploy and run everything from web dashboards — no command line. The
trick is to let **Cloudflare build from your GitHub repo** (it runs the deploy
for you and creates the Durable Objects automatically). You will use four
websites: **GitHub**, **Cloudflare**, **MailerLite**, and your **WordPress**
admin.

> You will **not** need `deploy.sh`, `wrangler`, or the GitHub Actions workflows
> for this route. (Those are for people who prefer the command line.)

---

## Step 1 — Merge the code into `main` (GitHub)
The deploy watches the `main` branch, so get the code there first.

1. Open the pull request on GitHub.
2. Click **Merge pull request** → **Confirm merge**.

Now `main` contains the whole project.

---

## Step 2 — Deploy the worker (Cloudflare dashboard)
This is the backend (referral codes, leaderboard, staffer API).

1. Go to **dash.cloudflare.com** → **Workers & Pages**.
2. Click **Create** → **Workers** → **Import a repository** (a.k.a. "Connect to
   Git"). Authorise GitHub and pick the **james-4-nationwide** repo.
3. In the build settings:
   - **Production branch:** `main`
   - **Root directory:** `referral-worker`
   - **Build command:** `npm install`
   - **Deploy command:** `npx wrangler deploy`  *(usually pre-filled)*
4. Click **Save and Deploy**. Cloudflare builds the project and — because of the
   migration in `wrangler.toml` — creates the two Durable Objects for you.
5. When it finishes, copy the worker's URL (e.g.
   `https://james4nationwide-referrals.<account>.workers.dev`). **This is your
   `WORKER_BASE`** — you'll paste it in a few places later.

### Add the three secrets (still in the dashboard)
1. Open the new worker → **Settings** → **Variables and Secrets**.
2. Add three **Secrets** (type = Secret, so they're encrypted):
   - `MAILERLITE_API_TOKEN` — from MailerLite → Integrations → API
   - `WEBHOOK_SECRET` — any long random string (e.g. a password-manager value)
   - `STAFF_TOKEN` — a different long random string
3. Go to **Deployments** → **Create deployment / Retry** to redeploy so the
   secrets take effect.

> No `openssl`? Use any password generator (e.g. your browser's suggested
> password) for `WEBHOOK_SECRET` and `STAFF_TOKEN`. Just keep a copy.

---

## Step 3 — MailerLite (web UI)
Follow `docs/mailerlite-setup.md` — it's all clicks in the MailerLite app:
1. Create the **`Pledgers`** group and the custom fields.
2. Build the **embedded pledge form** (with a hidden `referred_by` field); set
   its success redirect to
   `https://james4nationwide.co.uk/thank-you/?email={$email}`.
3. **Webhook:** Integrations → Webhooks → add
   `https://<WORKER_BASE>/webhook?token=<WEBHOOK_SECRET>` for the
   subscriber-confirmed/updated event.
4. Author + schedule the 5 reminder emails (and the seed broadcast) from
   `emails/`.

---

## Step 4 — WordPress pages (your site's page builder)
For each page, add a **Custom HTML / code block** in BlockArt and paste the file:
1. **/pledge** ← `wordpress/pledge-page.html` (also paste your MailerLite form
   embed into the `<!-- MAILERLITE FORM -->` spot).
2. **/thank-you** ← `wordpress/thank-you-page.html` — find `WORKER_BASE` in the
   pasted code and replace it with your worker URL.
3. **/leaderboard** ← `wordpress/leaderboard.html` — replace `WORKER_BASE` too.
4. Point the homepage "ELECT JAMES" button and `/how-to-vote` at `/pledge`.

> To open the HTML files from GitHub: click the file → click **Raw** → copy all,
> or use the **Copy raw file** button.

---

## Step 5 — Staffer console on Cloudflare Pages (dashboard)
1. **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → pick the
   **james-4-nationwide** repo.
2. Build settings:
   - **Production branch:** `main`
   - **Framework preset:** None
   - **Build command:** *(leave empty)*
   - **Build output directory:** `staffer-console`
3. **Save and Deploy.** Copy the Pages URL (e.g.
   `https://james4nationwide-console.pages.dev`).
4. Open that URL, and enter your **worker URL**, your **`STAFF_TOKEN`**, and your
   name. Then set the on-duty roster.

After this, both the worker and the console **re-deploy automatically** whenever
you (or I) push changes to `main` — all handled by Cloudflare, no terminal.

---

## Step 6 — Smoke test (just clicking around)
1. On your phone, open **/pledge**, pledge, and click the confirm link in the
   email → you land on **/thank-you** with your personal link and count.
2. In another browser, pledge via that personal link, confirm, then refresh the
   first person's thank-you page / the **/leaderboard** — the count goes up.
3. In the **console**, add an opportunity, claim it, mark it converted — the
   tracker updates.

---

## FAQ

**Do I need the GitHub Actions or `deploy.sh`?** No. Cloudflare's Git
integration (Steps 2 and 5) does the deploying. The Actions workflows stay
dormant unless you set a repo variable `ENABLE_CF_DEPLOY=true`.

**Where do the Durable Objects get created?** Automatically, during the
Cloudflare build in Step 2 (from the migration in `wrangler.toml`). Nothing to
click.

**I want a tidy URL** like `api.james4nationwide.co.uk`. In the worker →
**Settings** → **Domains & Routes** → add a custom domain, then use that as
`WORKER_BASE` everywhere.
