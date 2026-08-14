# FatClipboard component conventions

## No wrapper required
No provider, theme context, or root wrapper is needed — every component reads its data via plain
props (or its own internal mock-backed `invoke()` calls when unmounted from the real Tauri app;
see `.prompt.md` files for which). Just render a component directly:
```tsx
<SettingsPanel onClose={() => {}} />
```
Dark mode is a plain ancestor class, not a provider: add `className="dark"` to any parent element
to switch every `dark:`-prefixed utility below it. No class → light mode.

## Styling idiom: Tailwind utility classes, brand color/shadow/radius names
This is a Tailwind v3 app (classic JS config) with a custom palette — always reach for these named
utilities over raw hex/arbitrary values:

| Purpose | Light | Dark |
|---|---|---|
| Page background | `bg-cream` | `dark:bg-charcoal` |
| Card/panel surface | `bg-creamSurface` or `bg-white` | `dark:bg-charcoalSurface` |
| Primary text | `text-ink` | `dark:text-cream` |
| Secondary/muted text | `text-inkMuted` | `dark:text-inkMutedDark` |
| Hairline border | `border-borderLight` | `dark:border-borderDark` |
| Accent (brand green) | `text-accent` / `bg-accent` | `dark:text-accentDark` / `dark:bg-accentDark` |
| Accent tint fill | `bg-accentFill` | `dark:bg-accentFillDark` |

Other custom tokens: elevation via `shadow-card`/`dark:shadow-cardDark` (surfaces sitting in
normal flow — stat tiles, list cards) vs. `shadow-float`/`dark:shadow-floatDark` (things floating
above content — dropdowns, popovers, modals). Radii use Tailwind's stock scale (`rounded-lg`,
`rounded-xl`, `rounded-2xl`) — there's no custom radius token in active use. Text sizes are
mostly literal pixel arbitrary values
(`text-[12.5px]`, `text-[13px]`) rather than Tailwind's `text-sm`/`text-xs` scale — match that
granularity rather than snapping to the default scale. Every interactive color gets a `dark:`
counterpart; never ship a `dark:` class only, or light mode breaks.

## Icons: Tabler icon font, not an SVG library
Icons are `<i className="ti ti-<name>" />` from `@tabler/icons-webfont` (loaded as a CDN
`@import` already in this bundle's `styles.css` closure — no extra wiring needed). Browse names at
tabler.io/icons. Typical sizing/coloring: `<i className="ti ti-folder text-[12px] text-accent
dark:text-accentDark" />`. Never substitute a different icon set — the font is already loaded and
these are the only glyphs guaranteed to render.

## Where the truth lives
Read `styles.css` (this bundle's compiled stylesheet, includes every utility class actually used)
before inventing a new class combination — if a similar surface already exists, match its exact
classes rather than approximating. Each component's `.prompt.md` documents its real prop
contract and links back to source-derived JSDoc; several components (`Dashboard`, `AuthGate`,
`Onboarding`) take zero or one prop and manage their own internal state — check before adding
props that don't exist.

## Example: composing with the shared building blocks
```tsx
<div className="rounded-2xl bg-creamSurface dark:bg-charcoalSurface shadow-card dark:shadow-cardDark p-4">
  <div className="flex items-center gap-2 mb-1">
    <i className="ti ti-folder text-accent dark:text-accentDark text-[15px]" />
    <p className="text-[13px] font-medium text-ink dark:text-cream">Brand colors</p>
  </div>
  <ClampedText
    text="Primary purple #6B46C1, Cream #FFFFFF, Charcoal #1A1816"
    className="text-[12px] text-inkMuted dark:text-inkMutedDark"
    lines={2}
  />
</div>
```
