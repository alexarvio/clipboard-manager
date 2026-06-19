# Clip — Billing Flow

Part of the product/infra planning docs (see `free-vs-pro.md` for the tier feature breakdown this builds on).

This doc sketches the contract the app needs to integrate against once a Stripe
account exists. Nothing here is implemented yet — `tier` in `settings.rs` is
still a local dev-only flag with no real billing behind it. The point of
writing this now is so the eventual Stripe integration has a clear shape to
slot into, instead of being designed from scratch under pressure later.

## The core architecture gap

Clip currently has **no concept of an account or identity** — it's a fully
local desktop app, and `tier` is just a flag a user can flip in Settings.
Stripe subscriptions are tied to a customer (email), not a device. So before
any billing code can work, the app needs *some* way to know "this install
belongs to a paying customer."

Two ways to close that gap:

1. **License key / activation code** — Stripe Checkout completion triggers
   the server to generate a key, emailed to the customer, which they paste
   into Settings. The app sends it to the server on launch (and periodically)
   to confirm it's still valid and get back `tier`. Simple, no passwords, no
   session management — closest fit for a single-user desktop utility.
2. **Email + magic link account system** — heavier; gives you multi-device
   sync later, but is a bigger lift (auth, sessions, account recovery) for a
   v1 that doesn't need multi-device yet.

**Recommendation: start with (1).** It's the minimum that makes billing real,
and it doesn't foreclose moving to (2) later if multi-device sync becomes a
real feature (it's already listed as a future upsell in `free-vs-pro.md`).
This doc assumes the license-key model from here on.

## States

A subscription (and by extension, the local `tier`) moves through:

| State | Meaning | Local `tier` |
|---|---|---|
| `none` | Never started a trial or subscription | `free` |
| `trialing` | In the 7-day trial, card on file | `pro` |
| `active` | Paid subscription, billing normally | `pro` |
| `past_due` | Payment failed, Stripe retrying | `pro` (grace period) or `free` — TBD, see open questions |
| `canceled` | User cancelled, or all retries exhausted | `free` |

## Flow

**1. Starting a trial**
- User clicks "Start free trial" in-app (likely from the paywall message
  already shown when a Free user hits a Pro-gated action).
- App opens a Stripe Checkout session in the browser (Checkout handles card
  collection — Clip never touches card details directly, which also keeps it
  out of PCI scope).
- Checkout is configured with `subscription_data.trial_period_days: 7` and
  the monthly/annual price the user picked.
- On completion, Stripe fires `checkout.session.completed`.

**2. Server-side, on `checkout.session.completed`**
- Look up or create a customer record keyed by email.
- Generate a license key, store it against that customer + subscription ID.
- Email the key to the customer (or, if the app has a way to stay in the
  loop — e.g. it polls a short-lived session token after Checkout redirects
  back — hand the key straight back to the app so the user never has to copy
  it manually. Worth designing for this if feasible, since "go check your
  email and paste a code" is real friction).

**3. App activation**
- User pastes the license key into Settings.
- App calls a `/activate` (or `/license/status`) endpoint with the key.
- Server validates it against the subscription's current Stripe status and
  returns `{ tier, status, current_period_end }`.
- App stores the key + last-known `tier` locally and sets `tier` accordingly.

**4. Ongoing validation**
- App re-checks license status periodically (e.g. on launch, and maybe once
  a day in the background) rather than trusting the local flag forever —
  otherwise a cancelled subscription would still show as Pro indefinitely.
- If the check fails (network down, server unreachable), fail soft: keep the
  last-known tier for some grace window rather than instantly locking the
  user out over a transient outage.

**5. Trial ending / conversion**
- Stripe auto-charges the card at day 7 unless cancelled (this is just
  Stripe's default trial behavior — no custom code needed beyond having
  `trial_period_days` set).
- `customer.subscription.updated` fires when status moves from `trialing` to
  `active`. Server updates its record; app picks up the new status on its
  next validation check.

**6. Cancellation**
- User cancels (likely via a Stripe Customer Portal link, not a custom UI —
  Stripe's hosted portal handles plan changes/cancellation out of the box and
  is far less work than building it ourselves).
- `customer.subscription.deleted` (or `updated` with `cancel_at_period_end`)
  fires. Server marks the license inactive at period end.
- App's next validation check sees `status: canceled` and reverts `tier` to
  `free`. History/folders/pins already in place stay as-is — going to Free
  just re-imposes the caps (per `free-vs-pro.md`, the 50-item/3-folder/3-pin
  limits apply going forward, nothing already saved is deleted).

**7. Payment failure**
- `invoice.payment_failed` fires. Stripe's own retry schedule (Smart Retries)
  handles re-attempting the charge.
- Open question (below): does Pro access continue during retries, or drop
  immediately?

## Webhook events the server needs to handle

- `checkout.session.completed` — provision the license
- `customer.subscription.updated` — status transitions (trialing → active,
  active → past_due, etc.)
- `customer.subscription.deleted` — cancellation, revoke license
- `invoice.payment_failed` — optionally notify the user, decide grace-period
  behavior

All webhook handlers need to verify the Stripe signature header — this is
where `APP_SHARED_SECRET`-style thinking applies again, except it's Stripe's
own webhook signing secret, not something we invent.

## What needs to exist before this can be built

- A Stripe account (test mode is enough to build and test the whole flow
  before going live)
- A `/checkout` endpoint (server) to create Checkout sessions
- A `/webhook` endpoint (server) to receive the events above
- A `/activate` + `/license/status` endpoint (server)
- A customers/licenses table (server-side DB — doesn't exist yet; the
  existing `db.rs` is the *local* SQLite store on the user's machine, not a
  server-side store)
- License key field + "Manage subscription" link in `SettingsPanel.tsx`
- Replace the dev-only Plan toggle with the real activation flow (the toggle
  can stay behind a debug build flag for testing, but shouldn't ship to real
  users)

## Open questions

- **Past-due grace period**: keep Pro access during Stripe's retry window, or
  drop to Free immediately on first failed payment? Leaning toward a short
  grace period (matches how most subscription apps behave, avoids punishing
  someone over an expired card before they've even noticed).
- **Multiple devices**: license-key model as scoped above is single-key,
  not single-device-limited — same key could be pasted into Clip on two
  machines. Decide whether to cap activations per license, or just not worry
  about it for v1.
- **Annual plan trial**: does picking annual still get the 7-day trial, or is
  the trial monthly-only with annual requiring payment up front? Stripe
  supports either; this is a product decision, not a technical constraint.
- **Refunds/disputes**: no process defined yet for handling chargebacks or
  refund requests — needs a decision once real money is flowing.
