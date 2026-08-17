// Internal admin dashboard: total users, Free vs Pro split, signups, real
// revenue numbers pulled live from Stripe, and time-series charts of users/
// Pro subscribers/MRR. Deliberately its own module (same pattern as
// billing.js/email.js) rather than more routes bolted onto index.js -- this
// is a distinct, self-contained feature, not part of the app's own API
// surface.
//
// Auth: HTTP Basic Auth gated on a single ADMIN_PASSWORD env var. No
// session/cookie machinery -- this is a single-owner internal tool, not a
// multi-user surface, so the browser's native Basic Auth prompt (over HTTPS,
// which Railway terminates for us) is enough. Not wired into the users
// table or JWT auth at all on purpose: an admin dashboard shouldn't be
// reachable just because someone's Clip account session leaked.
//
// Look and feel (2026-08-09) deliberately mirrors website/index.html's own
// palette (--cream/--ink/--accent/--surface, same hex values, same light/
// dark split) rather than inventing a separate admin theme -- this is still
// "the FatClipboard product," just an internal page of it.

const crypto = require("crypto");
const express = require("express");
const { pool } = require("./db");
const billing = require("./billing");

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

// Admin API key for Anthropic's Usage & Cost API -- NOT the same as
// ANTHROPIC_API_KEY (that one only calls /v1/messages). This one starts
// with sk-ant-admin01- and only exists once an "Organization" has been set
// up in the Anthropic Console (Console -> Settings -> Organization);
// individual accounts can't generate one. See
// https://platform.claude.com/docs/en/manage-claude/usage-cost-api.
const ANTHROPIC_ADMIN_KEY = process.env.ANTHROPIC_ADMIN_KEY || "";
// $/1K tokens for voyage-3.5-lite (the model /embed actually calls, see
// index.js's voyageEmbed) -- from https://docs.voyageai.com/docs/pricing.
// Hardcoded rather than fetched anywhere because there's nowhere to fetch
// it from; update this by hand if Voyage ever changes the price for this
// model.
const VOYAGE_PRICE_PER_1K_TOKENS = 0.00002;

if (!ADMIN_PASSWORD) {
  console.warn(
    "[clip-server] WARNING: ADMIN_PASSWORD is not set. /admin will refuse all requests until it is. " +
      "Generate one with: openssl rand -hex 20"
  );
}
if (!ANTHROPIC_ADMIN_KEY) {
  console.warn(
    "[clip-server] NOTE: ANTHROPIC_ADMIN_KEY is not set. /admin will show Anthropic cost as unavailable " +
      "-- see the comment above this warning for how to get one."
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

// One row per calendar day that had at least one signup -- sparse on
// purpose, buildTimeSeries below fills in the gaps (and the cumulative
// running total) for every day in the chart's range.
async function dailySignupCounts() {
  const { rows } = await pool.query(`
    SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS n
    FROM users
    GROUP BY day
    ORDER BY day
  `);
  return rows;
}

// --- Website traffic (page_events, written by analytics.js) --------------
//
// Reads only -- writing happens over in analytics.js, which owns the
// table (creates it lazily, whitelists what event types get in, etc.).
// Wrapped in `safe()` everywhere it's called below so a server that hasn't
// received its first pageview yet (table doesn't exist) degrades to a
// "not set up yet" banner instead of a 500, same pattern as the
// Stripe/Anthropic sections.

async function trafficStats() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE event = 'pageview' AND created_at >= now() - interval '7 days')::int AS pageviews_7d,
      COUNT(*) FILTER (WHERE event = 'pageview' AND created_at >= now() - interval '30 days')::int AS pageviews_30d,
      COUNT(DISTINCT session_id) FILTER (WHERE event = 'pageview' AND session_id <> '' AND created_at >= now() - interval '7 days')::int AS visitors_7d,
      COUNT(DISTINCT session_id) FILTER (WHERE event = 'pageview' AND session_id <> '' AND created_at >= now() - interval '30 days')::int AS visitors_30d,
      COUNT(*) FILTER (WHERE event = 'download_click' AND created_at >= now() - interval '7 days')::int AS downloads_7d,
      COUNT(*) FILTER (WHERE event = 'download_click' AND created_at >= now() - interval '30 days')::int AS downloads_30d,
      COUNT(*) FILTER (WHERE event = 'download_click')::int AS downloads_alltime
    FROM page_events
  `);
  return rows[0];
}

// Mac waitlist signups, read straight from waitlist.js's own table rather
// than duplicated into page_events -- one source of truth for that number.
async function waitlistStats() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS signups_7d,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::int AS signups_30d,
      COUNT(*)::int AS signups_alltime
    FROM waitlist
  `);
  return rows[0];
}

