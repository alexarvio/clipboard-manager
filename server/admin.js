// Internal admin dashboard: total users, Free vs Pro split, signups, and
// real revenue numbers pulled live from Stripe. Deliberately its own module
// (same pattern as billing.js/email.js) rather than more routes bolted onto
// index.js -- this is a distinct, self-contained feature, not part of the
// app's own API surface.
//
// Auth: HTTP Basic Auth gated on a single ADMIN_PASSWORD env var. No
// session/cookie machinery -- this is a single-owner internal tool, not a
// multi-user surface, so the browser's native Basic Auth prompt (over HTTPS,
// which Railway terminates for us) is enough. Not wired into the users
// table or JWT auth at all on purpose: an admin dashboard shouldn't be
// reachable just because someone's Clip account session leaked.

const crypto = require("crypto");
const express = require("express");
const { pool } = require("./db");
const billing = require("./billing");

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

if (!ADMIN_PASSWORD) {
  console.warn(
    "[clip-server] WARNING: ADMIN_PASSWORD is not set. /admin will refuse all requests until it is. " +
      "Generate one with: openssl rand -hex 20"
  );
}

// Constant-time compare via crypto.timingSafeEqual -- a plain `===` here
// would let response timing leak how many leading characters of the
// password guess were correct, the same reason password hashes are compared
// this way elsewhere.
function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(500).send("Admin dashboard is not configured (ADMIN_PASSWORD not set).");
  }

  const header = req.header("authorization") || "";
  const [scheme, encoded] = header.split(" ");
  const unauthorized = () => {
    res.set("WWW-Authenticate", 'Basic realm="FatClipboard Admin"');
    res.status(401).send("Authentication required.");
  };

  if (scheme !== "Basic" || !encoded) return unauthorized();

  let password = "";
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    password = decoded.slice(decoded.indexOf(":") + 1);
  } catch {
    return unauthorized();
  }

  const providedBuf = Buffer.from(password);
  const expectedBuf = Buffer.from(ADMIN_PASSWORD);
  const ok =
    providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
  if (!ok) return unauthorized();

  next();
}

// --- Postgres: account counts --------------------------------------------

