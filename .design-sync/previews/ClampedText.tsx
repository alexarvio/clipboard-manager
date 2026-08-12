import { ClampedText } from "clipboard-manager";

export function ShortNoOverflow() {
  return (
    <ClampedText
      text="alex@clipapp.io"
      className="text-[13px] leading-snug text-ink dark:text-cream"
      lines={2}
    />
  );
}

export function TwoLinesLongText() {
  return (
    <div className="w-64">
      <ClampedText
        text="Hi Alex, just following up on my note from last week -- wanted to check whether the updated mockups made it through to the design review, and if there's anything else you need from me before Thursday's call."
        className="text-[13px] leading-snug text-ink dark:text-cream"
        lines={2}
      />
    </div>
  );
}

export function FourLinesLongText() {
  return (
    <div className="w-64">
      <ClampedText
        text="Thanks for the quick turnaround -- really appreciate you prioritizing this and getting it out the door ahead of schedule. The team reviewed the changes this morning and everything looks good to ship. One small thing: could you double check the routing number on the invoice before it goes out? Otherwise we're good to close this out."
        className="text-[13px] leading-snug text-ink dark:text-cream"
        lines={4}
      />
    </div>
  );
}

export function WithIcon() {
  return (
    <div className="w-64">
      <ClampedText
        text="Follow-up: Hi {{name}}, just following up on my last note -- wanted to check in and see if you had a chance to look this over. Let me know if you have any questions or need anything else from my end."
        className="text-[13px] leading-snug text-ink dark:text-cream"
        lines={3}
        icon={<i className="ti ti-file-text text-[12px] text-accent dark:text-accentDark mr-1.5 align-middle" />}
      />
    </div>
  );
}

export function ControlledExpanded() {
  return (
    <div className="w-64">
      <ClampedText
        text="Could you send over the updated mockups when you get a chance? No rush, just want to make sure we're aligned before the review on Thursday -- happy to hop on a quick call if that's easier than writing it all out."
        className="text-[13px] leading-snug text-ink dark:text-cream"
        lines={2}
        expanded={true}
        onToggleExpanded={() => {}}
      />
    </div>
  );
}
