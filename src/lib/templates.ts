// Snippet templates: a folder item can contain {{placeholder}} markers (e.g.
// "Hi {{name}}, following up on {{topic}}") that get filled in right before
// pasting instead of being pasted as literal text. Detection is automatic --
// there's no separate "make this a template" toggle in the UI. Any folder
// item whose content matches this pattern is treated as one (see
// FoldersPanel.tsx's pasteItem, which checks this before deciding whether to
// paste immediately or show the fill-in screen first).
const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

// Unique placeholder names, in first-appearance order, so the fill-in form's
// fields read in the same order they'll appear in the pasted text. A name
// used twice (e.g. {{name}} in both a greeting and a sign-off) only produces
// one field -- fillTemplate below fills every occurrence with that one answer.
export function extractPlaceholders(content: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const match of content.matchAll(PLACEHOLDER_RE)) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      ordered.push(name);
    }
  }
  return ordered;
}

// Substitutes every {{name}} with values[name]. A placeholder with no
// matching value (shouldn't normally happen, since the form is built from
// extractPlaceholders on the same content) is left as literal text rather
// than silently dropped, so a bug here fails visibly instead of pasting
// something subtly wrong.
export function fillTemplate(content: string, values: Record<string, string>): string {
  return content.replace(PLACEHOLDER_RE, (whole, name) => values[name] ?? whole);
}

// Turns a text selection into a {{placeholder}} marker (2026-07-21) --
// backs the "Placeholder" button next to snippet content textareas, so
// making a template doesn't mean hand-typing the {{ }} syntax. If nothing's
// selected, inserts a fresh {{placeholder}} at the cursor instead, with
// "placeholder" itself selected afterward so typing immediately renames it.
// Multi-word selections ("your name") get spaces/punctuation collapsed into
// underscores ("your_name") since PLACEHOLDER_RE above only matches \w+ --
// wrapping a phrase with a space in braces as-is would silently fail to
// ever be recognized as a placeholder.
export function insertPlaceholder(
  value: string,
  selectionStart: number,
  selectionEnd: number
): { text: string; cursorStart: number; cursorEnd: number } {
  const selected = value.slice(selectionStart, selectionEnd);
  let name = selected
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\w]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!name) name = "placeholder";

  const marker = `{{${name}}}`;
  const text = value.slice(0, selectionStart) + marker + value.slice(selectionEnd);
  const cursorStart = selectionStart + 2; // past the opening "{{"
  const cursorEnd = cursorStart + name.length;
  return { text, cursorStart, cursorEnd };
}

// Remembers the last values typed for a given template item, keyed by its
// folder-item id, so re-sending a similar snippet doesn't mean retyping the
// same name every time. This is the real desktop app (not a sandboxed chat
// artifact), so plain localStorage is fine here -- it's just a small
// per-device convenience cache, not anything that needs to sync or persist
// authoritatively (that's what the SQLite-backed folder item itself is for).
const STORAGE_PREFIX = "clip:template-values:";

export function loadLastValues(itemId: number): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + itemId);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveLastValues(itemId: number, values: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + itemId, JSON.stringify(values));
  } catch {
    // Storage disabled/full, etc. -- not worth failing the paste over.
  }
}
