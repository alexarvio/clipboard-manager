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
# edit .env and paste in your real ANTHROPIC_API_KEY (from console.anthropic.com)
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

If `APP_SHARED_SECRET` is set in `.env`, requests must include a matching
`x-app-secret` header or they get a 401. Leave it blank for local dev.

## Deploying it somewhere real

This is a plain Node/Express app, so any of these work with basically zero
config: Railway, Render, or Fly.io (all have free/cheap tiers good enough for
early traffic). Whichever you pick:

1. Set the `ANTHROPIC_API_KEY` and `APP_SHARED_SECRET` environment variables
   in that platform's dashboard (never commit `.env`).
2. Point the desktop app's Settings → server URL at the deployed URL instead
   of `http://localhost:8787`.

## Cost reality check

Claude Haiku 4.5 is $1.00 per million input tokens, $5.00 per million output
tokens. A typical clipboard transform (~50 tokens in, ~80 out) costs roughly
$0.00045. Even 1,000 people each running 50 transforms a day works out to
about $675/month in API spend — trivial against any reasonable subscription
price across a few hundred paying users.

## What's NOT built yet

- Real per-user accounts / Stripe-gated access (currently one shared secret
  for the whole app, not per-user billing)
- Rate limiting / abuse protection beyond the shared secret
- Usage tracking/dashboards
