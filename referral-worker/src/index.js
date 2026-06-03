/**
 * James4Nationwide — "Pledge & Remind" referral + outreach function.
 *
 * The custom-engineered backend for the campaign (Build Brief §4 + the outreach
 * engine in docs/outreach-engine-design.md).
 *
 * State lives in two Cloudflare Durable Objects (strongly consistent, single-
 * threaded — so counts and the queue update atomically, with no lost-update or
 * eventual-consistency races):
 *   - ReferralLedger : code index, referral counts, leaderboard, exactly-once
 *                      idempotency. Authoritative; MailerLite custom fields are
 *                      a best-effort mirror for display/segmentation.
 *   - OutreachQueue  : the staffer opportunity queue, roster and rotation.
 *
 * No new PII store: the ledger holds opaque codes + counts; the queue holds
 * references to *public* posts, never private profiles. No individual vote
 * tracking. Minimal PII. (Build Brief §6)
 */

const ML_API = "https://connect.mailerlite.com/api";

// Unambiguous alphabet (no 0/O/1/I/L) so server-minted codes are easy to read
// aloud / type. Browser-proposed codes use a wider URL-safe alphabet (they're
// never read aloud — they ride in links).
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 7;
// A browser-proposed code is only honoured if it looks like what genCode() in
// pledge-page.html produces — 16 URL-safe chars (~90 bits). Anything shorter is
// rejected and replaced by a server mint, so a hand-edited hidden form field
// can't register a trivially guessable code and weaken the unguessable-bearer
// assumption the public /leaderboard read relies on. (Codex review)
const CODE_RE = /^[A-Za-z0-9_-]{16,64}$/;

const OPP_STATUSES = ["new", "assigned", "contacted", "converted", "dropped", "rework"];
const OPP_OUTCOMES = ["pledged", "subscribed", "followed", "none"];
const MAX_REWORK = 2; // guardrail: cap re-attempts so re-work never becomes spam

// /leaderboard is the public read endpoint (live count + rank by referral
// code). Rate-limit it so the single ledger DO can't be hammered and so the
// code-validity response can't be brute-forced (Codex review #7).
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 30;

// Out-of-order referral buffers expire after the 45-day attribution window so
// abandoned entries (referrer never confirmed) can't accumulate.
const PENDING_TTL_MS = 45 * 24 * 60 * 60 * 1000;

/* ========================================================================== */
/* Worker (router)                                                            */
/* ========================================================================== */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return applyCors(env, request, new Response(null, { status: 204 }));
    }

    try {
      if (pathname === "/webhook" && request.method === "POST") {
        return await handleWebhook(request, env); // server-to-server, no CORS
      }
      if (pathname === "/leaderboard" && request.method === "GET") {
        return applyCors(env, request, await handleLeaderboard(request, url, env));
      }
      if (pathname.startsWith("/staff/")) {
        return applyCors(env, request, await handleStaff(request, url, env));
      }
      if (pathname === "/health") {
        return json({ ok: true });
      }
      return json({ error: "not_found" }, 404);
    } catch (err) {
      console.error("unhandled", err && err.stack ? err.stack : err);
      return json({ error: "internal_error" }, 500);
    }
  },
};

/* -------------------------------------------------------------------------- */
/* Webhook: MailerLite subscriber-confirmed                                   */
/* -------------------------------------------------------------------------- */

