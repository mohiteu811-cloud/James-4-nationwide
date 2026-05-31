import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { ReferralLedger, OutreachQueue } from "../src/index.js";

/* In-memory MailerLite + Durable Objects so we exercise the real worker +
   DO code paths end to end. */

function makeStorage() {
  const m = new Map();
  return {
    async get(k) {
      return m.has(k) ? structuredClone(m.get(k)) : undefined;
    },
    async put(k, v) {
      m.set(k, structuredClone(v));
    },
    async delete(k) {
      return m.delete(k);
    },
    async list({ prefix } = {}) {
      const out = new Map();
      for (const [k, v] of m) if (!prefix || k.startsWith(prefix)) out.set(k, structuredClone(v));
      return out;
    },
  };
}

// Fake DurableObjectNamespace: one instance per name, routed via fetch.
function makeNamespace(DOClass, env) {
  const instances = new Map();
  return {
    idFromName: (name) => ({ name }),
    get: (id) => {
      if (!instances.has(id.name)) instances.set(id.name, new DOClass({ storage: makeStorage() }, env));
      const inst = instances.get(id.name);
      return { fetch: (req) => inst.fetch(req) };
    },
  };
}

function makeEnv() {
  const subscribers = new Map(); // id -> { id, email, status, fields }
  const byEmail = new Map();
  let nextId = 1000;

  function addSubscriber({ email, status = "active", fields = {}, groups }) {
    const id = String(nextId++);
    const sub = { id, email, status, fields: { ...fields } };
    if (groups) sub.groups = groups;
    subscribers.set(id, sub);
    byEmail.set(email.toLowerCase(), id);
    return sub;
  }

  // Stub global fetch to emulate the MailerLite Connect API.
  globalThis.fetch = async (urlStr, opts = {}) => {
    const url = new URL(urlStr);
    const parts = url.pathname.split("/").filter(Boolean); // ["api","subscribers",id]
    const ident = decodeURIComponent(parts[2] || "");
    const method = opts.method || "GET";
    let id = subscribers.has(ident) ? ident : byEmail.get(ident.toLowerCase());

    if (method === "GET") {
      if (!id) return resp(404, {});
      return resp(200, { data: subscribers.get(id) });
    }
    if (method === "PUT") {
      const body = JSON.parse(opts.body);
      const sub = subscribers.get(id);
      sub.fields = { ...sub.fields, ...body.fields };
      return resp(200, { data: sub });
    }
    return resp(405, {});
  };

  const env = {
    MAILERLITE_API_TOKEN: "test-token",
    WEBHOOK_SECRET: "s3cret",
    STAFF_TOKEN: "staff-s3cret",
    SITE_BASE_URL: "https://james4nationwide.co.uk",
  };
  env.REFERRAL_LEDGER = makeNamespace(ReferralLedger, env);
  env.OUTREACH_QUEUE = makeNamespace(OutreachQueue, env);

  // Direct ledger access for seeding existing pledgers.
  const ledger = (action, payload) =>
    env.REFERRAL_LEDGER.get(env.REFERRAL_LEDGER.idFromName("ledger"))
      .fetch(new Request("https://do/" + action, { method: "POST", body: JSON.stringify(payload) }))
      .then((r) => r.json());

  return { env, addSubscriber, subscribers, ledger };
}

