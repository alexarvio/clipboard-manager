# FatClipboard — Competitive Research & Strategy Brainstorm

*Compiled 2026-07-29. Two research passes: (1) traditional/Windows-native clipboard managers — Ditto, ClipboardFusion, ClipClip, CopyQ, Windows 11's built-in Win+V; (2) premium/AI-adjacent tools — Paste, Raycast, Maccy, PastePal, Alfred. Full competitor-by-competitor detail is in the appendix below; this top section is the synthesis meant to actually drive a decision.*

---

## TL;DR — what actually matters here

1. **Nobody has real AI clipboard features yet, but the platform might beat everyone to it.** None of the five traditional Windows tools have any LLM/semantic-search/AI-transform capability today — FatClipboard's AI Transform, custom AI filters, and semantic search are currently uncontested in that lane. The real threat is Microsoft: credible reporting (patents + Windows Insider coverage) points to an AI-powered "Advanced Paste" being piloted directly in Windows. If that ships even in basic form, it commoditizes FatClipboard's headline Pro feature the same way Win+V already commoditized basic clipboard history. Worth watching, not panicking about — but worth having a plan for "what do we do if Windows ships AI paste transforms for free."

2. **FatClipboard's screenshot handling is a genuinely rare, defensible differentiator — and it's currently under-marketed.** Across all ten competitors researched, screenshot/image handling is either bolted-on and janky (Maccy has multi-year open GitHub issues about basic image preview/saving), conflated with OCR-into-text-search (PastePal), or just "another image clip" with no special treatment (Paste). FatClipboard's fully separate, foldable, unlimited-on-Pro, 100%-local screenshot library has no real match in this set. This is worth leaning into harder in marketing, not treating as a side feature.

3. **The subscription model will get real pushback, and it should be anticipated, not discovered.** Every traditional competitor (Ditto, CopyQ: free forever; ClipboardFusion, ClipClip: one-time perpetual license) avoids subscriptions entirely, and their communities treat that as a point of pride ("doesn't ask for an account, doesn't phone home"). On the premium side, Alfred and PastePal's one-time-purchase models get explicitly praised *for being one-time*, and there's a real, quoted pattern of users defecting from subscription tools toward free/one-time alternatives on principle (a PastePal reviewer: "I'm planning to switch to Maccy... which seems lighter"). This doesn't mean subscription can't work — but "why would I pay monthly when Ditto/CopyQ is free forever" is a real objection to have an answer ready for, and a one-time "lifetime" purchase option (the way Alfred and Paste both offer) is a proven way to capture the segment that will never subscribe but might buy once.

4. **Cross-device sync is the single most consistent gap FatClipboard has versus almost everyone.** ClipClip (Google Drive/OneDrive), ClipboardFusion (dedicated sync + mobile apps), Ditto (LAN sync), CopyQ (folder-based sync), Windows itself (Microsoft account sync), Paste (iCloud), PastePal (iCloud) — all of them have *some* multi-device story today. FatClipboard has none. This is probably the single biggest feature gap in the whole research set. It's also, per the research, genuinely hard to ship well (Paste's sync is simultaneously its most-praised feature and its most-complained-about source of real bugs, including one case of a sync bug filling 300GB of disk). Read as: "we should build this eventually, carefully — not "we're behind, ship it fast."

5. **"Good enough" beats "more features" for a real chunk of the market — this cuts both ways for FatClipboard's free tier.** Multiple independent, real quotes show people bouncing *off* feature-rich tools back to the simplest option ("I am not interested in fancy features that I rarely remember the shortcuts for... Windows key + V works just fine" — a real reader comment abandoning Ditto). At the same time, the actual trigger that pushes people to *look for* a third-party tool in the first place is almost always a data-loss moment — Windows' 25-item cap silently evicting old clips, not a desire for AI. FatClipboard's free tier (50 items/7 days) has the same shape of limitation as Win+V's cap. That's probably fine as an upgrade trigger, but worth knowing it's *also* the exact shape of thing that makes people give up and go back to "good enough" rather than upgrade — the free tier's core loop (capture → search → paste) needs to stay fast and frictionless regardless of the cap, since that experience is what either earns the upgrade or loses the user entirely.

6. **FatClipboard's modern UI is a real, validated advantage, not just a nice-to-have.** Ditto, ClipClip, and ClipboardFusion are all independently described by their own users as "outdated," "Windows-98-ish," or "underwhelming compared to newer apps" — even by people who otherwise love them. None of the free/one-time-purchase Windows tools have modernized visually in step with their features. A polished, current-feeling app (which is most of what this whole session's work has been) is competing in a lane where the alternative is genuinely dated software.

---

## Feature comparison at a glance

