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

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

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
    throw new Error("no billing account yet -- start a Pro trial first");
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripe_customer_id,
    return_url: `${WEBSITE_URL}/checkout-success.html`,
  });

  return session.url;
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
      const subscription = await stripe.subscriptions.retrieve(session.subscription);
      await applySubscriptionStatus(session.customer, subscription.id, subscription.status);
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
};
