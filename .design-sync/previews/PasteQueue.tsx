import { PasteQueue } from "clipboard-manager";

const items = [
  { id: 1, content: "https://stripe.com/docs/api" },
  { id: 2, content: "alex@clipapp.io" },
  { id: 3, content: "Thanks for the quick turnaround — really appreciate you prioritizing this and getting it out the door ahead of schedule." },
];

export function MidSequence() {
  return <PasteQueue items={items} index={1} onPasteNext={() => {}} onCancel={() => {}} />;
}

export function LastItem() {
  return <PasteQueue items={items} index={2} onPasteNext={() => {}} onCancel={() => {}} />;
}

export function SingleItem() {
  return (
    <PasteQueue
      items={[{ id: 1, content: "console.log('hello world')" }]}
      index={0}
      onPasteNext={() => {}}
      onCancel={() => {}}
    />
  );
}