| | FatClipboard | Ditto | ClipboardFusion | ClipClip | CopyQ | Win+V | Paste | Raycast | Maccy | PastePal | Alfred |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Platform | Windows | Windows | Windows | Windows | Cross-platform | Windows | Mac/iOS | Mac + Windows (2026) | Mac | Mac | Mac |
| Price model | Freemium sub. (~$6/mo) | Free | One-time license | Free / $49 one-time | Free | Free (OS) | Sub. or lifetime (~$90) | Free / $8-16 mo | Free (OSS) | $14.99 one-time | ~$45 one-time |
| Auto-categorization | Yes (rule-based) | No | No | Manual/basic | Manual (tabs/tags) | No | No | No | No | No | No |
| AI transform | Yes (Pro) | No | Macros (scripted, not AI) | "Actions" (deterministic) | Scripting (deterministic) | Rumored | Light (Apple Intelligence + MCP) | Yes, core paid feature | No | No | Only via user-built Workflow |
| Semantic/AI search | Yes (Pro) | No | No | No | No | No | No | No | No | No | No |
| Screenshots as first-class | Yes, separate & local | No | No | Yes (+ GIF/annotate) | No | No | No (just image clips) | No | Weak/buggy | OCR-into-text | No |
| Folders/nesting | Yes | No | No | Yes | Tabs (flat-ish) | No | Pinboards (flat) | No | No | No | No |
| Templates/placeholders | Yes | No | No | No | No | No | No | No | No | No | Manual snippet promotion |
| Stack/sequential paste | Yes | No | No | No | No | No | Yes (buggy per reviews) | No | No | Yes ("queue stack") | Clipboard merging (Cmd+C+C) |
| Cross-device sync | **No** | LAN only | Yes + mobile | Yes (Drive/OneDrive) | Via synced folder | Yes (MS account) | Yes (iCloud) | Yes (2026 beta) | No | Yes (iCloud) | No |
| Extension/scripting ecosystem | No | No | Macros (C#/VB.NET) | No | Scripting engine | No | No | Yes (major strength) | No | No | Workflows |

---

## Brainstorm: prioritized ideas worth discussing

### Quick wins (low effort, directly validated by research)
- **A one-time "lifetime" purchase option alongside the subscription.** Proven pattern (Alfred, Paste, PastePal all offer it) that captures the anti-subscription segment without abandoning the recurring-revenue model for everyone else.
- **Market the screenshot feature harder.** It's a real, rare differentiator (see #2 above) and right now it's positioned in the app/site as one feature among many rather than a headline.
- **Double down on "zero-configuration" as the pitch against CopyQ/Ditto-style power tools.** FatClipboard auto-categorizes; CopyQ/Ditto require manual tagging/config. That's a clean, defensible message: "smart by default, not smart if you configure it right."

### Bigger bets (validated gap, real effort)
- **Cross-device sync**, done carefully. Biggest single gap vs. the field, but also the feature most likely to introduce serious bugs if rushed (see Paste's 300GB sync bug). Worth scoping as its own project with real QA time, not a quick add.
- **A "bring your own API key" option for AI features.** Raycast built this directly in response to users wanting to pay for-what-they-use instead of a flat AI subscription. Could lower the barrier to Pro for AI-curious-but-price-sensitive users without cannibalizing the main subscription.
- **Some form of extensibility** (custom rules/categories users can define themselves), long-term. Not urgent, but the research suggests power-user loyalty (Alfred, Raycast) is often driven more by "I've invested time customizing this" than by any single built-in feature — worth keeping in mind as a retention lever once the core product is mature.

### Risks to watch, not act on yet
- **Windows shipping AI-powered "Advanced Paste" natively.** Not shipped yet (patents/rumors only) — worth periodically checking Windows Insider builds, not worth reacting to today.
- **Raycast now runs on Windows.** It's a launcher first, not a dedicated clipboard tool, but its AI commands + clipboard history + upcoming Windows extension ecosystem make it a real future competitor for the same "power-user hotkey tool" mindshare, not just a Mac-world curiosity anymore.

### Probably don't chase
- **Matching Maccy/CopyQ/Ditto on "free forever, no caps, no account."** There's a real, vocal segment that will never pay no matter how good the AI is (a PastePal user explicitly defecting to Maccy "for moral reasons" is a good encapsulation) — trying to win that segment head-on likely means abandoning the subscription model that funds the AI features in the first place. Better to serve them with a genuinely generous free tier than try to out-free the free tools.

---

## Appendix A — Full research: traditional/Windows-native clipboard managers

*(Ditto, ClipboardFusion, ClipClip, CopyQ, Windows 11 Win+V — includes sourced quotes and a citation list)*

### 1. Ditto (open-source, freeware, Windows)

**Overview:** Ditto is the granddaddy of Windows clipboard managers — free, open-source (currently maintained by Scott Brogden at github.com/sabrogden/Ditto, with at least one active fork by CyberShadow), and has been around for well over a decade. Current stable release as of the research date was 3.25.113.0 (Sept 2025), so it's still actively maintained, not abandoned.

**Core features:**
- Unlimited, persistent clipboard history stored in a local database (SQLite-backed), with no hard item cap and no time expiry — databases can grow to gigabytes.
- Captures plain text, RTF, HTML, images, and custom/arbitrary clipboard formats (including files).
- Fast search/filter by content, name, or metadata, triggered instantly on hotkey.
- Group hotkeys — assign shortcuts to frequently-reused snippets (e.g., email signatures, boilerplate).
- "Paste Options" — paste in different case transforms (plain text, uppercase, sentence case, camelCase, etc.) without a separate tool.
- Network sync — syncs clipboard history between computers on the same LAN (enter IP + password).
- No account required, no telemetry, fully auditable since it's open source.

**What it does best:** Reliability and trust as a "just works, forever, for free" tool for people who don't want to think about their clipboard manager. Its open-source nature is repeatedly cited as a selling point specifically because users are wary of subscription creep or being bought out and bloated with ads.

**Pricing:** Completely free, donationware-adjacent, no tiers, no accounts.

**Community sentiment:**
- How-To Geek (July 2026): calls it the tool the author would "least want to lose," and frames it as trustworthy for sensitive data *because* it's open source and doesn't phone home.
- Real reader comment ("Tasha"): *"I have tried a number of clipboard managers, including Ditto, and always end up back with Windows clipboard manager for its simplicity. Other than remembering what I clipped, I am not interested in fancy features that I rarely remember the shortcuts for. The Windows key + V works just fine."*
- Another reader ("Joanne"): *"I've used Clipmate for years. Can Ditto import my saved clips?"* — signals real import/migration friction as a switching barrier.
- MakeUseOf (Jan 2026): praised group hotkeys and paste-format options, but the author ultimately picked a newer, simpler tool (Pasteboard) over Ditto: *"It is the most efficient, free, easy-to-use, clean, and simple."*
- Repeated criticism: dated/basic UI, real learning curve for deeper features.

**Similarities to FatClipboard:** Both auto-capture history persistently and locally; both support search; both aim to never lose a copied item.

**Differences:** Zero categorization/tagging intelligence, no AI, no screenshots-as-first-class, no folders, no templates, no Stack mode, no monetization. Zero data caps ever, for free — a sharp contrast with FatClipboard's free tier (50 items/7 days).

---

### 2. ClipboardFusion (Binary Fortress Software)

**Overview:** Commercial Windows clipboard utility from Binary Fortress Software (2007, Canada). Positions itself as a clipboard **automation/transformation engine**, not just a history browser.

**Core features:**
- History with search and pinning; up to 30 assignable HotKeys in the free tier.
- Text scrubbing/formatting removal (strip HTML/RTF automatically or on hotkey).
- Macros in C#/VB.NET via a built-in code editor — e.g. auto-strip UTM params from URLs, regex find/replace, parse postal codes.
- Triggers — automatic rule-based actions.
- Clipboard sync across computers and mobile (Android/iOS/Windows Universal) — Pro/paid feature.
- Community macro library. Requires account registration even for free tier.

**What it does best:** Programmatic, code-level clipboard transformation — the closest analog here to FatClipboard's AI Transform, except deterministic/scripted rather than AI-interpreted.

**Pricing:** Free tier + Pro, sold as **perpetual/one-time license** ($19–$899 depending on tier, volume discounts available). 30-day free trial of Pro (mainly for sync) before reverting to Free.

**Community sentiment:**
- Slashdot reviews page had zero user reviews — thinner public presence than ClipClip.
- One aggregated complaint: *"ClipboardFusion started to charge to use macros, which was its special place"* — resentment about a previously-free feature moving behind a paywall.
- Binary Fortress described as a small, responsive vendor with good support.
- MakeUseOf: "The free version did almost all the job... you get encrypted syncing with the pro version" — free tier is generous for core use, gating mainly sync (a different split than FatClipboard's, which gates history size/pins/folders/AI).

**Similarities to FatClipboard:** Pinning, hotkey quick access, "do something smart to this clip" concept (macros vs. AI transform).

**Differences:** Deterministic scripting vs. natural-language AI; perpetual license vs. subscription; more mature multi-device sync (incl. mobile apps) than FatClipboard currently has. No folders, no screenshot management, no semantic search, no auto-categorization.

---

### 3. ClipClip

**Overview:** A modern-for-its-genre, Windows-only, feature-dense clipboard manager (Vitzo/clipclip.com), actively maintained. Positions itself as "more than copy-paste."

**Core features:**
- Up to 1,000 clips across "Recent Clips" (rolling buffer) and "Saved Clips" (permanent, foldered).
- Pinned clips section, separate from recent/saved.
- Integrated screenshot/screen-capture and GIF/screen-recording tools.
- Built-in clip editor: rich HTML editing, image annotation, case/formatting changes.
- OCR — extract text from images/scanned docs/PDFs.
- One-click translation.
- "Actions" — one-click Base64, MD5, HTML encode/decode, case conversion, format clearing.
- Cloud sync via Google Drive / OneDrive. Password-protected/encrypted folders. Default hotkey Ctrl+Shift+V (same family as FatClipboard's).

**What it does best:** Breadth as a Swiss-army-knife clipboard hub — OCR, translation, screenshots, and format conversion all in one app.

**Pricing:** Free personal license; **$49 one-time** commercial/business license (perpetual, not subscription).

**Community sentiment (Capterra, 34 reviews, 4.6/5, 100% "positive sentiment"):**
- Glen G.: *"This makes me wonder how Microsoft could not see how pathetic their clipboard functions are. ClipClip is so intuitive... you will never use anything else."* Con: wants a "check for updates" feature.
- Sergio G.: praised the recent/pinned/saved three-tier model, but flagged real friction — formatted-paste sometimes fails, and search-on-open doesn't default focus to the search field (opens focused on recent clips instead, requiring an extra keypress/click). Documentation is "a Google Doc," i.e. thin.
- Remus S.: wished it minimized to tray not taskbar, and stayed on top after pasting.
- Bob B.: "I cannot think of a single con... OneDrive storage is a game-changer."
- Aizal M.: praised free tier depth but "The UI is quite outdated but its ok since it sits on the tray."
- Recurring gripes: dated UI aesthetics, occasional formatted-paste bugs, minor window-focus/tray annoyances, thin documentation.

**Similarities to FatClipboard:** Arguably the closest feature-overlap competitor — recent + pinned + saved/organized as three tiers, screenshots as first-class, folders, "hub" ambition.

**Differences:** "Smart" features are deterministic/single-purpose (OCR, translate, hash/encode), not AI-interpreted — no semantic search, no natural-language filters, no custom-instruction AI transform. One-time purchase, not subscription. Free tier caps at 1,000 clips total rather than a time/item rolling window. Has real cloud sync today.

---

### 4. CopyQ (cross-platform, open source)

**Overview:** Advanced, free, open-source clipboard manager (Windows/macOS/Linux, ~11.9k GitHub stars, actively maintained). The default recommendation for power users/scripters across nearly every comparison site.

**Core features:**
- Unlimited history, text/images/code with adjustable format preservation.
- Organization via **tabs, labels/tags, and filters** — its standout organizational model.
- Built-in scripting engine (JS-like) for transforming/filtering/routing clipboard items automatically.
- Command-line interface for full automation outside the GUI.
- Encrypted storage for sensitive histories. Cross-machine sync via pointing a tab at a synced folder (Dropbox/OneDrive). Ignore-list for specific source apps (e.g. password managers). Pin feature. Fully free, no paid tier.

**What it does best:** Deep, code-level customizability and true cross-platform parity — treating the clipboard as a programmable data pipeline.

**Pricing:** 100% free and open source, no premium tier.

**Community sentiment:**
- Widely described as "the best free and open-source" pick across AlternativeTo, xda-developers, and multiple listicles.
- Real reader comment: *"CopyQ is my favorit[e]. Clipboard, Archive, Database, collections, and many more of functionality."*
- **GitHub issue tracker shows a real, recurring stability/resource-usage pattern**: eating gigabytes of RAM with a second monitor present (#1286); constant high CPU/RAM after copying large text (#3096); memory leaks growing over hours of uptime, especially macOS (#774); crash-on-startup loops (#1401, #1311); crashes on Wayland/Linux (#1455).
- Consistent framing: steeper learning curve than Ditto/ClipClip; power comes with real stability/footprint tax on less mainstream configs.

**Similarities to FatClipboard:** Pinning; some notion of categorization (manual tabs/tags vs. FatClipboard's automatic rule-based detection).

**Differences:** Manual/user-driven organization (you create tabs/tags yourself) vs. FatClipboard's zero-effort automatic categorization — an important product-philosophy divergence: CopyQ demands configuration, FatClipboard's pitch is zero-configuration intelligence. No AI features, no screenshots-as-clip-type, no templates, no accounts — will never compete on smart search/AI transform, but wins on scriptability, cross-platform reach, and price.

---

### 5. Windows 11 built-in clipboard history (Win+V) — the "do nothing" baseline

**Overview:** Free, pre-installed, zero-friction default on every Windows 10 (since 2018)/11 PC. Arguably FatClipboard's most important competitor by volume — it's what every prospective user already has running.

**Core features (per Microsoft's own docs):**
- Win+V popup panel; history capped at **25 entries max**, per-item size capped at **4MB**; supports only plain text, HTML, Bitmap — no files, no arbitrary formats.
- Pin items to survive restarts; **unpinned history is wiped on every restart**.
- Optional cloud sync tied to a Microsoft account (automatic or manual per-item).
- Individual delete / "Clear all." No search, no categorization, no folders, no editing.

**What it does best:** Ubiquity and zero setup cost — no download, no account beyond what's already logged in, "good enough" for the huge population that just wants to paste something from two steps ago.

**Pricing:** Free, bundled with the OS.

**Community sentiment:**
- The single most telling data point: a real reader comment (Tasha) explicitly abandoning Ditto to go back to Win+V, cited above.
- MakeUseOf's reviewer's actual motivation for trying five third-party tools: *"I found that it was constantly forgetting things that were copied, which made things frustrating"* — the 25-item cap silently evicting items is the real trigger event that sends people shopping, not a desire for AI/fancy features. Valuable acquisition-funnel insight.
- Widely-reported complaints (Microsoft Answers forums): users want pinned items to sort to the top instead of requiring scrolling; want to reorder pins; want tabs/folders; a 24H2 update reportedly briefly broke clipboard history entirely.
- **Directly relevant to FatClipboard's roadmap:** credible reporting (patent filings, Windows Insider coverage, e.g. Windows Central: "Windows Clipboard is getting smarter with AI — advanced paste is coming") that Microsoft is exploring an AI-powered "Advanced Paste" that transforms clipboard content via an LLM at paste time (format conversion, code language conversion, HTML/JSON generation from plain text). Not shipped — patents/rumors only as of this research — but a real strategic risk to flag: if Windows ships even a basic free version of this, it undercuts FatClipboard's headline Pro differentiator the same way Win+V already undercuts basic history tools.

**Similarities to FatClipboard:** Docked popup panel (same hotkey family, Ctrl+Shift+V vs. Win+V); pinning; possible future AI-assisted paste transforms.

**Differences:** No search, no auto-categorization, no folders, no screenshots-as-clips, no AI today, no Stack mode, no templates — deliberately minimal. Its only "feature" relative to FatClipboard is being pre-installed and free.

---

## Appendix B — Full research: premium/AI-adjacent competitors

*(Paste, Raycast, Maccy, PastePal, Alfred — includes sourced quotes and a citation list)*

### 1. Paste (Fiplab / Paste Team ApS) — Mac, iPhone, iPad

**Overview:** The most direct, mature premium analog to FatClipboard's Pro-tier ambitions — a polished, cross-device clipboard manager with subscription pricing, visual history, and (as of late 2025/2026) light AI features. Around since ~2015, 16,000+ App Store ratings at 4.5 stars.

**Core features:**
- Adjustable history retention (day/week/month/year/unlimited) with rich previews (image thumbnails, link previews, full text).
- Global hotkey (default Cmd+Shift+V) opens a banner sliding up from the bottom — visually similar in spirit to FatClipboard's docked quick-panel.
- "Power Search" (2025): search text inside screenshots via OCR, filter by type/app/date.
- "Pinboards" — saved/curated, shareable/collaborative item sets (a team feature FatClipboard doesn't have).
- iCloud sync across Mac/iPhone/iPad at no extra cost beyond subscription — the single biggest structural difference from FatClipboard.
- Rules to exclude sensitive apps (1Password, password fields) from capture.
- "Paste Stack" — accumulate/reorder/sequentially paste, close to FatClipboard's Stack mode. Macworld flagged a real flaw: the stack isn't persistent across sessions, and its default shortcut (Cmd+Shift+C) is dangerously close to Cmd+C, so an accidental trigger wipes the stack.
- iOS keyboard extension, Siri Shortcuts.
- **Paste MCP** (June 2026): a local MCP server exposing clipboard history as context to Claude/Codex/Cursor/etc. — a materially different AI strategy than FatClipboard's: positioning the clipboard as memory/context *for* external AI tools rather than building an in-house transform pipeline.
- Apple Intelligence integration (Nov 2025) for in-app proofread/rewrite — Apple's on-device model doing the work, not a Paste-built pipeline.

**What it does best:** Cross-device sync done simply (same Apple Account, no separate auth system); visual polish and "it just feels good" reputation.

**Pricing:** **$2.49/mo or $29.99/yr**, or one-time lifetime (~$89.99 per older sources; pricing has crept up over time). 7-day free trial. Also on Setapp ($9.99/mo bundle). Single paid product, no free/Pro split like FatClipboard.

**Community sentiment:**
- Strong marketing-site testimonials from developers/designers at MongoDB, Airbnb, IBM, etc.
- **Sync bugs are the #1 real complaint**: reports of sync being "useless, taking so long... for one device"; a documented severe bug in v6.5.0 where a background sync-asset folder filled with 300GB+ of junk data, rendering a MacBook Pro unusable until force-quit and manually cleaned up. Also reports of iOS-to-Mac paste simply breaking after an update.
- General critical consensus per a dedicated review title ("Good Design, Real Limitations"): good UX, but sync reliability and power-user depth (vs. Maccy/Alfred) are real weak points.

**Similarities/differences vs. FatClipboard:** Similar — rich preview UI, docked hotkey panel, stack mode, subscription-gated advanced capability. Different — real cross-device sync FatClipboard lacks; AI strategy is "hook into external AI tools" + light OS-level edits rather than FatClipboard's more ambitious in-house AI Transform/Custom Filters; no separate screenshot model (screenshots are just image clips); no free tier at all.

---

### 2. Raycast — macOS (and now Windows) launcher with clipboard history + AI

**Overview:** Not a dedicated clipboard manager — a Spotlight-replacement launcher — but Clipboard History is a flagship built-in feature, and its AI/monetization model is the most instructive reference point for pricing/gating AI. In 2026, Raycast launched on **Windows**, making it a direct platform competitor for the first time.

**Core features:**
- Command palette/launcher plus first-party features: Clipboard History, Window Management, Snippets, Quicklinks, Calculator, File Search, Emoji Picker, Calendar, Focus mode, Notes.
- Clipboard History: free tier retains **3 months**; Pro is unlimited. Filter by type, pin items, extract text from images (per one source).
- Extensions ecosystem: thousands of community-built extensions — widely regarded as Raycast's actual killer feature.
- Raycast AI: Chat, Quick AI, 30+ built-in AI Commands (Improve Writing, Fix Spelling/Grammar, Change Tone, Summarize Webpage, Find Bugs in Code) plus user-creatable custom commands — conceptually close to FatClipboard's AI Transform presets, scoped to arbitrary text/webpages rather than specifically clipboard items.
- 2026: **Bring Your Own Key (BYOK)** — connect your own OpenAI/Anthropic/Google API key for unlimited AI messaging without Pro, a direct response to cost complaints.
- **Raycast for Windows** (2026): ports the launcher, AI commands, clipboard history, snippets, window management; ~300 extensions on Windows so far vs. thousands on Mac; Cloud Sync (Mac/Windows/iOS) hit public beta July 2026.

**What it does best:** Being "one app to replace several others"; the extension ecosystem (its actual killer feature per long-time users); making AI feel native/ambient via the same launcher muscle memory.

**Pricing (as fetched):**
- **Free forever**: all core built-ins, thousands of extensions, 3 months clipboard history, 5 Notes, 50 free AI messages (one-time trial).
- **Pro**: $8/mo billed annually ($10/mo monthly) — unlimited clipboard history, unlimited Notes, Cloud Sync, custom themes, Translator, unlimited AI chat with standard models.
- **Advanced AI Add-on**: +$8/user/mo (so $16/mo all-in) for frontier models.
- Teams Free/Pro ($12-15/user/mo), Enterprise (custom).
- Notably: **"Is it possible to get Pro without AI? No"** — Raycast deliberately does not sell Pro without AI bundled; you can only disable AI in settings, not un-pay for it.

**Community sentiment:**
- Praised for speed, UI cohesion, calculator/window-management/extension breadth.
- Sharp, detailed real criticism from a widely-cited independent comparison (joshcollinsworth.com): **"Raycast's clipboard limit is a deal-breaker"** — hit a silent failure copying large text blocks (1,000-2,000 line JSON) that simply wouldn't save to history, no error, silently reverting to whatever was previously there; had to disable/re-enable repeatedly until switching to Alfred. Also: more keystrokes per action than Alfred, laggier snippet expansion, slower/less accurate file search.
- Subscription friction: at least one user "switched to Alfred instead for moral reasons"; the same reviewer: "By the time you've paid for Raycast Pro for a year, you could've paid for Alfred for a lifetime."
- On AI pricing: users explicitly asked for BYOK so they "only pay for what you actually use" — which is exactly what Raycast then built.

**Similarities/differences vs. FatClipboard:** Similar — capped free-tier retention vs. unlimited paid; built-in AI presets mirroring FatClipboard's Transform list; hotkey-summoned overlay. Different — clipboard is one of dozens of built-ins, not the spine; Pro deliberately couples to AI (can't buy one without the other) vs. FatClipboard bundling AI with several non-AI Pro perks; real extension ecosystem; now on Windows, increasingly a direct future competitor.

---

### 3. Maccy — Mac, free/open source

**Overview:** The "anti-Paste": free forever, open-source (MIT, github.com/p0deje/Maccy), deliberately minimal — the benchmark for "does the one job well and nothing else."

**Core features:**
- Text-focused clipboard history; image support has been a long-requested, still-imperfect area (Issue #44 requesting image support dates to 2019; post-2.0 issues remain: images not appearing (#1331), missing previews (#381, #945), can't save images to file (#1245), no annotation (#1348)).
- Fast keyboard-first search — type to filter, Enter to paste, no mouse.
- Pin items; clear history via shortcut. Privacy-respecting (mirrors password-manager clipboard scrubbing). Local-only storage.
- **Maccy 2.0** (2024): complete rewrite, AppKit+NSMenu → SwiftUI+NSPanel, Core Data → SwiftData, better memory handling for large images, backward-compatible with a documented downgrade path.
- No folders, no categorization, no AI, no screenshots-as-separate-entity, no stacks, no sync — deliberately.

**What it does best:** Fastest, lightest, most "gets out of your way" option — the top recommendation for developers/power users wanting raw history with zero friction. Open-source trust: "It is and will always be free" is a stated philosophy, not just a price point.

**Pricing:** $0. Free forever, MIT-licensed, via Mac App Store or Gumroad. No tiers, no IAP.

**Community sentiment:**
- Repeatedly framed as the answer for people who find Paste/PastePal "too much." Real, direct instance of defection: a PastePal (paid) reviewer wrote, "I'm planning to switch to Maccy on the App Store, which seems lighter and more minimalistic."
- The recurring, multi-year, still-unresolved complaint is **poor image/screenshot support** — exactly the gap FatClipboard's dedicated, foldable, local-only screenshot library fills.
- No monetization complaints (it's free) — itself a data point: free/OSS removes an entire category of friction subscription competitors face.

**Similarities/differences vs. FatClipboard:** Similar — keyboard-first, low-friction hotkey philosophy. Different — zero organization features at all vs. FatClipboard's much richer set; Maccy's users' allergy to subscriptions on principle is a real cautionary data point (some users will resist any paid tier no matter how good the AI is); Maccy's persistent image-handling weakness is precisely where FatClipboard's screenshot feature already outshines it.

---

### 4. PastePal — Mac (IndieGoodies)

**Overview:** Positions itself as the modern, native-feeling, one-time-purchase middle ground between Maccy's austerity and Paste's subscription.

**Core features:**
- Unlimited history, fast search/indexing.
- iCloud sync across Mac/iPhone/iPad, one universal purchase covers all platforms — matches Paste's sync capability but via one-time purchase.
- **OCR**: recognizes text inside copied images, stores recognized text alongside the item, making screenshots searchable by content — folds OCR text into the same item rather than a fully separate screenshot store.
- Multiple side-window positions, "hot edge" activation, "queue stack" (comparable to FatClipboard's Stack mode), advanced filtering, drag-and-drop. 35+ language localizations. No analytics, local storage.

**What it does best:** Native Mac feel at a low, one-time price; OCR-searchable screenshots as a standard (not gated) feature.

**Pricing:** **$14.99 one-time** IAP (Mac App Store, family sharing). Marketed explicitly as "no recurring subscription — buy once, use forever." Also sold via AppSumo as a lifetime-deal promotion (~$10-15).

**Community sentiment (AppSumo, 16 reviews, 3.88/5):**
- Enthusiastic 5-star: *"This is so good that its dumb that Apple has not made what this Tool does as an integrated feature..."* — praised the speed of the sidebar workflow vs. app-switching.
- Sharp complaints specifically about the **AppSumo lifetime-deal licensing** (not the app itself): one reviewer bought a $9 lifetime deal, then after reformatting their Mac the license key didn't work — support clarified "lifetime" meant the single license key, not multiple devices/reinstalls, and recommended buying from the App Store instead (ties to iCloud account, avoids the issue). Same reviewer noted storage growing quickly even with ~100 items kept, and said they were switching to Maccy.
- Two separate 1-star reviews reported AppSumo license keys simply not activating at all, with the founder responding asking users to email support — real friction specifically in the discount-marketplace redemption pipeline.
- Recurring "functional but not beautiful" sentiment — positions PastePal as strong but behind Paste on visual polish.

**Similarities/differences vs. FatClipboard:** Similar — OCR/searchable-image ambitions parallel a possible future for FatClipboard's screenshot store; queue-stack mirrors Stack mode. Different — one-time purchase, not subscription/freemium; the AppSumo review data is a useful cautionary tale specifically about lifetime-deal/licensing mechanics if FatClipboard ever considers a similar one-time or deal-marketplace option.

---

### 5. Alfred — Mac launcher, clipboard history feature (Powerpack)

**Overview:** Raycast's older, more "power-user tinkerer" predecessor — clipboard history is entirely gated behind a one-time-purchase Powerpack upgrade, rather than free-with-paid-extensions like Raycast.

**Core features:**
- Clipboard History (Powerpack): text, images, file references; disabled by default for privacy, needs explicit enable + Accessibility permission.
- Configurable retention: 24h / 7 days / 1 month / 3 months (unlimited possible via advanced settings) — conceptually close to FatClipboard's free-tier "50 items or 7 days."
- Searchable viewer via hotkey, filter by any word/phrase in the clip.
- **Clipboard Merging** — hold Cmd, double-tap C to append current selection to the previous clip in history — a distinctive "build a compound clip" interaction not found in FatClipboard, Paste, or Raycast.
- Save any clip as a permanent Snippet (auto-expanding) via Cmd+S from the viewer — a manual-promotion bridge between temporary history and permanent template, conceptually adjacent to FatClipboard's placeholder templates but without the fill-in-later fields.
- Ignore-list for sensitive apps. Advanced settings: auto-paste on Return, max clip size. Workflows (Alfred's extension answer) — more manual/scriptable than Raycast's GUI-driven store; an early-access "Alfred Gallery" is a direct catch-up move against Raycast's ecosystem.

**What it does best:** Raw speed (faster than Raycast for equivalent tasks per multiple sources); fewer keystrokes due to smarter default query interpretation; one-time-purchase model as a real point of user loyalty.

**Pricing:** **Powerpack: one-time ~£34/~$45**, "Mega Supporter" ~£59/~$78 adds lifetime future-version upgrades. No subscription at all — the purest one-time-purchase model researched. No free clipboard history at all (contrast with Raycast's free 3-month history).

**Community sentiment:**
- *"With Raycast, you need [to] enter two prompts to do most things... Alfred just needs one prompt."* On pricing: *"I don't personally consider [the Powerpack cost] a drawback... By the time you've paid for Raycast Pro for a year, you could've paid for Alfred for a lifetime."*
- General consensus: power users who've invested years in custom Workflows stay with Alfred; users wanting quick wins from a marketplace gravitate to Raycast.
- Criticized for dated visual design ("hasn't really updated in probably over a decade") and a much less polished workflow-authoring/sharing experience than Raycast.

**Similarities/differences vs. FatClipboard:** Similar — hotkey-summoned viewer with configurable retention windows close to FatClipboard's free-tier cap shape; an explicit free-vs-paid gate on clipboard history itself. Different — pure one-time purchase, no subscription, no AI baked in at all (only via user-built Workflows calling an LLM); "Clipboard Merging" is a distinctive low-friction interaction FatClipboard doesn't have and could consider; no screenshots-as-separate-thing, no folders/categorization.

---

## Sources

**Traditional/Windows tools:**
- https://www.howtogeek.com/this-open-source-clipboard-manager-slowly-became-my-most-important-productivity-tool/
- https://www.makeuseof.com/i-tested-windows-clipboard-managers-this-is-the-best-one/
- https://windowsforum.com/threads/ditto-clipboard-manager-best-open-source-windows-clipboard-history-tool.383114/
- https://windowsforum.com/threads/best-clipboard-managers-for-windows-11-in-2026-ditto-copyq-clipclip-and-more.391369/
- https://windowsforum.com/threads/best-clipboard-managers-for-windows-in-2026-ditto-copyq-clipclip-more.409292/
- https://sourceforge.net/projects/ditto-cp/
- https://github.com/sabrogden/Ditto | https://github.com/CyberShadow/Ditto
- https://www.clipboardfusion.com/ | https://www.clipboardfusion.com/FAQ/ | https://www.clipboardfusion.com/Compare/
- https://slashdot.org/software/p/ClipboardFusion/
- https://www.capterra.com/p/167579/ClipClip/ | https://www.clipclip.com/
- https://copyq.net/ | https://github.com/hluk/CopyQ | https://github.com/hluk/CopyQ/issues (1286, 3096, 774, 1401, 1311, 1455)
- https://www.xda-developers.com/open-source-clipboard-manager-copyq/
- https://support.microsoft.com/en-us/windows/clipboard-in-windows-c436501e-985d-1c8d-97ea-fe46ddf338c6
- https://www.windowscentral.com/microsoft/windows/microsoft-is-planning-an-actually-good-ai-upgrade-for-one-of-the-best-modern-windows-tools
- https://windowsforum.com/threads/microsoft-clipboard-copilot-turning-copy-paste-into-an-ai-productivity-tool.393953/
- https://alternativeto.net/software/ditto/ | https://alternativeto.net/software/copyq/

**Premium/AI-adjacent tools:**
- https://pasteapp.io/ | https://pasteapp.io/pricing | https://pasteapp.io/mcp
- https://www.macworld.com/article/804417/paste-review.html
- https://pasteryapp.com/blog/paste-app-review/
- https://www.techwench.com/best-clipboard-managers-2026/
- https://appsumo.com/products/pastepal/reviews/
- https://indiegoodies.com/pastepal | https://docs.indiegoodies.com/pastepal/Mac/features/recognize-text-image | https://github.com/IndieGoodies/PastePal
- https://www.raycast.com/pricing | https://www.raycast.com/core-features/ai | https://manual.raycast.com/ai/ai-commands | https://www.raycast.com/blog/raycast-for-windows | https://www.raycast.com/community-stories
- https://joshcollinsworth.com/blog/alfred-raycast
- https://tech-insider.org/raycast-vs-alfred-2026/
- https://www.alfredapp.com/help/features/clipboard/ | https://textexpander.com/blog/alfred-free-vs-powerpack
- https://maccy.app/ | https://github.com/p0deje/Maccy/issues (44, 1331, 1245) | https://github.com/p0deje/Maccy/pull/869 | https://github.com/p0deje/Maccy/releases/tag/2.0.0
