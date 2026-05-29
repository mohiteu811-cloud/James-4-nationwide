/**
 * James4Nationwide — "Pledge & Remind" referral function.
 *
 * The one custom-engineered component of the campaign (Build Brief §4).
 * State lives in MailerLite custom fields; the only extra storage is a tiny,
 * non-PII Cloudflare KV index mapping a public `referral_code` -> MailerLite
 * subscriber id, so we can credit a referrer without scanning the whole list.
 *
 * Two responsibilities:
 *   1. POST /webhook  — fired by MailerLite when a subscriber is confirmed.
 *                       Ensures the new subscriber has a referral_code and, if
 *                       they arrived via someone's ?ref= code, increments that
 *                       referrer's referral_count exactly once.
 *   2. GET  /referral — read endpoint the thank-you page calls to show the
 *                       supporter their personal link + live "voters brought in"
 *                       count. Lazily mints a code so the link works instantly,
 *                       even before double opt-in confirmation.
 *
 * No individual vote tracking. No member-register data. Minimal PII. (§6)
 */

const ML_API = "https://connect.mailerlite.com/api";

// Unambiguous alphabet (no 0/O/1/I/L) so codes are easy to read aloud / type.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 7;

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
  if (!verifyWebhookToken(request, env)) {
    return json({ error: "unauthorized" }, 401);
  }

  const payload = await request.json().catch(() => null);
  if (!payload) return json({ error: "bad_request" }, 400);

  // MailerLite batches events under `events`; fall back to a single event body.
  const events = Array.isArray(payload.events)
    ? payload.events
    : [payload];

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

function verifyWebhookToken(request, env) {
  const expected = env.WEBHOOK_SECRET;
  if (!expected) return false; // fail closed if misconfigured
  const url = new URL(request.url);
  const provided =
    url.searchParams.get("token") ||
    request.headers.get("x-webhook-token") ||
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

function shareBase(env) {
  return (env.SITE_BASE_URL || "https://james4nationwide.co.uk").replace(
    /\/+$/,
    ""
  );
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
  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}
