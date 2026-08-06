// Tiny proxy server for Clip's AI transform feature.
//
// Why this exists: the desktop app needs to call an LLM to transform clipboard
// text (fix grammar, summarize, translate, etc.), but it can never hold the
// real Anthropic API key itself -- anything shipped inside a desktop binary
// can be extracted. So instead, the app calls *this* server, this server
// holds the real key as an environment variable, and forwards the request.
//
// This is also the future home of real per-user gating (Stripe subscription
// check, usage limits, etc.) -- for now it just checks a single shared
// secret so random strangers on the internet can't run up your API bill the
// moment this is deployed somewhere public.

require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const Anthropic = require("@anthropic-ai/sdk");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool, initDb } = require("./db");
const { sendWelcomeEmail, sendPasswordResetEmail } = require("./email");
const billing = require("./billing");

const PORT = process.env.PORT || 8787;
const APP_SHARED_SECRET = process.env.APP_SHARED_SECRET || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const JWT_SECRET = process.env.JWT_SECRET || "";
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY || "";

if (!ANTHROPIC_API_KEY) {
  console.warn(
    "[clip-server] WARNING: ANTHROPIC_API_KEY is not set. /transform will fail until it is."
  );
}
if (!JWT_SECRET) {
  console.warn(
    "[clip-server] WARNING: JWT_SECRET is not set. /auth/* will fail until it is. Generate one with: openssl rand -hex 32"
  );
}
if (!VOYAGE_API_KEY) {
  console.warn(
    "[clip-server] WARNING: VOYAGE_API_KEY is not set. /embed (semantic search) will fail until it is. Get a free key at voyageai.com."
  );
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const app = express();
app.use(cors());

// Stripe webhook signature verification needs the exact raw request body
// bytes, not a re-serialized JSON object -- so this route has to be
// registered with express.raw() *before* the app-wide express.json() below
// ever gets a chance to parse (and thus alter) its body. Every other route
// in this file gets JSON as usual.
app.post(
  "/billing/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.header("stripe-signature");
    try {
      await billing.handleWebhookEvent(req.body, signature);
      res.json({ received: true });
    } catch (err) {
      // Deliberately 400, not 500 -- an invalid signature or a malformed
      // event is a bad *request*, and returning 500 here would make Stripe
      // retry it indefinitely, which won't fix a bad signature no matter
      // how many times it's retried.
      console.error("[clip-server] webhook error:", err.message);
      res.status(400).json({ error: "webhook error" });
    }
  }
);

app.use(express.json({ limit: "200kb" }));

// --- Accounts -----------------------------------------------------------
//
// Real per-user sign-up/log-in, backed by the users table in db.js. This is
// deliberately separate from requireAppSecret below -- that check just
// confirms a request came from a build of the app that knows the shared
// secret, it has no idea who the person is. This is the actual identity
// layer: an email + password, hashed with bcrypt, and a JWT session token
// the desktop app stores locally and sends back on future requests.
//
// No email verification yet, but password reset exists (see
// /auth/forgot-password and /auth/reset-password below). A welcome email
// goes out on sign-up too (see email.js) -- accounts carry `tier` on the
// server now instead of only in a local settings file, and live in Postgres
// (see db.js) rather than a SQLite file inside this server's own container.

const SESSION_LIFETIME = "180d";

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function signSession(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, {
    expiresIn: SESSION_LIFETIME,
  });
}

const authAttemptLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 20, // generous for someone mistyping their password a few times, not for a brute-force script
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many attempts -- try again in a few minutes" },
});
app.use(["/auth/signup", "/auth/login"], authAttemptLimiter);

