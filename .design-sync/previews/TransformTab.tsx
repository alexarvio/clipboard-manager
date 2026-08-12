import { TransformTab } from "clipboard-manager";

// Tiny inline SVG data URI standing in for a real captured-screenshot
// thumbnail, same idea as tauriShim.ts's own fakeThumb() helper -- there's
// no real screenshot behind this preview, just a placeholder sized/colored
// to look plausible in the "From a screenshot" preview card.
function fakeThumb(bg: string, label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="100%" height="100%" fill="${bg}"/><text x="50%" y="50%" font-family="sans-serif" font-size="20" fill="white" text-anchor="middle" dominant-baseline="middle">${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// tier "free" short-circuits to a locked upsell screen before any of the
// Input/Instruction/Output UI (or its data fetches) ever mount -- the one
// variant here guaranteed not to hit the tauriShim gap noted below.
export function FreeLocked() {
  return (
    <TransformTab
      tier="free"
      onManagePresets={() => {}}
      onOpenFolder={() => {}}
      onCreateNewFolder={() => {}}
    />
  );
}

// Fresh, empty tab -- as if someone opened Transform directly rather than
// arriving via a "Transform" action elsewhere. pendingInput is null, so
// Input starts blank for the user to paste their own text into.
export function ProFreshInput() {
  return (
    <TransformTab
      tier="pro"
      pendingInput={null}
      onManagePresets={() => {}}
      onOpenFolder={() => {}}
      onCreateNewFolder={() => {}}
      onConsumedPendingInput={() => {}}
    />
  );
}

// Hand-off from clicking "Transform" on an existing History/Folders clip
// (see App.tsx's goToTransform) -- Input arrives pre-filled with the
// clicked item's content and a fresh `seed` so the effect re-applies even
// if the exact same item is sent again later.
export function ProHandoffFromClip() {
  return (
    <TransformTab
      tier="pro"
      pendingInput={{
        content:
          "Hi team, quick update on the Q3 rollout -- we're on track for the Sept 15 launch, pending final QA sign-off from the mobile squad. Let me know if you need anything from my side before then.",
        seed: Date.now(),
      }}
      onManagePresets={() => {}}
      onOpenFolder={() => {}}
      onCreateNewFolder={() => {}}
      onConsumedPendingInput={() => {}}
    />
  );
}

// Hand-off from a screenshot's OCR'd text (see ScreenshotsPanel's own
// onTransformItem) -- sourceImage renders the "From a screenshot" preview
// card above Input, linking the OCR'd text back to where it came from.
export function ProHandoffFromScreenshot() {
  return (
    <TransformTab
      tier="pro"
      pendingInput={{
        content:
          "Q3 revenue grew 18% year over year, driven primarily by expansion in the mid-market segment. Churn held steady at 2.1%, in line with guidance.",
        seed: Date.now(),
        sourceImage: {
          thumb_data_uri: fakeThumb("#6B46C1", "Screenshot"),
          width: 1920,
          height: 1080,
          screenshot_id: 2,
        },
      }}
      onManagePresets={() => {}}
      onOpenFolder={() => {}}
      onCreateNewFolder={() => {}}
      onConsumedPendingInput={() => {}}
    />
  );
}