async function handleWebhook(request, env) {
  if (!env.MAILERLITE_API_KEY && !env.MAILERLITE_API_TOKEN) {
    return new Response('Missing API key', { status: 500 });
  }
  // The webhook URL is the secret. MailerLite lets you set a custom URL, so we
  // require a shared token (query ?token= or X-Webhook-Token header) and verify
  // it in constant time. Configure the same value as the WEBHOOK_SECRET secret.
  if (!verifyToken(request, env.WEBHOOK_SECRET)) {
    return json({ error: "unauthorized" }, 401);
  }

  const payload = await request.json().catch(() => null);
  if (!payload) return json({ error: "bad_request" }, 400);

  const events = Array.isArray(payload.events) ? payload.events : [payload];

  const results = [];
  for (const event of events) {
    const subscriber = extractSubscriber(event);
    if (!subscriber || !subscriber.id) continue;
    // Only act on confirmed/active subscribers — enforces the double-opt-in
    // red line: unconfirmed referrals are never credited.
    if (subscriber.status && subscriber.status !== "active") continue;
    results.push(await processConfirmedSubscriber(subscriber.id, env));
  }

  return json({ ok: true, processed: results.length, results });
}

/**
 * Crediting is now atomic and exactly-once in the ledger DO (keyed on the new
 * subscriber's id), so duplicate or self-triggered `subscriber.updated`
 * webhooks are no-ops and a failed MailerLite mirror write can never cause a
 * double credit (Codex review #1, #2, #3).
 */
async function processConfirmedSubscriber(subscriberId, env) {
  const sub = await mlGetSubscriber(env, subscriberId);
  if (!sub) return { id: subscriberId, skipped: "not_found" };

  // Re-verify against the *fetched* record. The webhook payload may omit
  // `status` (so handleWebhook's guard can't catch it); checking here means a
  // generic subscriber.updated/added event for an unconfirmed subscriber can
  // never be credited — double opt-in holds regardless of which event fired.
  if (sub.status !== "active") return { id: subscriberId, skipped: "not_active" };

  // If a Pledgers group is configured, only credit members of it, so an
  // account-level webhook can't turn a Weekly/Daily subscriber who never
  // pledged into a referral participant.
  if (env.PLEDGERS_GROUP_ID && Array.isArray(sub.groups)) {
    const inGroup = sub.groups.some((g) => String(g.id) === String(env.PLEDGERS_GROUP_ID));
    if (!inGroup) return { id: subscriberId, skipped: "not_in_pledgers_group" };
  }

  const fields = sub.fields || {};
  const { status, data: result } = await callDO(ledgerStub(env), "credit", {
    subscriberId: sub.id,
    referredBy: (fields.referred_by || "").trim(),
    preferCode: fields.referral_code || "",
  });
  // If the ledger did not accept the write (transient DO/storage failure, mint
  // error), fail loudly so MailerLite retries — rather than stamping pledged_at
  // over a no-op and losing the credit.
  if (status >= 300 || !result || result.error) {
    throw new Error(`ledger credit failed (${status})`);
  }

  // Mirror to MailerLite for display/segmentation. Best-effort: the ledger is
  // authoritative. Keep referral_code synced — this also corrects the rare
  // collision case where the ledger had to mint a replacement for the code the
  // browser proposed — but set pledged_at only on first processing so duplicate
  // deliveries don't move the original pledge date.
  const mirror = { referral_code: result.code };
  if (!result.already) mirror.pledged_at = today();
  await safe(() => mlUpdateSubscriber(env, sub.id, mirror));

  // Mirror the credited referrer's new count (the subscriber named in this
  // subscriber's referred_by).
  if (result.credited && result.credited.subscriberId && result.credited.referral_count != null) {
    await safe(() =>
      mlUpdateSubscriber(env, result.credited.subscriberId, {
        referral_count: result.credited.referral_count,
      })
    );
  }

  // This confirmation may also have flushed a pending buffer — i.e. referees who
  // confirmed *before* this subscriber registered their own code now get
  // credited to this subscriber. Mirror this subscriber's own updated count too.
  if (result.flushedDelta && result.code) {
    await safe(() =>
      mlUpdateSubscriber(env, sub.id, { referral_count: result.selfCount })
    );
  }

  return { id: subscriberId, ...result };
}

