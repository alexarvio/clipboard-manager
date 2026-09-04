// Stripe subscriptions, layered on top of the accounts that already exist
// (server/db.js's `users` table) rather than inventing a separate identity
// system -- see docs/billing-flow.md for the reasoning and the full state
// machine this file implements.
//
// Kept in its own module for the same reason email.js is separate from
// index.js: this is a meaningful, self-contained chunk of logic (Stripe API
// calls + the tier-derivation rules), not just another route handler.

const Stripe = require("stripe");
const { pool } = require("./db");

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_PRICE_MONTHLY = process.env.STRIPE_PRICE_MONTHLY || "";
const STRIPE_PRICE_ANNUAL = process.env.STRIPE_PRICE_ANNUAL || "";
// Where Stripe Checkout/Portal send the browser after the person is done.
// These just need to be *some* reachable page telling them to switch back
// to the Clip app -- see website/checkout-success.html and
// website/checkout-cancel.html. There's no deep link back into the desktop
// app itself; the app instead polls its own session after opening checkout
// (see refresh_account_status in main.rs) -- same reasoning as the
// password-reset flow's copy-a-code pattern instead of a clickable link.
const WEBSITE_URL = (process.env.WEBSITE_URL || "").replace(/\/$/, "");

if (!STRIPE_SECRET_KEY) {
  console.warn(
    "[clip-server] WARNING: STRIPE_SECRET_KEY is not set. /billing/* will fail until it is."
  );
}
if (!STRIPE_WEBHOOK_SECRET) {
  console.warn(
    "[clip-server] WARNING: STRIPE_WEBHOOK_SECRET is not set. /billing/webhook will reject everything until it is."
  );
}
if (!STRIPE_PRICE_MONTHLY || !STRIPE_PRICE_ANNUAL) {
  console.warn(
    "[clip-server] WARNING: STRIPE_PRICE_MONTHLY/STRIPE_PRICE_ANNUAL are not both set. /billing/checkout will fail until they are."
  );
}
if (!WEBSITE_URL) {
  console.warn(
    "[clip-server] WARNING: WEBSITE_URL is not set. /billing/checkout will fail until it is (Stripe Checkout needs somewhere real to redirect back to)."
  );
}

// 2026-08-06: pinned explicitly after Stripe rejected requests with
// "Managed Payments is not supported on API version 2025-02-24.acacia" --
// the account defaults to a newer API version than the installed `stripe`
// npm package (17.3.0) itself defaults to when no apiVersion is given.
// Pinning avoids relying on whatever the account's dashboard default
// happens to be, so this doesn't silently break again if that changes.
const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2025-03-31.basil" })
  : null;

function priceIdForPlan(plan) {
  if (plan === "monthly") return STRIPE_PRICE_MONTHLY;
  if (plan === "annual") return STRIPE_PRICE_ANNUAL;
  return null;
}

// Stripe's subscription statuses, collapsed down to Clip's binary tier.
// past_due is a deliberate grace period, not an oversight -- see the state
// table in docs/billing-flow.md for why.
function tierForSubscriptionStatus(status) {
  return status === "trialing" || status === "active" || status === "past_due" ? "pro" : "free";
}

// Reuses an existing Stripe Customer if this account already has one
// (returning to upgrade again after a past cancellation, e.g.), otherwise
// creates one and immediately persists the id -- so a second click of
// "start trial" before the first Checkout session is finished doesn't spin
// up a duplicate Stripe Customer for the same account.
async function getOrCreateStripeCustomer(user) {
  if (user.stripe_customer_id) return user.stripe_customer_id;

  const customer = await stripe.customers.create({
    email: user.email,
    metadata: { app_user_id: String(user.id) },
  });

  await pool.query("UPDATE users SET stripe_customer_id = $1 WHERE id = $2", [
    customer.id,
    user.id,
  ]);

  return customer.id;
}