function resp(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const call = (env, url, init) => worker.fetch(new Request(url, init), env, {});

// Fire a MailerLite "subscriber confirmed" webhook for one subscriber id.
const fireWebhook = (ctx, id, status = "active") =>
  call(ctx.env, "https://w/webhook?token=s3cret", {
    method: "POST",
    body: JSON.stringify({ events: [{ data: { subscriber: { id, status } } }] }),
  });

const leaderboard = (ctx, code) =>
  call(ctx.env, "https://w/leaderboard?code=" + encodeURIComponent(code)).then((r) => r.json());

/* ----------------------------- referral flow ---------------------------- */

test("the browser-generated referral_code is claimed on confirmation, then credited", async () => {
  const ctx = makeEnv();
  // Referrer confirms; the code their browser generated rides in on the form.
  const ref = ctx.addSubscriber({ email: "ref@example.com", status: "active", fields: { referral_code: "alphacode0000001" } });
  await fireWebhook(ctx, ref.id);
  assert.equal(ctx.subscribers.get(ref.id).fields.referral_code, "alphacode0000001"); // claimed, not replaced
  assert.ok(ctx.subscribers.get(ref.id).fields.pledged_at);

  // Referee pledges through that code and confirms — proving it was registered.
  const newbie = ctx.addSubscriber({
    email: "bob@example.com",
    status: "active",
    fields: { referred_by: "alphacode0000001", referral_code: "bobcode000000001" },
  });
  await fireWebhook(ctx, newbie.id);

  const lb = await leaderboard(ctx, "alphacode0000001");
  assert.equal(lb.you.count, 1);
  assert.equal(ctx.subscribers.get(ref.id).fields.referral_count, 1); // mirrored to MailerLite
});

test("an email never reaches the backend — there is no email lookup endpoint", async () => {
  const ctx = makeEnv();
  ctx.addSubscriber({ email: "alice@example.com", status: "active" });
  const res = await call(ctx.env, "https://w/referral?email=alice@example.com");
  assert.equal(res.status, 404); // endpoint removed entirely — no oracle
});

test("confirmation webhook credits the referrer exactly once (idempotent)", async () => {
  const ctx = makeEnv();
  const referrer = ctx.addSubscriber({
    email: "ref@example.com",
    fields: { referral_code: "ABCDEFG", referral_count: 2 },
  });
  await ctx.ledger("register", { subscriberId: referrer.id, code: "ABCDEFG", count: 2 });

  const newbie = ctx.addSubscriber({
    email: "bob@example.com",
    status: "active",
    fields: { referred_by: "ABCDEFG" },
  });

  const fire = () =>
    call(ctx.env, "https://w/webhook?token=s3cret", {
      method: "POST",
      body: JSON.stringify({
        events: [{ type: "subscriber.updated", data: { subscriber: { id: newbie.id, status: "active" } } }],
      }),
    });

  await (await fire()).json();
  await (await fire()).json(); // re-delivery must be a no-op

  assert.equal(ctx.subscribers.get(referrer.id).fields.referral_count, 3);
  assert.ok(ctx.subscribers.get(newbie.id).fields.pledged_at);
  assert.ok(ctx.subscribers.get(newbie.id).fields.referral_code);
});

test("webhook rejects a bad/missing token", async () => {
  const ctx = makeEnv();
  const res = await call(ctx.env, "https://w/webhook?token=wrong", {
    method: "POST",
    body: JSON.stringify({ events: [] }),
  });
  assert.equal(res.status, 401);
});

test("unconfirmed subscribers are not credited", async () => {
  const ctx = makeEnv();
  const referrer = ctx.addSubscriber({ email: "ref@example.com", fields: { referral_code: "ZZZ2345", referral_count: 0 } });
  await ctx.ledger("register", { subscriberId: referrer.id, code: "ZZZ2345", count: 0 });
  const newbie = ctx.addSubscriber({
    email: "carol@example.com",
    status: "unconfirmed",
    fields: { referred_by: "ZZZ2345" },
  });

  await call(ctx.env, "https://w/webhook?token=s3cret", {
    method: "POST",
    body: JSON.stringify({ events: [{ data: { subscriber: { id: newbie.id, status: "unconfirmed" } } }] }),
  });

  assert.equal(ctx.subscribers.get(referrer.id).fields.referral_count, 0);
});

test("out-of-order confirmation: a referee who confirms before the referrer is still credited", async () => {
  const ctx = makeEnv();
  // Referee confirms FIRST, through a code whose owner hasn't confirmed yet.
  const newbie = ctx.addSubscriber({
    email: "late@example.com",
    status: "active",
    fields: { referred_by: "betacode00000099", referral_code: "newbiecode000001" },
  });
  await fireWebhook(ctx, newbie.id);
  // Nothing credited yet — the referral is buffered, not lost.
  assert.equal((await leaderboard(ctx, "betacode00000099")).you, null);

  // Referrer confirms and registers the code — the buffer flushes.
  const ref = ctx.addSubscriber({ email: "early@example.com", status: "active", fields: { referral_code: "betacode00000099" } });
  await fireWebhook(ctx, ref.id);
  assert.equal((await leaderboard(ctx, "betacode00000099")).you.count, 1);
  assert.equal(ctx.subscribers.get(ref.id).fields.referral_count, 1); // mirrored

  // Re-delivering either webhook must not double-credit.
  await fireWebhook(ctx, ref.id);
  await fireWebhook(ctx, newbie.id);
  assert.equal((await leaderboard(ctx, "betacode00000099")).you.count, 1);
});

test("a code collision is resolved first-write-wins; the loser gets a fresh minted code", async () => {
  const ctx = makeEnv();
  const first = ctx.addSubscriber({ email: "first@example.com", status: "active", fields: { referral_code: "dupcode000000007" } });
  const second = ctx.addSubscriber({ email: "second@example.com", status: "active", fields: { referral_code: "dupcode000000007" } });
  await fireWebhook(ctx, first.id);
  await fireWebhook(ctx, second.id);

  assert.equal(ctx.subscribers.get(first.id).fields.referral_code, "dupcode000000007"); // keeps it
  const secondCode = ctx.subscribers.get(second.id).fields.referral_code;
  assert.notEqual(secondCode, "dupcode000000007");
  assert.match(secondCode, /^[A-Z2-9]{7}$/); // server-minted replacement, mirrored back

  // The disputed code still belongs to the first claimant.
  const newbie = ctx.addSubscriber({ email: "n@example.com", status: "active", fields: { referred_by: "dupcode000000007" } });
  await fireWebhook(ctx, newbie.id);
  assert.equal((await leaderboard(ctx, "dupcode000000007")).you.count, 1);
  assert.equal(ctx.subscribers.get(first.id).fields.referral_count, 1);
});

test("a missing or invalid referral_code (old form / migration) is replaced by a minted one", async () => {
  const ctx = makeEnv();
  const noCode = ctx.addSubscriber({ email: "old@example.com", status: "active" }); // no referral_code field
  const badCode = ctx.addSubscriber({ email: "bad@example.com", status: "active", fields: { referral_code: "has spaces & symbols!" } });
  await fireWebhook(ctx, noCode.id);
  await fireWebhook(ctx, badCode.id);

  assert.match(ctx.subscribers.get(noCode.id).fields.referral_code, /^[A-Z2-9]{7}$/);
  assert.match(ctx.subscribers.get(badCode.id).fields.referral_code, /^[A-Z2-9]{7}$/);
  assert.ok(ctx.subscribers.get(noCode.id).fields.pledged_at);
});

test("a too-short hand-edited referral_code is rejected and replaced by a minted one", async () => {
  const ctx = makeEnv();
  // Someone edits the hidden field to a trivially guessable value.
  const s = ctx.addSubscriber({ email: "tamper@example.com", status: "active", fields: { referral_code: "A" } });
  await fireWebhook(ctx, s.id);

  const code = ctx.subscribers.get(s.id).fields.referral_code;
  assert.notEqual(code, "A");
  assert.match(code, /^[A-Z2-9]{7}$/); // server-minted, not the guessable proposal
  // The guessable value was never registered, so it isn't a live leaderboard key.
  assert.equal((await leaderboard(ctx, "A")).you, null);
});

test("rate limiting kicks in on the public leaderboard endpoint", async () => {
  const ctx = makeEnv();
  let last;
  for (let i = 0; i < 31; i++) {
    last = await call(ctx.env, "https://w/leaderboard?code=ABCDEFG");
  }
  assert.equal(last.status, 429);
});

test("a confirmation event for a still-unconfirmed subscriber is not credited", async () => {
  const ctx = makeEnv();
  const referrer = ctx.addSubscriber({ email: "r@example.com", fields: { referral_code: "STAT123" } });
  await ctx.ledger("register", { subscriberId: referrer.id, code: "STAT123", count: 0 });
  // Fetched record is unconfirmed even though the event claims active.
  const newbie = ctx.addSubscriber({ email: "u@example.com", status: "unconfirmed", fields: { referred_by: "STAT123" } });

  await call(ctx.env, "https://w/webhook?token=s3cret", {
    method: "POST",
    body: JSON.stringify({ events: [{ data: { subscriber: { id: newbie.id, status: "active" } } }] }),
  });

  const lb = await (await call(ctx.env, "https://w/leaderboard?code=STAT123")).json();
  assert.equal(lb.you, null);
});

test("self-referrals are not credited", async () => {
  const ctx = makeEnv();
  // Someone reopened their own ?ref= link, so referred_by == their own code.
  const me = ctx.addSubscriber({
    email: "me@example.com",
    status: "active",
    fields: { referral_code: "myowncode0000001", referred_by: "myowncode0000001" },
  });
  await fireWebhook(ctx, me.id);

  const lb = await leaderboard(ctx, "myowncode0000001");
  assert.equal(lb.you, null); // count stayed 0
});

test("the Pledgers group restriction blocks non-members when configured", async () => {
  const ctx = makeEnv();
  ctx.env.PLEDGERS_GROUP_ID = "999";
  const referrer = ctx.addSubscriber({ email: "r@example.com", fields: { referral_code: "GRP123" } });
  await ctx.ledger("register", { subscriberId: referrer.id, code: "GRP123", count: 0 });

  // Active subscriber, but only in the Weekly group (111), not Pledgers (999).
  const outsider = ctx.addSubscriber({
    email: "weekly@example.com",
    status: "active",
    fields: { referred_by: "GRP123" },
    groups: [{ id: "111" }],
  });
  await call(ctx.env, "https://w/webhook?token=s3cret", {
    method: "POST",
    body: JSON.stringify({ events: [{ data: { subscriber: { id: outsider.id, status: "active" } } }] }),
  });
  assert.equal((await (await call(ctx.env, "https://w/leaderboard?code=GRP123")).json()).you, null);

  // A real pledger in group 999 is credited.
  const pledger = ctx.addSubscriber({
    email: "pledger@example.com",
    status: "active",
    fields: { referred_by: "GRP123" },
    groups: [{ id: "999" }],
  });
  await call(ctx.env, "https://w/webhook?token=s3cret", {
    method: "POST",
    body: JSON.stringify({ events: [{ data: { subscriber: { id: pledger.id, status: "active" } } }] }),
  });
  assert.equal((await (await call(ctx.env, "https://w/leaderboard?code=GRP123")).json()).you.count, 1);
});

/* ----------------------------- leaderboard ----------------------------- */

test("a caller beyond the top 50 still gets their real rank", async () => {
  const ctx = makeEnv();
  for (let i = 1; i <= 55; i++) {
    await ctx.ledger("register", { subscriberId: String(9000 + i), code: "C" + i, count: i });
  }
  // The referrer with count 1 sits at rank 55 — must not be null despite the
  // top-50 display truncation.
  const lb = await (await call(ctx.env, "https://w/leaderboard?code=C1")).json();
  assert.equal(lb.top.length, 20);
  assert.equal(lb.you.count, 1);
  assert.equal(lb.you.rank, 55);
});

test("crediting a referrer puts them on the anonymised leaderboard", async () => {
  const ctx = makeEnv();
  const referrer = ctx.addSubscriber({ email: "ref@example.com", fields: { referral_code: "LEAD123" } });
  await ctx.ledger("register", { subscriberId: referrer.id, code: "LEAD123", count: 0 });

  for (const email of ["a@example.com", "b@example.com"]) {
    const n = ctx.addSubscriber({ email, status: "active", fields: { referred_by: "LEAD123" } });
    await call(ctx.env, "https://w/webhook?token=s3cret", {
      method: "POST",
      body: JSON.stringify({ events: [{ data: { subscriber: { id: n.id, status: "active" } } }] }),
    });
  }

  const body = await (await call(ctx.env, "https://w/leaderboard?code=LEAD123")).json();
  assert.equal(body.top.length, 1);
  assert.equal(body.top[0].rank, 1);
  assert.equal(body.top[0].count, 2);
  assert.match(body.top[0].alias, /^[A-Z][a-z]+ [A-Z][a-z]+$/); // "Swift Otter"
  assert.ok(!("code" in body.top[0])); // never leak the code/identity
  assert.deepEqual(body.you, { rank: 1, alias: body.top[0].alias, count: 2 });
});

/* --------------------------- staffer console --------------------------- */

const staff = (env, path, init = {}) =>
  call(env, "https://w" + path, { ...init, headers: { "x-staff-token": "staff-s3cret", ...(init.headers || {}) } });

test("staff endpoints reject a missing token", async () => {
  const ctx = makeEnv();
  assert.equal((await call(ctx.env, "https://w/staff/stats")).status, 401);
});

test("staff endpoints reflect the request Origin in CORS (console can run anywhere)", async () => {
  const ctx = makeEnv();
  const res = await staff(ctx.env, "/staff/stats", { headers: { Origin: "http://localhost:5500" } });
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "http://localhost:5500");
});