async function topPaths(days) {
  const { rows } = await pool.query(
    `SELECT path, COUNT(*)::int AS n
     FROM page_events
     WHERE event = 'pageview' AND created_at >= now() - ($1 || ' days')::interval
     GROUP BY path ORDER BY n DESC LIMIT 8`,
    [days]
  );
  return rows;
}

async function topReferrers(days) {
  const { rows } = await pool.query(
    `SELECT COALESCE(NULLIF(referrer, ''), '(direct)') AS referrer, COUNT(*)::int AS n
     FROM page_events
     WHERE event = 'pageview' AND created_at >= now() - ($1 || ' days')::interval
     GROUP BY 1 ORDER BY n DESC LIMIT 8`,
    [days]
  );
  return rows;
}

// One row per calendar day that had at least one pageview -- same sparse
// shape as dailySignupCounts, filled in by buildPageviewSeries below.
async function dailyPageviewCounts() {
  const { rows } = await pool.query(`
    SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS n
    FROM page_events
    WHERE event = 'pageview'
    GROUP BY day
    ORDER BY day
  `);
  return rows;
}

// Dense daily series for the chart, same fill-the-gaps approach as
// buildTimeSeries below but simpler (one series, no subscription-interval
// math) -- kept separate rather than generalizing buildTimeSeries since the
// two have little in common besides "walk from day 0 to today."
function buildPageviewSeries(dayRows) {
  if (!dayRows.length) return { labels: [], series: [] };

  const dayMsFor = (r) => dayFloor(new Date(r.day).getTime());
  const todayMs = dayFloor(Date.now());
  const startMs = Math.min(...dayRows.map(dayMsFor));
  const totalDays = Math.max(1, Math.round((todayMs - startMs) / DAY_MS) + 1);

  const byDay = new Map();
  dayRows.forEach((r) => byDay.set(dayMsFor(r), r.n));

  const labels = [];
  const series = [];
  for (let i = 0; i < totalDays; i++) {
    const dayMs = startMs + i * DAY_MS;
    labels.push(new Date(dayMs).toISOString().slice(0, 10));
    series.push(byDay.get(dayMs) || 0);
  }
  return { labels, series };
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
          mrrCents += monthlyEquivalentCents(subscription);
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

// A subscription's recurring price(s) normalized to a monthly cents figure
// -- shared by mrrCentsAndCounts (current MRR) and buildTimeSeries (MRR
// history) so the two can't drift out of sync with each other.
function monthlyEquivalentCents(subscription) {
  let monthly = 0;
  for (const item of subscription.items.data) {
    const price = item.price;
    if (!price || !price.recurring) continue;
    const amount = (price.unit_amount || 0) * (item.quantity || 1);
    const intervalCount = price.recurring.interval_count || 1;
    if (price.recurring.interval === "month") monthly += amount / intervalCount;
    else if (price.recurring.interval === "year") monthly += amount / (12 * intervalCount);
  }
  return monthly;
}

// Every subscription ever created, any status (including canceled) -- the
// history chart needs the full lifecycle of each one, not just who's
// currently active.
async function allSubscriptionsEver() {
  const stripe = billing.stripe;
  if (!stripe) return [];

  const subs = [];
  let startingAfter;
  for (;;) {
    const page = await stripe.subscriptions.list({
      status: "all",
      limit: 100,
      starting_after: startingAfter,
    });
    subs.push(...page.data);
    if (!page.has_more) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return subs;
}

// --- AI provider costs (Anthropic real, Voyage estimated) -----------------
//
// Not the same kind of number as the revenue figures above -- there's no
// single "source of truth" API covering both providers the way Stripe is
// for money coming in. Anthropic has a real Cost API (below); Voyage has
// none at all (confirmed against their full API reference -- just
// embeddings/files/batch, nothing for billing), so its figure is an
// estimate built from what we log ourselves in ai_usage_events (see db.js
// and index.js's /embed route) multiplied by Voyage's published price.

// Real $ spend from Anthropic's Cost API
// (/v1/organizations/cost_report) for the given date range. Requires an
// Admin API key (ANTHROPIC_ADMIN_KEY) -- a different, more powerful key
// than ANTHROPIC_API_KEY, only available once an Organization exists in the
// Anthropic Console. Throws (rather than returning null) on failure so the
// caller can surface the actual error message -- "key missing," "no
// organization set up yet," and "key lacks the right scope" all look
// different to someone debugging this, and swallowing the distinction
// wouldn't help them.
async function anthropicCostUSD(startingAtISO, endingAtISO) {
  if (!ANTHROPIC_ADMIN_KEY) return null;

  let totalUSD = 0;
  let page;
  for (;;) {
    const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
    url.searchParams.set("starting_at", startingAtISO);
    url.searchParams.set("ending_at", endingAtISO);
    url.searchParams.append("group_by[]", "description");
    if (page) url.searchParams.set("page", page);

    const resp = await fetch(url, {
      headers: {
        "anthropic-version": "2023-06-01",
        "x-api-key": ANTHROPIC_ADMIN_KEY,
      },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Anthropic cost report failed (${resp.status}): ${body}`);
    }

    const data = await resp.json();
    // Each entry in `data` is one time bucket (this call doesn't set
    // bucket_width, so the API's own default applies); each bucket's
    // `results` holds one or more cost line items, each with an `amount`
    // that's a decimal-string dollar figure (e.g. "0.45" -> $0.45) per the
    // Cost API docs.
    for (const bucket of data.data || []) {
      for (const result of bucket.results || []) {
        const amount = parseFloat(result.amount);
        if (!Number.isNaN(amount)) totalUSD += amount;
      }
    }
    if (!data.has_more) break;
    page = data.next_page;
  }
  return totalUSD;
}

// Estimated $ spend on Voyage over the last `days` days, from our own
// ai_usage_events log rather than anything Voyage reports back -- see the
// section comment above.
async function voyageCostEstimateUSD(days) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(tokens), 0)::bigint AS tokens
     FROM ai_usage_events
     WHERE provider = 'voyage' AND created_at >= now() - ($1 || ' days')::interval`,
    [days]
  );
  const totalTokens = Number(rows[0].tokens);
  return (totalTokens / 1000) * VOYAGE_PRICE_PER_1K_TOKENS;
}

// --- Time series (users / Pro subscribers / MRR, by day) ------------------
//
// Users: exact, straight from Postgres created_at -- a real signup date per
// account, nothing approximated.
//
// Pro count & MRR: approximated from each Stripe subscription's `created`
// and `canceled_at` timestamps (a subscription counts as "Pro" for every day
// between the two, or through today if still ongoing) -- there's no
// per-account "became Pro on this exact day" log to read back, so this
// re-derives it from the subscription lifecycle Stripe already tracks.
// Revenue specifically is counted from `trial_end` onward (or `created` if
// there was no trial), and not at all for a subscription still sitting in
// `trialing` right now, since nothing's actually been charged yet in that
// case. Fine for a dashboard-level trend line; not meant to reconcile to
// the cent against Stripe's own reporting for a given historical day.
const DAY_MS = 24 * 60 * 60 * 1000;

function dayFloor(ms) {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function buildTimeSeries(signupRows, subs) {
  const todayMs = dayFloor(Date.now());

  const signupDayMs = signupRows.map((r) => dayFloor(new Date(r.day).getTime()));
  const subCreatedMs = subs.map((s) => dayFloor(s.created * 1000));

  const candidateStarts = [...signupDayMs, ...subCreatedMs].filter((n) => Number.isFinite(n));
  const startMs = candidateStarts.length ? Math.min(...candidateStarts) : todayMs;

  const totalDays = Math.max(1, Math.round((todayMs - startMs) / DAY_MS) + 1);

  const signupsByDay = new Map();
  signupRows.forEach((r, i) => {
    signupsByDay.set(signupDayMs[i], (signupsByDay.get(signupDayMs[i]) || 0) + r.n);
  });

  const subIntervals = subs.map((s) => {
    const startDayMs = dayFloor(s.created * 1000);
    const endDayMs = s.canceled_at
      ? dayFloor(s.canceled_at * 1000)
      : s.ended_at
      ? dayFloor(s.ended_at * 1000)
      : Infinity;
    const stillTrialing = s.status === "trialing";
    const revenueStartDayMs = stillTrialing
      ? Infinity
      : dayFloor(Math.max(s.created, s.trial_end || 0) * 1000);
    return { startDayMs, endDayMs, revenueStartDayMs, monthlyCents: monthlyEquivalentCents(s) };
  });

  const labels = [];
  const usersSeries = [];
  const proSeries = [];
  const mrrSeries = [];

  let cumulativeUsers = 0;
  for (let i = 0; i < totalDays; i++) {
    const dayMs = startMs + i * DAY_MS;
    cumulativeUsers += signupsByDay.get(dayMs) || 0;

    let pro = 0;
    let mrrCents = 0;
    for (const iv of subIntervals) {
      if (iv.startDayMs > dayMs || iv.endDayMs < dayMs) continue;
      pro++;
      if (iv.revenueStartDayMs <= dayMs) mrrCents += iv.monthlyCents;
    }

    const d = new Date(dayMs);
    labels.push(d.toISOString().slice(0, 10));
    usersSeries.push(cumulativeUsers);
    proSeries.push(pro);
    mrrSeries.push(Math.round(mrrCents) / 100);
  }

  return { labels, usersSeries, proSeries, mrrSeries };
}

function formatUSD(cents) {
  if (cents == null) return "—"; // em dash -- Stripe isn't configured
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

// Same as formatUSD, but for values already in dollars (Anthropic's Cost
// API and the Voyage estimate both work in dollars, not cents) --
// formatting a $0.0034-sized number needs more than the usual 2 decimal
// places or it just renders as "$0.00" for anyone still on a handful of
// cheap embed calls.
function formatUSDPrecise(dollars) {
  if (dollars == null) return "—";
  if (dollars > 0 && dollars < 0.01) {
    return dollars.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    });
  }
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD" });
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

function tableCard(title, rows, labelKey, valueKey, emptyText) {
  const body = rows.length
    ? rows
        .map(
          (r) =>
            `<tr><td>${escapeHtml(r[labelKey])}</td><td class="num">${escapeHtml(r[valueKey])}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="2" class="empty">${escapeHtml(emptyText)}</td></tr>`;
  return `
    <div class="chart-card">
      <div class="table-title">${escapeHtml(title)}</div>
      <table class="mini-table"><tbody>${body}</tbody></table>
    </div>
  `;
}

function renderDashboard({
  userStats,
  mrrCents,
  activeCount,
  trialingCount,
  totalRevenueCents,
  stripeConfigured,
  anthropicCostUSD30d,
  anthropicConfigured,
  anthropicError,
  voyageCostUSD30d,
  series,
  trafficConfigured,
  trafficError,
  traffic,
  waitlist,
  topPathRows,
  topReferrerRows,
  pageviewSeries,
}) {
  const free = userStats.total - userStats.pro;
  const conversionRate =
    trafficConfigured && traffic.visitors_30d > 0
      ? (((waitlist.signups_30d + traffic.downloads_30d) / traffic.visitors_30d) * 100).toFixed(1) + "%"
      : "—";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>FatClipboard Admin</title>
<meta name="robots" content="noindex, nofollow" />
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  /* Same palette + light/dark split as website/index.html's :root and
     html[data-theme="dark"] blocks -- kept in sync by hand since this is a
     tiny, separate file, not a shared stylesheet. Respects the OS/browser's
     color scheme (prefers-color-scheme) rather than a manual toggle -- this
     is a one-person internal tool, not worth its own theme switcher. */
  :root {
    --cream: #FFFFFF; --creamSurface: #F8F4EC; --ink: #1A1816; --inkMuted: #6E6859;
    --border: rgba(26,24,22,0.10); --accent: #7C6FE3; --accentFill: #EDEAFB; --surface: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --cream: #1C1A17; --creamSurface: #262320; --ink: #F2EEE3; --inkMuted: #A8A39B;
      --border: rgba(255,255,255,0.08); --accent: #B7A9FF; --accentFill: #332B4D; --surface: #2E2A25;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--cream); color: var(--ink); font-family: "Segoe UI Variable", "Segoe UI", -apple-system, sans-serif; padding: 40px 24px 60px; }
  .wrap { max-width: 1040px; margin: 0 auto; }
  .brand { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--accent); margin-bottom: 6px; }
  h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.3px; }
  .subtitle { color: var(--inkMuted); font-size: 13.5px; margin: 0 0 32px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-bottom: 28px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 18px 20px; box-shadow: 0 1px 2px rgba(26,24,22,0.05); }
  .card-label { font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--inkMuted); margin-bottom: 8px; }
  .card-value { font-size: 26px; font-weight: 700; }
  .card-sub { font-size: 12px; color: var(--inkMuted); margin-top: 4px; }
  .section-title { color: var(--accent); font-weight: 700; font-size: 12.5px; text-transform: uppercase; letter-spacing: 0.07em; margin: 32px 0 12px; }
  .warning { background: var(--accentFill); border: 1px solid var(--border); color: var(--ink); border-radius: 10px; padding: 12px 16px; font-size: 13px; margin-bottom: 20px; }
  .refresh { font-size: 12.5px; color: var(--inkMuted); }
  .refresh a { color: var(--accent); font-weight: 600; text-decoration: none; }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }
  .chart-card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 18px 20px; box-shadow: 0 1px 2px rgba(26,24,22,0.05); }
  .chart-card canvas { max-height: 220px; }
  .table-title { font-weight: 600; font-size: 12.5px; color: var(--ink); margin-bottom: 10px; }
  .mini-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  .mini-table td { padding: 6px 0; border-bottom: 1px solid var(--border); color: var(--ink); }
  .mini-table tr:last-child td { border-bottom: 0; }
  .mini-table td.num { text-align: right; color: var(--inkMuted); font-variant-numeric: tabular-nums; }
  .mini-table td.empty { color: var(--inkMuted); text-align: center; padding: 16px 0; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="brand">FatClipboard</div>
    <h1>Admin</h1>
    <p class="subtitle">Live account and revenue snapshot. <span class="refresh"><a href="/admin">Refresh</a></span></p>

    ${!stripeConfigured ? `<div class="warning">Stripe isn't configured on this server (STRIPE_SECRET_KEY missing) -- revenue figures and the Pro/MRR charts below are unavailable.</div>` : ""}
    ${!anthropicConfigured ? `<div class="warning">ANTHROPIC_ADMIN_KEY isn't set -- Anthropic cost is unavailable. This is a separate key from ANTHROPIC_API_KEY, and needs an Organization set up in the Anthropic Console first. See server/.env.example.</div>` : ""}
    ${anthropicConfigured && anthropicError ? `<div class="warning">Couldn't reach Anthropic's Cost API: ${escapeHtml(anthropicError)}</div>` : ""}
    ${trafficConfigured && trafficError ? `<div class="warning">Couldn't load website traffic: ${escapeHtml(trafficError)}</div>` : ""}
    ${!trafficConfigured ? `<div class="warning">No website traffic recorded yet -- this fills in once the tracking snippet on website/index.html sends its first pageview.</div>` : ""}

    <div class="section-title">Website (traffic &amp; conversions)</div>
    <div class="grid">
      ${statCard("Visitors (7d)", traffic.visitors_7d)}
      ${statCard("Visitors (30d)", traffic.visitors_30d)}
      ${statCard("Pageviews (30d)", traffic.pageviews_30d, `${traffic.pageviews_7d} in last 7d`)}
      ${statCard("Download clicks (30d)", traffic.downloads_30d, `${traffic.downloads_alltime} all-time`)}
      ${statCard("Mac waitlist (30d)", waitlist.signups_30d, `${waitlist.signups_alltime} all-time`)}
      ${statCard("Visitor → conversion (30d)", conversionRate, "downloads + waitlist signups ÷ visitors")}
    </div>
    <div class="charts" style="margin-bottom:28px;">
      <div class="chart-card"><canvas id="chart-pageviews"></canvas></div>
      ${tableCard("Top pages (30d)", topPathRows, "path", "n", "No pageviews yet")}
      ${tableCard("Top referrers (30d)", topReferrerRows, "referrer", "n", "No pageviews yet")}
    </div>

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

    <div class="section-title">AI costs (30d)</div>
    <div class="grid">
      ${statCard("Anthropic", formatUSDPrecise(anthropicCostUSD30d), "real, from Anthropic's Cost API")}
      ${statCard("Voyage", formatUSDPrecise(voyageCostUSD30d), "estimated from logged usage × list price")}
    </div>

    <div class="section-title">Over time</div>
    <div class="charts">
      <div class="chart-card"><canvas id="chart-users"></canvas></div>
      <div class="chart-card"><canvas id="chart-pro"></canvas></div>
      <div class="chart-card"><canvas id="chart-mrr"></canvas></div>
    </div>
  </div>

  <script>
    const SERIES = ${JSON.stringify(series)};
    const PAGEVIEW_SERIES = ${JSON.stringify(pageviewSeries)};

    const rootStyle = getComputedStyle(document.documentElement);
    const accent = rootStyle.getPropertyValue("--accent").trim();
    const ink = rootStyle.getPropertyValue("--ink").trim();
    const inkMuted = rootStyle.getPropertyValue("--inkMuted").trim();
    const border = rootStyle.getPropertyValue("--border").trim();

    // A handful of dates on a compact x-axis reads better than a label per
    // day once the range grows past a couple of weeks -- Chart.js's own
    // autoSkip handles the thinning, this just keeps the tick font small
    // and consistent with the rest of the page instead of its defaults.
    const commonOptions = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: inkMuted, font: { size: 10.5 }, maxRotation: 0, autoSkip: true }, grid: { color: border } },
        y: { beginAtZero: true, ticks: { color: inkMuted, font: { size: 10.5 } }, grid: { color: border } },
      },
    };

    function lineChart(canvasId, title, labels, data, formatY) {
      var el = document.getElementById(canvasId);
      if (!el) return;
      new Chart(el, {
        type: "line",
        data: {
          labels: labels,
          datasets: [{
            label: title,
            data,
            borderColor: accent,
            backgroundColor: accent + "22",
            fill: true,
            tension: 0.25,
            pointRadius: 0,
            borderWidth: 2,
          }],
        },
        options: {
          ...commonOptions,
          plugins: {
            ...commonOptions.plugins,
            title: { display: true, text: title, color: ink, font: { size: 12.5, weight: "600" }, align: "start", padding: { bottom: 10 } },
            tooltip: formatY ? { callbacks: { label: (ctx) => formatY(ctx.parsed.y) } } : undefined,
          },
        },
      });
    }

    if (PAGEVIEW_SERIES.labels.length) {
      lineChart("chart-pageviews", "Pageviews per day", PAGEVIEW_SERIES.labels, PAGEVIEW_SERIES.series);
    } else {
      var pvCanvas = document.getElementById("chart-pageviews");
      if (pvCanvas) pvCanvas.replaceWith(Object.assign(document.createElement("div"), { className: "table-title", textContent: "No pageviews yet" }));
    }
    lineChart("chart-users", "Total users (cumulative)", SERIES.labels, SERIES.usersSeries);
    lineChart("chart-pro", "Pro subscribers", SERIES.labels, SERIES.proSeries);
    lineChart("chart-mrr", "MRR", SERIES.labels, SERIES.mrrSeries, (v) => "$" + v.toFixed(2));
  </script>
