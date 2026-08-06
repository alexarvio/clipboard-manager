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

  console.log("[clip-server] Postgres schema ready");
}

module.exports = { pool, initDb };
