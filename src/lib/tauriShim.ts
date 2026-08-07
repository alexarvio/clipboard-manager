// Detects whether the app is running inside a real Tauri webview. When it's
// not (e.g. `npm run dev` opened in a plain browser for visual iteration),
// this supplies mock implementations of the Tauri APIs the UI depends on —
// `invoke` and `getCurrentWindow` — so the whole component tree renders and
// is clickable without the native Rust backend. When actually running inside
// Tauri (`npm run tauri dev` / the built app), every call passes straight
// through to the real APIs, unchanged.

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { getCurrentWindow as tauriGetCurrentWindow } from "@tauri-apps/api/window";
import { BUILTIN_PRESETS } from "./presets";

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ---- mock data --------------------------------------------------------

interface MockSettings {
  hotkey: string;
  max_history: number;
  launch_at_startup: boolean;
  theme: "dark" | "light";
  server_url: string;
  app_secret: string;
  tier: "free" | "pro";
  custom_presets: { label: string; instruction: string }[];
  // Screenshots' own separate custom-preset pool (2026-08-06 split) -- see
  // the matching field's doc comment on settings.rs::Settings.
  custom_presets_screenshots: { label: string; instruction: string }[];
  custom_filters: { name: string; prompt: string }[];
  visible_categories: string[];
  visible_presets: string[];
  // Was missing from this mock entirely -- fell back silently to
  // DEFAULT_SCREENSHOT_PRESETS wherever it's read with `?? fallback`, so it
  // never actually broke anything visible, just wasn't an accurate mirror
  // of settings.rs::Settings. Added while touching this file for the
  // custom_presets_screenshots split above.
  visible_presets_screenshots: string[];
  auth_token: string;
  user_email: string;
  first_name: string;
  onboarding_complete: boolean;
}

// Browser preview defaults to already signed in, since most iteration here
// is on the rest of the app, not the sign-up screen itself -- visit
// `/?auth=logout` to preview AuthGate.tsx the way a fresh install would see
// it (mirrors the mockWindowLabel `?window=` pattern below).
const startLoggedOut =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("auth") === "logout";

// Browser preview defaults to already onboarded, same reasoning as
// startLoggedOut above -- visit `/?onboarding=0` to preview Onboarding.tsx
// without also having to go through AuthGate first. A fresh (logged-out)
// preview always needs onboarding too, same as a real fresh install would.
const startNeedsOnboarding =
  startLoggedOut ||
  (typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("onboarding") === "0");

let settings: MockSettings = {
  hotkey: "Ctrl+Shift+V",
  max_history: 200,
  launch_at_startup: false,
  theme: "light",
  server_url: "http://localhost:8787",
  app_secret: "",
  tier: "free",
  custom_presets: [],
  custom_presets_screenshots: [],
  custom_filters: [],
  visible_categories: ["link", "email", "phone", "address", "bank_account"],
  visible_presets: [...BUILTIN_PRESETS],
  visible_presets_screenshots: [...BUILTIN_PRESETS],
  auth_token: startLoggedOut ? "" : "mock-session-token",
  user_email: startLoggedOut ? "" : "alex@example.com",
  first_name: startLoggedOut ? "" : "Alex",
  onboarding_complete: !startNeedsOnboarding,
};

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

