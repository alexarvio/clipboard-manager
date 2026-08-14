use crate::classify;
use base64::Engine;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize, Clone)]
pub struct ClipItem {
    pub id: i64,
    pub content: String,
    pub pinned: bool,
    pub created_at: String,
    // Auto-detected category (see classify.rs for the full list: text/link/
    // email/phone/address/bank_account/date_time/price/code/ip_address/
    // file_path), used by the free history filter. COALESCE'd to "text" in
    // SELECTs so legacy rows from before this column existed don't come
    // back NULL.
    pub category: String,
}

pub fn db_path() -> PathBuf {
    let mut dir = dirs::config_dir().expect("no config dir");
    dir.push("clip");
    std::fs::create_dir_all(&dir).ok();
    dir.push("history.sqlite");
    dir
}

/// Where full-resolution + thumbnail screenshot PNGs live on disk. Images
/// are never stored as SQLite blobs (see the "Screenshots" section below for
/// why) -- this directory holds the actual files, and the `screenshots`
/// table just points at them.
pub fn screenshots_dir() -> PathBuf {
    let mut dir = dirs::config_dir().expect("no config dir");
    dir.push("clip");
    dir.push("screenshots");
    std::fs::create_dir_all(&dir).ok();
    dir
}

#[derive(Serialize, Clone)]
pub struct Folder {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    pub item_count: i64,
    pub pinned: bool,
    // NULL means this is a top-level folder. Subfolders (added 2026-07-19)
    // reuse the same `folders` table with a self-referential parent_id
    // rather than a separate table, since a folder and a subfolder are the
    // same thing in every other respect (pinning, item limits, etc.).
    pub parent_id: Option<i64>,
    // How many direct child folders this one has -- lets the UI show a
    // folder row differently (or just know to render a "Folders" section)
    // without a second round-trip per folder.
    pub subfolder_count: i64,
}

#[derive(Serialize, Clone)]
pub struct FolderItem {
    pub id: i64,
    pub folder_id: i64,
    pub title: Option<String>,
    pub content: String,
    pub created_at: String,
    // "text" (the original kind -- content holds the actual saved text) or
    // "screenshot" (content is unused/empty, screenshot_id points at the row
    // in `screenshots` this item is a reference to). Folders can mix both
    // kinds freely -- this is a per-item tag, not a per-folder setting.
    pub kind: String,
    pub screenshot_id: Option<i64>,
    // Populated only for kind == "screenshot", by joining screenshots.thumb_path
    // and reading it the same way list_screenshots does. None for text items.
    pub thumb_data_uri: Option<String>,
}

pub fn init(conn: &Connection) {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS clip_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            pinned INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )",
        [],
    )
    .expect("failed to create table");

    // Migration for DBs created before `category` existed on clip_items.
    // If this is the first time the column is added (Ok, not already-exists
    // Err), backfill every existing row in one pass so old history doesn't
    // sit there NULL/uncategorized forever.
    let added_category = conn
        .execute("ALTER TABLE clip_items ADD COLUMN category TEXT", [])
        .is_ok();
    if added_category {
        backfill_categories(conn);
    }

    conn.execute(
        "CREATE TABLE IF NOT EXISTS folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            pinned INTEGER NOT NULL DEFAULT 0
        )",
        [],
    )
    .expect("failed to create folders table");

    // Migration for DBs created before `pinned` existed on folders.
    // Errors (column already exists) are expected and ignored.
    conn.execute("ALTER TABLE folders ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0", [])
        .ok();

    // Migration for DBs created before subfolders (2026-07-19) -- nullable
    // self-reference, NULL = top-level folder. No backfill needed since
    // every pre-existing folder is top-level by definition.
    conn.execute("ALTER TABLE folders ADD COLUMN parent_id INTEGER", [])
        .ok();

    conn.execute(
        "CREATE TABLE IF NOT EXISTS folder_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            folder_id INTEGER NOT NULL,
            title TEXT,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (folder_id) REFERENCES folders (id) ON DELETE CASCADE
        )",
        [],
    )
    .expect("failed to create folder_items table");

    // Migration for DBs created before folder items could reference a
    // screenshot instead of holding text -- same ignore-if-exists pattern as
    // the category/pinned migrations above. `kind` defaults to "text" so
    // every pre-existing folder_item (which was always text) keeps working
    // with no backfill needed.
    conn.execute("ALTER TABLE folder_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'", [])
        .ok();
    conn.execute("ALTER TABLE folder_items ADD COLUMN screenshot_id INTEGER", [])
        .ok();

    // Migration for DBs created before folder items were reorderable
    // (2026-07-19). Every pre-existing row defaults to 0 -- since they're
    // all tied, list_folder_items's `ORDER BY sort_order ASC, id DESC`
    // tiebreak reproduces the old newest-first order exactly, so no backfill
    // pass is needed to preserve existing folders' display order.
    conn.execute("ALTER TABLE folder_items ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0", [])
        .ok();

    // --- Dashboard stats -------------------------------------------------
    // These three tables back the Dashboard window's activity stats. They're
    // deliberately separate from clip_items, which gets trimmed (50-item/
    // 7-day cap on Free, see trim_history_for_tier) -- lifetime totals and
    // the streak heatmap need to survive trimming, so every insert bumps
    // these alongside clip_items rather than deriving stats from it later.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS lifetime_counters (
            metric TEXT PRIMARY KEY,
            count INTEGER NOT NULL DEFAULT 0
        )",
        [],
    )
    .expect("failed to create lifetime_counters table");

    conn.execute(
        "CREATE TABLE IF NOT EXISTS category_counters (
            category TEXT PRIMARY KEY,
            count INTEGER NOT NULL DEFAULT 0
        )",
        [],
    )
    .expect("failed to create category_counters table");

    conn.execute(
        "CREATE TABLE IF NOT EXISTS daily_activity (
            date TEXT PRIMARY KEY,
            count INTEGER NOT NULL DEFAULT 0
        )",
        [],
    )
    .expect("failed to create daily_activity table");

    // Screenshots -- Pro-only (gated in the command layer in main.rs, same
    // pattern as transform_clip/filter_by_ai), separate entirely from
    // clip_items per the product decision to keep "screenshots" as its own
    // section rather than mixed into the text history. file_path/thumb_path
    // point into screenshots_dir(); the row itself never holds image bytes.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS screenshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT NOT NULL,
            thumb_path TEXT NOT NULL,
            width INTEGER NOT NULL,
            height INTEGER NOT NULL,
            pinned INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )",
        [],
    )
    .expect("failed to create screenshots table");

    // Migration for DBs created before OCR text extraction (2026-07-31) --
    // NULL means "not OCR'd yet" (or OCR failed/unavailable), empty string
    // means "OCR ran, found no text". Backfill isn't attempted here since
    // that would mean re-decoding every screenshot PNG on disk at startup;
    // existing screenshots just stay NULL/unsearchable-by-text until they're
    // re-captured, which is an acceptable gap for a brand-new feature.
    conn.execute("ALTER TABLE screenshots ADD COLUMN ocr_text TEXT", [])
        .ok();

    // Semantic search embeddings -- Pro-only (see main.rs::semantic_search),
    // one row per clip_item that's been embedded via the server's /embed
    // endpoint (see server/index.js, which calls Voyage AI). `vector` is a
    // plain JSON array of f32s rather than a packed binary blob: history
    // sizes here are small (hundreds to low thousands of rows for a personal
    // clipboard manager, not millions), so a brute-force cosine-similarity
    // scan in Rust at query time (see semantic_search below) is plenty fast
    // without needing a real vector-index format. No FK/CASCADE is declared
    // here -- clip_items rows get deleted from three different places
    // (delete_item, trim_history, trim_history_by_age), so each of those
    // calls prune_orphaned_embeddings itself instead of relying on SQLite
    // foreign-key enforcement (which also isn't turned on for this
    // connection).
    conn.execute(
        "CREATE TABLE IF NOT EXISTS embeddings (
            clip_item_id INTEGER PRIMARY KEY,
            vector TEXT NOT NULL
        )",
        [],
    )
    .expect("failed to create embeddings table");

    // Same idea as `embeddings` above, but keyed by screenshot_id and kept in
    // its own table rather than reusing `embeddings` -- screenshots and
    // clip_items are deliberately separate feeds (see the "Screenshots"
    // section below), and mixing their ids into one embeddings table would
    // require a discriminator column just to tell them apart at query time.
    // Populated lazily/on-demand (see main.rs::semantic_search_screenshots),
    // not automatically on every capture the way clip embeddings are --
    // screenshot volume is effectively unlimited and free to capture, so
    // eagerly embedding every one would make embedding-API cost track raw
    // screenshot count instead of actual Smart-search usage.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS screenshot_embeddings (
            screenshot_id INTEGER PRIMARY KEY,
            vector TEXT NOT NULL
        )",
        [],
    )
    .expect("failed to create screenshot_embeddings table");

    // Recent-runs log for the standalone AI Transform tab (added
    // 2026-07-22, alongside moving Screenshots into a History sub-toggle
    // and giving Transform its own top-level tab) -- this is a lightweight
    // scratchpad of the last few transforms run from that tab, purely a
    // convenience so a user can glance back at "what did I just do" without
    // having saved every result to a folder. Deliberately separate from
    // clip_items/folder_items: it's not meant to be a permanent archive
    // (see TRANSFORM_LOG_LIMIT below, which trims it aggressively), and
    // isn't subject to the Free/Pro history cap logic those tables have.
    // Per-preset usage counts (2026-08-07), backing the Dashboard's "top
    // presets" stat. Only bumped when a run was actually triggered by
    // clicking a specific preset button (builtin or custom) -- see
    // transform_clip's preset_label param in main.rs -- not for freeform
    // typed instructions, so this stays an honest "which presets do you
    // actually reach for" count rather than lumping every transform in.
    // `label` alone (not builtin-vs-custom) is the key: a builtin's label
    // *is* its instruction text, and a custom preset's label is whatever
    // name it was saved under, so both already live in the same namespace
    // (see settings.rs's own note on this).
    conn.execute(
        "CREATE TABLE IF NOT EXISTS preset_usage_counts (
            label TEXT PRIMARY KEY,
            count INTEGER NOT NULL DEFAULT 0
        )",
        [],
    )
    .expect("failed to create preset_usage_counts table");

    conn.execute(
        "CREATE TABLE IF NOT EXISTS transform_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            input TEXT NOT NULL,
            instruction TEXT NOT NULL,
            output TEXT NOT NULL,
            created_at TEXT NOT NULL
        )",
        [],
    )
    .expect("failed to create transform_log table");

    // Migration for DBs created before preset_label existed on transform_log
    // (2026-08-13) -- lets the Recent list show a preset's actual name
    // ("Spanish") instead of falling back to its raw instruction/prompt text
    // ("translate any input text into the spanish language") for entries
    // that came from clicking a preset button rather than typing a freeform
    // instruction. NULL for freeform runs (there's no preset name to show,
    // the instruction text itself already *is* the label there) and for
    // every row logged before this column existed. Errors (column already
    // exists) are expected and ignored, same as every other migration here.
    conn.execute("ALTER TABLE transform_log ADD COLUMN preset_label TEXT", [])
        .ok();

    // --- Indexes ---------------------------------------------------------
    // Declared last so every ALTER TABLE above has already added the columns
    // these cover. All IF NOT EXISTS, so this is a no-op on an existing DB
    // and safe to re-run on every launch, same as the CREATE TABLEs.
    //
    // Every one of these backs a query that previously did a full table
    // scan: folder_items.folder_id is scanned once per folder just to build
    // list_folders' item_count subquery (and again by list_folder_items /
    // next_top_sort_order / delete_folder), folders.parent_id likewise for
    // subfolder_count and the parent filter, folder_items.screenshot_id by
    // delete_screenshot and list_screenshot_folder_memberships, and
    // created_at by the age-based Free-tier trims plus the date-range filter
    // in `search`.
    for sql in [
        "CREATE INDEX IF NOT EXISTS idx_folder_items_folder_id ON folder_items (folder_id)",
        "CREATE INDEX IF NOT EXISTS idx_folder_items_screenshot_id ON folder_items (screenshot_id)",
        "CREATE INDEX IF NOT EXISTS idx_folders_parent_id ON folders (parent_id)",
        "CREATE INDEX IF NOT EXISTS idx_clip_items_created_at ON clip_items (created_at)",
        "CREATE INDEX IF NOT EXISTS idx_screenshots_created_at ON screenshots (created_at)",
    ] {
        conn.execute(sql, []).ok();
    }
}

