// Every built-in, free-for-everyone category chip the app can detect, based
// on rule-based content detection (see src-tauri/src/classify.rs) -- no AI
// involved, so there's no cost to gate. `value` is what's sent to
// get_history's `category` param. There are more of these than most people
// want cluttering the filter dropdown at once, so which ones actually
// render there is controlled by Settings -> visible_categories (see
// SettingsPanel.tsx); this list is the full catalog they're picking from.
// Lives in its own module (rather than being exported from App.tsx) so both
// App.tsx and SettingsPanel.tsx can import it without a circular dependency.
export const ALL_CATEGORIES: { label: string; value: string }[] = [
  { label: "Link", value: "link" },
  { label: "Email", value: "email" },
  { label: "Phone", value: "phone" },
  { label: "Address", value: "address" },
  { label: "Bank account", value: "bank_account" },
  { label: "Date & time", value: "date_time" },
  { label: "Price", value: "price" },
  { label: "Code", value: "code" },
  { label: "IP address", value: "ip_address" },
  { label: "File path", value: "file_path" },
];
