// Mac waitlist endpoint (2026-08-16).
//
// Kept as a self-contained router rather than more routes bolted into
// index.js: it owns its own table, its own validation and its own rate
// limit, so mounting it is a one-liner and removing it later is a one-liner
// too. It takes the Postgres pool as an argument instead of importing from
// ./db, so it doesn't care how db.js happens to export things.
//
// Mounted in index.js as:
//
//     const createWaitlistRouter = require("./waitlist");
//     app.use(createWaitlistRouter(pool));
//
// Check it end to end once deployed:
//
//     curl -X POST https://<your-server>/waitlist \
//       -H 'Content-Type: application/json' \
//       -d '{"email":"you@example.com","platform":"mac"}'
//
// ...and read the list back with:
//
//     SELECT email, platform, created_at FROM waitlist ORDER BY created_at DESC;

const express = require("express");
const rateLimit = require("express-rate-limit");

// Deliberately permissive. This is a marketing-page capture, not an auth
// boundary: the cost of rejecting one unusual-but-valid address (long TLDs,
// plus-addressing, subdomained domains) is a lost signup, while the cost of
// letting a junk string through is one junk row. Real deliverability gets
// decided by the mail provider at send time regardless of what we do here.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const MAX_EMAIL_LENGTH = 254; // RFC 5321 maximum for a full address

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS waitlist (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    platform TEXT NOT NULL DEFAULT 'mac',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

module.exports = function createWaitlistRouter(pool) {
  const router = express.Router();

  // Created lazily on the first request rather than at require() time, and
  // deliberately NOT hooked into db.js's initDb().
  //
  // The require-time version of this was a genuine crash risk: it built a
  // promise chain that re-threw on failure, and a rejected promise nothing
  // is awaiting yet is an unhandled rejection -- which terminates the
  // process by default on Node 15+. So a bad DATABASE_URL would have taken
  // down the entire API (auth, billing, transform) over an optional
  // marketing endpoint.
  //
  // Lazy + memoized means: nothing runs until someone actually posts the
  // form, the promise is always created inside an `await` that has a
  // try/catch around it, and clearing the memo on failure lets the next
  // request retry instead of the endpoint staying broken until a redeploy.
  let tablePromise = null;
  function ensureTable() {
    if (!tablePromise) {
      tablePromise = pool.query(CREATE_TABLE_SQL).catch((err) => {
        tablePromise = null; // let the next request try again
        throw err;
      });
    }
    return tablePromise;
  }

  const waitlistLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 20, // per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many signups from this address. Try again later." },
  });

  // express.json() is already applied app-wide in index.js; it's repeated
  // here only so this router still works if it's ever mounted somewhere
  // that hasn't. body-parser marks a request it has already parsed and
  // skips it, so this is a no-op in the normal case rather than a second
  // parse.
  router.post("/waitlist", waitlistLimiter, express.json({ limit: "10kb" }), async (req, res) => {
    const rawEmail = (req.body && req.body.email) || "";
    const email = String(rawEmail).trim().toLowerCase();

    // Only ever store a value from a known set, so the column can't be used
    // as a scratchpad for arbitrary client-supplied text.
    const platform = req.body && req.body.platform === "linux" ? "linux" : "mac";

    if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
      return res.status(400).json({ message: "Please provide a valid email address." });
    }

    try {
      await ensureTable();

      // ON CONFLICT DO NOTHING + an unconditional 200 below means the
      // response is identical whether or not this address was already on
      // the list. Same reasoning as /auth/forgot-password: a different
      // response for "already signed up" would turn this open endpoint into
      // a way to test whether a given person is on the list.
      await pool.query(
        `INSERT INTO waitlist (email, platform)
         VALUES ($1, $2)
         ON CONFLICT (email) DO NOTHING`,
        [email, platform]
      );

      return res.json({ message: "You're on the list." });
    } catch (err) {
      console.error("[clip-server] /waitlist failed:", err);
      return res.status(500).json({ message: "Something went wrong. Try again shortly." });
    }
  });

  return router;
};
