// Every built-in, free-for-everyone category chip the app can detect, based
// on rule-based content detection (see src-tauri/src/classify.rs) -- no AI
// involved, so there's no cost to gate. `value` is what's sent to
// get_history's `category` param. There are more of these than most people
// want cluttering the filter dropdown at once, so which ones actually
// render there is controlled by Settings -> visible_categories (see
// SettingsPanel.tsx); this list is the full catalog they're picking from.
// Lives in its own module (rather than being exported from App.tsx) so both
// App.tsx and SettingsPanel.tsx can import it without a circular dependency.
// `icon` is a Tabler Icons class suffix (e.g. "ti-link" -> "ti ti-link") --
// added 2026-08-09 alongside SettingsPanel's Categories grid redesign
// (checkbox list -> icon + label toggle buttons) so this one shared list
// stays the single source of truth for both the label *and* the icon,
// rather than a second lookup table living next to whichever component
// happens to render icons this week.
export const ALL_CATEGORIES: { label: string; value: string; icon: string }[] = [
  { label: "Link", value: "link", icon: "ti-link" },
  { label: "Email", value: "email", icon: "ti-mail" },
  { label: "Phone", value: "phone", icon: "ti-phone" },
  { label: "Address", value: "address", icon: "ti-map-pin" },
  { label: "Bank account", value: "bank_account", icon: "ti-building-bank" },
  { label: "Date & time", value: "date_time", icon: "ti-calendar" },
  { label: "Price", value: "price", icon: "ti-currency-dollar" },
  { label: "Code", value: "code", icon: "ti-code" },
  { label: "IP address", value: "ip_address", icon: "ti-network" },
  { label: "File path", value: "file_path", icon: "ti-route" },
];
