/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // ---------------------------------------------------------------
        // Palette swap (2026-08-31). Six brand colors were given:
        //   light  #F6F3ED (warm paper) / #C2CBD3 (cool grey-blue) / #313851 (navy ink)
        //   dark   #333333 (base) / #474747 (surface) / #FD105E (accent)
        // Everything else below is a derived step (recessed surfaces, muted
        // text, hairline borders, accent wash) mixed from those six so the
        // existing token names keep meaning the same thing they did before.
        // ---------------------------------------------------------------

        // Light mode
        cream: "#F6F3ED",
        creamSurface: "#EFEBE3",
        // Cool inset tint derived from #C2CBD3 -- item-list/pill containers
        // (folder item lists, PasteQueue pill, preset chips, text inputs)
        // and their hover states. Reads as a recessed surface against the
        // warm paper background without competing with accentFill.
        pillTint: "#EAECEF",
        ink: "#313851",
        inkMuted: "#666E85",
        // A third text step below inkMuted, for timestamps and idle row
        // icons -- the Dashboard redesign's `--faint`. Muted was carrying
        // both jobs and the two never separated visually.
        inkFaint: "#939BAD",
        borderLight: "rgba(49, 56, 81, 0.14)",
        // Light-mode accent. The three light colors given have no vivid
        // accent in them, so this is the navy doing double duty (icons,
        // links, "Show more", active states). For a single brand accent
        // shared across both themes instead, swap this line for the pink:
        //   accent: "#FD105E",  accentFill: "#FDE3EC",
        accent: "#313851",
        accentFill: "#E1E6EB",

        // Dark mode
        charcoal: "#333333",
        charcoalSurface: "#474747",
        inkMutedDark: "#A6A6A6",
        inkFaintDark: "#8A8A8A",
        // Dark counterpart to pillTint. Inset rows previously fell back to
        // bare white/black alpha in dark mode, which reads flatter than the
        // charcoal surfaces around them.
        pillTintDark: "#414141",
        borderDark: "rgba(255, 255, 255, 0.10)",
        accentDark: "#FD105E",
        accentFillDark: "#4A2233",
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