/// Increments a named lifetime counter (e.g. "clips_saved", "transforms_run")
/// by 1, creating the row if it doesn't exist yet.
pub fn bump_lifetime(conn: &Connection, metric: &str) {
    conn.execute(
        "INSERT INTO lifetime_counters (metric, count) VALUES (?1, 1)
         ON CONFLICT(metric) DO UPDATE SET count = count + 1",
        params![metric],
    )
    .ok();
}

/// Same as bump_lifetime, but by an arbitrary amount rather than always 1 --
/// used for "characters_captured" (bumped by a clip's length, not by one per
/// clip). Kept as a separate function rather than adding an `amount` param
/// to bump_lifetime itself so every existing call site (which only ever
/// means "+1 event happened") stays exactly as readable as it is now.
pub fn bump_lifetime_by(conn: &Connection, metric: &str, amount: i64) {
    conn.execute(
        "INSERT INTO lifetime_counters (metric, count) VALUES (?1, ?2)
         ON CONFLICT(metric) DO UPDATE SET count = count + ?2",
        params![metric, amount],
    )
    .ok();
}

fn get_lifetime(conn: &Connection, metric: &str) -> i64 {
    conn.query_row(
        "SELECT count FROM lifetime_counters WHERE metric = ?1",
        params![metric],
        |row| row.get(0),
    )
    .unwrap_or(0)
}

fn bump_category_counter(conn: &Connection, category: &str) {
    conn.execute(
        "INSERT INTO category_counters (category, count) VALUES (?1, 1)
         ON CONFLICT(category) DO UPDATE SET count = count + 1",
        params![category],
    )
    .ok();
}

/// `date` is a plain YYYY-MM-DD day (local time), not a full RFC3339
/// timestamp -- one row per calendar day, incremented on every clip saved
/// that day. Backs the Dashboard's streak heatmap.
fn bump_daily_activity(conn: &Connection, date: &str) {
    conn.execute(
        "INSERT INTO daily_activity (date, count) VALUES (?1, 1)
         ON CONFLICT(date) DO UPDATE SET count = count + 1",
        params![date],
    )
    .ok();
}

/// Bumps a preset's usage count by 1, creating the row if it doesn't exist
/// yet -- see the preset_usage_counts table's own doc comment in init().
pub fn bump_preset_usage(conn: &Connection, label: &str) {
    conn.execute(
        "INSERT INTO preset_usage_counts (label, count) VALUES (?1, 1)
         ON CONFLICT(label) DO UPDATE SET count = count + 1",
        params![label],
    )
    .ok();
}

#[derive(Serialize, Clone)]
pub struct CategoryCount {
    pub category: String,
    pub count: i64,
}

#[derive(Serialize, Clone)]
pub struct DayCount {
    pub date: String,
    pub count: i64,
}

#[derive(Serialize, Clone)]
pub struct PresetUsage {
    pub label: String,
    pub count: i64,
}

#[derive(Serialize, Clone)]
pub struct FolderUsage {
    pub name: String,
    pub count: i64,
}

#[derive(Serialize, Clone)]
pub struct FolderStats {
    // Every folder including subfolders -- a subfolder is a "folder" just
    // as much as a top-level one (see the folders table's self-referential
    // parent_id), so this is a flat COUNT(*), not just top-level rows.
    pub folder_count: i64,
    pub item_count: i64,
    // None when there are no folders/items yet, rather than a fake
    // {name: "", count: 0} entry -- lets the frontend show a clean "no
    // folders yet" state instead of a misleading zero-count row.
    pub most_used_folder: Option<FolderUsage>,
}

fn get_folder_stats(conn: &Connection) -> FolderStats {
    let folder_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM folders", [], |row| row.get(0))
        .unwrap_or(0);
    let item_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM folder_items", [], |row| row.get(0))
        .unwrap_or(0);
    let most_used_folder = conn
        .query_row(
            "SELECT f.name, COUNT(fi.id) as c
             FROM folders f JOIN folder_items fi ON fi.folder_id = f.id
             GROUP BY f.id
             ORDER BY c DESC, f.id ASC
             LIMIT 1",
            [],
            |row| Ok(FolderUsage { name: row.get(0)?, count: row.get(1)? }),
        )
        .ok();
    FolderStats { folder_count, item_count, most_used_folder }
}

