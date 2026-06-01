# Outreach engine — design & guardrails

This turns the agentic-outreach diagram into a concrete, **compliant** design that
sits on top of the existing Pledge & Remind core. It is the reference for the
leaderboard and staffer-console builds in this repo.

> **Read this first.** The campaign's selling point (Build Brief §6) is consent,
> data minimisation and *no astroturfing*. The design below deliberately keeps a
> human in the loop and avoids building a profiled database of individuals. The
> guardrails are not optional polish — they are what keeps the engine on the
> right side of platform ToS, UK GDPR/PECR, and electoral-integrity norms.

## Diagram → components

| Diagram box | What we build | Status |
|---|---|---|
| **Listener Agent** (scans posts) | A **feed of public posts/topics** for humans to triage. We surface public chatter; we do **not** auto-harvest people into a contact store. | 🟡 reshaped |
| **Adds to queue / ranks by followers** | An **opportunity queue** with a *coarse, manual* priority. Follower-count auto-ranking is dropped (profiling). | 🟡 reshaped |
| **Assignment Agent** (round robin) | `POST /staff/assign` (round-robin across an on-duty roster) **and** self-claim. | 🟢 built |
| **Staffer** (responds w/ link) | The **staffer console** — claim, engage, paste the unique link, log outcome. | 🟢 built |
| **Tracker Agent** | `GET /staff/stats` + the console's tracker panel. | 🟢 built |
| **Opportunity clicks → conversion funnel → VOTES** | The existing `/pledge` → double opt-in → thank-you flow. | 🟢 exists |
| **Drop off → re-work queue** | `status: rework` — but capped re-attempts (see guardrails). | 🟢 built |
| **Staffer follow-up "Did you vote?"** | A console action that logs *that contact was made* — never how someone voted. | 🟢 built |
| **Encourage share w/ unique link** | The existing referral worker + thank-you share buttons. | 🟢 exists |
| **Anonymised leaderboard** | `GET /leaderboard` + public arcade page. Aliases, not identities. | 🟢 built |
| **Daily prize draw + countdown** | Front-end countdown; entries earned by **referrals only**. | 🔴 see guardrails |

## Guardrails (the non-negotiables)

1. **Human in the loop.** No automated DMing or mass contacting. The Listener
   surfaces *public posts*; a staffer decides whether and how to engage,
   preferably by replying in public.
2. **No profiled people-store.** An opportunity record holds a public post URL,
   a topic, a coarse manual priority, workflow status, and a free-text note —
   **no follower counts, no demographic scoring, no private contact details.**
3. **Capped re-work.** The drop-off → re-work loop is bounded (default max 2
   re-attempts) so it can never become repeat unsolicited contact.
4. **No vote tracking.** "Did you vote?" logs only that *a follow-up happened*.
   We never store whether or how an individual voted (§6).
5. **Anonymised leaderboard.** Ranks show generated aliases (e.g. "Swift Otter")
   derived from the opaque referral code — never names or emails.
6. **Incentives reward recruiting, not voting.** 🔴 A prize draw tied to *voting*
   risks breaching inducement rules. Entries must be earned by **referrals/shares
   only**, and the leaderboard ranks referrals, not votes. **Get this signed off
   by whoever advises the campaign before going live.**
7. **Suppression is global.** Anyone unsubscribed/suppressed in MailerLite is off
   limits to the whole engine, including outreach follow-ups.

## Data model

Stored in two **Durable Objects** (strongly consistent — atomic counts and an
atomic queue; no new PII store; opportunities reference *public* posts, not
private profiles):

**`ReferralLedger`** (authoritative; MailerLite fields mirror it for display):
```
code:<code>   -> "<subscriberId>"     # code index (browser-proposed, first-write-wins)
sub:<id>      -> "<code>"             # reverse index
count:<code>  -> <int>               # referral count (atomic increment)
done:<id>     -> 1                    # exactly-once: referrer credited for this referee
pending:<code> -> { ids:[...], ts }   # referees who confirmed before the referrer
flushed:<code>:<id> -> 1             # exactly-once flush guard for a buffered referee
lb:top        -> [ { code, alias, count }, ... ]   # leaderboard (top 50)
rate:<hash>   -> { start, count }     # /leaderboard rate-limit bucket (salted-hash IP)
```

**`OutreachQueue`**:
```
opp:<id>      -> { id, createdAt, updatedAt,
                   status,        # new|assigned|contacted|converted|dropped|rework
                   platform, postUrl, topic, priority(1-3),
                   assignedTo, assignedAt,
                   outcome,       # pledged|subscribed|followed|none
                   reworkCount, note, followedUp(bool) }
roster        -> ["Alex","Sam", ...]  # on-duty staffers
rotation      -> <int>                # round-robin pointer
```

## API surface (Cloudflare Worker)

Public (CORS-locked to the site):
- `GET /leaderboard?code=&limit=` — arcade ranks + the caller's own rank.

Staff-only (`x-staff-token` / `?token=` = `STAFF_TOKEN`):
- `POST /staff/opportunities` — add (Listener-fed or manual).
- `GET  /staff/opportunities?status=&assignedTo=` — queue view.
- `POST /staff/claim` — self-claim the next `new`/`rework` item.
- `POST /staff/assign` — round-robin assign all `new` items across the roster.
- `POST /staff/opportunities/:id` — update status/outcome/note/follow-up.
- `GET/POST /staff/roster` — read/set the on-duty roster.
- `GET  /staff/stats` — tracker aggregates.

## What is intentionally NOT built

- Auto-scraping or auto-DMing of individuals.
- Follower-count or demographic ranking of people.
- Any store of how a person voted.
- Auto-issued prize entries tied to voting.
