// Clamps a computed { top, left } dropdown/popover position so it always
// stays fully on-screen. These menus (FolderPicker, the row "..." menu,
// category/date filter dropdowns) are portaled straight to document.body
// with position: fixed and anchored off getBoundingClientRect() of a small
// icon button -- often inside a narrow grid column (e.g. ScreenshotsPanel's
// 2-column tile grid) or near the edge of the window. Nothing about
// position: fixed + a portal saves them from rendering partially off-screen
// if that raw anchor math runs past the window bounds, so every caller
// should route its computed position through this before setting state.
export function clampMenuPosition(
  top: number,
  left: number,
  width: number,
  height = 240,
  margin = 8
): { top: number; left: number } {
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const maxTop = Math.max(margin, window.innerHeight - height - margin);
  return {
    top: Math.min(Math.max(top, margin), maxTop),
    left: Math.min(Math.max(left, margin), maxLeft),
  };
}