#[derive(Serialize, Clone)]
pub struct DashboardStats {
    pub total_clips_saved: i64,
    pub transforms_run: i64,
    pub total_screenshots_saved: i64,
    // Total characters across every clip ever saved (see
    // bump_lifetime_by(..., "characters_captured", ...) at the clip-insert
    // site) -- tracked as its own running counter rather than derived from
    // clip_items, since that table gets trimmed on Free tier and this needs
    // to survive that, same reasoning as clips_saved/categories/daily_activity.
    pub total_characters_captured: i64,
    pub categories: Vec<CategoryCount>,
    // Last `days` calendar days, oldest first, zero-filled for days with no
    // activity so the frontend can render a fixed-width heatmap grid without
    // having to backfill gaps itself. Also what Dashboard.tsx derives
    // current streak, longest streak, this-week-vs-last-week, and busiest
    // weekday from client-side -- all four are just different reductions
    // over this same array, so none of them needed their own query here.
    pub daily_activity: Vec<DayCount>,
    // Top custom/builtin presets by click-through usage (see
    // preset_usage_counts), highest first. Empty until someone's actually
    // run a preset-triggered transform at least once.
    pub top_presets: Vec<PresetUsage>,
    pub folders: FolderStats,
}

/// Aggregates everything the Dashboard window needs in one call. `days`
/// controls how far back the heatmap goes (Dashboard.tsx currently asks for
/// 84 -- 12 weeks -- to match a GitHub-style contribution grid).
pub fn get_dashboard_stats(conn: &Connection, days: i64) -> DashboardStats {
    let total_clips_saved = get_lifetime(conn, "clips_saved");
    let transforms_run = get_lifetime(conn, "transforms_run");
    let total_screenshots_saved = get_lifetime(conn, "screenshots_saved");
    let total_characters_captured = get_lifetime(conn, "characters_captured");

    let mut categories = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT category, count FROM category_counters ORDER BY count DESC")
            .unwrap();
        let rows = stmt
            .query_map([], |row| {
                Ok(CategoryCount {
                    category: row.get(0)?,
                    count: row.get(1)?,
                })
            })
            .unwrap();
        categories.extend(rows.filter_map(|r| r.ok()));
    }

    // Zero-fill every day in the window first, then overlay real counts --
    // simpler than a SQL date-series generator and `days` is small (<=~365).
    let mut by_date: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    {
        let cutoff = (chrono::Local::now() - chrono::Duration::days(days)).format("%Y-%m-%d").to_string();
        let mut stmt = conn
            .prepare("SELECT date, count FROM daily_activity WHERE date >= ?1")
            .unwrap();
        let rows = stmt
            .query_map(params![cutoff], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .unwrap();
        for r in rows.filter_map(|r| r.ok()) {
            by_date.insert(r.0, r.1);
        }
    }

    let mut daily_activity = Vec::new();
    for i in (0..days).rev() {
        let date = (chrono::Local::now() - chrono::Duration::days(i))
            .format("%Y-%m-%d")
            .to_string();
        let count = by_date.get(&date).copied().unwrap_or(0);
        daily_activity.push(DayCount { date, count });
    }

    let mut top_presets = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT label, count FROM preset_usage_counts ORDER BY count DESC, label ASC LIMIT 8")
            .unwrap();
        let rows = stmt
            .query_map([], |row| Ok(PresetUsage { label: row.get(0)?, count: row.get(1)? }))
            .unwrap();
        top_presets.extend(rows.filter_map(|r| r.ok()));
    }

    let folders = get_folder_stats(conn);

    DashboardStats {
        total_clips_saved,
        transforms_run,
        total_screenshots_saved,
        total_characters_captured,
        categories,
        daily_activity,
        top_presets,
        folders,
    }
}

/// One-time pass run right after the `category` column is added, so
/// pre-existing clip_items get classified instead of sitting NULL forever.
fn backfill_categories(conn: &Connection) {
    let mut rows: Vec<(i64, String)> = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, content FROM clip_items WHERE category IS NULL")
            .unwrap();
        let mapped = stmt
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
            .unwrap();
        for r in mapped.filter_map(|r| r.ok()) {
            rows.push(r);
        }
    }
    for (id, content) in rows {
        let category = classify::classify(&content);
        conn.execute(
            "UPDATE clip_items SET category = ?1 WHERE id = ?2",
            params![category, id],
        )
        .ok();
    }
}

/// Free tier cap -- callers should check this before create_folder. Kept here
/// (rather than hardcoded in the UI) since it's a backend invariant.
pub const FREE_FOLDER_LIMIT: i64 = 3;

/// Pinning folders is Pro-only (gated in the command layer, not here) -- Free
/// already caps at 3 folders total, so pinning would be moot there. Even on
/// Pro it's capped at 3, same flat reasoning as clip-item pins.
pub const FOLDER_PIN_LIMIT: i64 = 3;

pub fn count_folders(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM folders", [], |row| row.get(0))
        .unwrap_or(0)
}

pub fn count_pinned_folders(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM folders WHERE pinned = 1", [], |row| {
        row.get(0)
    })
    .unwrap_or(0)
}

/// `parent_id` scopes the listing: `None` returns top-level folders only,
/// `Some(id)` returns the direct children of that folder. Subfolder support
/// (2026-07-19) reuses the same table/query shape rather than a separate
/// tree query, since a folder can only ever have one level of lookup done
/// at a time (the frontend calls this again each time it navigates deeper).
pub fn list_folders(conn: &Connection, parent_id: Option<i64>) -> Vec<Folder> {
    let sql = "SELECT f.id, f.name, f.created_at, f.pinned, f.parent_id,
                      (SELECT COUNT(*) FROM folder_items fi WHERE fi.folder_id = f.id) AS item_count,
                      (SELECT COUNT(*) FROM folders sf WHERE sf.parent_id = f.id) AS subfolder_count
               FROM folders f
               WHERE (?1 IS NULL AND f.parent_id IS NULL) OR f.parent_id = ?1
               ORDER BY f.pinned DESC, f.id ASC";
    let mut stmt = conn.prepare(sql).unwrap();
    let rows = stmt
        .query_map(params![parent_id], |row| {
            Ok(Folder {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                pinned: row.get::<_, i64>(3)? != 0,
                parent_id: row.get(4)?,
                item_count: row.get(5)?,
                subfolder_count: row.get(6)?,
            })
        })
        .unwrap();
    rows.filter_map(|r| r.ok()).collect()
}

/// Looks up a single folder by id regardless of nesting depth -- used when
/// jumping straight to a folder from elsewhere in the app (e.g. History's
/// "saved in" indicator), where the caller only has an id, not the full
/// ancestor path. Returns the same shape as list_folders' rows.
pub fn get_folder(conn: &Connection, id: i64) -> Option<Folder> {
    let sql = "SELECT f.id, f.name, f.created_at, f.pinned, f.parent_id,
                      (SELECT COUNT(*) FROM folder_items fi WHERE fi.folder_id = f.id) AS item_count,
                      (SELECT COUNT(*) FROM folders sf WHERE sf.parent_id = f.id) AS subfolder_count
               FROM folders f WHERE f.id = ?1";
    conn.query_row(sql, params![id], |row| {
        Ok(Folder {
            id: row.get(0)?,
            name: row.get(1)?,
            created_at: row.get(2)?,
            pinned: row.get::<_, i64>(3)? != 0,
            parent_id: row.get(4)?,
            item_count: row.get(5)?,
            subfolder_count: row.get(6)?,
        })
    })
    .ok()
}

pub fn create_folder(conn: &Connection, name: &str, parent_id: Option<i64>) -> i64 {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO folders (name, created_at, parent_id) VALUES (?1, ?2, ?3)",
        params![name, now, parent_id],
    )
    .ok();
    conn.last_insert_rowid()
}

/// Returns false (and leaves the row untouched) if pinning would exceed
/// FOLDER_PIN_LIMIT. Returns true otherwise, whether that was a pin or an
/// unpin. Tier check (Pro-only) happens in the command layer.
pub fn toggle_folder_pin(conn: &Connection, id: i64) -> bool {
    let currently_pinned: i64 = conn
        .query_row(
            "SELECT pinned FROM folders WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    if currently_pinned == 0 && count_pinned_folders(conn) >= FOLDER_PIN_LIMIT {
        return false;
    }

    conn.execute(
        "UPDATE folders SET pinned = 1 - pinned WHERE id = ?1",
        params![id],
    )
    .ok();
    true
}

