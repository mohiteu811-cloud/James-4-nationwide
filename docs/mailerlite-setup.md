# MailerLite setup (no code)

This is the configuration James does inside MailerLite. It is the foundation
everything else binds to. ~1 hour, and it starts capturing pledges immediately
(Build Brief §7.1).

## 1. Create the group

- **Groups → Create group → `Pledgers`.**
- Keep this separate from the existing Weekly/Daily lists so the 5 reminders
  only ever go to people who pledged.
- Note the **Group ID** (in the group's URL / API) — the developer needs it (§8).

## 2. Turn ON double opt-in for Pledgers

- **Settings → Subscribe settings →** ensure double opt-in is enabled.
- This is a non-negotiable red line (§6). The referral function deliberately
  only credits a referrer once the new subscriber is **confirmed/active**.

## 3. Create the custom fields

**Subscribers → Fields → Create field** for each:

| Field name      | Type   | Purpose                                            |
|-----------------|--------|----------------------------------------------------|
| `referral_code` | Text   | The subscriber's own shareable code                |
| `referred_by`   | Text   | Code of whoever referred them (set by the form)    |
| `referral_count`| Number | How many confirmed voters they've brought in       |
| `pledged_at`    | Date   | Set on confirmation; doubles as "processed" marker |
| `source`        | Text   | Where they pledged (e.g. `pledge_page`, `seed`)    |

> The field **key** (used by the API and form, e.g. `fields[referred_by]`) is
> usually the lower-cased name. Confirm the exact keys under Fields and pass the
> IDs/keys to the developer (§8).

## 4. Build the embedded pledge form

- **Forms → Embedded forms → Create**, subscribing to **Pledgers**.
- Fields: **Email** (required), optional **Name**.
- Add a **hidden field** mapped to `referred_by`. (If the builder won't allow a
  hidden field, the script on the pledge page creates the `fields[referred_by]`
  input itself — see `wordpress/pledge-page.html`.)
- Optionally set a hidden `source` default of `pledge_page`.
- **After-submit / success action:** redirect to
  `https://james4nationwide.co.uk/thank-you/?email={$email}` so the thank-you
  page can show the personal link + count.
- Copy the form embed HTML into the `<!-- MAILERLITE FORM -->` slot in
  `wordpress/pledge-page.html`.

## 5. Confirm the email footer

Check the default footer reads (§5):

> You pledged to support James Sherwin-Smith at james4nationwide.co.uk. We only
> ever use your email to remind you to vote. [Unsubscribe]. Data controller:
> [campaign details].

Fill in the real **data controller details** and confirm the unsubscribe link
works in every send.

## 6. Add the webhook (after the worker is deployed)

- **Integrations → Webhooks → Create.**
- Event: the **subscriber confirmed / updated** event (whichever your account
  exposes for double opt-in completion — the worker checks `status === active`,
  so an "updated" or "added to group" event works fine).
- URL: `https://<your-worker-domain>/webhook?token=<WEBHOOK_SECRET>`
  (the same secret you set on the worker — see `docs/deployment.md`).

## 7. The 5 reminder campaigns

Author the emails in `emails/` (copy is verbatim from §5), send to **Pledgers**,
and **schedule** each for its date in **Europe/London**:

| File                     | Date    | Subject                                            |
|--------------------------|---------|----------------------------------------------------|
| `1-ballot-incoming.md`   | 7 Jun   | Your Nationwide ballot lands tomorrow              |
| `2-ballot-open.md`       | 8 Jun   | Your ballot is live — here's how to vote           |
| `3-mid-reminder.md`      | 28 Jun  | Have you voted yet?                                |
| `4-pre-close.md`         | 11 Jul  | Voting closes in days                              |
| `5-final-call.md`        | 14 Jul  | Final call — voting closes at the AGM tomorrow     |

Scheduled campaigns are the simplest reliable path; a date-based Automation to
the Pledgers group works too if your plan includes it (§4).