/* -------------------------------------------------------------------------- */
/* Read endpoint: anonymised leaderboard + the caller's own live count/rank.  */
/* The caller passes their referral *code* (a bearer capability they already   */
/* hold) — never an email — so this endpoint reveals nothing about anyone but  */
/* the code-holder, and there is no email→data oracle anywhere in the backend. */
/* -------------------------------------------------------------------------- */

async function handleLeaderboard(request, url, env) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const { data: rate } = await callDO(ledgerStub(env), "rate", { ip });
  if (!rate.allowed) {
    return json({ error: "rate_limited" }, 429, { "Retry-After": String(rate.retryAfter || 60) });
  }

  const limit = clamp(parseInt(url.searchParams.get("limit"), 10) || 20, 1, 50);
  const code = (url.searchParams.get("code") || "").trim();
  const { data } = await callDO(ledgerStub(env), "leaderboard", { limit, code });
  return json(data);
}

/* -------------------------------------------------------------------------- */
/* Staffer console / outreach queue (staff-only) — forwarded to the DO        */
/* -------------------------------------------------------------------------- */

async function handleStaff(request, url, env) {
  if (!verifyToken(request, env.STAFF_TOKEN)) {
    return json({ error: "unauthorized" }, 401);
  }

  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;
  const stub = queueStub(env);

  if (path === "/staff/opportunities" && method === "GET") {
    return forwardDO(stub, "list", {
      status: url.searchParams.get("status"),
      assignedTo: url.searchParams.get("assignedTo"),
    });
  }
  if (path === "/staff/opportunities" && method === "POST") {
    return forwardDO(stub, "create", await readBody(request));
  }
  const idMatch = path.match(/^\/staff\/opportunities\/([\w-]+)$/);
  if (idMatch && (method === "POST" || method === "PATCH")) {
    return forwardDO(stub, "update", { id: idMatch[1], patch: await readBody(request) });
  }
  if (path === "/staff/claim" && method === "POST") {
    return forwardDO(stub, "claim", await readBody(request));
  }
  if (path === "/staff/assign" && method === "POST") {
    return forwardDO(stub, "assign", await readBody(request));
  }
  if (path === "/staff/roster" && method === "GET") {
    return forwardDO(stub, "rosterGet", {});
  }
  if (path === "/staff/roster" && method === "POST") {
    return forwardDO(stub, "rosterSet", await readBody(request));
  }
  if (path === "/staff/stats" && method === "GET") {
    return forwardDO(stub, "stats", {});
  }
  return json({ error: "not_found" }, 404);
}

async function forwardDO(stub, action, payload) {
  const { status, data } = await callDO(stub, action, payload);
  return json(data, status);
}

/* ========================================================================== */
/* Durable Object: ReferralLedger                                             */
/* ========================================================================== */

export class ReferralLedger {
  constructor(state, env) {
    this.storage = state.storage;
    this.env = env;
  }