/// Deletes a folder and everything in it. Subfolders (2026-07-19) aren't
/// tied to their parent via a real FK/CASCADE, so this recurses into child
/// folders first -- otherwise deleting a folder with subfolders would
/// orphan them (visible nowhere, but still sitting in the DB forever).
pub fn delete_folder(conn: &Connection, id: i64) {
    let child_ids: Vec<i64> = {
        let mut stmt = conn
            .prepare("SELECT id FROM folders WHERE parent_id = ?1")
            .unwrap();
        let rows = stmt.query_map(params![id], |row| row.get(0)).unwrap();
        rows.filter_map(|r| r.ok()).collect()
    };
    for child_id in child_ids {
        delete_folder(conn, child_id);
    }
    conn.execute("DELETE FROM folder_items WHERE folder_id = ?1", params![id])
        .ok();
    conn.execute("DELETE FROM folders WHERE id = ?1", params![id]).ok();
}

/// Persists a new item order within a folder after a drag-to-reorder (added
/// 2026-07-19) -- `ordered_ids` is the item ids in their new top-to-bottom
/// order, and each one's sort_order becomes its index. `folder_id` is used
/// as a belt-and-suspenders guard so a stale/tampered id list can't rewrite
/// sort_order for items outside the folder it claims to be reordering.
pub fn reorder_folder_items(conn: &Connection, folder_id: i64, ordered_ids: &[i64]) {
    for (i, id) in ordered_ids.iter().enumerate() {
        conn.execute(
            "UPDATE folder_items SET sort_order = ?1 WHERE id = ?2 AND folder_id = ?3",
            params![i as i64, id, folder_id],
        )
        .ok();
    }
}

pub fn list_folder_items(conn: &Connection, folder_id: i64) -> Vec<FolderItem> {
    // LEFT JOINed to screenshots so a screenshot-kind item's thumbnail comes
    // back in the same round-trip -- same reasoning as list_screenshots
    // inlining thumb_data_uri instead of making the frontend fetch it
    // separately per row. Ordered by the user's manual sort_order first
    // (added 2026-07-19 for drag-to-reorder), falling back to id DESC as a
    // tiebreak -- every pre-migration row defaults to the same sort_order,
    // so the tiebreak alone reproduces the old newest-first behavior for
    // folders nobody has manually reordered yet.
    let sql = "SELECT fi.id, fi.folder_id, fi.title, fi.content, fi.created_at,
                      fi.kind, fi.screenshot_id, s.thumb_path
               FROM folder_items fi
               LEFT JOIN screenshots s ON s.id = fi.screenshot_id
               WHERE fi.folder_id = ?1 ORDER BY fi.sort_order ASC, fi.id DESC";
    let mut stmt = conn.prepare(sql).unwrap();
    let rows = stmt
        .query_map(params![folder_id], |row| {
            let thumb_path: Option<String> = row.get(7)?;
            Ok(FolderItem {
                id: row.get(0)?,
                folder_id: row.get(1)?,
                title: row.get(2)?,
                content: row.get(3)?,
                created_at: row.get(4)?,
                kind: row.get(5)?,
                screenshot_id: row.get(6)?,
                thumb_data_uri: thumb_path.map(|p| read_as_data_uri(std::path::Path::new(&p))),
            })
        })
        .unwrap();
    rows.filter_map(|r| r.ok()).collect()
}

#[derive(Serialize, Clone)]
pub struct FolderMembership {
    pub content: String,
    pub folder_id: i64,
    pub folder_name: String,
}

/// Returns every (content, folder) pair across all *text* folder_items,
/// joined to the folder name. Used by the frontend to flag history rows
/// whose content is already saved somewhere -- folder_items has no FK back
/// to clip_items, only a content string copy, so this is a content-based
/// lookup. Screenshot-kind items are excluded (their content is always
/// empty) -- see list_screenshot_folder_memberships for their equivalent.
pub fn list_folder_memberships(conn: &Connection) -> Vec<FolderMembership> {
    let sql = "SELECT fi.content, fi.folder_id, f.name
               FROM folder_items fi
               JOIN folders f ON f.id = fi.folder_id
               WHERE fi.kind = 'text'";
    let mut stmt = conn.prepare(sql).unwrap();
    let rows = stmt
        .query_map([], |row| {
            Ok(FolderMembership {
                content: row.get(0)?,
                folder_id: row.get(1)?,
                folder_name: row.get(2)?,
            })
        })
        .unwrap();
    rows.filter_map(|r| r.ok()).collect()
}