// `user` here is a full row from `users` (id, email, tier, stripe_customer_id, ...).
async function createCheckoutSession(user, plan) {
  if (!stripe) throw new Error("server is not configured for billing yet");
  const priceId = priceIdForPlan(plan);
  if (!priceId) throw new Error("plan must be 'monthly' or 'annual'");
  if (!WEBSITE_URL) throw new Error("server is not configured for billing yet");

  // Trial-abuse gate, half one of two (see docs/billing-flow.md and the
  // migration comment in db.js): a fresh 7-day Pro trial is only handed out
  // to an account that's proven it owns its email address. This never
  // blocks the free tier, only starting a *trial* -- see index.js's
  // /billing/checkout, which turns this specific error into a 403 the app
  // recognizes and responds to with an inline "verify your email" prompt
  // rather than a dead-end error message.
  if (!user.email_verified) {
    const err = new Error("verify your email before starting a trial");
    err.code = "email_unverified";
    throw err;
  }

  const customerId = await getOrCreateStripeCustomer(user);

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: String(user.id),
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      trial_period_days: 7,
      // Belt-and-suspenders alongside the stripe_customer_id lookup the
      // webhook handler uses as its primary path -- if that ever fails to
      // resolve for some reason, the account id is also sitting right here
      // on the subscription itself.
      metadata: { app_user_id: String(user.id) },
    },
    success_url: `${WEBSITE_URL}/checkout-success.html`,
    cancel_url: `${WEBSITE_URL}/checkout-cancel.html`,
  });

  return session.url;
}

async function createPortalSession(user) {
  if (!stripe) throw new Error("server is not configured for billing yet");
  if (!user.stripe_customer_id) {
    throw new Error("no billing account yet, start a Pro trial first");
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripe_customer_id,
    return_url: `${WEBSITE_URL}/checkout-success.html`,
  });

  return session.url;
}

// Cancels a subscription immediately (not "at period end") -- used by
// account deletion (see index.js's DELETE /auth/account) so someone deleting
// their account doesn't keep getting billed for a subscription tied to an
// account that no longer exists. Deliberately not routed through Stripe's
// webhook -> applySubscriptionStatus path: the users row is about to be
// deleted outright anyway, so there's nothing left to update it on.
// Swallows "no such subscription"/already-canceled errors rather than
// throwing -- account deletion should still succeed even if Stripe's side
// of this is already gone or was never fully set up.
async function cancelSubscriptionImmediately(user) {
  if (!stripe || !user.stripe_subscription_id) return;
  try {
    await stripe.subscriptions.cancel(user.stripe_subscription_id);
  } catch (err) {
    console.warn(
      `[clip-server] couldn't cancel subscription ${user.stripe_subscription_id} during account deletion:`,
      err.message || err
    );
  }
}

// Trial-abuse gate, half two of two (see the email_verified check in
// createCheckoutSession, and the migration comment in db.js). Email
// verification alone doesn't stop a determined attacker -- Gmail's "+"
// aliases are infinite and every one verifies fine -- but a real card costs
// something, so this tracks which card *fingerprints* (Stripe's stable,
// non-reversible id for "this physical card", never the PAN itself) have
// already funded a trial. Only called from checkout.session.completed (the
// one event where a *new* trial actually begins) -- customer.subscription.
// updated re-fires the same status repeatedly as an existing subscription
// progresses, and re-running this there would do nothing new.
async function enforceTrialFingerprint(customerId, subscription) {
  if (subscription.status !== "trialing") return; // paid immediately, no trial to abuse

  const paymentMethod = subscription.default_payment_method;
  const fingerprint = paymentMethod && paymentMethod.card && paymentMethod.card.fingerprint;
  if (!fingerprint) {
    // No card on file, or an unexpected payment method type (e.g. a wallet
    // with no card sub-object) -- fail open rather than punishing a real
    // customer's trial over this.
    console.warn(
      `[clip-server] no card fingerprint on trialing subscription ${subscription.id}, skipping trial-abuse check`
    );
    return;
  }

  const { rows: userRows } = await pool.query("SELECT id FROM users WHERE stripe_customer_id = $1", [
    customerId,
  ]);
  const userId = userRows[0] && userRows[0].id;
  if (!userId) return; // applySubscriptionStatus's own "no matching account" warning already covers this

  const { rows: existing } = await pool.query(
    "SELECT user_id FROM trial_card_fingerprints WHERE fingerprint = $1",
    [fingerprint]
  );

  if (existing[0] && existing[0].user_id !== userId) {
    // This card already funded a trial on a different account -- end the
    // trial right now (Stripe charges the first invoice immediately)
    // instead of blocking the subscription outright, which would also
    // wrongly catch two real people sharing one household card. They still
    // get Pro, just without a second free week.
    console.warn(
      `[clip-server] card fingerprint reused across accounts (user ${userId}, subscription ${subscription.id}) -- ending trial immediately`
    );
    await stripe.subscriptions.update(subscription.id, { trial_end: "now" });
    return;
  }

  if (!existing[0]) {
    await pool.query(
      `INSERT INTO trial_card_fingerprints (fingerprint, user_id, subscription_id)
       VALUES ($1, $2, $3) ON CONFLICT (fingerprint) DO NOTHING`,
      [fingerprint, userId, subscription.id]
    );
  }
}

