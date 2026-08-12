import { FolderPicker } from "clipboard-manager";

export function Fresh() {
  return (
    <FolderPicker
      position={{ top: 40, left: 40 }}
      savedIn={[]}
      onClose={() => {}}
      onAdd={() => {}}
      onOpenFolder={() => {}}
      onCreateNewFolder={() => {}}
    />
  );
}

export function AlreadySaved() {
  return (
    <FolderPicker
      position={{ top: 40, left: 40 }}
      savedIn={[{ id: 1, name: "Email templates" }]}
      onClose={() => {}}
      onAdd={() => {}}
      onOpenFolder={() => {}}
      onCreateNewFolder={() => {}}
    />
  );
}

export function SavedInMultiple() {
  return (
    <FolderPicker
      position={{ top: 40, left: 40 }}
      savedIn={[
        { id: 1, name: "Email templates" },
        { id: 3, name: "Snippets" },
      ]}
      onClose={() => {}}
      onAdd={() => {}}
      onOpenFolder={() => {}}
      onCreateNewFolder={() => {}}
    />
  );
}