</body>
</html>`;
}

// Runs one external-provider call and never lets it reject -- a bad/missing
// key or a transient outage on Anthropic's or Stripe's side should degrade
// that one section of the page (with a warning banner explaining why,
// rendered by renderDashboard), not 500 the whole dashboard including the
// account numbers that came straight from our own database.
async function safe(fn, fallback) {
  try {
    return { value: await fn(), error: null };
  } catch (err) {
    console.error("[clip-server] /admin: a data source failed:", err);
    return { value: fallback, error: err.message || String(err) };
  }
}

const router = express.Router();

router.get("/", requireAdmin, async (_req, res) => {
  try {
    const stripeConfigured = !!billing.stripe;
    const anthropicConfigured = !!ANTHROPIC_ADMIN_KEY;

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY_MS);

    const DEFAULT_TRAFFIC = {
      pageviews_7d: 0,
      pageviews_30d: 0,
      visitors_7d: 0,
      visitors_30d: 0,
      downloads_7d: 0,
      downloads_30d: 0,
      downloads_alltime: 0,
    };
    const DEFAULT_WAITLIST = { signups_7d: 0, signups_30d: 0, signups_alltime: 0 };

    // Both page_events (analytics.js) and waitlist (waitlist.js) create
    // their own tables lazily on first write, so on a freshly deployed
    // server -- before the first real pageview/signup ever lands -- these
    // queries fail with "relation ... does not exist." That's an expected,
    // temporary state, not a real error, so it's treated differently from
    // any other failure (a genuinely broken query, a connection drop):
    // suppressed from the error banner, but still flips the "not set up
    // yet" notice on instead of quietly showing all-zero stats.
    const missingTable = (err) => !!err && /does not exist/i.test(err);

    const [
      userStats,
      signupRows,
      revenue,
      mrr,
      subsEver,
      anthropicCost,
      voyageCost,
      trafficResult,
      waitlistResult,
      topPathRows,
      topReferrerRows,
      pageviewRows,
    ] = await Promise.all([
      getUserStats(),
      dailySignupCounts(),
      stripeConfigured
        ? safe(totalRevenueCentsAllTime, null)
        : { value: null, error: null },
      stripeConfigured
        ? safe(mrrCentsAndCounts, { mrrCents: null, activeCount: 0, trialingCount: 0 })
        : { value: { mrrCents: null, activeCount: 0, trialingCount: 0 }, error: null },
      stripeConfigured ? safe(allSubscriptionsEver, []) : { value: [], error: null },
      anthropicConfigured
        ? safe(() => anthropicCostUSD(thirtyDaysAgo.toISOString(), now.toISOString()), null)
        : { value: null, error: null },
      safe(() => voyageCostEstimateUSD(30), null),
      safe(trafficStats, DEFAULT_TRAFFIC),
      safe(waitlistStats, DEFAULT_WAITLIST),
      safe(() => topPaths(30), []),
      safe(() => topReferrers(30), []),
      safe(dailyPageviewCounts, []),
    ]);

    const series = buildTimeSeries(signupRows, subsEver.value);
    const pageviewSeries = buildPageviewSeries(pageviewRows.value);
    const trafficTableMissing = missingTable(trafficResult.error);

    res.set("Content-Type", "text/html; charset=utf-8").send(
      renderDashboard({
        userStats,
        totalRevenueCents: revenue.value,
        mrrCents: mrr.value.mrrCents,
        activeCount: mrr.value.activeCount,
        trialingCount: mrr.value.trialingCount,
        stripeConfigured,
        anthropicCostUSD30d: anthropicCost.value,
        anthropicConfigured,
        anthropicError: anthropicCost.error,
        voyageCostUSD30d: voyageCost.value,
        series,
        trafficConfigured: !trafficTableMissing,
        trafficError: trafficTableMissing ? null : trafficResult.error,
        traffic: trafficResult.value,
        waitlist: waitlistResult.value,
        topPathRows: topPathRows.value,
        topReferrerRows: topReferrerRows.value,
        pageviewSeries,
      })
    );
  } catch (err) {
    console.error("[clip-server] /admin failed:", err);
    res.status(500).send("Something went wrong loading the dashboard -- check the server logs.");
  }
});

module.exports = { router };