// Applies a subscription's current Stripe status to the account it belongs
// to. Looked up by stripe_customer_id (present on every subscription event
// Stripe sends) rather than app_user_id metadata, since customer id is the
// field every one of the handled event types actually carries directly.
async function applySubscriptionStatus(customerId, subscriptionId, status) {
  const tier = tierForSubscriptionStatus(status);
  const { rowCount } = await pool.query(
    `UPDATE users
     SET stripe_subscription_id = $1, subscription_status = $2, tier = $3
     WHERE stripe_customer_id = $4`,
    [subscriptionId, status, tier, customerId]
  );
  if (rowCount === 0) {
    // Shouldn't happen in normal operation (the customer was created by
    // getOrCreateStripeCustomer and stamped onto a real account before any
    // webhook could fire) -- logged rather than thrown so a single
    // unresolvable webhook doesn't take down processing of the rest.
    console.warn(
      `[clip-server] webhook for unknown stripe_customer_id=${customerId} -- no matching account`
    );
  }
}

// req.body here is the raw Buffer (see the express.raw() middleware on this
// route in index.js) -- constructEvent needs the exact bytes Stripe signed,
// not a re-serialized JSON object, or signature verification always fails.
async function handleWebhookEvent(rawBody, signatureHeader) {
  if (!stripe) throw new Error("server is not configured for billing yet");
  if (!STRIPE_WEBHOOK_SECRET) throw new Error("server is not configured for billing yet");

  const event = stripe.webhooks.constructEvent(rawBody, signatureHeader, STRIPE_WEBHOOK_SECRET);

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      if (session.mode !== "subscription") break; // not one of ours
      // The subscription's own status (almost always "trialing" at this
      // point) is the source of truth, not an assumption baked in here --
      // fetch it rather than hardcoding tier="pro" for this event.
      // Expanded to pull the card fingerprint for enforceTrialFingerprint
      // below -- this is the one event where a *new* trial actually
      // begins, so it's the only place that check needs to run.
      const subscription = await stripe.subscriptions.retrieve(session.subscription, {
        expand: ["default_payment_method"],
      });
      await applySubscriptionStatus(session.customer, subscription.id, subscription.status);
      await enforceTrialFingerprint(session.customer, subscription);
      break;
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object;
      await applySubscriptionStatus(subscription.customer, subscription.id, subscription.status);
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      await applySubscriptionStatus(subscription.customer, subscription.id, "canceled");
      break;
    }

    default:
      // Plenty of other event types exist (invoice.*, payment_method.*,
      // etc.) -- ignored rather than erroring, since Stripe sends every
      // event type to every endpoint subscribed to "all events" and most
      // of them aren't relevant to tier.
      break;
  }
}

module.exports = {
  createCheckoutSession,
  createPortalSession,
  handleWebhookEvent,
  cancelSubscriptionImmediately,
  // Exported so admin.js can pull real revenue numbers straight from Stripe
  // (paid invoices, active subscriptions) without spinning up a second
  // Stripe client with its own separate config/API-version pinning to keep
  // in sync with this one.
  stripe,
};
