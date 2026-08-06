// Emergency admin helper: resets a user's password directly in the
// database, bypassing the normal email-a-code flow entirely.
//
// Why this still exists now that /auth/forgot-password and
// /auth/reset-password are real (see index.js): those depend on the
// account's inbox being reachable and RESEND_API_KEY being configured. This
// is the break-glass fallback for everything else -- someone locked out
// with no working email on file, RESEND_API_KEY misconfigured in
// production, etc. Not wired into the server; npm start doesn't touch it.
//
// Usage (from the server/ folder, against the same DATABASE_URL the server
// itself uses -- set in .env or passed inline):
//   node reset-password.js you@example.com yournewpassword
const bcrypt = require("bcryptjs");
const { pool } = require("./db");

const [, , email, newPassword] = process.argv;

async function main() {
  if (!email || !newPassword) {
    console.error("Usage: node reset-password.js <email> <new-password>");
    process.exit(1);
  }

  if (newPassword.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const normalizedEmail = email.trim().toLowerCase();
  const { rows } = await pool.query("SELECT id FROM users WHERE email = $1", [normalizedEmail]);
  const row = rows[0];

  if (!row) {
    console.error(`No account found for ${normalizedEmail}.`);
    process.exit(1);
  }

  const password_hash = await bcrypt.hash(newPassword, 10);
  await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [password_hash, row.id]);
  // Also invalidate any outstanding self-serve reset codes for this account,
  // same as the real /auth/reset-password flow does -- otherwise an old
  // emailed code would still work after this manual override.
  await pool.query("DELETE FROM password_reset_tokens WHERE user_id = $1", [row.id]);

  console.log(`Password updated for ${normalizedEmail}. You can log in with the new password now.`);
  await pool.end();
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