  async fetch(request) {
    const action = new URL(request.url).pathname.replace(/^\//, "");
    const body = await request.json().catch(() => ({}));
    try {
      switch (action) {
        case "registerSelf":
          return json(await this._registerSelf(body));
        case "credit":
          return json(await this._credit(body));
        case "register":
          return json(await this._register(body));
        case "leaderboard":
          return json(await this._leaderboard(body.limit, body.code));
        case "rate":
          return json(await this._rate(body.ip));
        default:
          return json({ error: "unknown_action" }, 400);
      }
    } catch (err) {
      console.error("ledger", err && err.stack ? err.stack : err);
      return json({ error: "ledger_error" }, 500);
    }
  }

  /**
   * Register the confirming subscriber's *own* referral code. The code is
   * proposed by the subscriber's browser (carried through MailerLite as the
   * `referral_code` field) so the email never reaches this backend. First write
   * wins: if the proposed code is already taken (astronomically unlikely for an
   * 80-bit random code) or is missing/invalid (old form, migration), we mint a
   * replacement and flag `replaced` so the caller can correct MailerLite.
   *
   * Idempotent: a subscriber already holding a code keeps it. Either way we then
   * flush any referees who confirmed *before* this code existed (see _credit).
   */
  async _registerSelf({ subscriberId, preferCode }) {
    const subKey = `sub:${subscriberId}`;
    let code = await this.storage.get(subKey);
    let replaced = false;

    if (!code) {
      const wanted = String(preferCode || "");
      if (CODE_RE.test(wanted) && !(await this.storage.get(`code:${wanted}`))) {
        code = wanted;
      } else {
        // No usable proposal (missing/invalid) or a collision with an existing
        // holder. Mint a fresh unique code; flag replaced only when the browser
        // actually proposed something, so the caller knows to overwrite it.
        if (wanted) replaced = true;
        code = await this._mint();
      }
      await this.storage.put(`code:${code}`, String(subscriberId));
      await this.storage.put(subKey, code);
    }

    const flushedDelta = await this._flushPending(code, subscriberId);
    return { code, replaced, flushedDelta, selfCount: await this._count(code) };
  }

  async _mint() {
    for (let i = 0; i < 8; i++) {
      const code = randomCode();
      if (!(await this.storage.get(`code:${code}`))) return code; // free
    }
    throw new Error("could not mint a unique referral code");
  }

  // Buffer a referee who confirmed before their referrer registered the code, so
  // no credit is lost to confirmation ordering. Deduped per code.
  async _addPending(refCode, subscriberId) {
    const key = `pending:${refCode}`;
    const pend = (await this.storage.get(key)) || { ids: [], ts: Date.now() };
    const id = String(subscriberId);
    if (!pend.ids.includes(id)) pend.ids.push(id);
    await this.storage.put(key, pend);
    if (this.storage.setAlarm && this.storage.getAlarm) {
      const armed = await this.storage.getAlarm();
      if (!armed) await this.storage.setAlarm(Date.now() + RATE_WINDOW_MS);
    }
  }

  // Credit every buffered referee for this code, exactly once (the flushed:
  // guard survives re-deliveries), then clear the buffer. Returns how many were
  // newly credited so the worker can mirror the new count to MailerLite.
  async _flushPending(code, subscriberId) {
    const key = `pending:${code}`;
    const pend = await this.storage.get(key);
    if (!pend || !Array.isArray(pend.ids) || !pend.ids.length) return 0;

    let delta = 0;
    for (const refereeId of pend.ids) {
      if (String(refereeId) === String(subscriberId)) continue; // never self-credit
      const fKey = `flushed:${code}:${refereeId}`;
      if (await this.storage.get(fKey)) continue; // already credited
      await this.storage.put(fKey, 1);
      delta += 1;
    }
    if (delta > 0) {
      const next = (await this._count(code)) + delta;
      await this.storage.put(`count:${code}`, next);
      await this._bumpLeaderboard(code, next);
    }
    await this.storage.delete(key);
    return delta;
  }

  async _credit({ subscriberId, referredBy, preferCode }) {
    const doneKey = `done:${subscriberId}`;
    // Claim the subscriber's own code (first-write-wins, mint-on-collision) and
    // flush anyone who confirmed ahead of them.
    const self = await this._registerSelf({ subscriberId, preferCode });
    const code = self.code;
    const meta = { replaced: self.replaced, flushedDelta: self.flushedDelta, selfCount: self.selfCount };

    // Exactly-once: if we've already processed this confirmation, do not credit
    // the referrer again (handles webhook retries + self-triggered
    // subscriber.updated). The pending flush above is independently idempotent.
    if (await this.storage.get(doneKey)) {
      return { code, credited: null, already: true, ...meta };
    }
    await this.storage.put(doneKey, 1);

    let credited = null;
    const ref = (referredBy || "").trim();
    if (ref) {
      const refSub = await this.storage.get(`code:${ref}`);
      if (refSub && String(refSub) === String(subscriberId)) {
        // Someone reopened their own ?ref= link — don't let them recruit themselves.
        credited = { code: ref, self: true };
      } else if (refSub) {
        const next = (await this._count(ref)) + 1;
        await this.storage.put(`count:${ref}`, next);
        await this._bumpLeaderboard(ref, next);
        credited = { code: ref, subscriberId: refSub, referral_count: next };
      } else {
        // Referrer hasn't confirmed yet — buffer so they're credited the moment
        // they do, instead of dropping the referral (Codex review: lost credits).
        await this._addPending(ref, subscriberId);
        credited = { code: ref, pending: true };
      }
    }
    return { code, credited, ...meta };
  }

  // Migration/seed helper: import an existing pledger's code (and count) so
  // referrals through links shared before this DO existed are still credited.
  async _register({ subscriberId, code, count }) {
    if (!code) return { ok: false };
    await this.storage.put(`code:${code}`, String(subscriberId));
    await this.storage.put(`sub:${subscriberId}`, code);
    if (count != null) {
      await this.storage.put(`count:${code}`, count);
      await this._bumpLeaderboard(code, count);
    }
    return { ok: true };
  }

  async _count(code) {
    return (await this.storage.get(`count:${code}`)) || 0;
  }

  async _bumpLeaderboard(code, count) {
    let list = (await this.storage.get("lb:top")) || [];
    list = list.filter((e) => e.code !== code);
    if (count > 0) list.push({ code, alias: aliasFor(code), count });
    list.sort((a, b) => b.count - a.count);
    await this.storage.put("lb:top", list.slice(0, 50));
  }

  async _leaderboard(limit, code) {
    const list = (await this.storage.get("lb:top")) || [];
    const top = list.slice(0, clamp(limit || 20, 1, 50)).map((e, i) => ({
      rank: i + 1,
      alias: e.alias,
      count: e.count,
    }));
    let you = null;
    if (code) {
      // Compute rank from the full per-code counts, not the truncated top-50
      // list, so supporters at rank 51+ still see their live rank.
      const myCount = await this._count(code);
      if (myCount > 0) {
        const counts = await this.storage.list({ prefix: "count:" });
        let ahead = 0;
        for (const v of counts.values()) if (v > myCount) ahead += 1;
        you = { rank: ahead + 1, alias: aliasFor(code), count: myCount };
      }
    }
    return { top, you, total: list.length };
  }

  async _rate(ip) {
    // Store a short, salted hash of the IP — never the raw address — and expire
    // the buckets, so this never becomes a durable store of supporter IPs.
    const key = `rate:${await hashId(ip)}`;
    const now = Date.now();
    let bucket = await this.storage.get(key);
    if (!bucket || now - bucket.start >= RATE_WINDOW_MS) bucket = { start: now, count: 0 };
    bucket.count += 1;
    await this.storage.put(key, bucket);
    if (this.storage.setAlarm && this.storage.getAlarm) {
      const pending = await this.storage.getAlarm();
      if (!pending) await this.storage.setAlarm(now + RATE_WINDOW_MS);
    }
    return {
      allowed: bucket.count <= RATE_MAX,
      retryAfter: Math.ceil((bucket.start + RATE_WINDOW_MS - now) / 1000),
    };
  }

  // Purge stale rate buckets (so hashed-IP keys can't accumulate) and abandoned
  // pending buffers (referrers who never confirmed within the attribution
  // window), so neither becomes an unbounded store.
  async alarm() {
    const now = Date.now();
    let live = 0;

    const buckets = await this.storage.list({ prefix: "rate:" });
    for (const [k, v] of buckets) {
      if (!v || now - v.start >= RATE_WINDOW_MS) await this.storage.delete(k);
      else live += 1;
    }

    const pending = await this.storage.list({ prefix: "pending:" });
    for (const [k, v] of pending) {
      if (!v || now - (v.ts || 0) >= PENDING_TTL_MS) await this.storage.delete(k);
      else live += 1;
    }

    if (live > 0 && this.storage.setAlarm) await this.storage.setAlarm(now + RATE_WINDOW_MS);
  }
}

/* ========================================================================== */
/* Durable Object: OutreachQueue                                              */
/* ========================================================================== */

export class OutreachQueue {
  constructor(state, env) {
    this.storage = state.storage;
    this.env = env;
  }

