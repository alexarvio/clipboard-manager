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

function renderDashboard({
  userStats,
  mrrCents,
  activeCount,
  trialingCount,
  totalRevenueCents,
  stripeConfigured,
  series,
}) {
  const free = userStats.total - userStats.pro;

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
    --cream: #F2EEE3; --creamSurface: #F8F4EC; --ink: #1A1816; --inkMuted: #6E6859;
    --border: rgba(26,24,22,0.10); --accent: #5EA800; --accentFill: #F1F8E7; --surface: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --cream: #1C1A17; --creamSurface: #262320; --ink: #F2EEE3; --inkMuted: #A8A39B;
      --border: rgba(255,255,255,0.08); --accent: #C1FF72; --accentFill: #2B3B16; --surface: #2E2A25;
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
</style>
</head>
<body>
  <div class="wrap">
    <div class="brand">FatClipboard</div>
    <h1>Admin</h1>
    <p class="subtitle">Live account and revenue snapshot. <span class="refresh"><a href="/admin">Refresh</a></span></p>

    ${!stripeConfigured ? `<div class="warning">Stripe isn't configured on this server (STRIPE_SECRET_KEY missing) -- revenue figures and the Pro/MRR charts below are unavailable.</div>` : ""}

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

    <div class="section-title">Over time</div>
    <div class="charts">
      <div class="chart-card"><canvas id="chart-users"></canvas></div>
      <div class="chart-card"><canvas id="chart-pro"></canvas></div>
      <div class="chart-card"><canvas id="chart-mrr"></canvas></div>
    </div>
  </div>

  <script>
    const SERIES = ${JSON.stringify(series)};

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

    function lineChart(canvasId, title, data, formatY) {
      new Chart(document.getElementById(canvasId), {
        type: "line",
        data: {
          labels: SERIES.labels,
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

    lineChart("chart-users", "Total users (cumulative)", SERIES.usersSeries);
    lineChart("chart-pro", "Pro subscribers", SERIES.proSeries);
    lineChart("chart-mrr", "MRR", SERIES.mrrSeries, (v) => "$" + v.toFixed(2));
  </script>
</body>
</html>`;
}

const router = express.Router();

router.get("/", requireAdmin, async (_req, res) => {
  try {
    const stripeConfigured = !!billing.stripe;
    const [userStats, signupRows, revenueResult, mrrResult, subsEver] = await Promise.all([
      getUserStats(),
      dailySignupCounts(),
      stripeConfigured ? totalRevenueCentsAllTime() : Promise.resolve(null),
      stripeConfigured
        ? mrrCentsAndCounts()
        : Promise.resolve({ mrrCents: null, activeCount: 0, trialingCount: 0 }),
      stripeConfigured ? allSubscriptionsEver() : Promise.resolve([]),
    ]);

    const series = buildTimeSeries(signupRows, subsEver);

    res.set("Content-Type", "text/html; charset=utf-8").send(
      renderDashboard({
        userStats,
        totalRevenueCents: revenueResult,
        mrrCents: mrrResult.mrrCents,
        activeCount: mrrResult.activeCount,
        trialingCount: mrrResult.trialingCount,
        stripeConfigured,
        series,
      })
    );
  } catch (err) {
    console.error("[clip-server] /admin failed:", err);
    res.status(500).send("Something went wrong loading the dashboard -- check the server logs.");
  }
});

module.exports = { router };
