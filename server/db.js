// Postgres-backed store for real user accounts (email + hashed password +
// plan tier) and password reset tokens.
//
// This used to be a local SQLite file (server/data.db, via better-sqlite3).
// Moved to Postgres because SQLite here was a file living inside the
// server's own container -- on Railway/Render/Fly, a fresh deploy usually
// means a fresh filesystem, so every account (and every paying customer's
// tier) would vanish on the next `git push`. Postgres lives on a separate,
// persistent host, so redeploying the server doesn't touch it, and a
// managed provider (Neon, Supabase, Railway's own Postgres, etc.) gives you
// automated backups for free.
//
// The clipboard history itself is untouched by this -- that's local SQLite
// on the user's own machine (src-tauri/src/db.rs), a completely separate
// database with a completely separate reason to exist (per-device, never
// leaves the machine). Only server-side *accounts* moved.
//
// `pg` (node-postgres) is used directly rather than an ORM -- this is a
// two-table schema with a handful of queries, not worth the extra
// abstraction layer.

const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL || "";

if (!DATABASE_URL) {
  console.warn(
    "[clip-server] WARNING: DATABASE_URL is not set. /auth/* will fail until it is. " +
      "Get a free Postgres instance from neon.tech, supabase.com, or Railway, then set " +
      "DATABASE_URL to its connection string (looks like postgres://user:pass@host/dbname)."
  );
}

// Most managed Postgres providers (Neon, Supabase, Railway) require SSL and
// hand out a self-signed-looking chain from Node's perspective -- rejecting
// unauthorized certs here would just break every one of them out of the
// box. This is the standard, documented workaround for exactly that case,
// not a real security downgrade: the connection is still encrypted, this
// only skips validating the certificate chain.
const pool = new Pool(
  DATABASE_URL
    ? { connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }
    : undefined
);

pool.on("error", (err) => {
  // Fires on an *idle* connection going bad (network blip, provider
  // restart) -- without this handler, that's an uncaught exception that
  // takes the whole server down. A query-time failure is handled separately
  // by whatever awaited it.
  console.error("[clip-server] unexpected Postgres pool error:", err);
});

// Called once at startup (see index.js) before the server starts accepting
// requests. Safe to run every time the process boots -- IF NOT EXISTS makes
// this a no-op against an already-migrated database.
async function initDb() {
  if (!DATABASE_URL) return; // nothing to migrate against; routes will fail loudly per-request instead
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'free',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Every reset request looks this up by user_id (to invalidate old tokens)
  // and every reset submission scans for a matching, unexpired, unused
  // token -- both benefit from an index rather than a sequential scan as
  // this table grows.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_reset_tokens_user ON password_reset_tokens(user_id);
  `);

  // Billing (see docs/billing-flow.md and server/billing.js). ADD COLUMN IF
  // NOT EXISTS makes these safe to run against a database that already has
  // rows in `users` -- existing accounts just get NULLs here until they
  // check out for the first time.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT;`);
  // The webhook handler's first move on almost every event is "find the
  // account with this Stripe customer id" -- without an index that's a
  // sequential scan of the whole users table on every single webhook
  // delivery.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_users_stripe_customer_id ON users(stripe_customer_id);
  `);

  // Display name (2026-08-06), collected at signup so the app can show a
  // "Good morning, Alex" style greeting on the Dashboard instead of nothing
  // more personal than the account's email. Nullable/no default -- accounts
  // created before this column existed just show a name-less greeting
  // fallback (see Dashboard.tsx) rather than needing a backfill.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;`);

  // Email verification + trial-abuse prevention (2026-08-25). Accounts
  // already require an email/password to use the app at all (see
  // AuthGate.tsx), but nothing stopped someone from typing a fake or
  // disposable address, never proving they own it, and burning a fresh
  // 7-day Pro trial on it -- see docs/billing-flow.md's trial-abuse note.
  // email_verified gates the *trial*, not the free tier itself (see
  // billing.js::createCheckoutSession) -- verifying isn't required to use
  // Clip for free, only to start a Pro trial, so this adds zero friction
  // to the signups that were never going to abuse anything.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_verification_codes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_email_verification_user ON email_verification_codes(user_id);
  `);

  // The second half of the trial-abuse fix: verified email alone doesn't
  // stop someone determined enough (Gmail "+" aliases are infinite and each
  // one verifies fine). What actually costs an attacker something is a
  // real card, so this tracks which card *fingerprints* (Stripe's stable,
  // non-reversible id for "this physical card", not the PAN itself) have
  // already been used to start a trial. See billing.js's webhook handler --
  // a second account trying to trial on a fingerprint that's already been
  // used gets its trial ended immediately (charged now, same as a returning
  // customer) rather than the signup being blocked outright, since blocking
  // would also catch the legitimate case of two real people sharing a
  // household card.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trial_card_fingerprints (
      fingerprint TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subscription_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Voyage usage log (2026-08-09) -- Voyage has no usage/cost API of its
  // own (checked their full API reference: just embeddings/files/batch,
  // nothing for billing), so this is the only way to show a real cost
  // figure for it on the admin dashboard. One row per /embed call, logging
  // the real total_tokens Voyage's own response reports -- see voyageEmbed
  // in index.js. admin.js multiplies the sum by Voyage's published
  // per-token price to get an estimate; it's an estimate of *our* usage
  // against *their* list price, not something pulled from Voyage directly.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_usage_events (
      id SERIAL PRIMARY KEY,
      provider TEXT NOT NULL,
      kind TEXT NOT NULL,
      tokens INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // admin.js's cost estimate always filters by provider + a recent date
  // range (e.g. "last 30 days") -- a composite index on exactly those two
  // columns is what that query actually needs, rather than a sequential
  // scan that grows with every embed call.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_usage_events_provider_created ON ai_usage_events(provider, created_at);
  `);

  console.log("[clip-server] Postgres schema ready");
}

module.exports = { pool, initDb };
