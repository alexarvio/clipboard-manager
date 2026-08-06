/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // Light mode (cream)
        cream: "#F2EEE3",
        creamSurface: "#F8F4EC",
        ink: "#1A1816",
        inkMuted: "#6E6859",
        borderLight: "rgba(0, 0, 0, 0.08)",
        // Accent recolored 2026-07-27 to match the FatClipboard logo's neon
        // lime-green (the "CLIPBOARD" wordmark, #C1FF72) instead of the old
        // purple -- accentDark uses the exact logo green since it's bright
        // enough to pop straight off charcoal; accent (light mode) is a
        // darker, more saturated shade of the *same* hue/sat rather than the
        // literal logo color, since #C1FF72 at full brightness has too little
        // contrast to read as text/icons against the cream background.
        accent: "#5EA800",
        accentFill: "#F1F8E7",
        // Dark mode (warm charcoal — not pure black, to match the cream brand)
        charcoal: "#1C1A17",
        charcoalSurface: "#262320",
        inkMutedDark: "#A8A39B",
        borderDark: "rgba(255, 255, 255, 0.08)",
        accentDark: "#C1FF72",
        accentFillDark: "#2B3B16",
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