test("opportunity lifecycle: create -> round-robin assign -> convert -> stats", async () => {
  const ctx = makeEnv();
  await staff(ctx.env, "/staff/roster", { method: "POST", body: JSON.stringify({ roster: ["Alex", "Sam"] }) });

  const ids = [];
  for (const topic of ["FairerShare", "AGM", "Quick Vote"]) {
    const r = await staff(ctx.env, "/staff/opportunities", {
      method: "POST",
      body: JSON.stringify({ topic, platform: "x", postUrl: "https://x.com/p/" + topic }),
    });
    ids.push((await r.json()).opportunity.id);
  }

  const assign = await (await staff(ctx.env, "/staff/assign", { method: "POST", body: "{}" })).json();
  assert.equal(assign.assigned, 3);
  assert.deepEqual(assign.assignments.map((a) => a.assignedTo), ["Alex", "Sam", "Alex"]);

  await staff(ctx.env, "/staff/opportunities/" + ids[0], {
    method: "POST",
    body: JSON.stringify({ status: "converted", outcome: "pledged", followedUp: true }),
  });

  const stats = await (await staff(ctx.env, "/staff/stats")).json();
  assert.equal(stats.total, 3);
  assert.equal(stats.byStatus.assigned, 2);
  assert.equal(stats.byStatus.converted, 1);
  assert.equal(stats.byOutcome.pledged, 1);
  assert.equal(stats.followedUp, 1);
  assert.equal(stats.byStaffer.Alex.converted, 1);
});