async function getUserStats() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE tier = 'pro')::int AS pro,
      COUNT(*) FILTER (WHERE subscription_status = 'trialing')::int AS trialing,
      COUNT(*) FILTER (WHERE subscription_status = 'canceled')::int AS canceled,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS signups_7d,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::int AS signups_30d
    FROM users
  `);
  return rows[0];
}

// --- Stripe: real revenue numbers -----------------------------------------
//
// Deliberately not derived from our own tier/subscription_status columns --
// those tell us who currently *has* Pro access, not what's actually been
// billed. Stripe is the source of truth for money; this just reads it back.

// Sums amount_paid (in cents) across every paid invoice, all-time. Paginates
// with starting_after since an account can have more than one page (100) of
// invoices -- fine to call on every dashboard load for now given the likely
// invoice volume, revisit with caching if this ever gets slow.
async function totalRevenueCentsAllTime() {
  const stripe = billing.stripe;
  if (!stripe) return null;

  let totalCents = 0;
  let startingAfter;
  for (;;) {
    const page = await stripe.invoices.list({
      status: "paid",
      limit: 100,
      starting_after: startingAfter,
    });
    for (const invoice of page.data) totalCents += invoice.amount_paid;
    if (!page.has_more) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return totalCents;
}

// Current MRR (cents), normalizing annual subscriptions down to a monthly
// figure so a $29.99/yr subscriber and a $3.99/mo subscriber both
// contribute a comparable per-month number. Only `active` subscriptions
// count toward MRR -- `trialing` ones haven't been charged yet, so they're
// reported separately (see trialingCount) rather than folded into revenue.
async function mrrCentsAndCounts() {
  const stripe = billing.stripe;
  if (!stripe) return { mrrCents: null, activeCount: 0, trialingCount: 0 };

  let mrrCents = 0;
  let activeCount = 0;
  let trialingCount = 0;

  for (const status of ["active", "trialing"]) {
    let startingAfter;
    for (;;) {
      const page = await stripe.subscriptions.list({
        status,
        limit: 100,
        starting_after: startingAfter,
      });
      for (const subscription of page.data) {
        if (status === "active") {
          activeCount++;
          for (const item of subscription.items.data) {
            const price = item.price;
            if (!price || !price.recurring) continue;
            const amount = (price.unit_amount || 0) * (item.quantity || 1);
            const intervalCount = price.recurring.interval_count || 1;
            if (price.recurring.interval === "month") {
              mrrCents += amount / intervalCount;
            } else if (price.recurring.interval === "year") {
              mrrCents += amount / (12 * intervalCount);
            }
          }
        } else {
          trialingCount++;
        }
      }
      if (!page.has_more) break;
      startingAfter = page.data[page.data.length - 1].id;
    }
  }

  return { mrrCents: Math.round(mrrCents), activeCount, trialingCount };
}

function formatUSD(cents) {
  if (cents == null) return "—"; // em dash -- Stripe isn't configured
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function statCard(label, value, sublabel) {
  return `
    <div class="card">
      <div class="card-label">${escapeHtml(label)}</div>
      <div class="card-value">${escapeHtml(value)}</div>
      ${sublabel ? `<div class="card-sub">${escapeHtml(sublabel)}</div>` : ""}
    </div>
  `;
}

function renderDashboard({ userStats, mrrCents, activeCount, trialingCount, totalRevenueCents, stripeConfigured }) {
  const free = userStats.total - userStats.pro;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>FatClipboard Admin</title>
<meta name="robots" content="noindex, nofollow" />
<style>
  :root { --cream: #F2EEE3; --ink: #1A1816; --inkMuted: #6E6859; --border: rgba(26,24,22,0.1); --accent: #5EA800; --surface: #ffffff; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--cream); color: var(--ink); font-family: "Segoe UI", -apple-system, sans-serif; padding: 40px 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .subtitle { color: var(--inkMuted); font-size: 13.5px; margin: 0 0 32px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; max-width: 900px; margin-bottom: 28px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 18px 20px; }
  .card-label { font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--inkMuted); margin-bottom: 8px; }
  .card-value { font-size: 26px; font-weight: 700; }
  .card-sub { font-size: 12px; color: var(--inkMuted); margin-top: 4px; }
  .section-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--inkMuted); margin: 28px 0 12px; }
  .warning { background: #fff3cd; border: 1px solid #ffe08a; color: #6b5400; border-radius: 10px; padding: 12px 16px; font-size: 13px; max-width: 900px; margin-bottom: 20px; }
  .refresh { font-size: 12.5px; color: var(--inkMuted); }
  .refresh a { color: var(--accent); font-weight: 600; text-decoration: none; }
</style>
</head>
<body>
  <h1>FatClipboard Admin</h1>
  <p class="subtitle">Live account and revenue snapshot. <span class="refresh"><a href="/admin">Refresh</a></span></p>

  ${!stripeConfigured ? `<div class="warning">Stripe isn't configured on this server (STRIPE_SECRET_KEY missing) -- revenue figures below are unavailable.</div>` : ""}

  <div class="section-title">Accounts</div>
  <div class="grid">
    ${statCard("Total users", userStats.total)}
    ${statCard("Free", free)}
    ${statCard("Pro", userStats.pro, `${trialingCount} in trial`)}
    ${statCard("Signups (7d)", userStats.signups_7d)}
    ${statCard("Signups (30d)", userStats.signups_30d)}
    ${statCard("Canceled", userStats.canceled)}
  </div>

  <div class="section-title">Revenue (from Stripe)</div>
  <div class="grid">
    ${statCard("MRR", formatUSD(mrrCents), `${activeCount} paying subscriptions`)}
    ${statCard("Total revenue (all-time)", formatUSD(totalRevenueCents))}
  </div>
</body>
</html>`;
}

const router = express.Router();

router.get("/", requireAdmin, async (_req, res) => {
  try {
    const stripeConfigured = !!billing.stripe;
    const [userStats, revenueResult, mrrResult] = await Promise.all([
      getUserStats(),
      stripeConfigured ? totalRevenueCentsAllTime() : Promise.resolve(null),
      stripeConfigured
        ? mrrCentsAndCounts()
        : Promise.resolve({ mrrCents: null, activeCount: 0, trialingCount: 0 }),
    ]);

    res.set("Content-Type", "text/html; charset=utf-8").send(
      renderDashboard({
        userStats,
        totalRevenueCents: revenueResult,
        mrrCents: mrrResult.mrrCents,
        activeCount: mrrResult.activeCount,
        trialingCount: mrrResult.trialingCount,
        stripeConfigured,
      })
    );
  } catch (err) {
    console.error("[clip-server] /admin failed:", err);
    res.status(500).send("Something went wrong loading the dashboard -- check the server logs.");
  }
});

module.exports = { router };
