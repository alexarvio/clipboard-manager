# clipboard-manager design-sync notes

## Repo shape
This is a Tauri desktop **app** (`FatClipboard`/`clipboard-manager`), not a component library.
`src/components/*.tsx` are large stateful app screens (64–1,802 lines), not small reusable
primitives. Synced anyway per explicit user request (`/design-sync` session, 2026-08-12) after
confirming they understood the fidelity trade-off. `App.tsx` and `main.tsx` (the root orchestrator
and the Vite bootstrap entry, living directly under `src/`, not `src/components/`) are excluded
from the sync entirely — see the CRITICAL notes below; this isn't optional scoping, `main.tsx`
literally cannot be included without breaking every preview.

## CRITICAL: this repo needs a real, hand-written entry file — synth-entry mode does not work here
Two separate, serious bugs were found only by **manually opening `.review.html` in a real browser**
(2026-08-12) — the automated Playwright render check was skipped this sync (declined — no
Playwright installed), and both bugs shipped completely undetected through the first upload
(every single component was broken; the "22 KB" earlier build validated clean and looked fine in
`package-validate.mjs`'s own checks, because nothing in that pipeline actually mounts a browser
DOM without Playwright). **Moral: for any repo where Playwright is declined, budget for a manual
browser check before considering ANY build "done" — validate exiting 0 proves the bundle is
well-formed, not that it renders anything.**