const history = [
  { id: 1, content: "https://stripe.com/docs/api", pinned: true, created_at: minutesAgo(1), category: "link" },
  { id: 2, content: "alex@clipapp.io", pinned: false, created_at: minutesAgo(2), category: "email" },
  { id: 3, content: "(415) 555-0192", pinned: false, created_at: minutesAgo(3), category: "phone" },
  { id: 4, content: "Thanks for the quick turnaround — really appreciate you prioritizing this.", pinned: false, created_at: minutesAgo(4), category: "" },
  { id: 5, content: "1234 Market St, San Francisco, CA 94103", pinned: false, created_at: minutesAgo(5), category: "address" },
  { id: 6, content: "npm run tauri dev", pinned: false, created_at: minutesAgo(6), category: "" },
  { id: 7, content: "Routing: 121000358  Account: 0099213456", pinned: false, created_at: minutesAgo(7), category: "bank_account" },
  { id: 8, content: "Could you send over the updated mockups when you get a chance?", pinned: false, created_at: minutesAgo(9), category: "" },
  // New rule-based categories (see classify.rs) -- mirrored here so the
  // browser-preview picker/dropdown has something to actually demo.
  { id: 9, content: "$42.99", pinned: false, created_at: minutesAgo(12), category: "price" },
  { id: 10, content: "const handleSubmit = () => {", pinned: false, created_at: minutesAgo(14), category: "code" },
  { id: 11, content: "192.168.1.42", pinned: false, created_at: minutesAgo(16), category: "ip_address" },
  { id: 12, content: "/Users/alex/Projects/clip/README.md", pinned: false, created_at: minutesAgo(18), category: "file_path" },
  { id: 13, content: "Jun 30, 2026", pinned: false, created_at: daysAgo(2), category: "date_time" },
];

interface MockFolder {
  id: number;
  name: string;
  created_at: string;
  item_count: number;
  pinned: boolean;
  // null = top-level folder. See db.rs's subfolder support (2026-07-19).
  parent_id: number | null;
}

const folders: MockFolder[] = [
  { id: 1, name: "Email templates", created_at: new Date().toISOString(), item_count: 2, pinned: true, parent_id: null },
  { id: 2, name: "Brand colors", created_at: new Date().toISOString(), item_count: 3, pinned: false, parent_id: null },
  { id: 3, name: "Snippets", created_at: new Date().toISOString(), item_count: 1, pinned: false, parent_id: null },
];
let nextFolderId = 4;

// subfolder_count is derived rather than stored, same as the real backend's
// computed column -- avoids it silently going stale as folders are added/
// removed under a parent.
function withSubfolderCount(f: MockFolder) {
  return { ...f, subfolder_count: folders.filter((x) => x.parent_id === f.id).length };
}

interface MockFolderItem {
  id: number;
  folder_id: number;
  title: string | null;
  content: string;
  created_at: string;
  kind: "text" | "screenshot";
  screenshot_id: number | null;
  thumb_data_uri: string | null;
}

const folderItems: Record<number, MockFolderItem[]> = {
  1: [
    { id: 1, folder_id: 1, title: "Follow-up", content: "Hi {{name}}, just following up on my last note...", created_at: new Date().toISOString(), kind: "text", screenshot_id: null, thumb_data_uri: null },
    { id: 2, folder_id: 1, title: "Thank you", content: "Thanks so much for taking the time today.", created_at: new Date().toISOString(), kind: "text", screenshot_id: null, thumb_data_uri: null },
  ],
  2: [
    { id: 3, folder_id: 2, title: "Primary purple", content: "#6B46C1", created_at: new Date().toISOString(), kind: "text", screenshot_id: null, thumb_data_uri: null },
    { id: 4, folder_id: 2, title: "Cream", content: "#F2EEE3", created_at: new Date().toISOString(), kind: "text", screenshot_id: null, thumb_data_uri: null },
    { id: 5, folder_id: 2, title: "Charcoal", content: "#1A1816", created_at: new Date().toISOString(), kind: "text", screenshot_id: null, thumb_data_uri: null },
  ],
  3: [{ id: 6, folder_id: 3, title: null, content: "console.log()", created_at: new Date().toISOString(), kind: "text", screenshot_id: null, thumb_data_uri: null }],
};
let nextFolderItemId = 7;
let pinnedFolderCount = 1;
let pinnedItemCount = 1;

const FREE_PIN_LIMIT = 3;
const FREE_FOLDER_LIMIT = 3;
const SCREENSHOT_PIN_LIMIT = 3;

