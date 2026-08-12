# clipboard-manager design-sync notes

## Repo shape
This is a Tauri desktop **app** (`FatClipboard`/`clipboard-manager`), not a component library.
`src/components/*.tsx` are large stateful app screens (64–1,802 lines), not small reusable
primitives. Synced anyway per explicit user request (`/design-sync` session, 2026-08-12) after
confirming they understood the fidelity trade-off. `App.tsx` (the root orchestrator holding all
app state, 1,744 lines) is intentionally excluded via `componentSrcMap: {"App": null}` — the
user scoped the sync to the 12 files under `src/components/`. It can be added back on a future
re-sync if wanted.

## No library build — synth-entry mode
`package.json` has no `main`/`module`/`exports`, and `tsconfig.json` has `noEmit: true` — this
app never builds a `.d.ts`-typed library entry, only a bundled Vite app. The converter run for
this repo therefore always synthesizes its entry from `src/*.tsx` (the `[NO_DIST]` code path).
Component `.d.ts` prop contracts are auto-extracted straight from the `.tsx` source types
(no separate declaration build to check against), so verify prop shapes look right if anything
seems off in a component's `.prompt.md`.

**Getting `--entry`/`--node-modules` to resolve correctly**: since `node_modules/clipboard-manager`
doesn't exist (npm never self-installs a package into its own node_modules), pass
`--entry ./dist/index.js` (a path that deliberately does NOT exist) so the build script's
package-root walk-up still lands on this repo's own `package.json` (giving it the right
`PKG_DIR`), while the nonexistent path makes `resolveDistEntry` soft-fail into synth-entry mode
as intended. Always pass `--node-modules ./node_modules` (this repo's own — it has its own
`react`/`react-dom`, no monorepo hoisting here).

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

## Icon font is a remote CDN link, not part of the bundle
Every `<i className="ti ti-*">` icon (used in 9 of the 12 synced components) comes from
`@tabler/icons-webfont`, loaded in `index.html` via a plain CDN `<link>` — **not** through
Vite/Tailwind, so the build's CSS scrape can't see it. Wired in as a remote `@import` prepended
to `cfg.cssEntry` (above) — matches the `[FONT_REMOTE]` pattern (informational, loads at
runtime, no local font file to ship). Without this, every icon in nearly every component would
render as blank/tofu.

## No provider needed
No React Context anywhere in `src/` (`grep -r createContext|useContext|Provider src/` — zero
hits). Everything is plain prop-drilling from `App.tsx`. `cfg.provider` is intentionally unset.

## tauriShim already solves the "runs outside Tauri" problem
`src/lib/tauriShim.ts` detects `window.__TAURI_INTERNALS__` and, when absent, transparently
swaps every `invoke()`/`getCurrentWindow()` call for realistic in-memory mock data (history
items, folders, screenshots, dashboard stats, auth state, etc.) — this is exactly what makes
these components renderable as standalone previews at all. Query params it already supports for
picking preview states: `?auth=logout` (AuthGate's fresh-install view), `?onboarding=0`
(Onboarding flow), `?window=dashboard` (renders `Dashboard.tsx` instead of the docked panel).
Component previews can lean on these mock defaults directly — no need to reinvent fixture data.

## Known render warns
- `[FONT_MISSING] "Cambria"` — Tailwind's `font-serif` utility (`ui-serif, Georgia, Cambria,
  "Times New Roman", Times, serif`) is compiled into the shared stylesheet because Vite/Tailwind
  scans the whole `src/` tree for class usage, but the only place `font-serif` is actually used
  is `App.tsx:1413` (one decorative italic word in onboarding-style copy) — a file excluded from
  sync scope. None of the 12 synced components reference it. Triaged as expected noise, not
  fixed; would go away on its own if App.tsx is ever added to scope and then not use font-serif,
  or can be ignored indefinitely.

## tauriShim.ts changes made during this sync
While authoring previews, subagents found two real gaps in `src/lib/tauriShim.ts`'s mock layer
(not design-sync artifacts — these would affect anyone running `npm run dev` in a plain browser
too). Both were fixed directly in app source, with the user's explicit sign-off:
- **No way to preview Pro tier.** `settings.tier` was hardcoded `"free"` with no override, unlike
  the file's existing `?auth=`/`?onboarding=`/`?window=` query-param pattern. Added `?tier=pro`
  (same pattern) plus a runtime `__setMockTier("pro"|"free")` export, for callers (like preview
  stories) that render components directly rather than loading `index.html` with a query string.
  `__setMockTier` is exposed on the DS bundle via `cfg.extraEntries: ["./src/lib/tauriShim.ts"]`
  — that also puts `invoke`, `getCurrentWindow`, `isTauri`, and `mockWindowLabel` on
  `window.ClipboardManager`, which is harmless (they're already meant to be safe outside Tauri)
  but worth knowing if `window.ClipboardManager`'s surface ever looks bigger than "just the 12
  components."
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
- **SettingsPanel has no Pro-tier story.** Unlike ScreenshotsPanel/FoldersPanel/TransformTab
  (which take `tier` as a real prop — safe to vary per story), SettingsPanel reads tier
  internally via `get_settings()`. `__setMockTier` can flip it, but every named export in one
  preview file shares the same page/module instance in grid mode, and React's passive effects
  (where the `get_settings()` call lives) don't fire until the whole synchronous mount loop for
  every cell on the page finishes — so a `__setMockTier` call in one story leaks into every
  other story's effect on the same page, including ones that never called it. Tried and reverted
  (see the note left in `.design-sync/previews/SettingsPanel.tsx`). Only usable when *every*
  story in a file wants the same tier (ScreenshotsPanel.tsx does this deliberately — see its own
  comment). A real per-story SettingsPanel Pro variant would need either a `tier` prop added to
  the real component (an app change beyond this sync's scope) or per-story page isolation, which
  this converter's card system doesn't support.

## Re-sync risks
- The hashed CSS filename (above) is the single most likely thing to silently go stale — a
  re-sync that skips the rebuild+recopy step will validate against last time's stylesheet.
- `App.tsx` was excluded from scope by user request, not because it can't render — it's a
  reasonable future add (it needs zero props, since it manages all its own state internally).
