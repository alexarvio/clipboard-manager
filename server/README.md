# Clip server

A tiny proxy server that lets the Clip desktop app use AI transforms (fix
grammar, summarize, translate, etc.) without ever shipping a real API key
inside the app itself.

## Why this exists

The desktop app can't safely hold an Anthropic API key — anything inside a
distributed binary can be extracted by anyone who downloads it, and then
they're spending your money with no limit. So instead:

```
Clip app  --(content + instruction)-->  this server  --(real API key)-->  Anthropic
```

This server is also where future per-user gating lives (checking someone's
paid subscription before letting their request through). For now it only has
a single shared-secret check — good enough to stop randoms from hammering the
endpoint once it's deployed, but not real per-user billing yet.

## Run it locally

```
cd server
npm install
cp .env.example .env
# edit .env: paste in your real ANTHROPIC_API_KEY (from console.anthropic.com),
# set DATABASE_URL to a Postgres connection string (a free instance from
# neon.tech, supabase.com, or Railway's Postgres add-on all work -- see
# "Accounts & Postgres" below), set a JWT_SECRET (e.g. `openssl rand -hex 32`)
# for the accounts endpoints, and optionally a RESEND_API_KEY (from
# resend.com) for the welcome/password-reset emails
npm start
```

It listens on `http://localhost:8787` by default. Test it:

```
curl http://localhost:8787/health
```

## Endpoints

- `GET /health` — returns `{ ok: true }` if the server is up.
- `POST /transform` — body `{ "content": "...", "instruction": "..." }`,
  returns `{ "result": "..." }`. Calls Claude Haiku 4.5 under the hood
  (fast + cheap, the right model for short transforms like this).
- `POST /auth/signup` — body `{ "email": "...", "password": "..." }` (password
  8+ chars). Creates an account (starts on the `free` tier) and returns
  `{ "token": "...", "user": { "email": "...", "tier": "free" } }`.
- `POST /auth/login` — same body shape, returns the same shape for an
  existing account.
- `GET /auth/me` — requires `Authorization: Bearer <token>`, returns
  `{ "user": { "email": "...", "tier": "..." } }`. Used by the app to
  re-check a stored session is still valid and pick up a tier change.
- `POST /auth/forgot-password` — body `{ "email": "..." }`. Always returns
  `200 { "message": "..." }`, whether or not that email has an account —
  this is deliberate, so the endpoint can't be used to check who's signed
  up. If the account exists, emails it a one-time reset code (valid 1 hour).
- `POST /auth/reset-password` — body `{ "token": "...", "new_password": "..." }`
  where `token` is the code from that email. Returns the same
  `{ "token": "...", "user": {...} }` shape as signup/login on success (the
  app signs the person straight back in), or `400` if the code is wrong,
  already used, or expired.
- `POST /embed` — body `{ "texts": ["..."], "input_type": "query" | "document" }`
  (up to 100 texts per call), returns `{ "embeddings": [[...], ...] }`, one
  vector per input text, same order. Proxies to Voyage AI
  (`voyage-3.5-lite`, 512 dimensions) the same way `/transform` proxies to
  Claude — the real `VOYAGE_API_KEY` only ever lives here. Backs semantic
  search: the desktop app embeds new clips as `"document"` in the background
  and the search query as `"query"`, then ranks by cosine similarity
  entirely on-device (see `src-tauri/src/db.rs`'s `semantic_search`) — this
  endpoint never sees your clipboard history in bulk, only one clip's text
  at a time (or a batch during the one-time backfill after upgrading to
  Pro).
- `POST /billing/checkout` — requires `Authorization: Bearer <token>`, body
  `{ "plan": "monthly" | "annual" }`, returns `{ "url": "..." }` — a Stripe
  Checkout URL to open in the system browser. Starts a 7-day trial.
- `POST /billing/portal` — requires auth, no body, returns `{ "url": "..." }`
  — a Stripe Billing Portal URL for managing or cancelling the subscription.
  Errors if the account has never checked out.
- `POST /billing/webhook` — Stripe calls this, not the app. See
  `billing.js` and `docs/billing-flow.md`.

## Accounts & Postgres

Accounts live in Postgres now (`DATABASE_URL`), not a local SQLite file.
That's deliberate: this server's own filesystem gets wiped on every deploy
on most hosts (Railway/Render/Fly all rebuild the container from scratch),
so a SQLite file sitting next to `index.js` would lose every account — and
every paying customer's `tier` — the next time you push a fix. Postgres
lives on a separate, persistent host and comes with automated backups on
any of the managed providers above. `db.js` creates the `users` and
`password_reset_tokens` tables automatically on startup if they don't exist
yet (`CREATE TABLE IF NOT EXISTS`) — no separate migration step needed, in
either direction (fresh database or one that already has these tables).

This is entirely separate from the desktop app's own local SQLite database
(`src-tauri/src/db.rs`) — that one stores clipboard history on each user's
own machine and was never a candidate to move; only server-side *accounts*
moved to Postgres.

Passwords are hashed with bcrypt; sessions are JWTs signed with
`JWT_SECRET`, valid 180 days.

`POST /auth/signup` also fires off a welcome email via Resend (see
`email.js`) — fire-and-forget, so a missing `RESEND_API_KEY` or a failed send
never blocks account creation, it just skips the email and logs a warning.
`POST /auth/forgot-password` sends a similar email with a reset code — this
one *is* awaited and logged on failure (not fire-and-forget), since it's the
only way that flow completes; without `RESEND_API_KEY` set, the code is
logged to the server console instead, so the flow is still testable locally.
Without a verified domain, Resend's own `onboarding@resend.dev` sender works
out of the box but can only deliver to the email address you signed up to
Resend with — fine for testing, not for real users. To actually send to
anyone: add your domain in the Resend dashboard, verify the DNS records they
give you (SPF/DKIM), then set `EMAIL_FROM` to an address on that domain.

Locked out and email isn't reachable (misconfigured `RESEND_API_KEY` in
production, etc.)? `node reset-password.js you@example.com newpassword`
resets a password directly against `DATABASE_URL`, bypassing email entirely
— see the comment at the top of that file.