app.post("/auth/signup", async (req, res) => {
  if (!JWT_SECRET) return res.status(500).json({ error: "server is not configured for accounts yet" });

  const { email, password, firstName } = req.body || {};
  // Normalize *before* validating. isValidEmail's regex is anchored and
  // rejects any whitespace, so " Alex@Example.com " (trivially produced by
  // pasting, or by a mobile keyboard adding a trailing space) used to be
  // turned away as "not a valid email address" -- even though /auth/login
  // trims the exact same input before looking it up, so the two endpoints
  // disagreed about what counts as a valid address.
  const normalizedEmail =
    typeof email === "string" ? email.trim().toLowerCase() : email;
  if (!isValidEmail(normalizedEmail)) {
    return res.status(400).json({ error: "enter a valid email address" });
  }
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }
  const normalizedFirstName = typeof firstName === "string" ? firstName.trim() : "";
  if (!normalizedFirstName) {
    return res.status(400).json({ error: "enter your first name" });
  }
  // Generous but not unbounded -- this only ever renders in a greeting
  // ("Good morning, {name}"), so there's no reason to accept anything long
  // enough to look broken there.
  if (normalizedFirstName.length > 50) {
    return res.status(400).json({ error: "first name is too long" });
  }

  const { rows: existingRows } = await pool.query("SELECT id FROM users WHERE email = $1", [
    normalizedEmail,
  ]);
  if (existingRows[0]) {
    return res.status(409).json({ error: "an account with that email already exists" });
  }

  const password_hash = await bcrypt.hash(password, 10);
  // The SELECT above is a nicety, not the real guard -- two signups for the
  // same address that arrive at once both pass it, and the second INSERT
  // then throws on the UNIQUE index. Postgres reports that as error code
  // 23505 (unique_violation) -- catch specifically that and return exactly
  // the same 409 the pre-check would have, rather than a generic 500.
  let userId;
  try {
    const { rows } = await pool.query(
      "INSERT INTO users (email, password_hash, tier, first_name) VALUES ($1, $2, 'free', $3) RETURNING id",
      [normalizedEmail, password_hash, normalizedFirstName]
    );
    userId = rows[0].id;
  } catch (err) {
    if (err && err.code === "23505") {
      return res.status(409).json({ error: "an account with that email already exists" });
    }
    console.error("[clip-server] /auth/signup insert failed:", err);
    return res.status(500).json({ error: "couldn't create that account" });
  }

  const user = { id: userId, email: normalizedEmail, tier: "free" };

  // Deliberately not awaited -- sendWelcomeEmail already catches its own
  // errors internally (see email.js), and there's no reason to make someone
  // wait on an email provider round-trip just to finish signing up.
  sendWelcomeEmail(normalizedEmail);

  res.json({
    token: signSession(user),
    user: { email: user.email, tier: user.tier, first_name: normalizedFirstName },
  });
});

app.post("/auth/login", async (req, res) => {
  if (!JWT_SECRET) return res.status(500).json({ error: "server is not configured for accounts yet" });

  const { email, password } = req.body || {};
  if (typeof email !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "email and password are required" });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [normalizedEmail]);
  const row = rows[0];
  // Same "invalid email or password" message either way -- doesn't leak
  // whether the email exists at all.
  if (!row) return res.status(401).json({ error: "invalid email or password" });

  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return res.status(401).json({ error: "invalid email or password" });

  res.json({
    token: signSession(row),
    user: { email: row.email, tier: row.tier, first_name: row.first_name || "" },
  });
});

function requireAuth(req, res, next) {
  const header = req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing session" });
  try {
    req.authUser = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "session expired -- please log in again" });
  }
}

// Lets an existing account (created before first_name was collected at
// signup, or anyone who just wants to change it) set/update their display
// name from Settings -- see SettingsPanel.tsx's Account section and
// update_first_name in main.rs. Same validation as signup's own first-name
// check.
app.post("/auth/update-profile", requireAuth, async (req, res) => {
  const { firstName } = req.body || {};
  const normalizedFirstName = typeof firstName === "string" ? firstName.trim() : "";
  if (!normalizedFirstName) {
    return res.status(400).json({ error: "enter your first name" });
  }
  if (normalizedFirstName.length > 50) {
    return res.status(400).json({ error: "first name is too long" });
  }

  const { rows } = await pool.query(
    "UPDATE users SET first_name = $1 WHERE id = $2 RETURNING email, tier, first_name",
    [normalizedFirstName, req.authUser.sub]
  );
  if (!rows[0]) return res.status(404).json({ error: "account not found" });
  res.json({ user: rows[0] });
});

// Lets the app re-check a stored session is still valid and pull the
// account's current tier (e.g. after upgrading on another device, once
// real billing exists).
app.get("/auth/me", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT email, tier, first_name FROM users WHERE id = $1", [
    req.authUser.sub,
  ]);
  if (!rows[0]) return res.status(404).json({ error: "account not found" });
  res.json({ user: { ...rows[0], first_name: rows[0].first_name || "" } });
});

// --- Billing (Stripe) ------------------------------------------------------
//
// See docs/billing-flow.md for the full picture. The short version: both
// routes below need the full users row (not just the {sub, email} the JWT
// carries), since billing.js needs stripe_customer_id to know whether to
// create a new Stripe Customer or reuse an existing one.

