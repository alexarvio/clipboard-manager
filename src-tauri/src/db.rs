use crate::classify;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize, Clone)]
pub struct ClipItem {
    pub id: i64,
    pub content: String,
    pub pinned: bool,
    pub created_at: String,
    // Auto-detected category (text/link/email/phone/address/bank_account),
    // used by the Pro-only history filter. COALESCE'd to "text" in SELECTs
    // so legacy rows from before this column existed don't come back NULL.
    pub category: String,
}

pub fn db_path() -> PathBuf {
    let mut dir = dirs::config_dir().expect("no config dir");
    dir.push("clip");
    std::fs::create_dir_all(&dir).ok();
    dir.push("history.sqlite");
    dir
}

#[derive(Serialize, Clone)]
pub struct Folder {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    pub item_count: i64,
    pub pinned: bool,
}

#[derive(Serialize, Clone)]
pub struct FolderItem {
    pub id: i64,
    pub folder_id: i64,
    pub title: Option<String>,
    pub content: String,
    pub created_at: String,
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

pub fn list_folders(conn: &Connection) -> Vec<Folder> {
    let sql = "SELECT f.id, f.name, f.created_at, COUNT(fi.id) as item_count, f.pinned
               FROM folders f
               LEFT JOIN folder_items fi ON fi.folder_id = f.id
               GROUP BY f.id
               ORDER BY f.pinned DESC, f.id ASC";
    let mut stmt = conn.prepare(sql).unwrap();
    let rows = stmt
        .query_map([], |row| {
            Ok(Folder {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                item_count: row.get(3)?,
                pinned: row.get::<_, i64>(4)? != 0,
            })
        })
        .unwrap();
    rows.filter_map(|r| r.ok()).collect()
}

pub fn create_folder(conn: &Connection, name: &str) -> i64 {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO folders (name, created_at) VALUES (?1, ?2)",
        params![name, now],
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

pub fn delete_folder(conn: &Connection, id: i64) {
    conn.execute("DELETE FROM folder_items WHERE folder_id = ?1", params![id])
        .ok();
    conn.execute("DELETE FROM folders WHERE id = ?1", params![id]).ok();
}

pub fn list_folder_items(conn: &Connection, folder_id: i64) -> Vec<FolderItem> {
    let sql = "SELECT id, folder_id, title, content, created_at FROM folder_items
               WHERE folder_id = ?1 ORDER BY id DESC";
    let mut stmt = conn.prepare(sql).unwrap();
    let rows = stmt
        .query_map(params![folder_id], |row| {
            Ok(FolderItem {
                id: row.get(0)?,
                folder_id: row.get(1)?,
                title: row.get(2)?,
                content: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .unwrap();
    rows.filter_map(|r| r.ok()).collect()
}

pub fn add_to_folder(conn: &Connection, folder_id: i64, content: &str, title: Option<&str>) -> i64 {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO folder_items (folder_id, title, content, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![folder_id, title, content, now],
    )
    .ok();
    conn.last_insert_rowid()
}

pub fn update_folder_item(conn: &Connection, id: i64, title: Option<&str>, content: &str) {
    conn.execute(
        "UPDATE folder_items SET title = ?1, content = ?2 WHERE id = ?3",
        params![title, content, id],
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

/// Insert a new clip, but don't duplicate if it's identical to the most recent entry.
pub fn insert_if_new(conn: &Connection, content: &str) {
    let last: Option<String> = conn
        .query_row(
            "SELECT content FROM clip_items ORDER BY id DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .ok();

    if last.as_deref() == Some(content) {
        return;
    }

    let now = chrono::Local::now().to_rfc3339();
    let category = classify::classify(content);
    conn.execute(
        "INSERT INTO clip_items (content, pinned, created_at, category) VALUES (?1, 0, ?2, ?3)",
        params![content, now, category],
    )
    .ok();
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

/// `category` filters to an exact category (text/link/email/phone/address/
/// bank_account) when Some, or returns everything when None. The
/// `?2 IS NULL OR ... = ?2` pattern lets one query handle both cases without
/// branching SQL strings. COALESCE treats legacy NULL rows (pre-migration,
/// not yet backfilled in some edge case) as "text".
pub fn search(conn: &Connection, query: &str, category: Option<&str>) -> Vec<ClipItem> {
    let sql = "SELECT id, content, pinned, created_at, COALESCE(category, 'text') FROM clip_items
               WHERE content LIKE ?1 AND (?2 IS NULL OR COALESCE(category, 'text') = ?2)
               ORDER BY pinned DESC, id DESC
               LIMIT 200";
    let pattern = format!("%{}%", query.replace('%', ""));
    let mut stmt = conn.prepare(sql).unwrap();
    let rows = stmt
        .query_map(params![pattern, category], |row| {
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
