import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

/* In-memory MailerLite + KV so we can exercise the real worker code paths. */

function makeEnv() {
  const subscribers = new Map(); // id -> { id, email, status, fields }
  const byEmail = new Map(); // email -> id
  let nextId = 1000;

  function addSubscriber({ email, status = "active", fields = {} }) {
    const id = String(nextId++);
    const sub = { id, email, status, fields: { ...fields } };
    subscribers.set(id, sub);
    byEmail.set(email.toLowerCase(), id);
    return sub;
  }

  const kv = (() => {
    const m = new Map();
    return {
      get: async (k) => (m.has(k) ? m.get(k) : null),
      put: async (k, v) => void m.set(k, v),
    };
  })();

  // Stub global fetch to emulate the MailerLite Connect API.
  globalThis.fetch = async (urlStr, opts = {}) => {
    const url = new URL(urlStr);
    const parts = url.pathname.split("/").filter(Boolean); // ["api","subscribers",id]
    const ident = decodeURIComponent(parts[2] || "");
    const method = opts.method || "GET";

    let id = subscribers.has(ident) ? ident : byEmail.get(ident.toLowerCase());

    if (method === "GET") {
      if (!id) return jsonResponse(404, {});
      return jsonResponse(200, { data: subscribers.get(id) });
    }
    if (method === "PUT") {
      const body = JSON.parse(opts.body);
      const sub = subscribers.get(id);
      sub.fields = { ...sub.fields, ...body.fields };
      return jsonResponse(200, { data: sub });
    }
    return jsonResponse(405, {});
  };

  return {
    env: {
      MAILERLITE_API_TOKEN: "test-token",
      WEBHOOK_SECRET: "s3cret",
      STAFF_TOKEN: "staff-s3cret",
      SITE_BASE_URL: "https://james4nationwide.co.uk",
      REFERRALS: kv,
    },
    addSubscriber,
    subscribers,
    kv,
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const call = (env, url, init) => worker.fetch(new Request(url, init), env, {});

test("lookup lazily mints a code and returns a working link without sealing pledged_at", async () => {
  const ctx = makeEnv();
  ctx.addSubscriber({ email: "alice@example.com", status: "unconfirmed" });

  const res = await call(
    ctx.env,
    "https://w/referral?email=alice@example.com"
  );
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.match(body.referral_code, /^[A-Z2-9]{7}$/);
  assert.equal(body.referral_count, 0);
  assert.equal(
    body.referral_link,
    `https://james4nationwide.co.uk/pledge/?ref=${body.referral_code}`
  );
  // Must NOT have stamped pledged_at — the webhook still needs to credit later.
  const sub = [...ctx.subscribers.values()][0];
  assert.equal(sub.fields.pledged_at, undefined);
  // Code must be resolvable back to the subscriber via KV.
  assert.equal(await ctx.kv.get(`code:${body.referral_code}`), sub.id);
});

test("confirmation webhook credits the referrer exactly once (idempotent)", async () => {
  const ctx = makeEnv();
  const referrer = ctx.addSubscriber({
    email: "ref@example.com",
    fields: { referral_code: "ABCDEFG", referral_count: 2 },
  });
  await ctx.kv.put("code:ABCDEFG", referrer.id);

  const newbie = ctx.addSubscriber({
    email: "bob@example.com",
    status: "active",
    fields: { referred_by: "ABCDEFG" },
  });

  const fire = () =>
    call(ctx.env, "https://w/webhook?token=s3cret", {
      method: "POST",
      body: JSON.stringify({
        events: [
          { type: "subscriber.updated", data: { subscriber: { id: newbie.id, status: "active" } } },
        ],
      }),
    });

  await (await fire()).json();
  // Re-deliver the same event: pledged_at gate should make it a no-op.
  await (await fire()).json();

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
  const referrer = ctx.addSubscriber({
    email: "ref@example.com",
    fields: { referral_code: "ZZZ2345", referral_count: 0 },
  });
  await ctx.kv.put("code:ZZZ2345", referrer.id);
  const newbie = ctx.addSubscriber({
    email: "carol@example.com",
    status: "unconfirmed",
    fields: { referred_by: "ZZZ2345" },
  });

  await call(ctx.env, "https://w/webhook?token=s3cret", {
    method: "POST",
    body: JSON.stringify({
      events: [{ data: { subscriber: { id: newbie.id, status: "unconfirmed" } } }],
    }),
  });

  assert.equal(ctx.subscribers.get(referrer.id).fields.referral_count, 0);
});

/* ----------------------------- leaderboard ----------------------------- */

test("crediting a referrer puts them on the anonymised leaderboard", async () => {
  const ctx = makeEnv();
  const referrer = ctx.addSubscriber({
    email: "ref@example.com",
    fields: { referral_code: "LEAD123", referral_count: 0 },
  });
  await ctx.kv.put("code:LEAD123", referrer.id);

  // two confirmed referrals through LEAD123
  for (const email of ["a@example.com", "b@example.com"]) {
    const n = ctx.addSubscriber({ email, status: "active", fields: { referred_by: "LEAD123" } });
    await call(ctx.env, "https://w/webhook?token=s3cret", {
      method: "POST",
      body: JSON.stringify({ events: [{ data: { subscriber: { id: n.id, status: "active" } } }] }),
    });
  }

  const res = await call(ctx.env, "https://w/leaderboard?code=LEAD123");
  const body = await res.json();

  assert.equal(body.top.length, 1);
  assert.equal(body.top[0].rank, 1);
  assert.equal(body.top[0].count, 2);
  assert.match(body.top[0].alias, /^[A-Z][a-z]+ [A-Z][a-z]+$/); // "Swift Otter"
  assert.ok(!("code" in body.top[0])); // never leak the code/identity
  assert.deepEqual(body.you, { rank: 1, alias: body.top[0].alias, count: 2 });
});

/* --------------------------- staffer console --------------------------- */

const staff = (env, path, init = {}) =>
  call(env, "https://w" + path, {
    ...init,
    headers: { "x-staff-token": "staff-s3cret", ...(init.headers || {}) },
  });

test("staff endpoints reject a missing token", async () => {
  const ctx = makeEnv();
  const res = await call(ctx.env, "https://w/staff/stats");
  assert.equal(res.status, 401);
});

test("opportunity lifecycle: create -> round-robin assign -> convert -> stats", async () => {
  const ctx = makeEnv();
  await staff(ctx.env, "/staff/roster", {
    method: "POST",
    body: JSON.stringify({ roster: ["Alex", "Sam"] }),
  });

  const ids = [];
  for (const topic of ["FairerShare", "AGM", "Quick Vote"]) {
    const r = await staff(ctx.env, "/staff/opportunities", {
      method: "POST",
      body: JSON.stringify({ topic, platform: "x", postUrl: "https://x.com/p/" + topic }),
    });
    ids.push((await r.json()).opportunity.id);
  }

  const assignRes = await staff(ctx.env, "/staff/assign", { method: "POST", body: "{}" });
  const assign = await assignRes.json();
  assert.equal(assign.assigned, 3);
  // round robin Alex, Sam, Alex
  assert.deepEqual(
    assign.assignments.map((a) => a.assignedTo),
    ["Alex", "Sam", "Alex"]
  );

  // convert the first one
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
  const r = await staff(ctx.env, "/staff/opportunities", {
    method: "POST",
    body: JSON.stringify({ topic: "FairerShare" }),
  });
  const id = (await r.json()).opportunity.id;

  // send to rework MAX_REWORK (2) times — both allowed
  for (let i = 0; i < 2; i++) {
    const res = await staff(ctx.env, "/staff/opportunities/" + id, {
      method: "POST",
      body: JSON.stringify({ status: "rework" }),
    });
    assert.equal((await res.json()).opportunity.status, "rework");
  }
  // third time trips the cap -> auto-dropped
  const res = await staff(ctx.env, "/staff/opportunities/" + id, {
    method: "POST",
    body: JSON.stringify({ status: "rework" }),
  });
  const body = await res.json();
  assert.equal(body.note, "rework_cap_reached_dropped");
  assert.equal(body.opportunity.status, "dropped");
});

test("claim pulls the highest-priority item first", async () => {
  const ctx = makeEnv();
  await staff(ctx.env, "/staff/opportunities", {
    method: "POST",
    body: JSON.stringify({ topic: "low", priority: 1 }),
  });
  await staff(ctx.env, "/staff/opportunities", {
    method: "POST",
    body: JSON.stringify({ topic: "high", priority: 3 }),
  });

  const claimed = await (
    await staff(ctx.env, "/staff/claim", {
      method: "POST",
      body: JSON.stringify({ staffer: "Sam" }),
    })
  ).json();

  assert.equal(claimed.claimed.topic, "high");
  assert.equal(claimed.claimed.assignedTo, "Sam");
  assert.equal(claimed.claimed.status, "assigned");
});