  async fetch(request) {
    const action = new URL(request.url).pathname.replace(/^\//, "");
    const body = await request.json().catch(() => ({}));
    try {
      switch (action) {
        case "create":
          return await this._create(body);
        case "list":
          return json(await this._list(body));
        case "update":
          return await this._update(body.id, body.patch || {});
        case "claim":
          return json(await this._claim(body.staffer));
        case "assign":
          return await this._assign(body.staffers);
        case "rosterGet":
          return json({ roster: (await this.storage.get("roster")) || [] });
        case "rosterSet": {
          const roster = Array.isArray(body.roster) ? body.roster.map(String) : [];
          await this.storage.put("roster", roster);
          return json({ roster });
        }
        case "stats":
          return json(await this._stats());
        default:
          return json({ error: "unknown_action" }, 400);
      }
    } catch (err) {
      console.error("queue", err && err.stack ? err.stack : err);
      return json({ error: "queue_error" }, 500);
    }
  }

  async _all() {
    const map = await this.storage.list({ prefix: "opp:" });
    return [...map.values()];
  }

  async _create(body) {
    // Guardrail: store a *public post* reference + workflow state only. No
    // follower counts / profiling fields, even if sent.
    if (!body.postUrl && !body.topic) {
      return json({ error: "postUrl_or_topic_required" }, 400);
    }
    // Only allow http(s) public-post links — blocks javascript:/data: URLs that
    // could execute in the token-holding console origin if rendered.
    if (body.postUrl && !/^https?:\/\//i.test(String(body.postUrl))) {
      return json({ error: "invalid_post_url" }, 400);
    }
    const now = new Date().toISOString();
    const opp = {
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: "new",
      platform: str(body.platform, 40),
      postUrl: str(body.postUrl, 500),
      topic: str(body.topic, 120),
      priority: clamp(parseInt(body.priority, 10) || 2, 1, 3),
      note: str(body.note, 1000),
      assignedTo: null,
      assignedAt: null,
      outcome: null,
      reworkCount: 0,
      followedUp: false,
    };
    // Atomic within the DO — concurrent creates can't clobber each other's
    // index append (Codex review #4).
    await this.storage.put(`opp:${opp.id}`, opp);
    return json({ opportunity: opp }, 201);
  }

  async _list({ status, assignedTo }) {
    let items = await this._all();
    if (status) items = items.filter((o) => o.status === status);
    if (assignedTo) items = items.filter((o) => o.assignedTo === assignedTo);
    items.sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
    return { opportunities: items, count: items.length };
  }

  async _update(id, patch) {
    const opp = await this.storage.get(`opp:${id}`);
    if (!opp) return json({ error: "not_found" }, 404);

    if (patch.status !== undefined) {
      if (!OPP_STATUSES.includes(patch.status)) return json({ error: "invalid_status" }, 400);
      if (patch.status === "rework") {
        if (opp.reworkCount >= MAX_REWORK) {
          // Guardrail: never let re-work become repeat unsolicited contact.
          opp.status = "dropped";
          opp.note = appendNote(opp.note, "auto-dropped: re-work cap reached");
          await this.storage.put(`opp:${id}`, touch(opp));
          return json({ opportunity: opp, note: "rework_cap_reached_dropped" });
        }
        opp.reworkCount += 1;
        opp.assignedTo = null;
        opp.assignedAt = null;
      }
      opp.status = patch.status;
    }
    if (patch.outcome !== undefined) {
      if (patch.outcome !== null && !OPP_OUTCOMES.includes(patch.outcome)) {
        return json({ error: "invalid_outcome" }, 400);
      }
      opp.outcome = patch.outcome;
    }
    if (patch.assignedTo !== undefined) opp.assignedTo = patch.assignedTo ? String(patch.assignedTo) : null;
    if (patch.priority !== undefined) opp.priority = clamp(parseInt(patch.priority, 10) || opp.priority, 1, 3);
    if (patch.note !== undefined) opp.note = str(patch.note, 1000);
    // "Did you vote?" follow-up logs only THAT a contact happened — never the answer.
    if (patch.followedUp !== undefined) opp.followedUp = !!patch.followedUp;

    await this.storage.put(`opp:${id}`, touch(opp));
    return json({ opportunity: opp });
  }

  async _claim(staffer) {
    staffer = str(staffer, 60);
    if (!staffer) return { error: "staffer_required" };
    const queue = (await this._all())
      .filter((o) => o.status === "new" || o.status === "rework")
      .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
    const next = queue[0];
    if (!next) return { claimed: null, message: "queue_empty" };
    // Single-winner: the DO serialises requests, so a second concurrent claim
    // sees this item already assigned and picks the next one (Codex review #5).
    next.status = "assigned";
    next.assignedTo = staffer;
    next.assignedAt = new Date().toISOString();
    await this.storage.put(`opp:${next.id}`, touch(next));
    return { claimed: next };
  }

  async _assign(staffers) {
    const roster =
      Array.isArray(staffers) && staffers.length
        ? staffers.map(String)
        : (await this.storage.get("roster")) || [];
    if (!roster.length) return json({ error: "no_roster" }, 400);

    const queue = (await this._all())
      .filter((o) => o.status === "new")
      .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));