app.post("/billing/checkout", requireAuth, async (req, res) => {
  const { plan } = req.body || {};
  if (plan !== "monthly" && plan !== "annual") {
    return res.status(400).json({ error: "plan must be 'monthly' or 'annual'" });
  }

  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [req.authUser.sub]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: "account not found" });

  try {
    const url = await billing.createCheckoutSession(user, plan);
    res.json({ url });
  } catch (err) {
    console.error("[clip-server] /billing/checkout failed:", err);
    res.status(502).json({ error: err.message || "couldn't start checkout" });
  }
});

app.post("/billing/portal", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [req.authUser.sub]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: "account not found" });

  try {
    const url = await billing.createPortalSession(user);
    res.json({ url });
  } catch (err) {
    console.error("[clip-server] /billing/portal failed:", err);
    res.status(400).json({ error: err.message || "couldn't open billing portal" });
  }
});

// --- Password reset -------------------------------------------------------
//
// Two-step flow: request a reset (always responds the same way whether or
// not the email exists, so this can't be used to check who has an account),
// then submit the token that arrived by email along with a new password.
//
// The token itself is a long random string, generated with crypto's CSPRNG
// (not Math.random, which is not safe for anything security-sensitive).
// Only its SHA-256 hash is ever stored -- if the database leaked, the
// tokens in it wouldn't be directly usable, same reasoning as hashing
// passwords with bcrypt (a fast hash is fine here, unlike passwords,
// because this token already has far more entropy than any password a
// person would choose, so it isn't at risk from an offline brute-force
// guessing attack the way a weak password would be).
//
// Clip is a desktop app with no registered URL scheme to deep-link a
// browser "reset your password" page back into it, so instead of a
// clickable link, the email contains a token the person copies and pastes
// into the app's "Reset password" screen (see AuthGate.tsx) -- the same
// shape of flow as pasting a verification code, just longer.

const RESET_TOKEN_BYTES = 32; // -> 43-char base64url string once encoded
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function hashResetToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 5, // generous for someone retrying a typo'd email, not for inbox-bombing a stranger
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many attempts -- try again in a few minutes" },
});
app.use(["/auth/forgot-password", "/auth/reset-password"], passwordResetLimiter);

app.post("/auth/forgot-password", async (req, res) => {
  if (!JWT_SECRET) return res.status(500).json({ error: "server is not configured for accounts yet" });

  const { email } = req.body || {};
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const GENERIC_RESPONSE = {
    message: "If an account exists for that email, a reset code is on its way.",
  };
  if (!isValidEmail(normalizedEmail)) {
    // Still 200, not 400 -- an attacker probing for valid accounts shouldn't
    // be able to tell "bad email format" apart from "valid but unknown
    // email" apart from "known email, code sent" by response shape alone.
    return res.json(GENERIC_RESPONSE);
  }

  const { rows } = await pool.query("SELECT id FROM users WHERE email = $1", [normalizedEmail]);
  const user = rows[0];
  if (user) {
    const token = crypto.randomBytes(RESET_TOKEN_BYTES).toString("base64url");
    const tokenHash = hashResetToken(token);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    // Invalidate any outstanding tokens for this account first -- only the
    // most recently requested code should work, so an old email lying
    // around (or a stale link in a compromised inbox) doesn't stay valid
    // forever.
    await pool.query("DELETE FROM password_reset_tokens WHERE user_id = $1", [user.id]);
    await pool.query(
      "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
      [user.id, tokenHash, expiresAt]
    );

    // Awaited (unlike the welcome email) because this token is the only way
    // the flow completes -- if sending genuinely fails, that should show up
    // in the server log rather than silently vanishing. The response to the
    // client stays generic either way, so this doesn't leak account
    // existence through timing or response shape.
    try {
      await sendPasswordResetEmail(normalizedEmail, token);
    } catch (err) {
      console.error("[clip-server] failed to send password reset email:", err);
    }
  }

  res.json(GENERIC_RESPONSE);
});

