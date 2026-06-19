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
- **No AI transform of any kind** — this is the hard line between tiers, since every transform call costs real money (Claude API + server)

## Pro tier (monthly or annual)

- **Unlimited clipboard history** — no item cap, no retention window
- **Unlimited folders** — no cap on number of folders (vs 3 on Free)
- **Pin folders** — Pro-only. Free already caps at 3 folders total, so pinning would be moot there. Capped at a flat **3 pinned folders**, same flat-cap reasoning as clip-item pins below — do not relax this cap if pins are ever extended further.
- Pin cap **stays at 3** — unlike folders, this is not a tier lever. Decision: unlimited pins defeat the point of pinning ("a few things you need *right now*"); if you need more than 3 permanent items, that's what folders are for. Do not relax this for Pro.
- **Unlimited AI transform**, including:
  - The 6 built-in presets (fix grammar, make formal, make casual, summarize, to bullet points, translate to Spanish)
  - Free-text custom instruction ("type your own")
  - **Custom saved presets** — save your own instruction as a reusable one-click button, same transform pipeline as the built-ins, just personalized (e.g. "rewrite like my work emails," applied to whatever's currently in the clipboard)
- **Filter history by category** — auto-detected, best-effort classification of each clip into Text / Link / Email / Phone number / Address / Bank account number, accessible via a "Filter" button above the history list that expands into a dropdown of categories. Detection is heuristic pattern matching (regex), not validation — it can misclassify edge cases, especially bank account numbers (any unformatted run of 8-17 digits is treated as a possible account/routing number, since there's no way to actually verify it)
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
- Category filter for history (Text/Link/Email/Phone/Address/Bank account), Pro-only — implemented (`classify.rs` for regex-based auto-detection at insert time, `category` column + one-time backfill in `db.rs`, `category` param threaded through `get_history`/`db::search`, Pro-gated Filter button + dropdown with lock icons in `App.tsx`)
- Custom saved presets (save your own instruction as a reusable one-click button) — implemented (`custom_presets: Vec<CustomPreset>` on `Settings` in `settings.rs`, persisted through the existing `get_settings`/`save_settings` commands; save/run/delete UI in `TransformBar.tsx`). Implicitly Pro-only since `TransformBar` itself is never rendered for Free tier.

**Not built yet:**

- Real billing/subscription/trial flow — no Stripe integration, no card collection, no trial countdown, no auto-conversion or cancellation handling; `tier` is just a flag a user can flip themselves in Settings
- Any usage cap or fair-use limit on Pro AI transform — not implemented
- Pricing — not set; placeholder numbers in this doc only

## Open questions / future considerations

- Should there be a usage cap even on Pro (e.g. fair-use limit) to protect against runaway API costs from a single user?
- Multi-device sync, image/file clipboard support, and a higher-quality model tier (Sonnet vs Haiku) were discussed as possible future upsells but are **not** part of the v1 Pro feature set — revisit later if Pro needs more differentiation.
