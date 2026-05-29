# James4Nationwide — "Pledge & Remind"

Campaign build for James Sherwin-Smith's member-nominated candidacy for the
Nationwide board. The site already runs on **WordPress + MailerLite**, so this
repo contains only what's genuinely missing (Build Brief v2 §3) — it does not
rebuild capture forms, double opt-in, unsubscribe, or suppression, which
MailerLite already handles.

## Why this exists

The election is decided at **ballot-open**: ballots land **8 June 2026** and
voting closes at the online AGM on **15 July 2026**. The ballot's default
"Quick Vote" counts against James — a supporter must scroll past it and vote
FOR. We have no member register, so we build a **consented** list and reach
people at the decisive moment. This is a democratic-integrity campaign: consent,
data minimisation, and no astroturfing are the product (§6).

## What's in here

| Path                | What it is |
|---------------------|------------|
| `referral-worker/`  | **The custom backend:** a Cloudflare Worker that mints referral codes, credits referrers, serves the anonymised leaderboard, and runs the staffer outreach API. State lives in two strongly-consistent Durable Objects (opaque codes + counts, public-post references) with MailerLite custom fields mirroring counts — no new PII store. |
| `wordpress/`        | HTML/JS to paste into BlockArt: the **/pledge** page (commitment copy + MailerLite form + `?ref=` capture), the **thank-you** page (personal link + live count + share buttons), and the public **leaderboard** (arcade ranks + prize-draw countdown). |
| `staffer-console/`  | Standalone admin app for on-duty staffers: opportunity queue, round-robin assignment, tracker, and the "Did you vote?" follow-up. Human-driven by design. |
| `emails/`           | The 5 scheduled **reminder** emails + the **seed broadcast**, copy verbatim from §5, ready to paste into MailerLite. |
| `mockup/`           | Visual mockups: the two screens, the referral-loop journey, and an interactive `demo.html`. |
| `docs/`             | `mailerlite-setup.md` (no-code config), `deployment.md` (the worker), `outreach-engine-design.md` (agentic-outreach design + guardrails), `inputs-needed.md` (§8 checklist). |

## Build order (ship incrementally — §7)

1. **MailerLite config** — `docs/mailerlite-setup.md` (group, fields, form, double opt-in). *Starts capturing within the hour.*
2. **/pledge page** — paste `wordpress/pledge-page.html`; point the homepage "ELECT JAMES" CTA and `/how-to-vote` at it.
3. **Referral worker** — `docs/deployment.md`; wire the webhook + thank-you page.
4. **Reminder campaigns** — author/schedule the `emails/` to Pledgers.
5. **Activate the existing list** — send `emails/0-seed-broadcast.md` to current Weekly/Daily subscribers (the pyramid's seed layer).
6. **Polish** — accessibility (WCAG AA, large tap targets, high contrast), Pixel retargeting, source tagging.

## The canonical line — on every email and share

> **Don't Quick Vote. Scroll down. Vote FOR Sherwin-Smith.**

## Red lines (§6)

Double opt-in only · working unsubscribe + suppression honoured · no list
buying/scraping/non-consented imports · no member-register data · nothing
automated touching the CES ballot · no individual vote tracking (pledges +
referrals only) · minimal PII (first name + email + referral fields).

## Definition of done (§9)

A member pledges in <30s on mobile, confirms (double opt-in), and lands on a
thank-you page with a working personal link and live count. `?ref=` signups
increment the referrer's `referral_count`. The 5 reminders fire on schedule to
Pledgers with §5 copy and a working unsubscribe. No new PII store beyond
MailerLite custom fields.