test("re-work is capped so it can never become repeat unsolicited contact", async () => {
  const ctx = makeEnv();
  const id = (await (await staff(ctx.env, "/staff/opportunities", { method: "POST", body: JSON.stringify({ topic: "FairerShare" }) })).json()).opportunity.id;

  for (let i = 0; i < 2; i++) {
    const res = await staff(ctx.env, "/staff/opportunities/" + id, { method: "POST", body: JSON.stringify({ status: "rework" }) });
    assert.equal((await res.json()).opportunity.status, "rework");
  }
  const body = await (await staff(ctx.env, "/staff/opportunities/" + id, { method: "POST", body: JSON.stringify({ status: "rework" }) })).json();
  assert.equal(body.note, "rework_cap_reached_dropped");
  assert.equal(body.opportunity.status, "dropped");
});

test("opportunity creation rejects non-http(s) URLs (no javascript: links)", async () => {
  const ctx = makeEnv();
  const bad = await staff(ctx.env, "/staff/opportunities", {
    method: "POST",
    body: JSON.stringify({ topic: "x", postUrl: "javascript:alert(document.cookie)" }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "invalid_post_url");

  const ok = await staff(ctx.env, "/staff/opportunities", {
    method: "POST",
    body: JSON.stringify({ topic: "x", postUrl: "https://x.com/p/1" }),
  });
  assert.equal(ok.status, 201);
});

test("claim pulls the highest-priority item first and assigns it", async () => {
  const ctx = makeEnv();
  await staff(ctx.env, "/staff/opportunities", { method: "POST", body: JSON.stringify({ topic: "low", priority: 1 }) });
  await staff(ctx.env, "/staff/opportunities", { method: "POST", body: JSON.stringify({ topic: "high", priority: 3 }) });

  const claimed = await (await staff(ctx.env, "/staff/claim", { method: "POST", body: JSON.stringify({ staffer: "Sam" }) })).json();
  assert.equal(claimed.claimed.topic, "high");
  assert.equal(claimed.claimed.assignedTo, "Sam");
  assert.equal(claimed.claimed.status, "assigned");
});
