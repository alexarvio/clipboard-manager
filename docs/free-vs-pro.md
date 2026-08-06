# Clip — Free vs Pro

Part 1 of 3 product/infra planning docs (feature breakdown → infrastructure → deployment).

## Monetization model

- Free tier, forever — no AI, capped history.
- Pro is a subscription: monthly, or annual at a discount.
- 7-day free trial, **card required up front** (auto-bills at end of trial unless cancelled).

## Free tier

- Clipboard history capped at **50 items or 7 days, whichever comes first**
- Search history
- Pin / unpin items — capped at **3 pinned items at a time**
- **Folders** — up to **3 folders**, for manually saving specific items (e.g. addresses, recurring snippets, things you'll need again) so they're easy to find later
  - Items saved into a folder are **exempt from the 50-item/7-day cap** — that's the actual point of folders on Free: a way to rescue something from the rolling history and keep it permanently, even without Pro
- Global hotkey toggle (left-docked sliding panel)
- System tray icon + quit
- Launch at startup
- **Filter history by category** — auto-detected, best-effort classification of each clip into Text / Link / Email / Phone number / Address / Bank account number, accessible via a "Filter" button above the history list. Detection is heuristic pattern matching (regex), not validation — it can misclassify edge cases, especially bank account numbers (any unformatted run of 8-17 digits is treated as a possible account/routing number, since there's no way to actually verify it). Free because it's pure local computation (no API cost), unlike the AI-powered custom filters below
- Snippet templates — `{{variable}}` placeholders get filled in right before paste, no tier check
- **Multi-item sequential paste ("Stack" mode)** — select multiple items from History in Stack mode to build an ordered paste queue; each hotkey press pastes the next item in sequence ("Pasting 2 of 5"), and the queue survives the panel hiding/showing so you can paste one, switch apps, and resume right where you left off
- **Screenshots** (moved to Free 2026-08-01, previously Pro-only) — every screenshot you take (Win+Shift+S, PrintScreen, etc.) gets its own history, separate from text clips: grid view grouped pinned-then-by-day, click-to-paste, full-size preview modal, pin/unpin (flat cap of 3, same as clip-item pins), delete, save to folder, and local OCR text extraction (Windows.Media.Ocr, no cloud call) powering keyword search over screenshot text. Same cap as text history: **50 items or 7 days, whichever comes first**, unpinned only. Reasoning: none of this costs anything to run (no AI/API calls), so there's no reason to gate it the way AI transform is gated -- only the AI-backed screenshot actions below stay Pro
- **No AI transform of any kind** — this is the hard line between tiers, since every transform call costs real money (Claude API + server). This includes AI Transform on screenshots (via their OCR'd text) and Smart (semantic) search over screenshots, both of which call the same paid AI endpoints as their text-clip equivalents

## Pro tier (monthly or annual)

- **Unlimited clipboard history** — no item cap, no retention window
- **Unlimited folders** — no cap on number of folders (vs 3 on Free)
- **Pin folders** — Pro-only. Free already caps at 3 folders total, so pinning would be moot there. Capped at a flat **3 pinned folders**, same flat-cap reasoning as clip-item pins below — do not relax this cap if pins are ever extended further.
- Pin cap **stays at 3** — unlike folders, this is not a tier lever. Decision: unlimited pins defeat the point of pinning ("a few things you need *right now*"); if you need more than 3 permanent items, that's what folders are for. Do not relax this for Pro.
- **Unlimited AI transform**, including:
  - The 6 built-in presets (fix grammar, make formal, make casual, summarize, to bullet points, translate to Spanish)
  - Free-text custom instruction ("type your own")
  - **Custom saved presets** — save your own instruction as a reusable one-click button, same transform pipeline as the built-ins, just personalized (e.g. "rewrite like my work emails," applied to whatever's currently in the clipboard)
- **Custom AI filters** — unlike the free category filter above, these let you save your own natural-language filter prompt (e.g. "things related to the Johnson project") and run it against history via the AI server, so it's gated the same way as transform
- **Semantic search** — search history by meaning, not just exact substring match, via Voyage AI embeddings (text clips and screenshots both -- see Screenshots' own Smart-search entry below)
- **AI Transform on screenshots** — same `transform_clip` pipeline as text clips, run against a screenshot's OCR'd text (see Free tier's Screenshots entry for the capture/OCR/keyword-search half, which is free)
- **Smart (semantic) search over screenshots** — same idea as text-clip semantic search, embedding each screenshot's OCR'd text on-demand (the first time a Smart search actually runs, not automatically on every capture, to keep embedding cost tied to real usage rather than raw screenshot volume)
- Everything in Free

## Trial mechanics

- Card required to start the 7-day trial
- Auto-converts to paid (monthly or annual, whichever the user picked) at day 7 unless cancelled
- Cancelling during the trial reverts the account to Free (capped history) rather than losing the app entirely

## Pricing — TBD, suggested starting point

No price locked in yet. For reference, comparable productivity/clipboard tools:

| App | Model | Price |
|---|---|---|
| Paste (Mac clipboard manager) | Subscription | ~$1.49/mo or $14.99/yr |
| Raycast Pro | Subscription | ~$8/mo or $96/yr (includes AI) |
| TextExpander | Subscription | ~$3.33/mo billed annually |
| CleanShot X | One-time (different model) | $29 one-time |

Given Clip's AI transform is the main cost driver (Claude API calls), a reasonable starting point to discuss:

- **$4.99/mo**, or **$39.99/yr** (~33% discount vs monthly) — positions Clip mid-pack, in line with tools that bundle AI rather than pure utility apps like Paste.

This is a placeholder for discussion, not a final number — revisit once we know actual Claude API cost per transform and expected usage per Pro user.

## Implementation status (as of 2026-06-18)

What's actually built vs. still just planned in this doc.

**Built:**

- Search history — implemented (`db::search`)
- Pin/unpin clip items, capped at 3 (flat, both tiers) — implemented (`db::MAX_PINNED`, `toggle_pin`)
- Folders, capped at 3 on Free / unlimited on Pro — implemented (`db::FREE_FOLDER_LIMIT`, tier check in `create_folder`)
- Items saved into a folder are exempt from the history cap — implemented (folders are a separate table, not subject to `trim_history`)
- Pin/unpin folders, Pro-only, capped at 3 — implemented (`db::FOLDER_PIN_LIMIT`, tier check in `toggle_folder_pin` command)
- Global hotkey toggle, system tray icon, launch at startup — implemented
- AI transform gated to Pro only — implemented server-side in `transform_clip` (checks `tier == "pro"`, returns an error otherwise) and reflected in the UI (locked sparkle icon + paywall message on Free)
- 6 built-in transform presets + free-text custom instruction — implemented (`TransformBar.tsx`)
- A `tier` flag on Settings (`"free"` / `"pro"`) — implemented, but it's a **local dev-only toggle** (Settings → Plan), not backed by real billing yet
- History cap, tier-enforced: 50 items or 7 days (whichever comes first) on Free, unlimited on Pro — implemented (`db::trim_history_for_tier`, `FREE_HISTORY_LIMIT`/`FREE_HISTORY_DAYS`, called from the clipboard watcher in `main.rs` using the live `tier` setting). The old user-editable "History limit" field in Settings is gone, replaced with read-only text reflecting the current plan's fixed cap
- Category filter for history (Text/Link/Email/Phone/Address/Bank account), **Free** (corrected 2026-07-19 — this doc previously said Pro-only, but it was never actually gated in code and there's no good reason to gate pure local pattern-matching) — implemented (`classify.rs` for regex-based auto-detection at insert time, `category` column + one-time backfill in `db.rs`, `category` param threaded through `get_history`/`db::search`, Filter button + dropdown in `App.tsx`, no tier check anywhere in the path)
- Custom saved presets (save your own instruction as a reusable one-click button) — implemented (`custom_presets: Vec<CustomPreset>` on `Settings` in `settings.rs`, persisted through the existing `get_settings`/`save_settings` commands; save/run/delete UI in `TransformBar.tsx`). Implicitly Pro-only since `TransformBar` itself is never rendered for Free tier.
- Screenshots, **Free** (moved off Pro-only 2026-08-01 -- previously this doc said Pro-only and that was accurate at the time, but capture/view/paste/pin/keyword-search/folders are all local with no API cost, so gating the whole feature behind Pro no longer made sense once OCR and Smart search were split out as separate, genuinely AI-backed pieces) — capture, OCR (Windows.Media.Ocr, `ocr.rs`), listing, paste, pin, keyword search, and folder-filing all work on both tiers now; capped the same as text history (`db::trim_screenshots_for_tier`, reusing `FREE_HISTORY_LIMIT`/`FREE_HISTORY_DAYS`, called from the watcher in `main.rs` after every capture). `ScreenshotsPanel.tsx` no longer gates the tab itself on tier.
- AI Transform on screenshots + Smart search over screenshots, **Pro-only** — the two AI-backed pieces that stayed gated when the rest of Screenshots moved to Free. `semantic_search_screenshots` checks `tier == "pro"` server-side same as text-clip `semantic_search`; the Transform icon in `ScreenshotsPanel.tsx` checks tier client-side and shows a paywall message (same pattern as History's row-level Transform in `App.tsx`'s `RowMenu`) rather than opening the panel and failing.
- Multi-item sequential paste ("Stack" mode), **Free** (decision 2026-07-19 — previously flagged as "should be Pro-only" but reconsidered and confirmed Free, matching the fact that it was never actually gated) — implemented (`App.tsx`'s `stackBuilderIds`/`pasteQueue`/`pasteQueueIndex`, `PasteQueue.tsx`), no tier check anywhere in the path, which is now correct/intentional rather than a gap

**Built (billing, added 2026-08-03 — see `billing-flow.md` for the full writeup):**

- Real billing/subscription/trial flow, implemented — Stripe Checkout in subscription mode with a 7-day trial (card required up front), a webhook handler stamping `tier`/`subscription_status` onto the account row, a Billing Portal for self-serve cancel/plan-switch, and app-side polling (`refresh_account_status`) since there's no deep link back from the system-browser checkout flow. `tier` is now driven by the Stripe subscription state machine (trialing/active/past_due → pro; canceled/unpaid/incomplete_expired → free), not a flag a user flips themselves — **except** the dev-only Plan toggle still in `SettingsPanel.tsx`, kept for local testing without a real Stripe checkout every time, which is a known gap (see below)
- Pricing — locked in at **$3.99/mo or $29/yr** (~40% off annual), superseding the placeholder $4.99/$39.99 numbers earlier in this doc
- Usage cap on Pro AI transform/filter/embed — implemented server-side in `server/index.js`, not client-visible: a burst limiter (`express-rate-limit`, 20/min on `/transform` and `/filter-match`, 60/min on `/embed`) plus a per-account daily cap (`dailyCap` middleware, `DAILY_LIMITS = { transform: 500, "filter-match": 50, embed: 4000 }` per UTC day, keyed off the authenticated user id). In-memory, resets on server restart — fine for now, would need a real store (Redis/DB) if the server ever runs multi-instance
- Custom AI filter (`filter-match`) candidate set — capped independently of everything else: `filter_by_ai` (`main.rs`) calls `db::search(&conn, "", None, None, None, db::AI_FILTER_CANDIDATE_LIMIT)`, and `AI_FILTER_CANDIDATE_LIMIT = 500` regardless of tier. So a single filter-match call never sends more than the newest 500 items to the server no matter how large a Pro user's (uncapped) history grows — cost per call can't run away. There's no date/age filtering in that call (both date params are `None`), which is fine for cost, but does mean a Pro user with more than 500 items in history has anything older than the newest 500 silently invisible to a custom AI filter (including a saved `CustomFilter` preset — it's the same command under the hood, no separate budget). At Claude Haiku 4.5 pricing ($1/M input, $5/M output tokens), 500 items costs roughly $0.01-$0.02 per call; the daily cap (`filter-match: 50`/day) bounds worst case around $0.50-$1/day per account even if every call maxed out the candidate pool.
- **2026-08-05 cap rework, plain search vs. AI filter split** — `db::search` (used by `get_history`, the plain keyword/category/date search-bar path) used to have a single hardcoded `LIMIT 200` shared with the AI filter's candidate query, meaning a Pro user's own keyword search silently couldn't see anything past the newest 200 items even though storage itself was uncapped. `search` now takes an explicit `limit` param: `main.rs`'s `get_history` passes `db::FREE_SEARCH_LIMIT` (100) on Free — moot in practice since Free's storage cap (50 items) never gets that high anyway — and `-1` (SQLite's "no limit") on Pro, so Pro's own search/category-filter now genuinely covers all of history. The AI filter kept its own separate, smaller cap (`AI_FILTER_CANDIDATE_LIMIT` above) since that one drives real per-call API cost, not just local SQLite query cost.
- **Semantic (Smart) search has no candidate cap at all** — `db::semantic_search` scans every embedded row in the database (no `LIMIT` in that query), ranks by cosine similarity, and returns the top 30 matches above a 0.5 score threshold. The only related cap is on *embedding creation* (getting a clip into a searchable state in the first place), not search itself: `BACKFILL_LIMIT` in `main.rs` (fires once, the moment an account upgrades to Pro, so pre-existing history becomes searchable too) was `300` — capped so an upgrade with years of history wouldn't leave anything older permanently un-embedded — and was raised to `-1` (unlimited) on 2026-08-05 once the actual embedding cost was worked out (~$0.0000008/item at Voyage's `voyage-3.5-lite` pricing, i.e. a few thousand items on upgrade costs a fraction of a cent). New clips still embed one at a time as they're captured on Pro; the shared `embed: 4000`/day cap (see above) covers captures + backfill + query embeds combined and is an abuse ceiling, not something real usage approaches.
- **OCR (screenshots) has no cost or cap at all** — `ocr.rs` runs entirely on-device via Windows' `Windows.Media.Ocr` API, no network call, so extracting text from a screenshot is free regardless of volume, on either tier (per the Screenshots entry above). The only point in that pipeline that costs money is if the OCR'd text is then run through AI Transform or Smart search, which are the two pieces that stay Pro-gated.

**Not built yet:**

- Refund/dispute policy — no process defined for chargebacks or refund requests once real money is flowing (see `billing-flow.md`'s open questions)
- Closing the dev-only Plan toggle gap in `SettingsPanel.tsx` before a real release build — right now nothing stops a user from just flipping it themselves locally

## Open questions / future considerations

- Refunds/disputes: what's Clip's own policy, once real money is flowing? (Stripe's dashboard handles the mechanics either way.)
- Multi-device sync, image/file clipboard support, and a higher-quality model tier (Sonnet vs Haiku) were discussed as possible future upsells but are **not** part of the v1 Pro feature set — revisit later if Pro needs more differentiation.
