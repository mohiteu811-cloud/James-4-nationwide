/**
 * James4Nationwide — "Pledge & Remind" referral + outreach function.
 *
 * The custom-engineered backend for the campaign (Build Brief §4 + the outreach
 * engine in docs/outreach-engine-design.md). State lives in MailerLite custom
 * fields plus a single Cloudflare KV namespace (no extra PII store): a
 * code -> subscriber-id index, an anonymised leaderboard, and the staffer
 * outreach queue (which references public posts, not private profiles).
 *
 * Responsibilities:
 *   1. POST /webhook      — MailerLite confirmation: mint code, credit referrer.
 *   2. GET  /referral     — thank-you page: personal link + live count.
 *   3. GET  /leaderboard  — public arcade leaderboard (aliases, not identities).
 *   4. /staff/*           — staffer console API (round-robin queue + tracker).
 *
 * No individual vote tracking. No member-register data. Minimal PII. (§6)
 */

const ML_API = "https://connect.mailerlite.com/api";

// Unambiguous alphabet (no 0/O/1/I/L) so codes are easy to read aloud / type.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 7;

const OPP_STATUSES = ["new", "assigned", "contacted", "converted", "dropped", "rework"];
const OPP_OUTCOMES = ["pledged", "subscribed", "followed", "none"];
const MAX_REWORK = 2; // guardrail: cap re-attempts so re-work never becomes spam

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return cors(env, new Response(null, { status: 204 }));
    }

    try {
      if (pathname === "/webhook" && request.method === "POST") {
        return await handleWebhook(request, env);
      }
      if (pathname === "/referral" && request.method === "GET") {
        return cors(env, await handleReferralLookup(url, env));
      }
      if (pathname === "/leaderboard" && request.method === "GET") {
        return cors(env, await handleLeaderboard(url, env));
      }
      if (pathname.startsWith("/staff/")) {
        return cors(env, await handleStaff(request, url, env));
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
  // The webhook URL is the secret. MailerLite lets you set a custom URL, so we
  // require a shared token (query ?token= or X-Webhook-Token header) and verify
  // it in constant time. Configure the same value as the WEBHOOK_SECRET secret.
  if (!verifyToken(request, env.WEBHOOK_SECRET)) {
    return json({ error: "unauthorized" }, 401);
  }

  const payload = await request.json().catch(() => null);
  if (!payload) return json({ error: "bad_request" }, 400);

  // MailerLite batches events under `events`; fall back to a single event body.
  const events = Array.isArray(payload.events) ? payload.events : [payload];

  const results = [];
  for (const event of events) {
    const subscriber = extractSubscriber(event);
    if (!subscriber || !subscriber.id) continue;

    // Only act on confirmed/active subscribers — this is what enforces the
    // double-opt-in red line: unconfirmed referrals are never credited.
    if (subscriber.status && subscriber.status !== "active") continue;

    results.push(await processConfirmedSubscriber(subscriber.id, env));
  }

  return json({ ok: true, processed: results.length, results });
}

/**
 * Idempotent confirmation handler. `pledged_at` doubles as the "fully
 * processed" marker: once it is set we have already minted a code and credited
 * any referrer, so re-deliveries are no-ops.
 */
async function processConfirmedSubscriber(subscriberId, env) {
  const sub = await mlGetSubscriber(env, subscriberId);
  if (!sub) return { id: subscriberId, skipped: "not_found" };

  const fields = sub.fields || {};
  if (fields.pledged_at) {
    return { id: subscriberId, skipped: "already_processed" };
  }

  // 1. Ensure this subscriber has their own referral code.
  const code = fields.referral_code || (await mintCode(env, sub.id));

  // 2. Credit the referrer, if any.
  let credited = null;
  const referredBy = (fields.referred_by || "").trim();
  if (referredBy) {
    credited = await creditReferrer(env, referredBy);
  }

  // 3. Stamp pledged_at last — this seals the idempotency gate.
  await mlUpdateSubscriber(env, sub.id, {
    referral_code: code,
    pledged_at: today(),
  });

  return { id: subscriberId, code, credited };
}

async function creditReferrer(env, referralCode) {
  const referrerId = await env.REFERRALS.get(`code:${referralCode}`);
  if (!referrerId) return { code: referralCode, found: false };

  const referrer = await mlGetSubscriber(env, referrerId);
  if (!referrer) return { code: referralCode, found: false };

  const current = parseInt((referrer.fields || {}).referral_count, 10);
  const next = (Number.isFinite(current) ? current : 0) + 1;

  await mlUpdateSubscriber(env, referrer.id, { referral_count: next });
  await updateLeaderboard(env, referralCode, next);
  return { code: referralCode, found: true, referral_count: next };
}

/* -------------------------------------------------------------------------- */
/* Read endpoint: thank-you page link + live count                            */
/* -------------------------------------------------------------------------- */

async function handleReferralLookup(url, env) {
  const email = (url.searchParams.get("email") || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return json({ error: "email_required" }, 400);
  }

  const sub = await mlGetSubscriber(env, email);
  if (!sub) {
    // Subscriber not visible yet (form just submitted). Return a friendly
    // "pending" so the thank-you page can poll or show a fallback.
    return json({ status: "pending" }, 202);
  }

  const fields = sub.fields || {};
  // Lazy-mint so the personal link works the instant they hit thank-you,
  // before the confirmation webhook has run. We do NOT set pledged_at here,
  // so the webhook still credits the referrer on confirmation.
  const code = fields.referral_code || (await mintCode(env, sub.id));

  const count = parseInt(fields.referral_count, 10);
  return json({
    status: sub.status === "active" ? "confirmed" : "pending_confirmation",
    referral_code: code,
    referral_count: Number.isFinite(count) ? count : 0,
    referral_link: `${shareBase(env)}/pledge/?ref=${code}`,
  });
}

/* -------------------------------------------------------------------------- */
/* Leaderboard (anonymised, arcade-style)                                     */
/* -------------------------------------------------------------------------- */

// Generated alias keeps the board fun and identity-free (Build Brief §6).
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

async function updateLeaderboard(env, code, count) {
  const list = await kvGetJSON(env, "lb:top", []);
  const existing = list.find((e) => e.code === code);
  if (existing) existing.count = count;
  else list.push({ code, alias: aliasFor(code), count });
  list.sort((a, b) => b.count - a.count);
  await kvPutJSON(env, "lb:top", list.slice(0, 50));
}

async function handleLeaderboard(url, env) {
  const limit = clamp(parseInt(url.searchParams.get("limit"), 10) || 20, 1, 50);
  const code = (url.searchParams.get("code") || "").trim();
  const list = await kvGetJSON(env, "lb:top", []);

  const top = list.slice(0, limit).map((e, i) => ({
    rank: i + 1,
    alias: e.alias,
    count: e.count,
  }));

  let you = null;
  if (code) {
    const idx = list.findIndex((e) => e.code === code);
    if (idx >= 0) {
      you = { rank: idx + 1, alias: list[idx].alias, count: list[idx].count };
    }
  }

  return json({ top, you, total: list.length });
}

/* -------------------------------------------------------------------------- */
/* Staffer console / outreach queue (staff-only)                              */
/* -------------------------------------------------------------------------- */

async function handleStaff(request, url, env) {
  if (!verifyToken(request, env.STAFF_TOKEN)) {
    return json({ error: "unauthorized" }, 401);
  }

  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;

  if (path === "/staff/opportunities") {
    if (method === "GET") return listOpportunities(url, env);
    if (method === "POST") return createOpportunity(await readBody(request), env);
  }

  const idMatch = path.match(/^\/staff\/opportunities\/([\w-]+)$/);
  if (idMatch && (method === "POST" || method === "PATCH")) {
    return updateOpportunity(idMatch[1], await readBody(request), env);
  }

  if (path === "/staff/claim" && method === "POST") {
    return claimOpportunity(await readBody(request), env);
  }
  if (path === "/staff/assign" && method === "POST") {
    return assignRoundRobin(await readBody(request), env);
  }
  if (path === "/staff/roster") {
    if (method === "GET") return json({ roster: await kvGetJSON(env, "staff:roster", []) });
    if (method === "POST") {
      const body = await readBody(request);
      const roster = Array.isArray(body.roster) ? body.roster.map(String) : [];
      await kvPutJSON(env, "staff:roster", roster);
      return json({ roster });
    }
  }
  if (path === "/staff/stats" && method === "GET") {
    return staffStats(env);
  }

  return json({ error: "not_found" }, 404);
}

async function createOpportunity(body, env) {
  // Guardrail: store a *public post* reference + workflow state only. We do not
  // accept or persist follower counts / profiling fields, even if sent.
  if (!body.postUrl && !body.topic) {
    return json({ error: "postUrl_or_topic_required" }, 400);
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
  await kvPutJSON(env, `opp:${opp.id}`, opp);
  const index = await kvGetJSON(env, "opp:index", []);
  index.push(opp.id);
  await kvPutJSON(env, "opp:index", index);
  return json({ opportunity: opp }, 201);
}

async function listOpportunities(url, env) {
  const status = url.searchParams.get("status");
  const assignedTo = url.searchParams.get("assignedTo");
  const all = await loadAllOpportunities(env);
  let items = all;
  if (status) items = items.filter((o) => o.status === status);
  if (assignedTo) items = items.filter((o) => o.assignedTo === assignedTo);
  // newest first, but prioritise higher-priority within the queue view
  items.sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
  return json({ opportunities: items, count: items.length });
}

async function updateOpportunity(id, body, env) {
  const opp = await kvGetJSON(env, `opp:${id}`, null);
  if (!opp) return json({ error: "not_found" }, 404);

  if (body.status !== undefined) {
    if (!OPP_STATUSES.includes(body.status)) {
      return json({ error: "invalid_status" }, 400);
    }
    if (body.status === "rework") {
      if (opp.reworkCount >= MAX_REWORK) {
        // Guardrail: never let re-work become repeat unsolicited contact.
        opp.status = "dropped";
        opp.note = appendNote(opp.note, "auto-dropped: re-work cap reached");
        await kvPutJSON(env, `opp:${id}`, touch(opp));
        return json({ opportunity: opp, note: "rework_cap_reached_dropped" });
      }
      opp.reworkCount += 1;
      opp.assignedTo = null;
      opp.assignedAt = null;
    }
    opp.status = body.status;
  }
  if (body.outcome !== undefined) {
    if (body.outcome !== null && !OPP_OUTCOMES.includes(body.outcome)) {
      return json({ error: "invalid_outcome" }, 400);
    }
    opp.outcome = body.outcome;
  }
  if (body.assignedTo !== undefined) opp.assignedTo = body.assignedTo ? String(body.assignedTo) : null;
  if (body.priority !== undefined) opp.priority = clamp(parseInt(body.priority, 10) || opp.priority, 1, 3);
  if (body.note !== undefined) opp.note = str(body.note, 1000);
  // "Did you vote?" follow-up logs only THAT contact happened — never the answer.
  if (body.followedUp !== undefined) opp.followedUp = !!body.followedUp;

  await kvPutJSON(env, `opp:${id}`, touch(opp));
  return json({ opportunity: opp });
}

async function claimOpportunity(body, env) {
  const staffer = str(body.staffer, 60);
  if (!staffer) return json({ error: "staffer_required" }, 400);

  const all = await loadAllOpportunities(env);
  const queue = all
    .filter((o) => o.status === "new" || o.status === "rework")
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));

  const next = queue[0];
  if (!next) return json({ claimed: null, message: "queue_empty" });

  next.status = "assigned";
  next.assignedTo = staffer;
  next.assignedAt = new Date().toISOString();
  await kvPutJSON(env, `opp:${next.id}`, touch(next));
  return json({ claimed: next });
}