app.post("/auth/reset-password", async (req, res) => {
  if (!JWT_SECRET) return res.status(500).json({ error: "server is not configured for accounts yet" });

  const { token, new_password } = req.body || {};
  if (typeof token !== "string" || !token.trim()) {
    return res.status(400).json({ error: "reset code is required" });
  }
  if (typeof new_password !== "string" || new_password.length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }

  const tokenHash = hashResetToken(token.trim());
  const { rows } = await pool.query(
    `SELECT prt.id AS token_id, prt.expires_at, prt.used_at, u.id AS user_id, u.email, u.tier
     FROM password_reset_tokens prt
     JOIN users u ON u.id = prt.user_id
     WHERE prt.token_hash = $1`,
    [tokenHash]
  );
  const row = rows[0];

  // Same error either way -- an expired code and a wrong/already-used code
  // should look identical to whoever's typing it in.
  const invalid = () => res.status(400).json({ error: "that reset code is invalid or has expired" });

  if (!row) return invalid();
  if (row.used_at) return invalid();
  if (new Date(row.expires_at).getTime() < Date.now()) return invalid();

  const password_hash = await bcrypt.hash(new_password, 10);
  await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [
    password_hash,
    row.user_id,
  ]);
  await pool.query("UPDATE password_reset_tokens SET used_at = now() WHERE id = $1", [
    row.token_id,
  ]);

  const user = { id: row.user_id, email: row.email, tier: row.tier };
  // Sign the person straight back in, same as signup/login -- they just
  // proved account ownership by reading the code out of their inbox, no
  // reason to make them log in a second time right after.
  res.json({ token: signSession(user), user: { email: user.email, tier: user.tier } });
});

// Simple shared-secret check. This is NOT real per-user auth -- it just
// confirms the request came from a build of the app that knows the secret,
// so this endpoint can't be hammered anonymously by anyone who finds the
// URL. Kept as an outer layer alongside requireAuth/requirePro below rather
// than replaced by them -- this blocks a request before it even costs a DB
// lookup, and stays useful defense-in-depth even once real per-user auth is
// in place.
function requireAppSecret(req, res, next) {
  if (!APP_SHARED_SECRET) return next(); // not configured -> auth disabled (local dev)
  const provided = req.header("x-app-secret");
  if (provided !== APP_SHARED_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// Real per-user tier gate for the three AI-backed endpoints (/transform,
// /filter-match, /embed) -- all three cost real money per call, so unlike
// most of this file, this is the actual security boundary, not just UX.
//
// Deliberately re-queries the users table on every request rather than
// trusting anything carried in the JWT (the token only ever holds
// `sub`/`email`, see signSession -- tier is never embedded in it). Sessions
// are valid 180 days; baking tier into the token would mean an account
// downgraded by Stripe (once that's wired up) or by hand stays "Pro" from
// the app's perspective for up to half a year. A single indexed lookup on
// a tiny table is cheap enough that there's no real reason to cache it.
//
// Must run after requireAuth (needs req.authUser.sub).
async function requirePro(req, res, next) {
  try {
    const { rows } = await pool.query("SELECT tier FROM users WHERE id = $1", [
      req.authUser.sub,
    ]);
    if (!rows[0]) {
      return res.status(401).json({ error: "account not found -- please log in again" });
    }
    if (rows[0].tier !== "pro") {
      return res.status(403).json({ error: "this feature requires Clip Pro" });
    }
    next();
  } catch (err) {
    console.error("[clip-server] tier check failed:", err);
    res.status(500).json({ error: "something went wrong" });
  }
}

// --- Abuse/cost caps --------------------------------------------------
//
// The daily cap below is now keyed by authenticated user id when available
// (see dailyCap) -- requireAuth/requirePro run ahead of it on every gated
// route, so req.authUser is always set by the time it runs. The shared
// secret/IP fallback stays for routes or configurations where that isn't
// true. Both caps are in-memory and reset if the server restarts/redeploys
// -- fine for a stopgap, not a substitute for real per-account usage
// tracking/dashboards.

// 1. Burst limiter: a scripted client can fire hundreds of requests per
// second; the daily cap below wouldn't even register that as unusual until
// the damage (and the bill) is already done. This just slows down bursts,
// keyed by IP since that's available before we even look at the body/header.
const burstLimiter = rateLimit({
  windowMs: 60_000,
  max: 20, // generous for a human clicking a button repeatedly; not for a script
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many requests -- slow down and try again in a minute" },
});
app.use(["/transform", "/filter-match"], burstLimiter);

// /embed gets its own, more generous burst limiter -- unlike /transform and
// /filter-match (each triggered by one explicit click), search-time semantic
// queries fire every time someone pauses typing in the search bar (see
// App.tsx's debounced effect), so a real person doing several searches in a
// row is expected to look "bursty" in a way the other two never are.
const embedBurstLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many requests -- slow down and try again in a minute" },
});
app.use("/embed", embedBurstLimiter);