// Tiny inline SVGs standing in for real screenshot thumbnails in browser
// preview -- there's no real Rust watcher/arboard here to have captured
// actual PNGs from screenshots_dir() (see db.rs), so this fakes the same
// data-URI shape list_screenshots returns (thumb_data_uri) well enough to
// demo the grid, pin, delete, and paste flows end to end.
function fakeThumb(bg: string, label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="100%" height="100%" fill="${bg}"/><text x="50%" y="50%" font-family="sans-serif" font-size="20" fill="white" text-anchor="middle" dominant-baseline="middle">${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

let screenshots: {
  id: number;
  width: number;
  height: number;
  pinned: boolean;
  created_at: string;
  thumb_data_uri: string;
}[] = [
  { id: 1, width: 1920, height: 1080, pinned: true, created_at: minutesAgo(3), thumb_data_uri: fakeThumb("#6B46C1", "Screenshot 1") },
  { id: 2, width: 1440, height: 900, pinned: false, created_at: minutesAgo(20), thumb_data_uri: fakeThumb("#B9A6F0", "Screenshot 2") },
  { id: 3, width: 1920, height: 1080, pinned: false, created_at: daysAgo(1), thumb_data_uri: fakeThumb("#1A1816", "Screenshot 3") },
];
let pinnedScreenshotCount = 1;

const TRANSFORM_RESPONSES: Record<string, (s: string) => string> = {
  "Fix grammar": (s) => s,
  "Make formal": (s) => `Please be advised: ${s}`,
  "Make casual": (s) => `hey so ${s.toLowerCase()}`,
  Summarize: (s) => s.split(" ").slice(0, 8).join(" ") + "…",
  "To bullet points": (s) =>
    s.split(/[.,]\s*/).filter(Boolean).map((x) => `• ${x}`).join("\n"),
  "Translate to Spanish": (s) => `[ES] ${s}`,
};

function delay<T>(value: T, ms = 220): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

// ---- mock invoke --------------------------------------------------------

async function mockInvoke<T>(cmd: string, args: any = {}): Promise<T> {
  switch (cmd) {
    case "get_settings":
      return delay(settings) as Promise<T>;

    case "save_settings":
      settings = { ...settings, ...args.settings };
      return delay(undefined as T);

    // Mirrors main.rs's auth_signup/auth_login: no real server round-trip in
    // browser preview, just enough validation to exercise AuthGate's error
    // states, then "sign in" by populating auth_token/user_email the same
    // way a real response would.
    case "auth_signup":
    case "auth_login": {
      await delay(null, 350);
      const email = ((args.email as string) ?? "").trim();
      const password = (args.password as string) ?? "";
      if (!email.includes("@")) throw "enter a valid email address";
      if (cmd === "auth_signup" && password.length < 8) {
        throw "password must be at least 8 characters";
      }
      if (!password) throw "invalid email or password";
      settings = { ...settings, auth_token: "mock-session-token", user_email: email.toLowerCase() };
      return settings as unknown as T;
    }

    case "auth_logout": {
      settings = { ...settings, auth_token: "", user_email: "", tier: "free" };
      return delay(settings) as Promise<T>;
    }

    // Mirrors main.rs's request_password_reset: always "succeeds" with the
    // same generic message, matching the real server's behavior of never
    // revealing whether an email has an account.
    case "request_password_reset": {
      await delay(null, 350);
      return "If an account exists for that email, a reset code is on its way." as unknown as T;
    }

    // Mirrors main.rs's reset_password. In browser preview there's no real
    // emailed code to check against, so any non-empty token is accepted --
    // this only needs to exercise ResetPassword's UI states, not real
    // security.
    case "reset_password": {
      await delay(null, 350);
      const token = ((args.token as string) ?? "").trim();
      // Tauri exposes the Rust command's `new_password` param as
      // `newPassword` here (auto camelCase conversion at the invoke
      // boundary) -- see the date_from/date_to -> dateFrom/dateTo bug this
      // exact mismatch caused elsewhere in this file before it was fixed.
      const newPassword = (args.newPassword as string) ?? "";
      if (!token) throw "that reset code is invalid or has expired";
      if (newPassword.length < 8) throw "password must be at least 8 characters";
      settings = { ...settings, auth_token: "mock-session-token" };
      return settings as unknown as T;
    }

    // Mirrors main.rs's start_checkout: in a real build this opens the
    // system browser to a Stripe Checkout URL. There's nothing to open in
    // browser preview, so this instead schedules the mock account to flip
    // to Pro a few seconds later -- simulating someone finishing checkout
    // -- so SettingsPanel's polling loop has something real to observe
    // rather than polling forever against a tier that never changes.
    case "start_checkout": {
      await delay(null, 400);
      setTimeout(() => {
        settings = { ...settings, tier: "pro" };
      }, 4000);
      return undefined as T;
    }

    // Mirrors main.rs's open_billing_portal -- nothing to actually open in
    // browser preview.
    case "open_billing_portal": {
      await delay(null, 400);
      return undefined as T;
    }

    // Mirrors main.rs's refresh_account_status (GET /auth/me + update local
    // tier). Just returns whatever the mock settings currently say, which
    // is what lets the start_checkout timeout above actually get noticed.
    case "refresh_account_status": {
      await delay(null, 200);
      return settings as unknown as T;
    }

    case "get_history": {
      const q = (args.query ?? "").toLowerCase();
      const category = args.category ?? null;
      const dateFrom = (args.dateFrom as string | undefined) ?? null;
      const dateTo = (args.dateTo as string | undefined) ?? null;
      const filtered = history.filter(
        (it) =>
          (!q || it.content.toLowerCase().includes(q)) &&
          (!category || it.category === category) &&
          (!dateFrom || it.created_at >= dateFrom) &&
          (!dateTo || it.created_at <= dateTo)
      );
      const ordered = [...filtered.filter((i) => i.pinned), ...filtered.filter((i) => !i.pinned)];
      return delay(ordered) as Promise<T>;
    }

    case "paste_item":
      console.log("[mock] paste_item", args.id);
      return delay(undefined as T);

    case "toggle_pin": {
      const item = history.find((i) => i.id === args.id);
      if (!item) return delay(false as T);
      if (!item.pinned && pinnedItemCount >= FREE_PIN_LIMIT && settings.tier !== "pro") {
        return delay(false as T);
      }
      item.pinned = !item.pinned;
      pinnedItemCount += item.pinned ? 1 : -1;
      return delay(true as T);
    }

    case "delete_history_item": {
      const idx = history.findIndex((i) => i.id === args.id);
      if (idx !== -1) {
        if (history[idx].pinned) pinnedItemCount -= 1;
        history.splice(idx, 1);
      }
      return delay(undefined as T);
    }

    // Stand-in for the real AI classification the Tauri command does via the
    // server's /filter-match endpoint -- there's no LLM available in a plain
    // browser preview, so this just does a crude keyword-overlap match
    // against each item's content. Good enough to demo the feature flowing
    // end-to-end; not meant to be a faithful semantic match.
    case "filter_by_ai": {
      await delay(null, 450);
      if (settings.tier !== "pro") throw "upgrade to Pro to use AI filters";
      const prompt = ((args.prompt as string) ?? "").toLowerCase();
      const words = prompt.match(/[a-z0-9]+/g) ?? [];
      const stop = new Set(["a", "an", "the", "is", "of", "for", "that", "with", "to", "and", "or", "this"]);
      const keywords = words.filter((w) => w.length > 2 && !stop.has(w));
      const matches = history.filter((it) => {
        const content = it.content.toLowerCase();
        return keywords.some((k) => content.includes(k));
      });
      return matches.map((it) => it.id) as unknown as T;
    }

    // Stand-in for the real Voyage-embeddings-backed semantic search (see
    // main.rs::semantic_search / server/index.js's /embed) -- there's no
    // real embeddings API available in a plain browser preview, so this
    // just does a crude keyword-overlap match against each item's content,
    // same spirit as the filter_by_ai mock above. Good enough to demo the
    // "meaning match" badge and the merge-with-substring-results behavior
    // end to end; not meant to be a faithful semantic match.
    case "semantic_search": {
      await delay(null, 400);
      if (settings.tier !== "pro") throw "upgrade to Pro to use semantic search";
      const q = ((args.query as string) ?? "").toLowerCase();
      const words = q.match(/[a-z0-9]+/g) ?? [];
      const stop = new Set(["a", "an", "the", "is", "of", "for", "that", "with", "to", "and", "or", "this", "my"]);
      const keywords = words.filter((w) => w.length > 2 && !stop.has(w));
      if (keywords.length === 0) return [] as unknown as T;
      const matches = history.filter((it) => {
        const content = it.content.toLowerCase();
        return !content.includes(q) && keywords.some((k) => content.includes(k));
      });
      // Same { id, score } shape the real command returns (see SemanticMatch
      // in main.rs) -- the frontend reads `.id` off each match and renders
      // `score` as a "N% match" badge, so returning bare ids here made every
      // smart search look empty in browser preview.
      return matches.map((it, i) => ({
        id: it.id,
        score: Math.max(0.5, 0.92 - i * 0.05),
      })) as unknown as T;
    }

    case "list_folders": {
      const parentId = (args.parentId ?? null) as number | null;
      return delay(
        folders.filter((f) => f.parent_id === parentId).map(withSubfolderCount)
      ) as Promise<T>;
    }

    case "get_folder": {
      const f = folders.find((f) => f.id === args.id);
      return delay((f ? withSubfolderCount(f) : null) as T);
    }

    case "list_folder_items":
      return delay([...(folderItems[args.folderId] ?? [])]) as Promise<T>;

    case "reorder_folder_items": {
      const list = folderItems[args.folderId];
      if (list) {
        const orderedIds: number[] = args.orderedIds;
        const byId = new Map(list.map((i) => [i.id, i]));
        const reordered = orderedIds.map((id) => byId.get(id)).filter((i): i is MockFolderItem => !!i);
        folderItems[args.folderId] = reordered;
      }
      return delay(undefined as T);
    }

    case "list_folder_memberships": {
      const memberships: { content: string; folder_id: number; folder_name: string }[] = [];
      for (const [fid, list] of Object.entries(folderItems)) {
        const f = folders.find((f) => f.id === Number(fid));
        if (!f) continue;
        for (const item of list) {
          if (item.kind !== "text") continue;
          memberships.push({ content: item.content, folder_id: f.id, folder_name: f.name });
        }
      }
      return delay(memberships) as Promise<T>;
    }

    case "list_screenshot_folder_memberships": {
      const memberships: { screenshot_id: number; folder_id: number; folder_name: string }[] = [];
      for (const [fid, list] of Object.entries(folderItems)) {
        const f = folders.find((f) => f.id === Number(fid));
        if (!f) continue;
        for (const item of list) {
          if (item.kind !== "screenshot" || item.screenshot_id == null) continue;
          memberships.push({ screenshot_id: item.screenshot_id, folder_id: f.id, folder_name: f.name });
        }
      }
      return delay(memberships) as Promise<T>;
    }

    case "create_folder": {
      if (settings.tier !== "pro" && folders.length >= FREE_FOLDER_LIMIT) {
        throw "Folder limit reached";
      }
      const f: MockFolder = {
        id: nextFolderId++,
        name: args.name,
        created_at: new Date().toISOString(),
        item_count: 0,
        pinned: false,
        parent_id: args.parentId ?? null,
      };
      folders.push(f);
      folderItems[f.id] = [];
      return delay(withSubfolderCount(f) as T);
    }

    case "paste_folder_item":
      console.log("[mock] paste_folder_item", args.id);
      return delay(undefined as T);

    case "update_folder_item": {
      for (const list of Object.values(folderItems)) {
        const it = list.find((i) => i.id === args.id);
        if (it) {
          it.title = args.title ?? null;
          it.content = args.content;
        }
      }
      return delay(undefined as T);
    }

    case "update_folder_item_title": {
      for (const list of Object.values(folderItems)) {
        const it = list.find((i) => i.id === args.id);
        if (it) it.title = args.title ?? null;
      }
      return delay(undefined as T);
    }

    case "add_to_folder": {
      const f = folders.find((f) => f.id === args.folderId);
      const item: MockFolderItem = {
        id: nextFolderItemId++,
        folder_id: args.folderId,
        title: args.title ?? null,
        content: args.content,
        created_at: new Date().toISOString(),
        kind: "text",
        screenshot_id: null,
        thumb_data_uri: null,
      };
      (folderItems[args.folderId] ??= []).push(item);
      if (f) f.item_count++;
      return delay(undefined as T);
    }

    case "add_screenshot_to_folder": {
      if (settings.tier !== "pro") throw "screenshots are a Pro feature";
      const f = folders.find((f) => f.id === args.folderId);
      const shot = screenshots.find((s) => s.id === args.screenshotId);
      if (!f || !shot) return delay(undefined as T);
      const item: MockFolderItem = {
        id: nextFolderItemId++,
        folder_id: args.folderId,
        title: args.title ?? null,
        content: "",
        created_at: new Date().toISOString(),
        kind: "screenshot",
        screenshot_id: shot.id,
        thumb_data_uri: shot.thumb_data_uri,
      };
      (folderItems[args.folderId] ??= []).push(item);
      f.item_count++;
      return delay(undefined as T);
    }

    case "delete_folder_item": {
      for (const [fid, list] of Object.entries(folderItems)) {
        const idx = list.findIndex((i) => i.id === args.id);
        if (idx >= 0) {
          list.splice(idx, 1);
          const f = folders.find((f) => f.id === Number(fid));
          if (f) f.item_count = Math.max(0, f.item_count - 1);
        }
      }
      return delay(undefined as T);
    }

    case "toggle_folder_pin": {
      const f = folders.find((f) => f.id === args.id);
      if (!f) return delay(false as T);
      if (settings.tier !== "pro") throw "Pro only";
      if (!f.pinned && pinnedFolderCount >= FREE_FOLDER_LIMIT) return delay(false as T);
      f.pinned = !f.pinned;
      pinnedFolderCount += f.pinned ? 1 : -1;
      return delay(true as T);
    }

    case "transform_clip": {
      await delay(null, 550);
      const fn = TRANSFORM_RESPONSES[args.instruction as string];
      if (fn) return fn(args.content) as unknown as T;
      return `[${args.instruction}] ${args.content}` as unknown as T;
    }

    case "paste_text":
      console.log("[mock] paste_text", args.text);
      return delay(undefined as T);

    // Backs the Dashboard window (see Dashboard.tsx) in browser preview,
    // where there's no real SQLite lifetime_counters/category_counters/
    // daily_activity tables (see db.rs) to read from. Numbers are just
    // deterministic sample data sized to look like a few weeks of real use,
    // so the UI has something realistic to render.
    case "get_dashboard_stats": {
      const categoryCounts = new Map<string, number>();
      for (const it of history) {
        if (!it.category) continue;
        categoryCounts.set(it.category, (categoryCounts.get(it.category) ?? 0) + 1);
      }
      // Scale the small in-memory history sample up so the bars/heatmap look
      // like weeks of real activity rather than the literal ~13-item mock list.
      const categories = [...categoryCounts.entries()]
        .map(([category, count]) => ({ category, count: count * 14 + 3 }))
        .sort((a, b) => b.count - a.count);

      const days = 84;
      const daily_activity = Array.from({ length: days }, (_, i) => {
        const idx = days - 1 - i;
        const date = new Date(Date.now() - idx * 86_400_000).toISOString().slice(0, 10);
        // Deterministic pseudo-random-looking pattern: quieter on what would
        // be weekends, a couple of skipped days, otherwise moderate activity.
        const dow = new Date(date).getDay();
        const base = dow === 0 || dow === 6 ? 1 : 3;
        const wobble = (idx * 37) % 7;
        const count = (idx % 11 === 0) ? 0 : base + wobble;
        return { date, count };
      });

      const stats = {
        total_clips_saved: 1247,
        transforms_run: 86,
        total_screenshots_saved: 23,
        total_characters_captured: 184320,
        categories,
        daily_activity,
        top_presets: [
          { label: "Summarize", count: 34 },
          { label: "Fix grammar", count: 21 },
          { label: "Extract key info", count: 12 },
        ],
        folders: {
          folder_count: 6,
          item_count: 42,
          most_used_folder: { name: "Recipes", count: 15 },
        },
      };
      return delay(stats) as Promise<T>;
    }

    // Screenshots -- Pro-only end to end (see db.rs/main.rs), so these throw
    // the same way the real Tauri commands do when tier isn't "pro", rather
    // than silently succeeding in browser preview.
    case "list_screenshots": {
      await delay(null, 200);
      if (settings.tier !== "pro") throw "screenshots are a Pro feature";
      return [...screenshots] as unknown as T;
    }

    case "get_screenshot_full": {
      await delay(null, 250);
      if (settings.tier !== "pro") throw "screenshots are a Pro feature";
      const item = screenshots.find((s) => s.id === args.id);
      if (!item) throw "screenshot not found";
      // Real full-res images are just bigger PNGs -- for the mock, a bigger
      // version of the same placeholder SVG is enough to exercise the
      // preview modal's loading/rendering path.
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${item.width}" height="${item.height}"><rect width="100%" height="100%" fill="#6B46C1"/><text x="50%" y="50%" font-family="sans-serif" font-size="28" fill="white" text-anchor="middle" dominant-baseline="middle">Screenshot ${item.id} (full res)</text></svg>`;
      return `data:image/svg+xml,${encodeURIComponent(svg)}` as unknown as T;
    }

    case "paste_screenshot": {
      console.log("[mock] paste_screenshot", args.id);
      if (settings.tier !== "pro") throw "screenshots are a Pro feature";
      return delay(undefined as T);
    }

    case "delete_screenshot": {
      screenshots = screenshots.filter((s) => s.id !== args.id);
      return delay(undefined as T);
    }

    case "toggle_screenshot_pin": {
      if (settings.tier !== "pro") throw "screenshots are a Pro feature";
      const item = screenshots.find((s) => s.id === args.id);
      if (!item) return delay(false as T);
      if (!item.pinned && pinnedScreenshotCount >= SCREENSHOT_PIN_LIMIT) {
        return delay(false as T);
      }
      item.pinned = !item.pinned;
      pinnedScreenshotCount += item.pinned ? 1 : -1;
      return delay(true as T);
    }

    default:
      console.warn(`[mock invoke] unhandled command "${cmd}"`, args);
      return delay(undefined as T);
  }
}

// ---- mock window ---------------------------------------------------------

type Listener = () => void;

// In the real app, which window you're in (the docked quick panel vs. the
// full Dashboard window) is determined by the Tauri window label (see the
// two entries in tauri.conf.json and main.tsx's Root component). There's no
// such thing in a plain browser preview, so this reads it from a `?window=`
// query param instead -- visit `/?window=dashboard` to preview the Dashboard
// UI, otherwise it behaves like the "main" quick-panel window.
export const mockWindowLabel =
  typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("window") ?? "main"
    : "main";

function createMockWindow() {
  return {
    label: mockWindowLabel,
    hide: () => console.log("[mock] appWindow.hide()"),
    listen: async (event: string, cb: Listener) => {
      // Simulate the panel already being open on page load, since there's no
      // real hotkey/Rust side here to emit "panel-open" in a plain browser.
      if (event === "panel-open") setTimeout(cb, 0);
      return () => {};
    },
  };
}

// ---- exports ---------------------------------------------------------------

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) return tauriInvoke<T>(cmd, args);
  return mockInvoke<T>(cmd, args);
}

export function getCurrentWindow() {
  if (isTauri) return tauriGetCurrentWindow();
  return createMockWindow() as unknown as ReturnType<typeof tauriGetCurrentWindow>;
}