async function assignRoundRobin(body, env) {
  const roster =
    Array.isArray(body.staffers) && body.staffers.length
      ? body.staffers.map(String)
      : await kvGetJSON(env, "staff:roster", []);
  if (!roster.length) return json({ error: "no_roster" }, 400);

  const all = await loadAllOpportunities(env);
  const queue = all
    .filter((o) => o.status === "new")
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));

  let pointer = (await kvGetJSON(env, "staff:rotation", 0)) | 0;
  const assignments = [];
  const now = new Date().toISOString();
  for (const opp of queue) {
    const staffer = roster[pointer % roster.length];
    pointer++;
    opp.status = "assigned";
    opp.assignedTo = staffer;
    opp.assignedAt = now;
    await kvPutJSON(env, `opp:${opp.id}`, touch(opp));
    assignments.push({ id: opp.id, assignedTo: staffer });
  }
  await kvPutJSON(env, "staff:rotation", pointer);
  return json({ assigned: assignments.length, assignments });
}

async function staffStats(env) {
  const all = await loadAllOpportunities(env);
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
  return json({
    total: all.length,
    byStatus,
    byOutcome,
    byStaffer,
    followedUp,
  });
}

async function loadAllOpportunities(env) {
  const index = await kvGetJSON(env, "opp:index", []);
  const items = await Promise.all(index.map((id) => kvGetJSON(env, `opp:${id}`, null)));
  return items.filter(Boolean);
}