// 2. Daily cap: bounds total worst-case spend per key/IP per day. Numbers
// are set well above what any real, actively-using human would hit --
// /transform is a quick, cheap call people might fire dozens of times a day;
// /filter-match is far pricier per call (it can carry up to 500 clipboard
// items as context), so a real user has little reason to run it more than a
// handful of times a day.
const DAILY_LIMITS = {
  transform: 500,
  "filter-match": 50,
  // Each search-bar pause is one call embedding a short query string (cheap,
  // ~$0.00000004 at voyage-3.5-lite pricing) -- generous headroom for
  // someone doing dozens of searches a day, still a hard ceiling against a
  // scripted client.
  embed: 4000,
};

const usage = new Map(); // key -> { day: "YYYY-MM-DD", counts: { [kind]: number } }

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// Clears out stale entries once a day so this Map doesn't grow forever.
setInterval(() => {
  const day = todayUTC();
  for (const [key, entry] of usage) {
    if (entry.day !== day) usage.delete(key);
  }
}, 60 * 60 * 1000).unref();

function dailyCap(kind) {
  return (req, res, next) => {
    const key =
      req.authUser && req.authUser.sub != null
        ? `user:${req.authUser.sub}`
        : req.header("x-app-secret") || req.ip;
    const day = todayUTC();
    let entry = usage.get(key);
    if (!entry || entry.day !== day) {
      entry = { day, counts: {} };
      usage.set(key, entry);
    }
    const count = entry.counts[kind] || 0;
    if (count >= DAILY_LIMITS[kind]) {
      console.warn(`[clip-server] daily cap hit for ${kind} (key=${key})`);
      return res.status(429).json({ error: "daily limit reached -- try again tomorrow" });
    }
    entry.counts[kind] = count + 1;
    next();
  };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/transform", requireAppSecret, requireAuth, requirePro, dailyCap("transform"), async (req, res) => {
  const { content, instruction } = req.body || {};

  if (typeof content !== "string" || !content.trim()) {
    return res.status(400).json({ error: "content is required" });
  }
  if (typeof instruction !== "string" || !instruction.trim()) {
    return res.status(400).json({ error: "instruction is required" });
  }
  // Guard against someone sending a huge payload through this endpoint --
  // clipboard transforms should be short, not entire documents.
  if (content.length > 20000) {
    return res.status(400).json({ error: "content too long" });
  }
  // Same guard on the instruction -- without it, everything the content cap
  // stops could just be moved into `instruction` and forwarded upstream
  // anyway (both end up in the same prompt, and both cost the same per
  // token).
  if (instruction.length > 20000) {
    return res.status(400).json({ error: "instruction too long" });
  }

  try {
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `Apply this instruction to the text below. Return ONLY the transformed text, with no preamble, no explanation, and no quotation marks around it.\n\nInstruction: ${instruction}\n\nText:\n${content}`,
        },
      ],
    });

    const transformed = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    res.json({ result: transformed });
  } catch (err) {
    console.error("[clip-server] /transform failed:", err);
    res.status(502).json({ error: "transform failed" });
  }
});

app.post("/filter-match", requireAppSecret, requireAuth, requirePro, dailyCap("filter-match"), async (req, res) => {
  const { items, prompt } = req.body || {};

  if (!Array.isArray(items)) {
    return res.status(400).json({ error: "items must be an array" });
  }
  if (typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "prompt is required" });
  }
  // Same spirit as /transform's content-length guard -- this is meant for a
  // user's clipboard history, not an unbounded payload.
  if (items.length > 500) {
    return res.status(400).json({ error: "too many items" });
  }
  // Same guard as /transform's on `instruction` -- `prompt` is concatenated
  // straight into the upstream request, so it needs its own ceiling too.
  if (prompt.length > 20000) {
    return res.status(400).json({ error: "prompt too long" });
  }
  // Every entry has to be an object before the `it.id` / `it.content` reads
  // below -- mirrors /embed's per-element check on `texts`. A single null in
  // this array used to throw out of this async handler (express 4 doesn't
  // await route handlers), taking the whole process down with it.
  if (items.some((it) => typeof it !== "object" || it === null)) {
    return res.status(400).json({ error: "each item must be an object" });
  }

  if (items.length === 0) {
    return res.json({ matches: [] });
  }

  const numbered = items
    .map((it) => `${it.id}: ${String(it.content ?? "").slice(0, 500)}`)
    .join("\n");

  try {
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `Below is a numbered list of clipboard history entries ("id: content"). Return ONLY a JSON array of the ids whose content matches this filter description, with no preamble, no explanation, and no markdown formatting. If nothing matches, return [].\n\nFilter: ${prompt}\n\nEntries:\n${numbered}`,
        },
      ],
    });

    const raw = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    let matches = [];
    try {
      const jsonText = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
      const parsed = JSON.parse(jsonText);
      if (Array.isArray(parsed)) {
        matches = parsed.map((id) => Number(id)).filter((id) => !Number.isNaN(id));
      }
    } catch {
      // Model didn't return parseable JSON -- treat as no matches rather
      // than erroring the whole request out.
    }

    res.json({ matches });
  } catch (err) {
    console.error("[clip-server] /filter-match failed:", err);
    res.status(502).json({ error: "filter failed" });
  }
});