    let pointer = (await this.storage.get("rotation")) | 0;
    const assignments = [];
    const now = new Date().toISOString();
    for (const opp of queue) {
      const staffer = roster[pointer % roster.length];
      pointer++;
      opp.status = "assigned";
      opp.assignedTo = staffer;
      opp.assignedAt = now;
      await this.storage.put(`opp:${opp.id}`, touch(opp));
      assignments.push({ id: opp.id, assignedTo: staffer });
    }
    await this.storage.put("rotation", pointer);
    return json({ assigned: assignments.length, assignments });
  }

  async _stats() {
    const all = await this._all();
    const byStatus = {};
    const byOutcome = {};
    const byStaffer = {};
    let followedUp = 0;
    for (const o of all) {
      byStatus[o.status] = (byStatus[o.status] || 0) + 1;
      if (o.outcome) byOutcome[o.outcome] = (byOutcome[o.outcome] || 0) + 1;
      if (o.assignedTo) {
        byStaffer[o.assignedTo] = byStaffer[o.assignedTo] || { assigned: 0, converted: 0 };
        byStaffer[o.assignedTo].assigned += 1;
        if (o.status === "converted") byStaffer[o.assignedTo].converted += 1;
      }
      if (o.followedUp) followedUp += 1;
    }
    return { total: all.length, byStatus, byOutcome, byStaffer, followedUp };
  }
}

