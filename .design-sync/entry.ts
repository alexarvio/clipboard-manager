// Real entry for the design-sync converter. Every component in src/components/
// uses `export default function Name(...)`, and ES module `export *` never
// forwards a default export -- the converter's synth-entry fallback
// (`export * from "<file>.tsx"` for every matching src file) silently
// produces zero actual bindings for any of them. Explicit named re-exports
// here sidestep that entirely. See .design-sync/NOTES.md.
export { default as AuthGate } from "../src/components/AuthGate";
export { default as ClampedText } from "../src/components/ClampedText";
export { default as ConfirmPopover } from "../src/components/ConfirmPopover";
export { default as Dashboard } from "../src/components/Dashboard";
export { default as FolderPicker } from "../src/components/FolderPicker";
export { default as FoldersPanel } from "../src/components/FoldersPanel";
export { default as Onboarding } from "../src/components/Onboarding";
export { default as PasteQueue } from "../src/components/PasteQueue";
export { default as ScreenshotsPanel } from "../src/components/ScreenshotsPanel";
export { default as SettingsPanel } from "../src/components/SettingsPanel";
export { default as TransformBar } from "../src/components/TransformBar";
export { default as TransformTab } from "../src/components/TransformTab";
