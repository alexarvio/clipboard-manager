import { FoldersPanel } from "clipboard-manager";

// Mock data (see src/lib/tauriShim.ts): three top-level folders --
// id 1 "Email templates" (2 items, pinned, has {{placeholder}} templates),
// id 2 "Brand colors" (3 items, plain hex-code snippets),
// id 3 "Snippets" (1 item) -- which is also exactly FREE_FOLDER_LIMIT (3),
// so the free-tier root list naturally demos the "at limit" upsell card
// with zero extra setup.

export function RootListFree() {
  return (
    <FoldersPanel
      tier="free"
      onPasted={() => {}}
      onStartPasteQueue={() => {}}
      onTransformItem={() => {}}
      onMembershipsChanged={() => {}}
    />
  );
}

export function RootListPro() {
  return (
    <FoldersPanel
      tier="pro"
      onPasted={() => {}}
      onStartPasteQueue={() => {}}
      onTransformItem={() => {}}
      onMembershipsChanged={() => {}}
    />
  );
}

// Drills straight into "Brand colors" (mock folder id 2) via openFolderId --
// shows the folder-detail item list (three color-swatch text items), the
// Stack/New folder/New item action row, and (tier "pro") the unlocked
// sparkle "Transform with AI" icon on each text item's row-action cluster.
export function FolderDetailBrandColors() {
  return (
    <FoldersPanel
      tier="pro"
      openFolderId={2}
      onOpenedFolder={() => {}}
      onPasted={() => {}}
      onStartPasteQueue={() => {}}
      onTransformItem={() => {}}
      onMembershipsChanged={() => {}}
    />
  );
}

// Drills into "Email templates" (mock folder id 1), whose two items contain
// {{placeholder}} markers -- demos the small "template" writing-icon badge
// next to an item's title, and (tier "free") the locked/gray AI-transform
// icon instead of the Pro sparkle.
export function FolderDetailEmailTemplates() {
  return (
    <FoldersPanel
      tier="free"
      openFolderId={1}
      onOpenedFolder={() => {}}
      onPasted={() => {}}
      onStartPasteQueue={() => {}}
      onTransformItem={() => {}}
      onMembershipsChanged={() => {}}
    />
  );
}

// startCreating opens the inline "new folder" name input on the root list
// immediately, as if the History tab's "New folder" option inside its
// Add-to-folder picker had just handed off here.
export function NewFolderInline() {
  return (
    <FoldersPanel
      tier="free"
      startCreating
      onStartedCreating={() => {}}
      onPasted={() => {}}
      onStartPasteQueue={() => {}}
      onTransformItem={() => {}}
      onMembershipsChanged={() => {}}
    />
  );
}