/// The sort_order a newly-added item needs to land at the top of its
/// folder's manual order -- one less than the current lowest, so it sorts
/// before every existing item (list_folder_items orders sort_order ASC).
/// Matches the pre-reorder behavior where the most recently added item
/// always appeared first.
fn next_top_sort_order(conn: &Connection, folder_id: i64) -> i64 {
    let min: i64 = conn
        .query_row(
            "SELECT COALESCE(MIN(sort_order), 0) FROM folder_items WHERE folder_id = ?1",
            params![folder_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    min - 1
}

/// Inserts a text folder item -- `kind`/`screenshot_id` are left out of the
/// column list entirely so SQLite applies their column defaults ("text" /
/// NULL), same as every folder_item created before screenshots existed.
pub fn add_to_folder(conn: &Connection, folder_id: i64, content: &str, title: Option<&str>) -> i64 {
    let now = chrono::Local::now().to_rfc3339();
    let sort_order = next_top_sort_order(conn, folder_id);
    conn.execute(
        "INSERT INTO folder_items (folder_id, title, content, created_at, sort_order) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![folder_id, title, content, now, sort_order],
    )
    .ok();
    conn.last_insert_rowid()
}

/// Inserts a screenshot-kind folder item -- a reference to an existing row
/// in `screenshots`, not a copy of any image bytes (unlike text items, which
/// do copy the content string). `content` is stored empty since it's unused
/// for this kind; the frontend reads thumb_data_uri/screenshot_id instead.
pub fn add_screenshot_to_folder(
    conn: &Connection,
    folder_id: i64,
    screenshot_id: i64,
    title: Option<&str>,
) -> i64 {
    let now = chrono::Local::now().to_rfc3339();
    let sort_order = next_top_sort_order(conn, folder_id);
    conn.execute(
        "INSERT INTO folder_items (folder_id, title, content, created_at, kind, screenshot_id, sort_order)
         VALUES (?1, ?2, '', ?3, 'screenshot', ?4, ?5)",
        params![folder_id, title, now, screenshot_id, sort_order],
    )
    .ok();
    conn.last_insert_rowid()
}

/// Text-item edit -- both title and content. Only ever called for kind ==
/// "text"; screenshot-kind items have no editable content, see
/// update_folder_item_title below.
pub fn update_folder_item(conn: &Connection, id: i64, title: Option<&str>, content: &str) {
    conn.execute(
        "UPDATE folder_items SET title = ?1, content = ?2 WHERE id = ?3",
        params![title, content, id],
    )
    .ok();
}

/// Title-only edit, for screenshot-kind items -- there's no text content to
/// change, just the optional label.
pub fn update_folder_item_title(conn: &Connection, id: i64, title: Option<&str>) {
    conn.execute(
        "UPDATE folder_items SET title = ?1 WHERE id = ?2",
        params![title, id],
    )
    .ok();
}

pub fn delete_folder_item(conn: &Connection, id: i64) {
    conn.execute("DELETE FROM folder_items WHERE id = ?1", params![id]).ok();
}

pub fn get_folder_item_content(conn: &Connection, id: i64) -> Option<String> {
    conn.query_row(
        "SELECT content FROM folder_items WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .ok()
}

/// (kind, content, screenshot_id) for a folder item -- used by
/// paste_folder_item in main.rs to decide whether to paste plain text or
/// look up and paste the referenced screenshot's image.
pub fn get_folder_item_for_paste(conn: &Connection, id: i64) -> Option<(String, String, Option<i64>)> {
    conn.query_row(
        "SELECT kind, content, screenshot_id FROM folder_items WHERE id = ?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .ok()
}

#[derive(Serialize, Clone)]
pub struct ScreenshotFolderMembership {
    pub screenshot_id: i64,
    pub folder_id: i64,
    pub folder_name: String,
}

/// Same purpose as list_folder_memberships, but for screenshots -- content
/// has no meaning for a screenshot-kind item, so membership is keyed by
/// screenshot_id instead of a content string. Used by ScreenshotsPanel to
/// show its own "already saved in" indicator, the same way History rows use
/// list_folder_memberships.
pub fn list_screenshot_folder_memberships(conn: &Connection) -> Vec<ScreenshotFolderMembership> {
    let sql = "SELECT fi.screenshot_id, fi.folder_id, f.name
               FROM folder_items fi
               JOIN folders f ON f.id = fi.folder_id
               WHERE fi.kind = 'screenshot' AND fi.screenshot_id IS NOT NULL";
    let mut stmt = conn.prepare(sql).unwrap();
    let rows = stmt
        .query_map([], |row| {
            Ok(ScreenshotFolderMembership {
                screenshot_id: row.get(0)?,
                folder_id: row.get(1)?,
                folder_name: row.get(2)?,
            })
        })
        .unwrap();
    rows.filter_map(|r| r.ok()).collect()
}

pub fn delete_item(conn: &Connection, id: i64) {
    conn.execute("DELETE FROM clip_items WHERE id = ?1", params![id]).ok();
    prune_orphaned_embeddings(conn);
}

/// Insert a new clip, but don't duplicate if it's identical to the most
/// recent entry. Returns the new row's id so callers can kick off
/// downstream work keyed to it (right now: embedding it for semantic search,
/// see main.rs's watcher thread) -- returns None when the insert was skipped
/// as a duplicate, since there's nothing new to do in that case.
pub fn insert_if_new(conn: &Connection, content: &str) -> Option<i64> {
    let last: Option<String> = conn
        .query_row(
            "SELECT content FROM clip_items ORDER BY id DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .ok();

    if last.as_deref() == Some(content) {
        return None;
    }

    let now = chrono::Local::now().to_rfc3339();
    let category = classify::classify(content);
    // Bail out if the insert actually failed (e.g. SQLITE_TOOBIG on a huge
    // clip, or a disk error) instead of swallowing it with `.ok()`: every
    // line below assumes a new row exists. `last_insert_rowid()` returns the
    // *previous* successful insert's id on this connection, so returning
    // Some(id) here after a failure handed the watcher thread a live id
    // belonging to some other, unrelated clip -- which it then wrote this
    // clip's embedding against (see main.rs's embed-on-save), permanently
    // mismatching that row's semantic-search vector with its content. It
    // also inflated the Dashboard's lifetime/category/streak counters for a
    // clip that was never saved.
    if conn
        .execute(
            "INSERT INTO clip_items (content, pinned, created_at, category) VALUES (?1, 0, ?2, ?3)",
            params![content, now, category],
        )
        .is_err()
    {
        return None;
    }

    // Dashboard stats -- deliberately bumped here (not derived from
    // clip_items later), since clip_items gets trimmed on Free tier and
    // these need to survive that. See the "Dashboard stats" section in init().
    bump_lifetime(conn, "clips_saved");
    bump_lifetime_by(conn, "characters_captured", content.chars().count() as i64);
    bump_category_counter(conn, &category);
    bump_daily_activity(conn, &chrono::Local::now().format("%Y-%m-%d").to_string());

    Some(conn.last_insert_rowid())
}

pub fn trim_history(conn: &Connection, max_items: i64) {
    // Keep all pinned items, plus the most recent `max_items` unpinned ones.
    conn.execute(
        "DELETE FROM clip_items WHERE pinned = 0 AND id NOT IN (
            SELECT id FROM clip_items WHERE pinned = 0 ORDER BY id DESC LIMIT ?1
        )",
        params![max_items],
    )
    .ok();
    prune_orphaned_embeddings(conn);
}

/// Deletes unpinned items older than `days`. Pinned items are exempt, same
/// as the count-based trim_history above. `created_at` is stored as RFC3339
/// (chrono's `to_rfc3339`), which sorts correctly as plain text.
pub fn trim_history_by_age(conn: &Connection, days: i64) {
    let cutoff = (chrono::Local::now() - chrono::Duration::days(days)).to_rfc3339();
    conn.execute(
        "DELETE FROM clip_items WHERE pinned = 0 AND created_at < ?1",
        params![cutoff],
    )
    .ok();
    prune_orphaned_embeddings(conn);
}

// --- Semantic search (Pro-only) -----------------------------------------
//
// Embeddings are computed by the server (see server/index.js's /embed
// endpoint, which calls Voyage AI -- Anthropic has no embeddings API of its
// own) and stored here keyed by clip_item_id. Search itself never leaves the
// device: main.rs's semantic_search command embeds just the query string
// remotely, then this brute-force-scans every stored vector locally and
// ranks by cosine similarity. This runs *alongside*, not instead of, the
// substring search in `search` above -- see App.tsx for how the two result
// sets get merged.

/// Stores (or replaces) the embedding vector for a clip item.
pub fn save_embedding(conn: &Connection, clip_item_id: i64, vector: &[f32]) {
    let json = serde_json::to_string(vector).unwrap_or_default();
    conn.execute(
        "INSERT INTO embeddings (clip_item_id, vector) VALUES (?1, ?2)
         ON CONFLICT(clip_item_id) DO UPDATE SET vector = excluded.vector",
        params![clip_item_id, json],
    )
    .ok();
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a * norm_b)
}

/// Cosine-similarity search over every stored embedding. Returns (id, score)
/// pairs above `min_score`, best match first, capped at `limit` -- a
/// brute-force scan rather than an ANN index, which is plenty fast at the
/// history sizes this app deals with (hundreds to low thousands of rows).
pub fn semantic_search(
    conn: &Connection,
    query_vector: &[f32],
    limit: usize,
    min_score: f32,
) -> Vec<(i64, f32)> {
    let mut stmt = conn
        .prepare(
            "SELECT e.clip_item_id, e.vector FROM embeddings e
             JOIN clip_items c ON c.id = e.clip_item_id",
        )
        .unwrap();
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
        .unwrap();

    let mut scored: Vec<(i64, f32)> = Vec::new();
    for (id, json) in rows.filter_map(|r| r.ok()) {
        let Ok(vector) = serde_json::from_str::<Vec<f32>>(&json) else {
            continue;
        };
        let score = cosine_similarity(query_vector, &vector);
        if score >= min_score {
            scored.push((id, score));
        }
    }
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit);
    scored
}

/// (id, content) pairs for clip_items that don't have an embedding yet, most
/// recent first, capped at `limit`. Used for the one-time backfill that
/// fires when an account upgrades to Pro (see main.rs's
/// spawn_embedding_backfill) -- without it, semantic search would come up
/// empty for anyone who upgrades with existing history, since embed-on-save
/// only covers clips captured after upgrading.
pub fn clip_items_missing_embeddings(conn: &Connection, limit: i64) -> Vec<(i64, String)> {
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.content FROM clip_items c
             LEFT JOIN embeddings e ON e.clip_item_id = c.id
             WHERE e.clip_item_id IS NULL
             ORDER BY c.id DESC LIMIT ?1",
        )
        .unwrap();
    let rows = stmt
        .query_map(params![limit], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .unwrap();
    rows.filter_map(|r| r.ok()).collect()
}

/// Deletes any embedding rows whose clip_item no longer exists. Called right
/// after every clip_items deletion path (delete_item, trim_history,
/// trim_history_by_age) instead of relying on a real FK cascade, since this
/// connection doesn't have foreign-key enforcement turned on.
pub fn prune_orphaned_embeddings(conn: &Connection) {
    conn.execute(
        "DELETE FROM embeddings WHERE clip_item_id NOT IN (SELECT id FROM clip_items)",
        [],
    )
    .ok();
}

/// Free tier history cap per docs/free-vs-pro.md: 50 items or 7 days,
/// whichever comes first. Pinned items are exempt from both.
pub const FREE_HISTORY_LIMIT: i64 = 50;
pub const FREE_HISTORY_DAYS: i64 = 7;

/// Applies the Free-tier history cap (count + age). Pro is unlimited, so
/// this is a no-op for tier == "pro". Use this instead of calling
/// trim_history/trim_history_by_age directly once tier is known -- the old
/// user-editable `max_history` setting is no longer the source of truth.
pub fn trim_history_for_tier(conn: &Connection, tier: &str) {
    if tier == "pro" {
        return;
    }
    trim_history(conn, FREE_HISTORY_LIMIT);
    trim_history_by_age(conn, FREE_HISTORY_DAYS);
}

/// Same Free-tier cap as text history (see FREE_HISTORY_LIMIT/DAYS and
/// trim_history_for_tier above) -- 2026-08-01 Free/Pro split change made
/// capturing/viewing/pasting/pinning/filing screenshots free, matching text
/// history's own "capped on Free, unlimited on Pro" rule rather than either
/// leaving screenshots fully gated or fully uncapped. Kept as its own
/// function (not just calling trim_history with a different table name)
/// since screenshots need delete_screenshot's file/embedding/folder-item
/// cleanup on every row removed, not a plain DELETE.
pub fn trim_screenshots_for_tier(conn: &Connection, tier: &str) {
    if tier == "pro" {
        return;
    }
    trim_screenshots(conn, FREE_HISTORY_LIMIT);
    trim_screenshots_by_age(conn, FREE_HISTORY_DAYS);
}

fn trim_screenshots(conn: &Connection, max_items: i64) {
    let ids: Vec<i64> = {
        let mut stmt = conn
            .prepare(
                "SELECT id FROM screenshots WHERE pinned = 0 AND id NOT IN (
                    SELECT id FROM screenshots WHERE pinned = 0 ORDER BY id DESC LIMIT ?1
                )",
            )
            .unwrap();
        let rows = stmt.query_map(params![max_items], |row| row.get::<_, i64>(0)).unwrap();
        rows.filter_map(|r| r.ok()).collect()
    };
    for id in ids {
        delete_screenshot(conn, id);
    }
}

fn trim_screenshots_by_age(conn: &Connection, days: i64) {
    let cutoff = (chrono::Local::now() - chrono::Duration::days(days)).to_rfc3339();
    let ids: Vec<i64> = {
        let mut stmt = conn
            .prepare("SELECT id FROM screenshots WHERE pinned = 0 AND created_at < ?1")
            .unwrap();
        let rows = stmt.query_map(params![cutoff], |row| row.get::<_, i64>(0)).unwrap();
        rows.filter_map(|r| r.ok()).collect()
    };
    for id in ids {
        delete_screenshot(conn, id);
    }
}

/// `category` filters to an exact category (text/link/email/phone/address/
/// bank_account/date_time/price/code/ip_address/file_path) when Some, or
/// returns everything when None. `date_from`/`date_to` are inclusive RFC3339
/// bounds on `created_at` (string-comparable since it's always written via
/// chrono's `to_rfc3339`) -- pass start-of-day/end-of-day timestamps from the
/// caller for a calendar-day range. All three filters use the same
/// `?n IS NULL OR ...` pattern so one query handles every combination
/// without branching SQL strings. COALESCE treats legacy NULL category rows
/// (pre-migration, not yet backfilled in some edge case) as "text".
/// Free-tier search/browse result cap. This is a *result-set* limit (how
/// much of your own history a single search/filter call can return), not the
/// same thing as FREE_HISTORY_LIMIT (how much history is kept in storage at
/// all). Free never actually needs this -- FREE_HISTORY_LIMIT already caps
/// stored rows at 50 -- but `search` needs *some* limit passed in for every
/// caller, so this is what Free's caller passes. Pro passes -1 (see
/// `search`'s doc comment for why that means "no limit" to SQLite).
pub const FREE_SEARCH_LIMIT: i64 = 100;

/// Candidate pool size for the custom AI filter (filter_by_ai in main.rs),
/// same tier on both Free and Pro since this one isn't about local SQLite
/// query cost -- every candidate item gets sent to the AI server and billed
/// per token, so this bounds worst-case cost per call rather than result
/// completeness. Matches the server's own `items.length > 500` ceiling in
/// server/index.js's /filter-match handler, so raising this doesn't require
/// a server-side change up to 500 -- past that, server/index.js's guard
/// would also need to move.
pub const AI_FILTER_CANDIDATE_LIMIT: i64 = 500;

/// Plain keyword/category/date search over clip_items. `limit` bounds the
/// result set -- pass a positive number to cap it, or -1 for "no limit"
/// (SQLite treats a negative LIMIT as unbounded, so this doesn't need an
/// `Option`/branch here). Historically this had a hardcoded `LIMIT 200`
/// baked into the SQL regardless of tier, which meant a Pro user with an
/// uncapped (per FREE_HISTORY_LIMIT/trim_history_for_tier) history beyond
/// ~200 items would silently lose the ability to search/filter anything
/// older than the newest 200 rows. Callers now decide: main.rs's
/// `get_history` passes FREE_SEARCH_LIMIT on Free, -1 on Pro; `filter_by_ai`
/// passes its own separate, smaller cap (AI_FILTER_CANDIDATE_LIMIT below)
/// regardless of tier, since that one's candidate count directly drives AI
/// API cost per call, not just local SQLite query cost.
pub fn search(
    conn: &Connection,
    query: &str,
    category: Option<&str>,
    date_from: Option<&str>,
    date_to: Option<&str>,
    limit: i64,
) -> Vec<ClipItem> {
    let sql = "SELECT id, content, pinned, created_at, COALESCE(category, 'text') FROM clip_items
               WHERE content LIKE ?1 ESCAPE '\\' AND (?2 IS NULL OR COALESCE(category, 'text') = ?2)
               AND (?3 IS NULL OR created_at >= ?3) AND (?4 IS NULL OR created_at <= ?4)
               ORDER BY pinned DESC, id DESC
               LIMIT ?5";
    // Same escaping as search_screenshots. This used to just delete '%' from
    // the query and leave '_' alone, so searching for "user_id" silently
    // matched "userXid" too (and typing a '%' quietly searched for something
    // other than what was typed) -- both are plain substring searches from
    // the user's point of view, so LIKE's wildcards need escaping, not
    // stripping.
    let pattern = format!(
        "%{}%",
        query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let mut stmt = conn.prepare(sql).unwrap();
    let rows = stmt
        .query_map(params![pattern, category, date_from, date_to, limit], |row| {
            Ok(ClipItem {
                id: row.get(0)?,
                content: row.get(1)?,
                pinned: row.get::<_, i64>(2)? != 0,
                created_at: row.get(3)?,
                category: row.get(4)?,
            })
        })
        .unwrap();
    rows.filter_map(|r| r.ok()).collect()
}

pub fn get_content(conn: &Connection, id: i64) -> Option<String> {
    conn.query_row(
        "SELECT content FROM clip_items WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .ok()
}

/// Pins are capped at a flat 3 regardless of tier -- intentionally not a
/// free-vs-Pro lever (see docs/free-vs-pro.md). Unpinning is always allowed;
/// pinning a 4th item is refused until the caller frees up a slot.
pub const MAX_PINNED: i64 = 3;

pub fn count_pinned(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM clip_items WHERE pinned = 1",
        [],
        |row| row.get(0),
    )
    .unwrap_or(0)
}

/// Returns false (and leaves the row untouched) if pinning would exceed
/// MAX_PINNED. Returns true otherwise, whether that was a pin or an unpin.
pub fn toggle_pin(conn: &Connection, id: i64) -> bool {
    let currently_pinned: i64 = conn
        .query_row(
            "SELECT pinned FROM clip_items WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    if currently_pinned == 0 && count_pinned(conn) >= MAX_PINNED {
        return false;
    }

    conn.execute(
        "UPDATE clip_items SET pinned = 1 - pinned WHERE id = ?1",
        params![id],
    )
    .ok();
    true
}

// --- Screenshots (Pro-only) --------------------------------------------
//
// Kept as its own table and its own on-disk image folder rather than being
// folded into clip_items -- product decision was a dedicated "Screenshots"
// section, separate from the text history, not a mixed feed (see the
// classify.rs-based category system, which only ever makes sense for text).
// Every row stores a full-resolution PNG (used for pasting back) and a
// smaller thumbnail PNG (used for the list view) -- the row itself never
// holds raw image bytes, just paths into screenshots_dir().

pub const SCREENSHOT_PIN_LIMIT: i64 = 3;
// pub: also used by main.rs's ocr_uploaded_image to build a matching-size
// thumbnail for uploaded (not persisted) images, so the "From a screenshot"
// preview card looks the same size regardless of which path produced it.
pub const THUMBNAIL_MAX_WIDTH: u32 = 320;

#[derive(Serialize, Clone)]
pub struct ScreenshotItem {
    pub id: i64,
    pub width: i64,
    pub height: i64,
    pub pinned: bool,
    pub created_at: String,
    // Base64 PNG data URI, ready to drop straight into an <img src> -- sent
    // inline with list_screenshots so the frontend doesn't need a second
    // round-trip per thumbnail just to render the grid.
    pub thumb_data_uri: String,
    // Text recognized by local Windows OCR (see ocr.rs), filled in shortly
    // after capture by a background thread. None means "never OCR'd yet" --
    // once OCR actually runs, this is always Some, even if it's Some("")
    // (found nothing) -- see save_ocr_text/screenshots_missing_ocr, which
    // rely on that distinction to know what still needs (re)processing.
    // Sent inline (unlike the full-res image) since it's just text, not
    // worth a second round-trip -- powers keyword search, the AI Transform
    // action, and Smart search over screenshots.
    pub ocr_text: Option<String>,
}

fn read_as_data_uri(path: &std::path::Path) -> String {
    match std::fs::read(path) {
        Ok(bytes) => {
            let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
            format!("data:image/png;base64,{b64}")
        }
        Err(_) => String::new(),
    }
}

/// Encodes `rgba` (raw RGBA8 bytes from arboard::Clipboard::get_image(), as
/// captured by the watcher thread in main.rs) to PNG, writes both a
/// full-resolution copy and a downscaled thumbnail to screenshots_dir(),
/// and inserts the row. Returns the new row's id.
pub fn insert_screenshot(conn: &Connection, rgba: &[u8], width: u32, height: u32) -> Option<i64> {
    let img = image::RgbaImage::from_raw(width, height, rgba.to_vec())?;
    let dynamic = image::DynamicImage::ImageRgba8(img);

    let id_seed = chrono::Local::now().timestamp_millis();
    let dir = screenshots_dir();
    let full_path = dir.join(format!("{id_seed}.png"));
    let thumb_path = dir.join(format!("{id_seed}_thumb.png"));

    dynamic.save(&full_path).ok()?;

    let thumb = if width > THUMBNAIL_MAX_WIDTH {
        let ratio = THUMBNAIL_MAX_WIDTH as f64 / width as f64;
        let thumb_height = (height as f64 * ratio).round() as u32;
        dynamic.resize(THUMBNAIL_MAX_WIDTH, thumb_height.max(1), image::imageops::FilterType::Triangle)
    } else {
        dynamic
    };
    thumb.save(&thumb_path).ok()?;

    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO screenshots (file_path, thumb_path, width, height, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            full_path.to_string_lossy().to_string(),
            thumb_path.to_string_lossy().to_string(),
            width,
            height,
            now
        ],
    )
    .ok()?;

    // Same "survive trimming/deletion" reasoning as clips_saved in
    // insert_if_new -- screenshots has no trim cap today (Pro-only, and Pro
    // is unlimited everywhere else too), but the lifetime counter should
    // still reflect total-ever-saved, not current-row-count, for
    // consistency and in case a cap gets added later.
    bump_lifetime(conn, "screenshots_saved");

    Some(conn.last_insert_rowid())
}

pub fn list_screenshots(conn: &Connection) -> Vec<ScreenshotItem> {
    let sql = "SELECT id, file_path, thumb_path, width, height, pinned, created_at, ocr_text
               FROM screenshots ORDER BY pinned DESC, id DESC LIMIT 200";
    let mut stmt = conn.prepare(sql).unwrap();
    let rows = stmt
        .query_map([], |row| {
            let thumb_path: String = row.get(2)?;
            Ok(ScreenshotItem {
                id: row.get(0)?,
                width: row.get(3)?,
                height: row.get(4)?,
                pinned: row.get::<_, i64>(5)? != 0,
                created_at: row.get(6)?,
                thumb_data_uri: read_as_data_uri(std::path::Path::new(&thumb_path)),
                ocr_text: row.get(7)?,
            })
        })
        .unwrap();
    rows.filter_map(|r| r.ok()).collect()
}

/// Same shape as list_screenshots, but filtered to rows whose OCR'd text
/// contains `query` (case-insensitive substring match, same spirit as the
/// plain-text History search in `search` above). Free/instant/no API cost --
/// OCR text is extracted locally at capture time, so this is just a LIKE
/// query, not a network round-trip. Still capped at 200 and still
/// pinned-first, matching list_screenshots' own ordering.
pub fn search_screenshots(conn: &Connection, query: &str) -> Vec<ScreenshotItem> {
    let sql = "SELECT id, file_path, thumb_path, width, height, pinned, created_at, ocr_text
               FROM screenshots
               WHERE ocr_text IS NOT NULL AND ocr_text LIKE ?1 COLLATE NOCASE ESCAPE '\\'
               ORDER BY pinned DESC, id DESC LIMIT 200";
    // The backslash escapes below only mean anything to SQLite if the LIKE
    // declares an ESCAPE character (there's no default one) -- without the
    // clause above, searching for "user_id" built the pattern
    // "%user\_id%", which matches a literal backslash and therefore matched
    // nothing at all. The backslash itself has to be escaped first, or a
    // query containing one would escape whatever character followed it.
    let pattern = format!(
        "%{}%",
        query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let mut stmt = conn.prepare(sql).unwrap();
    let rows = stmt
        .query_map(params![pattern], |row| {
            let thumb_path: String = row.get(2)?;
            Ok(ScreenshotItem {
                id: row.get(0)?,
                width: row.get(3)?,
                height: row.get(4)?,
                pinned: row.get::<_, i64>(5)? != 0,
                created_at: row.get(6)?,
                thumb_data_uri: read_as_data_uri(std::path::Path::new(&thumb_path)),
                ocr_text: row.get(7)?,
            })
        })
        .unwrap();
    rows.filter_map(|r| r.ok()).collect()
}

/// Stores the OCR result for a screenshot -- called once, shortly after
/// capture, by the background OCR thread in main.rs. Empty strings are
/// normalized to NULL so "ran OCR, found nothing" and "same as before we had
/// OCR" both read the same way (screenshots_missing_embeddings and
/// search_screenshots both treat NULL/empty as "nothing to search").
pub fn save_ocr_text(conn: &Connection, screenshot_id: i64, text: &str) {
    conn.execute(
        "UPDATE screenshots SET ocr_text = ?1 WHERE id = ?2",
        params![text, screenshot_id],
    )
    .ok();
}

/// (id, file_path) pairs for screenshots that have never been through OCR at
/// all -- NULL specifically means "not processed yet" (see save_ocr_text's
/// doc comment above, and ScreenshotItem's own comment on ocr_text): once a
/// screenshot has been OCR'd, its ocr_text is always Some (an empty string
/// if nothing was found), so it never shows up here again and doesn't get
/// silently retried forever. Used by main.rs's backfill_screenshot_ocr,
/// which runs once whenever ScreenshotsPanel mounts -- OCR only ran
/// automatically on capture going forward from when this feature shipped,
/// so anything captured before that (or before a build that actually
/// compiled the OCR code) would otherwise sit unsearchable forever.
pub fn screenshots_missing_ocr(conn: &Connection, limit: i64) -> Vec<(i64, String)> {
    let mut stmt = conn
        .prepare(
            "SELECT id, file_path FROM screenshots
             WHERE ocr_text IS NULL
             ORDER BY id DESC LIMIT ?1",
        )
        .unwrap();
    let rows = stmt
        .query_map(params![limit], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .unwrap();
    rows.filter_map(|r| r.ok()).collect()
}

/// Returns the full-resolution file path for pasting -- the frontend never
/// sees this, it's read straight back into arboard::Clipboard::set_image()
/// in main.rs's paste_screenshot command.
pub fn get_screenshot_path(conn: &Connection, id: i64) -> Option<String> {
    conn.query_row(
        "SELECT file_path FROM screenshots WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .ok()
}

/// Full-resolution data URI for the "expand to preview" view -- deliberately
/// not sent as part of list_screenshots (that would mean shipping every
/// screenshot at full size on every panel open, which is fine for 2-3 items
/// but not for a couple hundred). Read on demand only when the user actually
/// opens the preview for one specific item.
pub fn get_screenshot_full_data_uri(conn: &Connection, id: i64) -> Option<String> {
    let path = get_screenshot_path(conn, id)?;
    Some(read_as_data_uri(std::path::Path::new(&path)))
}

pub fn count_pinned_screenshots(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM screenshots WHERE pinned = 1",
        [],
        |row| row.get(0),
    )
    .unwrap_or(0)
}

/// Same flat-cap-of-3 reasoning as clip-item and folder pins elsewhere --
/// see MAX_PINNED and FOLDER_PIN_LIMIT.
pub fn toggle_screenshot_pin(conn: &Connection, id: i64) -> bool {
    let currently_pinned: i64 = conn
        .query_row(
            "SELECT pinned FROM screenshots WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    if currently_pinned == 0 && count_pinned_screenshots(conn) >= SCREENSHOT_PIN_LIMIT {
        return false;
    }

    conn.execute(
        "UPDATE screenshots SET pinned = 1 - pinned WHERE id = ?1",
        params![id],
    )
    .ok();
    true
}

/// Deletes both the row and its on-disk files. Missing files (already
/// cleaned up some other way) are ignored rather than treated as errors.
/// Also removes any folder_items that reference this screenshot -- unlike
/// text items (which copy the content string, so the original clip can be
/// deleted independently), a screenshot folder item is just a reference, so
/// deleting the source screenshot removes it from any folders it was in too
/// rather than leaving a dangling, broken tile behind.
pub fn delete_screenshot(conn: &Connection, id: i64) {
    if let Some(path) = get_screenshot_path(conn, id) {
        std::fs::remove_file(&path).ok();
        let thumb = path.replace(".png", "_thumb.png");
        std::fs::remove_file(&thumb).ok();
    }
    conn.execute(
        "DELETE FROM folder_items WHERE kind = 'screenshot' AND screenshot_id = ?1",
        params![id],
    )
    .ok();
    conn.execute(
        "DELETE FROM screenshot_embeddings WHERE screenshot_id = ?1",
        params![id],
    )
    .ok();
    conn.execute("DELETE FROM screenshots WHERE id = ?1", params![id]).ok();
}

// --- Screenshot semantic search (Pro-only, on-demand embeddings) --------
//
// Mirrors the clip_items embeddings section above almost exactly (same
// cosine-similarity brute-force scan, same JSON-array-in-a-TEXT-column
// storage), with one deliberate difference: clip embeddings are computed
// eagerly, the moment a clip is saved (see main.rs's watcher thread), but
// screenshot embeddings are computed lazily, the first time a Smart search
// actually runs (see main.rs::semantic_search_screenshots) -- see
// screenshot_embeddings' table comment in init() for why.

/// Stores (or replaces) the embedding vector for a screenshot's OCR'd text.
pub fn save_screenshot_embedding(conn: &Connection, screenshot_id: i64, vector: &[f32]) {
    let json = serde_json::to_string(vector).unwrap_or_default();
    conn.execute(
        "INSERT INTO screenshot_embeddings (screenshot_id, vector) VALUES (?1, ?2)
         ON CONFLICT(screenshot_id) DO UPDATE SET vector = excluded.vector",
        params![screenshot_id, json],
    )
    .ok();
}

/// (id, ocr_text) pairs for screenshots that have OCR'd text but no embedding
/// yet, most recent first, capped at `limit`. Called at the top of every
/// semantic_search_screenshots run to "catch up" any screenshots captured
/// since the last search -- see the section comment above for why this is
/// on-demand rather than automatic-on-capture.
pub fn screenshots_missing_embeddings(conn: &Connection, limit: i64) -> Vec<(i64, String)> {
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.ocr_text FROM screenshots s
             LEFT JOIN screenshot_embeddings e ON e.screenshot_id = s.id
             WHERE e.screenshot_id IS NULL
               AND s.ocr_text IS NOT NULL AND s.ocr_text != ''
             ORDER BY s.id DESC LIMIT ?1",
        )
        .unwrap();
    let rows = stmt
        .query_map(params![limit], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .unwrap();
    rows.filter_map(|r| r.ok()).collect()
}

/// Cosine-similarity search over every stored screenshot embedding, joined
/// back to the full ScreenshotItem so the frontend gets everything it needs
/// (thumbnail, dimensions, etc.) in one round-trip -- unlike the clip_items
/// version, which only returns ids for App.tsx to resolve against items it
/// already has loaded, ScreenshotsPanel doesn't necessarily have every
/// matching screenshot loaded already (list_screenshots caps at 200), so
/// resolving server-side avoids a "found it, but can't show it" gap.
pub fn semantic_search_screenshots(
    conn: &Connection,
    query_vector: &[f32],
    limit: usize,
    min_score: f32,
) -> Vec<(ScreenshotItem, f32)> {
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.file_path, s.thumb_path, s.width, s.height, s.pinned,
                    s.created_at, s.ocr_text, e.vector
             FROM screenshot_embeddings e
             JOIN screenshots s ON s.id = e.screenshot_id",
        )
        .unwrap();
    let rows = stmt
        .query_map([], |row| {
            let thumb_path: String = row.get(2)?;
            let item = ScreenshotItem {
                id: row.get(0)?,
                width: row.get(3)?,
                height: row.get(4)?,
                pinned: row.get::<_, i64>(5)? != 0,
                created_at: row.get(6)?,
                thumb_data_uri: read_as_data_uri(std::path::Path::new(&thumb_path)),
                ocr_text: row.get(7)?,
            };
            let vector_json: String = row.get(8)?;
            Ok((item, vector_json))
        })
        .unwrap();

    let mut scored: Vec<(ScreenshotItem, f32)> = Vec::new();
    for (item, json) in rows.filter_map(|r| r.ok()) {
        let Ok(vector) = serde_json::from_str::<Vec<f32>>(&json) else {
            continue;
        };
        let score = cosine_similarity(query_vector, &vector);
        if score >= min_score {
            scored.push((item, score));
        }
    }
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit);
    scored
}

// --- AI Transform tab: recent-runs log --------------------------------
// See the comment on the transform_log table in init() above for why this
// exists and why it's capped/trimmed rather than kept forever.

pub const TRANSFORM_LOG_LIMIT: i64 = 50;

#[derive(Serialize, Clone)]
pub struct TransformLogEntry {
    pub id: i64,
    pub input: String,
    pub instruction: String,
    pub output: String,
    pub created_at: String,
    // Set only when this run came from clicking an actual preset button
    // (builtin or custom) -- see the preset_label migration's doc comment
    // above. The frontend falls back to `instruction` for display when this
    // is None, which is correct for freeform runs and pre-migration rows
    // alike.
    pub preset_label: Option<String>,
}

/// Records one completed transform run and trims the log back down to
/// TRANSFORM_LOG_LIMIT rows. Called after a successful transform_clip call
/// from the standalone Transform tab specifically -- not from the
/// per-item TransformBar (History/Folders rows), which is a "fix this one
/// clip in place" action rather than something you'd browse back through.
pub fn log_transform(
    conn: &Connection,
    input: &str,
    instruction: &str,
    output: &str,
    preset_label: Option<&str>,
) -> i64 {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO transform_log (input, instruction, output, created_at, preset_label) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![input, instruction, output, now, preset_label],
    )
    // `.ok()` rather than `.expect()`, matching every other insert in this
    // file: input/output here are arbitrary user/model text, and a failed
    // insert (e.g. SQLITE_TOOBIG on a very large transform) used to panic
    // inside the log_transform command while holding the connection mutex,
    // which poisons it and takes down every later `conn.lock().unwrap()` in
    // the app. The returned id is only used as a local handle and isn't read
    // by the frontend.
    .ok();
    let id = conn.last_insert_rowid();

    conn.execute(
        "DELETE FROM transform_log WHERE id NOT IN (
            SELECT id FROM transform_log ORDER BY id DESC LIMIT ?1
        )",
        params![TRANSFORM_LOG_LIMIT],
    )
    .ok();

    id
}

pub fn get_transform_log(conn: &Connection) -> Vec<TransformLogEntry> {
    let mut stmt = conn
        .prepare(
            "SELECT id, input, instruction, output, created_at, preset_label
             FROM transform_log ORDER BY id DESC LIMIT ?1",
        )
        .expect("failed to prepare transform_log query");
    let rows = stmt
        .query_map(params![TRANSFORM_LOG_LIMIT], |row| {
            Ok(TransformLogEntry {
                id: row.get(0)?,
                input: row.get(1)?,
                instruction: row.get(2)?,
                output: row.get(3)?,
                created_at: row.get(4)?,
                preset_label: row.get(5)?,
            })
        })
        .expect("failed to query transform_log");
    rows.filter_map(Result::ok).collect()
}

pub fn delete_transform_log_entry(conn: &Connection, id: i64) {
    conn.execute("DELETE FROM transform_log WHERE id = ?1", params![id]).ok();
}

pub fn clear_transform_log(conn: &Connection) {
    conn.execute("DELETE FROM transform_log", []).ok();
}