/* -------------------------------------------------------------------------- */
/* Durable Object plumbing                                                    */
/* -------------------------------------------------------------------------- */

function ledgerStub(env) {
  return env.REFERRAL_LEDGER.get(env.REFERRAL_LEDGER.idFromName("ledger"));
}
function queueStub(env) {
  return env.OUTREACH_QUEUE.get(env.OUTREACH_QUEUE.idFromName("queue"));
}
async function callDO(stub, action, payload) {
  const res = await stub.fetch(
    new Request(`https://do/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    })
  );
  return { status: res.status, data: await res.json() };
}

/* -------------------------------------------------------------------------- */
/* Referral codes + aliases                                                   */
/* -------------------------------------------------------------------------- */

function randomCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

// Generated alias keeps the leaderboard fun and identity-free (Build Brief §6).
const ALIAS_ADJ = ["Swift","Bold","Quiet","Bright","Steady","Keen","Brave","Sharp","Calm","Lucky","Mighty","Nimble","Royal","Wise","Fierce","Sunny","Gallant","Plucky","Loyal","Cheery"];
const ALIAS_NOUN = ["Otter","Badger","Falcon","Heron","Stag","Fox","Hare","Owl","Wren","Lynx","Robin","Marten","Kite","Adder","Tern","Pony","Hedgehog","Squirrel","Curlew","Puffin"];

function aliasFor(code) {
  let h = 2166136261;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h = h >>> 0;
  return `${ALIAS_ADJ[h % ALIAS_ADJ.length]} ${ALIAS_NOUN[Math.floor(h / ALIAS_ADJ.length) % ALIAS_NOUN.length]}`;
}

// Short, salted hash of an identifier (used for rate-limit keys) so we never
// persist a raw IP address.
async function hashId(value) {
  const data = new TextEncoder().encode(`j4n:${value || "unknown"}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* -------------------------------------------------------------------------- */
/* MailerLite client                                                          */
/* -------------------------------------------------------------------------- */

async function mlFetch(env, method, path, body) {
  const apiKey = env.MAILERLITE_API_TOKEN || env.MAILERLITE_API_KEY;
  if (!apiKey) {
    return { status: 500, data: null };
  }
  const res = await fetch(`${ML_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 404) return { status: 404, data: null };
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`MailerLite ${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  }
  return { status: res.status, data };
}

// Identifier may be a subscriber id or an email — both are accepted by the API.
async function mlGetSubscriber(env, identifier) {
  const { data } = await mlFetch(env, "GET", `/subscribers/${encodeURIComponent(identifier)}`);
  return data ? data.data : null;
}

async function mlUpdateSubscriber(env, subscriberId, fields) {
  const { data } = await mlFetch(env, "PUT", `/subscribers/${subscriberId}`, { fields });
  return data ? data.data : null;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function verifyToken(request, expected) {
  if (!expected) return false; // fail closed if misconfigured
  const url = new URL(request.url);
  const provided =
    url.searchParams.get("token") ||
    request.headers.get("x-webhook-token") ||
    request.headers.get("x-staff-token") ||
    "";
  return timingSafeEqual(provided, expected);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function extractSubscriber(event) {
  if (!event) return null;
  if (event.data && event.data.subscriber) return event.data.subscriber;
  if (event.subscriber) return event.subscriber;
  if (event.email || event.id) return event; // already a bare subscriber object
  return null;
}

async function readBody(request) {
  return (await request.json().catch(() => null)) || {};
}

async function safe(fn) {
  try {
    return await fn();
  } catch (err) {
    console.error("mirror_failed", err && err.message ? err.message : err);
    return null;
  }
}

function touch(opp) {
  opp.updatedAt = new Date().toISOString();
  return opp;
}

function appendNote(note, line) {
  return note ? `${note}\n${line}` : line;
}

function str(v, max) {
  if (v === undefined || v === null) return "";
  return String(v).slice(0, max);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function shareBase(env) {
  return (env.SITE_BASE_URL || "https://james4nationwide.co.uk/");//.replace(/\/+$/, "");
}

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD for MailerLite date field
}

function json(body, status = 200, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ "Content-Type": "application/json" }, extraHeaders || {}),
  });
}

/**
 * Origin-aware CORS. Public endpoints stay locked to the site origin; staff
 * endpoints reflect the request origin because they are token-authenticated and
 * credential-less — this lets the console run from the documented contexts
 * (hosted elsewhere or opened locally) without weakening security
 * (Codex review #10).
 */
function applyCors(env, request, response) {
  const path = new URL(request.url).pathname;
  const headers = new Headers(response.headers);
  const allowOrigin = path.startsWith("/staff/")
    ? request.headers.get("Origin") || "*"
    : shareBase(env);
  headers.set("Access-Control-Allow-Origin", allowOrigin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-Staff-Token, X-Webhook-Token");
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}
