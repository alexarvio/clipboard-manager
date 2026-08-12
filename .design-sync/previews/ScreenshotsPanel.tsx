import { ScreenshotsPanel } from "clipboard-manager";

// NOTE on tier and mock data (see .design-sync/NOTES.md's "Known preview limitations"): a
// __setMockTier bundle export was tried (via cfg.extraEntries) so these stories could force the
// shared mock's list_screenshots call to succeed, but extraEntries broke the whole bundle's
// component namespace (window.ClipboardManager ended up with ONLY the extraEntries' exports,
// none of the 12 real components -- caught via a manual browser check, 2026-08-12) and was
// reverted. Without it, ScreenshotsPanel's own `list_screenshots` call is gated, in
// src/lib/tauriShim.ts's mockInvoke, by the *shared, module-level* mock `settings.tier`
// (hardcoded to "free") -- not by the `tier` prop passed to this component. Passing tier="pro"
// below does NOT make the mock's list_screenshots call succeed, so both stories render the same
// empty-grid state rather than a populated one -- a pre-existing tauriShim limitation, not a bug
// in these story files.
//
// Also worth noting: the doc comment at the top of ScreenshotsPanel.tsx (and this component's
// prop-contract description) describe Free tier as showing "a locked upsell card instead of the
// real grid" -- but the component's actual current render logic (see its own later comment,
// ~line 279: "Screenshots itself is free on both tiers now") has no such branch. Free and Pro
// render identically today except for the Smart-search effect and the Transform button's
// paywall toast (both interaction-gated, not visible from a static tier prop alone).

export function Pro() {
  return (
    <ScreenshotsPanel
      tier="pro"
      onPasted={() => {}}
      onOpenFolder={() => {}}
      onCreateNewFolder={() => {}}
      onTransformItem={() => {}}
    />
  );
}

export function Free() {
  return (
    <ScreenshotsPanel
      tier="free"
      onPasted={() => {}}
      onOpenFolder={() => {}}
      onCreateNewFolder={() => {}}
      onTransformItem={() => {}}
    />
  );
}

// A genuinely different, honestly-reachable render state (not dependent on the tier gap
// above): with a non-empty `query` and the default "text" search mode, an empty result
// set renders the "No screenshots match ..." message instead of the generic empty state.
export function NoSearchMatches() {
  return (
    <ScreenshotsPanel
      tier="pro"
      query="passport photo"
      onPasted={() => {}}
      onOpenFolder={() => {}}
      onCreateNewFolder={() => {}}
      onTransformItem={() => {}}
    />
  );
}
