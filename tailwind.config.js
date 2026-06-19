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
        accent: "#6B46C1",
        accentFill: "#F1ECFB",
        // Dark mode (warm charcoal — not pure black, to match the cream brand)
        charcoal: "#1C1A17",
        charcoalSurface: "#262320",
        inkMutedDark: "#A8A39B",
        borderDark: "rgba(255, 255, 255, 0.08)",
        accentDark: "#B9A6F0",
        accentFillDark: "#2E2640",
      },
      borderRadius: {
        panel: "18px",
      },
    },
  },
  plugins: [],
};