If `APP_SHARED_SECRET` is set in `.env`, requests to `/transform`,
`/filter-match`, and `/embed` must include a matching `x-app-secret` header
or they get a 401. Leave it blank for local dev. This is separate from
`/auth/*` above — accounts identify *who* someone is, the shared secret just
confirms a request came from a real build of the app.

## Billing (Stripe)

See `docs/billing-flow.md` for the full picture. Short version: `/transform`,
`/filter-match`, and `/embed` also require `Authorization: Bearer <token>`
and re-check `tier` straight from the `users` table on every request (not
from anything the client sends) — Stripe is what actually flips that column
now, via `/billing/webhook`.

Local testing needs the Stripe CLI (`stripe listen --forward-to
localhost:8787/billing/webhook`) to get webhook events to your machine —
Stripe can't reach `localhost` directly. The CLI prints a `whsec_...` value
each time you run it; that's what goes in `STRIPE_WEBHOOK_SECRET` for local
dev (a *different* value than the one in your production dashboard, since
each webhook endpoint — the CLI's local forwarder counts as one — gets its
own signing secret).

## Deploying it somewhere real

This is a plain Node/Express app, so any of these work with basically zero
config: Railway, Render, or Fly.io (all have free/cheap tiers good enough for
early traffic). Whichever you pick:

1. Set up a managed Postgres instance (neon.tech, supabase.com, or your
   host's own Postgres add-on all work) and copy its connection string.
2. Deploy the website (`website/`) somewhere with a real HTTPS URL — Stripe
   Checkout needs a real reachable `success_url`/`cancel_url` to redirect to.
3. In the Stripe dashboard: create the "Clip Pro" product with its two
   prices, add a webhook endpoint pointed at
   `https://your-deployed-server.com/billing/webhook` subscribed to
   `checkout.session.completed`, `customer.subscription.updated`, and
   `customer.subscription.deleted`, and copy its signing secret.
4. Set `ANTHROPIC_API_KEY`, `DATABASE_URL`, `APP_SHARED_SECRET`,
   `JWT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_ANNUAL`, `WEBSITE_URL`, and
   (optionally) `RESEND_API_KEY`/`EMAIL_FROM`/`VOYAGE_API_KEY` in that
   platform's dashboard (never commit `.env`).
5. Point the desktop app's Settings → server URL at the deployed URL instead
   of `http://localhost:8787`.

## Cost reality check

Claude Haiku 4.5 is $1.00 per million input tokens, $5.00 per million output
tokens. A typical clipboard transform (~50 tokens in, ~80 out) costs roughly
$0.00045. Even 1,000 people each running 50 transforms a day works out to
about $675/month in API spend — trivial against any reasonable subscription
price across a few hundred paying users.

## What's NOT built yet

- Real Stripe products/prices/webhook — the code is wired end to end, but
  needs an actual Stripe account with a "Clip Pro" product, two prices, and
  a webhook endpoint created in the dashboard before any of it does
  anything (see `docs/billing-flow.md`)
- Trial-ending / payment-failure emails — Stripe drives the subscription
  state machine, but nothing emails the customer about it yet (e.g. "your
  trial ends in 2 days", "your card was declined")
- The dev-only Plan toggle in `SettingsPanel.tsx` still exists for local
  testing and isn't gated behind a debug build flag — see the note in
  `docs/billing-flow.md`
- Email verification — password reset exists now (see above); verifying an
  email address at signup does not
- Trial-lifecycle emails ("trial ending soon", win-back, etc.) — there's no
  trial concept in the schema yet (`tier` is just "free"/"pro"), and no
  scheduled job to send time-based emails; the welcome email is a one-off
  triggered directly by sign-up, not part of a sequence
- Usage tracking/dashboards per account (only the abuse caps above, which are
  keyed by shared secret/IP, not by account)