**Bug 1 — `cfg.srcDir` must never point above `src/components/`.** The converter's synth-entry
mode (used automatically whenever there's no `dist` build — see below) does
`export * from "<path>";` for **every** `.tsx`/`.jsx` file under `cfg.srcDir`, regardless of
`componentSrcMap` (that map only filters the downstream *component list*, not which files get
bundled). `componentSrcMap: {"App": null}` was tried first and does NOT stop `App.tsx`/`main.tsx`
from being bundled and executed. `main.tsx` runs
`ReactDOM.createRoot(document.getElementById("root")).render(...)` at module top level — a real
side effect, not gated behind any export — so with `cfg.srcDir` at the repo's `src/` root, that
line ran on every single preview page, threw ("Target container is not a DOM element", no `#root`
in the preview HTML), and left `window.ClipboardManager` never assigned, breaking every other
component too.

**Bug 2 (bigger, found right after fixing bug 1) — synth-entry mode cannot see ANY of this repo's
components at all, even scoped correctly.** Every one of the 12 components is
`export default function Name(...)` — a **default** export, and ES module `export * from "mod"`
**never forwards a default export** (this is standard JS spec behavior, not a converter bug).
Synth-entry mode's blind `export * from "<file>.tsx"` therefore produces **zero** actual named
bindings for any component here — `Object.getOwnPropertyNames(window.ClipboardManager)` came back
as just `["__esModule"]`. This is invisible in `package-build.mjs`'s/`package-validate.mjs`'s own
output — the build reports "12 components" (from `componentSrcMap`-driven discovery, which is
separate from what actually got bundled) and validate exits 0 (it checks structural things like
`.d.ts` parseability and CSS import resolution, not "does the exported symbol actually exist").
Only a real browser catches this, via `React.createElement: type is invalid ... got undefined`.

**The fix for both, together**: this repo cannot use synth-entry mode at all. `.design-sync/entry.ts`
(committed, durable) is a small hand-written barrel with explicit named re-exports:
```ts
export { default as AuthGate } from "../src/components/AuthGate";
export { default as ClampedText } from "../src/components/ClampedText";
// ...all 12
```
`cfg.entry: ".design-sync/entry.ts"` points the converter at it directly. Because this file
*exists*, `resolveDistEntry` uses it as-is and never falls into synth-entry mode — so `main.tsx`/
`App.tsx` are never touched (fixes bug 1 as a side effect, no `cfg.srcDir` override even needed
for that purpose — it's kept anyway, see below) and the barrel's explicit `export {default as X}`
syntax correctly forwards each default export by name (fixes bug 2). Because there's no real
`dist`/`.d.ts` for `exportedNames()` to read, `cfg.componentSrcMap` ALSO needs every one of the 12
names with a non-null path (any non-null value registers a component regardless of what
`exportedNames()` finds) — without it, `resolvePackage()` finds 0 components and hard-exits.
`cfg.srcDir: "src/components"` is kept for enrichment (JSDoc/grouping) — harmless now that entry
generation no longer walks it, but if a future re-sync ever removes `cfg.entry` and falls back to
synth mode, `srcDir` scoping is what stands between that fallback and Bug 1 recurring. **Adding a
new component**: add it to BOTH `.design-sync/entry.ts` (barrel re-export) AND
`cfg.componentSrcMap` (registration) — one without the other means it's either invisible to the
bundle or invisible to discovery.

## No library build — why synth-entry mode was ever in play
`package.json` has no `main`/`module`/`exports`, and `tsconfig.json` has `noEmit: true` — this
app never builds a `.d.ts`-typed library entry, only a bundled Vite app. Without `cfg.entry` set,
the converter would synthesize an entry from `src/*.tsx` (the `[NO_DIST]` code path) — which is
exactly the broken path described above. `cfg.entry` (the hand-written barrel) bypasses this
entirely; the `[NO_DIST]` log line should never appear in this repo's build output anymore. If it
does, `cfg.entry` isn't being picked up — check the config first.

## Tailwind CSS — hashed build output
Styling is Tailwind v3 (classic JS config, `tailwind.config.js`), not CSS-variable-based tokens
— no `var(--*)` custom properties anywhere, so `[TOKENS_MISSING]` shouldn't fire. The compiled
stylesheet only exists after `npm run build` (Vite content-hashes the output filename, e.g.
`dist/assets/index-DMOKy9y0.css`), so `cfg.cssEntry` points at a **stable copy**:
`.design-sync/.cache/compiled.css`. **Every re-sync must re-run `npm run build` and re-copy**
before running the converter — and re-prepend the icon-font import (below), since the copy is
a fresh overwrite each time:
```sh
npm run build && cp dist/assets/index-*.css .design-sync/.cache/compiled.css
printf '%s\n%s' '@import url("https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css");' "$(cat .design-sync/.cache/compiled.css)" > .design-sync/.cache/compiled.css.tmp
mv .design-sync/.cache/compiled.css.tmp .design-sync/.cache/compiled.css
```
Verified working end-to-end in a real browser (2026-08-12): computed styles on rendered elements
matched the expected Tailwind classes exactly (e.g. `.text-inkMuted` → `rgb(110, 104, 89)`).

## Icon font is a remote CDN link, not part of the bundle
Every `<i className="ti ti-*">` icon (used in 9 of the 12 synced components) comes from
`@tabler/icons-webfont`, loaded in `index.html` via a plain CDN `<link>` — **not** through
Vite/Tailwind, so the build's CSS scrape can't see it. Wired in as a remote `@import` prepended
to `cfg.cssEntry` (above) — matches the `[FONT_REMOTE]` pattern (informational, loads at
runtime, no local font file to ship). Without this, every icon in nearly every component would
render as blank/tofu. Verified rendering correctly in a real browser (2026-08-12, e.g. PasteQueue's
green list icon and the "Paste this" button's copy icon).

## No provider needed
No React Context anywhere in `src/` (`grep -r createContext|useContext|Provider src/` — zero
hits). Everything is plain prop-drilling from `App.tsx`. `cfg.provider` is intentionally unset.

## tauriShim already solves the "runs outside Tauri" problem
`src/lib/tauriShim.ts` detects `window.__TAURI_INTERNALS__` and, when absent, transparently
swaps every `invoke()`/`getCurrentWindow()` call for realistic in-memory mock data (history
items, folders, screenshots, dashboard stats, auth state, etc.) — this is exactly what makes
these components renderable as standalone previews at all. Query params it already supports for
picking preview states: `?auth=logout` (AuthGate's fresh-install view), `?onboarding=0`
(Onboarding flow), `?window=dashboard` (renders `Dashboard.tsx` instead of the docked panel),
`?tier=pro` (added this sync — see below). Component previews can lean on these mock defaults
directly — no need to reinvent fixture data.

## Known render warns
- `[FONT_MISSING] "Cambria"` — Tailwind's `font-serif` utility (`ui-serif, Georgia, Cambria,
  "Times New Roman", Times, serif`) is compiled into the shared stylesheet because Vite/Tailwind
  scans the whole `src/` tree for class usage, but the only place `font-serif` is actually used
  is `App.tsx:1413` (one decorative italic word in onboarding-style copy) — a file excluded from
  sync scope. None of the 12 synced components reference it. Triaged as expected noise, not
  fixed; would go away on its own if App.tsx is ever added to scope and then not use font-serif,
  or can be ignored indefinitely.

## tauriShim.ts changes made during this sync
While authoring previews, subagents found real gaps in `src/lib/tauriShim.ts`'s mock layer (not
design-sync artifacts — these would affect anyone running `npm run dev` in a plain browser too).
All fixed directly in app source, with the user's explicit sign-off:
- **No way to preview Pro tier.** `settings.tier` was hardcoded `"free"` with no override, unlike
  the file's existing `?auth=`/`?onboarding=`/`?window=` query-param pattern. Added `?tier=pro`
  (same pattern) plus a runtime `__setMockTier("pro"|"free")` export for programmatic callers.
  **`__setMockTier` was also briefly exposed on the DS bundle via `cfg.extraEntries:
  ["./src/lib/tauriShim.ts"]` — this was REVERTED.** `extraEntries` merges the extra module's
  exports onto `window.<GLOBAL>` via a generated `.bundle-entry.mjs` with a `__dsMainNs` marker
  namespace re-export; in this repo that mechanism silently broke the merge entirely — the final
  `window.ClipboardManager` ended up with ONLY tauriShim's exports and none of the 12 real
  components (caught via a manual browser check, same session). Root cause not fully isolated
  (possibly an interaction between a namespace-of-a-namespace `export * as X from Y` where Y
  itself lacked real named exports, back when Y was still synth-entry — worth re-investigating
  if `extraEntries` is ever wanted again, but ONLY after the barrel-entry fix above and with a
  real browser check on the result, not just a clean `validate` exit). `__setMockTier` and the
  `?tier=pro` URL override still exist and work in the real app / manual `npm run dev` browser
  testing — they're just not reachable from design-sync preview `.tsx` files anymore.
- **Pro-tier TransformTab crashed in browser preview.** `get_transform_log`, `log_transform`, and
  `delete_transform_log_entry` had no mock case, so `get_transform_log` silently resolved
  `undefined` (the generic unhandled-command fallback) instead of `[]`, and TransformTab's
  unconditional `log.length` read crashed on render. Added a small in-memory `transformLog` mock
  array + the three commands, same pattern as `history`/`folders`.
- **Screenshots Smart search crashed in browser preview.** `semantic_search_screenshots` had no
  mock case either (same `undefined`-instead-of-`[]` failure as above, in ScreenshotsPanel's own
  Smart-search effect). Added a mock matching `semantic_search`'s keyword-overlap approach against
  each screenshot's OCR text — which also meant adding an `ocr_text` field to the mock
  `screenshots` array, since it was missing entirely (every screenshot's OCR text was silently
  `undefined`, even though the real `ScreenshotItem` type requires it).
- **Not fixed, lower priority**: `copy_to_clipboard` and `ocr_uploaded_image` (TransformTab's
  image-upload flow) are still unmocked. Neither blocks initial render — they're only reached via
  click handlers (Copy button, image upload) — so no story crashes, but exercising them
  interactively in a served preview will just console-warn and no-op.

## Known preview limitations
- **ScreenshotsPanel's Free/Pro stories both render the same empty grid.** `list_screenshots`'
  mock gates on the *shared* `settings.tier` (hardcoded `"free"`, no longer overridable from a
  preview file — see the `extraEntries` revert above), not the `tier` PROP passed to the
  component. Verified correct in a real browser (2026-08-12): both stories show the honest
  "no screenshots yet" empty state.
- **SettingsPanel has no Pro-tier story.** Unlike ScreenshotsPanel/FoldersPanel/TransformTab
  (which take `tier` as a real prop — safe to vary per story since props are per-JSX-instance,
  not shared state), SettingsPanel reads tier internally via `get_settings()`. Even with
  `__setMockTier` working, every named export in one preview file shares the same page/module
  instance in grid mode, and React's passive effects (where `get_settings()` lives) don't fire
  until the whole synchronous mount loop for every cell on the page finishes — so a
  `__setMockTier` call in one story would leak into every other story's effect on the same page.
  A real per-story SettingsPanel Pro variant would need either a `tier` prop added to the real
  component (an app change beyond this sync's scope) or per-story page isolation, which this
  converter's card system doesn't support.

## Re-sync risks
- The hashed CSS filename (above) is the single most likely thing to silently go stale — a
  re-sync that skips the rebuild+recopy step will validate against last time's stylesheet.
- **If a re-sync ever removes `cfg.entry` or `cfg.componentSrcMap`, the bundle silently ships
  with zero working components and `package-validate.mjs` will still exit 0.** There is no
  automated check that catches this short of a real browser render — see the CRITICAL section
  above. Always do a manual `.review.html` browser check after any config change that touches
  `entry`, `srcDir`, `extraEntries`, or `componentSrcMap`, not just after the first sync.
- `App.tsx`/`main.tsx` were excluded from scope both by user request AND because `main.tsx`'s
  `ReactDOM.createRoot(document.getElementById("root"))` side effect is incompatible with the
  preview harness as-is. `App.tsx` itself has no such side effect (just a module-level
  `getCurrentWindow()` call, harmless) and could be added to `.design-sync/entry.ts` +
  `componentSrcMap` on a future re-sync if wanted; `main.tsx` cannot be added without first
  guarding its bootstrap call behind a real-Tauri/real-`#root`-exists check.
