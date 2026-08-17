// First-party website analytics (2026-08-17).
//
// Same shape as waitlist.js on purpose: a self-contained router that takes
// the Postgres pool as an argument, creates its own table lazily on first
// request (not hooked into db.js's initDb()), and is a one-liner to mount
// or remove. Exists because the admin dashboard (admin.js) had accounts,
// revenue, and AI cost -- but nothing about the marketing site itself:
// whether anyone's visiting, where from, or whether a visit turns into a
// download or a waitlist signup.
//
// Deliberately NOT a third-party analytics script (Plausible/Fathom/GA):
// the ask was for these numbers to live in the admin dashboard that
// already exists, not on a separate vendor's URL. The tradeoff that comes
// with that choice: bot filtering here is a plain User-Agent blocklist,
// not the fingerprinting a dedicated analytics vendor uses, so treat the
// numbers as directionally right rather than audit-grade.
//
// No cookies. The only thing the client stores is a random id in
// localStorage (see the tracking script in website/index.html) so the
// dashboard can count distinct visitors instead of raw pageviews -- that
// id isn't tied to an account or any personal data, same reasoning as
// giving each browser tab an anonymous cart id.
//
// Mounted in index.js as:
//
//     const createAnalyticsRouter = require("./analytics");
//     app.use(createAnalyticsRouter(pool));
//
// Read the raw events back with:
//
//     SELECT event, path, referrer, created_at FROM page_events ORDER BY created_at DESC LIMIT 50;

const express = require("express");
const rateLimit = require("express-rate-limit");

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS page_events (
    id SERIAL PRIMARY KEY,
    event TEXT NOT NULL,
    path TEXT NOT NULL,
    referrer TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;
const CREATE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS page_events_created_at_idx ON page_events (created_at);
`;

// Only these two are ever accepted -- same reasoning as waitlist.js's
// platform whitelist, so the column can't become a scratchpad for
// arbitrary client-supplied strings.
const ALLOWED_EVENTS = new Set(["pageview", "download_click"]);

// A plain substring blocklist, not a full bot-detection library. Good
// enough to keep uptime monitors, link-preview crawlers, and search-engine
// bots from inflating the visitor count; a determined bot spoofing a real
// browser UA will still get through, same as it would for most sites.
const BOT_UA_PATTERN =
  /bot|spider|crawl|slurp|headless|curl|wget|python-requests|monitor|pingdom|uptime|facebookexternalhit|preview|lighthouse|phantomjs/i;

function truncate(str, max) {
  const s = String(str || "");
  return s.length > max ? s.slice(0, max) : s;
}

// Strips query strings from paths/referrers before they're ever stored --
// a query string can carry a signup token, an email in a magic link, a
// Stripe session id, etc. None of that belongs in an analytics table, and
// the aggregate stats the dashboard shows don't need it.
//
// No "default to /" fallback here on purpose -- that would turn an empty
// referrer (direct traffic, no referring page at all) into the literal
// string "/", which would then never match admin.js's
// `COALESCE(NULLIF(referrer, ''), '(direct)')` and direct traffic would
// silently stop showing up as "(direct)" in the top-referrers table. The
// route handler below applies its own "/" default, but only to `path`.
function stripQuery(url) {
  const s = String(url || "");
  const cut = s.search(/[?#]/); // also drop hash fragments, e.g. "#pricing"
  return cut === -1 ? s : s.slice(0, cut);
}

module.exports = function createAnalyticsRouter(pool) {
  const router = express.Router();

  let tablePromise = null;
  function ensureTable() {
    if (!tablePromise) {
      tablePromise = pool
        .query(CREATE_TABLE_SQL)
        .then(() => pool.query(CREATE_INDEX_SQL))
        .catch((err) => {
          tablePromise = null; // let the next request try again
          throw err;
        });
    }
    return tablePromise;
  }

  // Generous on purpose: a single visitor loading a few pages, plus one
  // download click, is a handful of events -- this is here to blunt an
  // abusive script hammering the endpoint, not to gate normal browsing.
  const eventLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 300, // per IP
    standardHeaders: true,
    legacyHeaders: false,
    // Beacons/keepalive fetches don't surface a JSON body to the caller
    // anyway (see the 204 below), so no message needed -- just stop
    // accepting more from this IP for the rest of the window.
  });

  // sendBeacon posts with a Blob body and no explicit Content-Type header
  // controllable by the caller in every browser, so this route parses the
  // body itself (as text, then JSON) rather than relying on
  // express.json()'s Content-Type sniffing to always match.
  router.post(
    "/api/event",
    eventLimiter,
    express.text({ type: "*/*", limit: "4kb" }),
    async (req, res) => {
      // Always 204: this endpoint should never make a page's own load or a
      // button click visibly fail because analytics hiccupped, and a
      // varying response would be one more thing a bot could use to probe
      // behavior. Bad/unparseable bodies below just no-op past the 204.
      res.status(204).end();

      try {
        const ua = req.header("user-agent") || "";
        if (BOT_UA_PATTERN.test(ua)) return;

        let body;
        try {
          body = JSON.parse(req.body || "{}");
        } catch {
          return;
        }

        const event = String(body.event || "");
        if (!ALLOWED_EVENTS.has(event)) return;

        const path = truncate(stripQuery(body.path), 300) || "/";
        const referrer = truncate(stripQuery(body.referrer), 300);
        const sessionId = truncate(body.sid, 100);

        await ensureTable();
        await pool.query(
          `INSERT INTO page_events (event, path, referrer, session_id) VALUES ($1, $2, $3, $4)`,
          [event, path, referrer, sessionId]
        );
      } catch (err) {
        // Already responded 204 above -- just log so a broken table/query
        // doesn't fail silently forever.
        console.error("[clip-server] /api/event failed:", err);
      }
    }
  );

  return router;
};
