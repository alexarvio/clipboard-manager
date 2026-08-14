/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // Light mode
        cream: "#FFFFFF",
        creamSurface: "#F6F4FB",
        // Light lavender (2026-08-12) specifically for item-list/pill
        // containers (folder item lists, the PasteQueue pill, preset toggle
        // chips, standalone text inputs) and their clickable rows' hover
        // state. Deliberately a lighter, less saturated tint than accentFill
        // (#EDEAFB) -- accentFill stays reserved for actual accent-highlight
        // boxes (Dashboard stat tile, Transform preset-preview boxes, the
        // "Paste now" CTA) where more saturation is the point; these
        // containers just need to read as a distinct inset surface, not as
        // an accent callout.
        pillTint: "#F6F4FB",
        ink: "#1A1816",
        inkMuted: "#6E6859",
        borderLight: "rgba(0, 0, 0, 0.08)",
        // Accent recolored 2026-08-12 back to violet/lavender (#7C6FE3),
        // moving off the neon lime-green ("CLIPBOARD" wordmark, #C1FF72) that
        // had been in place since the 2026-07-27 pass. accentDark is a
        // lighter, less saturated lavender (#B7A9FF) than the light-mode
        // accent -- same reasoning as before: the light-mode shade needs more
        // contrast to read as text/icons against the (now white) cream
        // background, while the dark-mode shade can be brighter against
        // charcoal without blowing out.
        accent: "#7C6FE3",
        accentFill: "#EDEAFB",
        // Dark mode (warm charcoal — not pure black, to match the original
        // cream brand). Reverted back to the original warm tone (2026-08-13)
        // -- only the accent (icons, links, "Show more", active states)
        // stays lavender; the charcoal background/surface itself goes back
        // to how it looked before the violet dark-mode pass.
        charcoal: "#1C1A17",
        charcoalSurface: "#262320",
        inkMutedDark: "#A8A39B",
        borderDark: "rgba(255, 255, 255, 0.08)",
        accentDark: "#B7A9FF",
        accentFillDark: "#332B4D",
      },
      borderRadius: {
        panel: "18px",
      },
      // Elevation scale added for the 2026-07-27 visual-refresh pass -- up
      // to now, "floating" surfaces (the Pinned/date-group cards, dropdown
      // menus, popovers) only had a hairline ring and no actual shadow, so
      // everything read as flat/co-planar with the background instead of
      // stacked on top of it. `card` is for cards sitting in the normal flow
      // (Pinned box, date groups, stat tiles); `float` is for things
      // genuinely floating above content (portaled dropdowns, the
      // FolderPicker, the bottom Transform panel) and gets a visibly
      // stronger shadow since those need to read as "on top," not just
      // "slightly separated." Dark-mode variants are pure-black shadows at
      // higher opacity -- a light-mode-strength shadow all but disappears
      // against the already-dark charcoal background.
      boxShadow: {
        card: "0 1px 2px rgba(0,0,0,0.04), 0 4px 10px rgba(0,0,0,0.05)",
        cardDark: "0 1px 2px rgba(0,0,0,0.25), 0 4px 12px rgba(0,0,0,0.35)",
        float: "0 4px 10px rgba(0,0,0,0.08), 0 12px 28px rgba(0,0,0,0.10)",
        floatDark: "0 4px 12px rgba(0,0,0,0.4), 0 16px 32px rgba(0,0,0,0.45)",
      },
    },
  },
  plugins: [],
};
