# Clip — Billing Flow

Part of the product/infra planning docs (see `free-vs-pro.md` for the tier feature breakdown this builds on).

**Status: implemented (2026-08-03).** This doc used to sketch a license-key
model on the premise that Clip had no concept of an account. That premise is
gone — real accounts (email + password, JWT sessions, `tier` on the server
in Postgres) shipped first, and server-side tier enforcement (every
AI-backed endpoint re-checks `tier` from the database, not from anything the
client sends) shipped after that. Billing slots into that existing identity
layer instead of inventing a new one: **Stripe subscriptions are tied to the
same account row that already has a `tier` column**, no license key, no
pasting a code into Settings.

## Pricing

- **$3.99/mo**, or **$29/yr** (~40% off the monthly rate — a real incentive
  to pick annual, which is better for retention and cash flow than a token
  discount).
- **7-day free trial, card required up front** — Stripe auto-charges at day
  7 unless cancelled; this needs zero custom code beyond setting
  `subscription_data.trial_period_days: 7` on the Checkout session.
  Cancelling during the trial reverts to Free at day 7, nothing charged.
- Free tier stays free forever, capped as described in `free-vs-pro.md`.
  Free costs nothing to run (no AI calls), so there's no cost pressure to
  ever change that.

## How identity carries through

1. User is already signed in (real requirement before first app use, see
   `AuthGate.tsx`) — the app always has a valid session token by the time
   billing is relevant.
2. Starting checkout is `POST /billing/checkout` with that same
   `Authorization: Bearer <token>` header everything else already sends.
   The server knows exactly which account this is for — no separate
   "prove who you are to Stripe" step.
3. Stripe Checkout collects the card (Clip never touches card details,
   keeping it out of PCI scope). On completion, the server's webhook
   handler stamps `stripe_customer_id` onto that same `users` row and sets
   `tier = 'pro'`.
4. Next time the app calls any Pro-gated endpoint, or re-checks `/auth/me`,
   it sees the new tier. No activation code, nothing to paste.

## Schema

Three columns added to the existing `users` table (`server/db.js`):

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT;
```

`subscription_status` mirrors Stripe's own subscription status
(`trialing`/`active`/`past_due`/`canceled`/etc.) — kept separately from
`tier` because they're not quite the same thing: `tier` is the binary
free/pro the rest of the app already checks everywhere, `subscription_status`
is the finer-grained Stripe state used to decide *what `tier` should be* and
to show something more informative than "Pro" or "Free" in Settings (e.g.
"Pro — trial ends in 4 days", "Pro — payment failed, update your card").

## Tier state machine

| Stripe subscription status | `tier` | Reasoning |
|---|---|---|
| `trialing` | `pro` | Trial means full access, that's the point of a trial |
| `active` | `pro` | Paying normally |
| `past_due` | `pro` | **Decision:** grace period. Stripe's Smart Retries are already trying to recharge the card; dropping someone to Free the moment a card expires (before they've even noticed) is a bad experience for what's usually a temporary problem. They keep Pro until retries are exhausted. |
| `canceled` / `unpaid` / `incomplete_expired` | `free` | Subscription is genuinely over |

History/folders/pins already saved are never touched by a tier change —
dropping to Free just re-imposes the caps (50 items/7 days, 3 pins, 3
folders) going forward, per `free-vs-pro.md`.

## Endpoints (`server/index.js` + `server/billing.js`)

- `POST /billing/checkout` (requires auth) — body `{ "plan": "monthly" | "annual" }`.
  Creates or reuses a Stripe Customer for this account, creates a Checkout
  Session in subscription mode with a 7-day trial, returns `{ "url": "..." }`
  for the app to open in the system browser.
- `POST /billing/portal` (requires auth) — creates a Stripe Billing Portal
  session (handles plan switching and cancellation entirely on Stripe's
  side — far less work and more trustworthy than building that UI
  ourselves) and returns `{ "url": "..." }`. Errors if the account has never
  checked out (no `stripe_customer_id` yet).
- `POST /billing/webhook` — Stripe webhook receiver. Verifies the
  `Stripe-Signature` header against `STRIPE_WEBHOOK_SECRET` (this route is
  mounted with `express.raw()`, ahead of the app's global `express.json()`
  middleware, since signature verification needs the exact raw request
  body). Handles:
  - `checkout.session.completed` — stamps `stripe_customer_id` and
    `stripe_subscription_id` onto the account.
  - `customer.subscription.updated` — the main state-transition event
    (trialing → active, active → past_due, etc.); updates
    `subscription_status` and derives `tier` per the table above.
  - `customer.subscription.deleted` — sets `subscription_status = 'canceled'`,
    `tier = 'free'`.

## App side

- `start_checkout(plan)` (Tauri command) calls `/billing/checkout`, opens
  the returned URL in the system browser (the `open` crate — no custom URL
  scheme, no deep-linking. Same reasoning as password reset: getting a
  browser tab to hand control back to a specific desktop app cleanly is a
  real platform-specific project, copy/return-to-the-app is not).
- Since there's no deep link back, the app can't be told the instant
  checkout finishes. Instead, once checkout opens, the UI polls
  `refresh_account_status` (hits `/auth/me`, updates local `tier`) every few
  seconds for a few minutes, and stops as soon as `tier` flips to `pro`. A
  manual "I've finished checking out" button covers anyone who takes longer
  than the polling window.
- `open_billing_portal()` calls `/billing/portal` and opens it the same way
  — this is how someone cancels or switches plans, from Settings.
- The dev-only Plan toggle in `SettingsPanel.tsx` (Settings → Plan) still
  exists for local testing without needing a real Stripe checkout every
  time, clearly labeled as not real billing. It's a genuine gap that
  nothing stops it from reaching a real build — see `free-vs-pro.md`'s
  "not built yet" list.

## Open questions (down from four to two)

- **Multiple devices**: signing into the same Pro account on a second
  device already grants Pro there too (tier lives on the account, not the
  device) — this was true the moment accounts shipped, unrelated to
  billing. Not treated as abuse; a family/multi-computer user having Pro
  everywhere they're signed in is a feature, not a leak.
- **Refunds/disputes**: no process defined yet for handling chargebacks or
  refund requests — needs a decision once real money is flowing. Stripe's
  dashboard handles the mechanics; the open question is just what Clip's
  own policy is.