/* -------------------------------------------------------------------------- */
/* Referral codes                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Generate a unique code, persist the code -> subscriber-id index in KV, and
 * write the code back onto the subscriber. Retries on the (vanishingly rare)
 * KV collision.
 */
async function mintCode(env, subscriberId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const existing = await env.REFERRALS.get(`code:${code}`);
    if (existing && existing !== String(subscriberId)) continue; // collision
    await env.REFERRALS.put(`code:${code}`, String(subscriberId));
    await mlUpdateSubscriber(env, subscriberId, { referral_code: code });
    return code;
  }
  throw new Error("could not mint a unique referral code after 5 attempts");
}

function randomCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* MailerLite client                                                          */
/* -------------------------------------------------------------------------- */

async function mlFetch(env, method, path, body) {
  const res = await fetch(`${ML_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.MAILERLITE_API_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 404) return { status: 404, data: null };
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      `MailerLite ${method} ${path} -> ${res.status} ${JSON.stringify(data)}`
    );
  }
  return { status: res.status, data };
}

// Identifier may be a subscriber id or an email — both are accepted by the API.
async function mlGetSubscriber(env, identifier) {
  const { data } = await mlFetch(
    env,
    "GET",
    `/subscribers/${encodeURIComponent(identifier)}`
  );
  return data ? data.data : null;
}

async function mlUpdateSubscriber(env, subscriberId, fields) {
  const { data } = await mlFetch(env, "PUT", `/subscribers/${subscriberId}`, {
    fields,
  });
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

async function kvGetJSON(env, key, def) {
  const raw = await env.REFERRALS.get(key);
  return raw ? JSON.parse(raw) : def;
}

async function kvPutJSON(env, key, val) {
  await env.REFERRALS.put(key, JSON.stringify(val));
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
  return (env.SITE_BASE_URL || "https://james4nationwide.co.uk").replace(/\/+$/, "");
}

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD for MailerLite date field
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function cors(env, response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", shareBase(env));
  headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-Staff-Token, X-Webhook-Token");
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}