// --- Semantic search (Pro-only, gated in the Rust command layer) -------
//
// Anthropic has no embeddings API of its own, so this proxies to Voyage AI
// the same way /transform proxies to Claude -- the real VOYAGE_API_KEY only
// ever lives here, never inside the desktop app. voyage-3.5-lite is Voyage's
// cheap/fast tier (comparable in spirit to using Haiku for /transform
// instead of Opus), with output_dimension pinned to 512 rather than the
// 1024 default -- smaller vectors mean less to store per clip and a faster
// cosine-similarity scan in db.rs::semantic_search, and 512 is still plenty
// of dimensionality for personal-clipboard-history-sized retrieval.
async function voyageEmbed(texts, inputType) {
  const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input: texts,
      model: "voyage-3.5-lite",
      input_type: inputType,
      output_dimension: 512,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`voyage embeddings request failed (${resp.status}): ${body}`);
  }

  const data = await resp.json();
  // Voyage returns `data: [{ embedding, index }, ...]` -- sort by index
  // rather than trusting array order, then strip back down to just the
  // vectors so the Rust side gets a plain array-of-arrays lined up with the
  // input texts it sent.
  return [...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

app.post("/embed", requireAppSecret, requireAuth, requirePro, dailyCap("embed"), async (req, res) => {
  if (!VOYAGE_API_KEY) {
    return res.status(500).json({ error: "server is not configured for semantic search yet" });
  }

  const { texts, input_type } = req.body || {};

  if (!Array.isArray(texts) || texts.length === 0) {
    return res.status(400).json({ error: "texts must be a non-empty array" });
  }
  if (texts.length > 100) {
    return res.status(400).json({ error: "too many texts in one request" });
  }
  if (input_type !== "query" && input_type !== "document") {
    return res.status(400).json({ error: "input_type must be 'query' or 'document'" });
  }
  // Same spirit as /transform's content-length guard -- clipboard-sized
  // text, not entire documents.
  if (texts.some((t) => typeof t !== "string" || t.length > 20000)) {
    return res.status(400).json({ error: "one or more texts is invalid or too long" });
  }

  try {
    const embeddings = await voyageEmbed(texts, input_type);
    res.json({ embeddings });
  } catch (err) {
    console.error("[clip-server] /embed failed:", err);
    res.status(502).json({ error: "embedding failed" });
  }
});

// Anything that throws before/inside a route handler ends up here. Without
// this, express falls back to its built-in error handler, which (unless
// NODE_ENV=production is set, and nothing here sets it) renders an HTML page
// containing the full stack trace and absolute server file paths -- so a
// truncated JSON body or an over-limit payload leaked the server's directory
// layout and dependency versions to whoever sent it. Reply with the same
// JSON shape every other endpoint uses instead, and keep the detail in the
// server log where it belongs.
// eslint-disable-next-line no-unused-vars -- express identifies error
// middleware by arity, so `next` has to stay in the signature.
app.use((err, _req, res, _next) => {
  const status = err && Number.isInteger(err.status) ? err.status : 500;
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "invalid JSON body" });
  }
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ error: "request body too large" });
  }
  console.error("[clip-server] unhandled request error:", err);
  res.status(status).json({ error: "something went wrong" });
});

// initDb() has to finish (creating the users/password_reset_tokens tables
// if they don't exist yet) before the server starts accepting requests --
// this file is CommonJS, so a plain top-level `await` isn't available,
// hence the wrapper. A failure here (e.g. DATABASE_URL points at something
// unreachable) should stop the process loudly rather than come up and fail
// every /auth/* request one at a time.
async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`[clip-server] listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("[clip-server] failed to start:", err);
  process.exit(1);
});
