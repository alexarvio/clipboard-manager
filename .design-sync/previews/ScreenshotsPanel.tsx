import { ScreenshotsPanel, __setMockTier } from "clipboard-manager";

// The panel itself renders the same grid regardless of the `tier` prop
// today (screenshots are viewable on both tiers; only Smart search and the
// Transform paywall toast are tier-gated, and those are interaction-only,
// not visible from a static prop). What DOES matter for a populated preview
// is the shared mock backend's own tier check on list_screenshots — see
// __setMockTier's doc comment in src/lib/tauriShim.ts. Set once here since
// every story below shares this page's module state (grid mode mounts every
// export on the same page), so per-story tier variance isn't meaningful —
// this makes every cell able to actually fetch mock screenshots.
__setMockTier("pro");

export function Populated() {
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

// A genuinely different, honestly-reachable render state: with a non-empty
// `query` and the default "text" search mode, a result set with no matches
// renders the "No screenshots match ..." message instead of the grid.
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
