import { ConfirmPopover } from "clipboard-manager";

export function DeletePreset() {
  return (
    <ConfirmPopover
      position={{ top: 24, left: 24 }}
      message='Delete preset "Summarize"?'
      onConfirm={() => {}}
      onCancel={() => {}}
    />
  );
}

export function CustomLabel() {
  return (
    <ConfirmPopover
      position={{ top: 24, left: 24 }}
      message="Remove this folder and everything in it? This can't be undone."
      confirmLabel="Remove folder"
      onConfirm={() => {}}
      onCancel={() => {}}
    />
  );
}
