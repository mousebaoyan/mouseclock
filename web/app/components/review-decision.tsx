import { useEffect, useState, type SubmitEvent } from "react";
import { useFetcher } from "react-router";
import { Button } from "./ui/button.tsx";

// How long a decision on the review page waits before it is sent, for a slip to be taken back
// (design §12.2).
export const UNDO_SECONDS = 5;

export type Decide = (event: SubmitEvent<HTMLFormElement>) => void;

// A decision on one card: the button clicked and the form it sends, until it is sent or taken
// back. Leaving the page first drops it, and the card still waits. Each card sends on its own, so
// the rest of the list stays as it is while it does.
export function useDecision<Action>() {
  const fetcher = useFetcher<Action>();
  const { submit } = fetcher;
  const [decision, setDecision] = useState<{
    form: FormData;
    choice: string;
    sent: boolean;
  } | null>(null);
  useEffect(() => {
    if (!decision || decision.sent) return undefined;
    const timer = setTimeout(() => {
      void submit(decision.form, { method: "post" });
      setDecision({ ...decision, sent: true });
    }, UNDO_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [decision, submit]);
  const decide: Decide = (event) => {
    event.preventDefault();
    setDecision({
      form: new FormData(event.currentTarget, event.submitter),
      choice: event.submitter?.textContent ?? "",
      sent: false,
    });
  };
  // A decision sent and answered with an error leaves the card as it was, the error under it.
  const pending = decision !== null && !(decision.sent && fetcher.state === "idle");
  return {
    result: fetcher.data,
    decision: pending ? decision : null,
    decide,
    undo: () => setDecision(null),
  };
}

// What was picked, and taking it back while it waits.
export function Deciding({
  decision,
  undo,
}: {
  decision: { choice: string; sent: boolean };
  undo: () => void;
}) {
  return (
    <output className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
      <span className="text-[13px]">
        {decision.sent
          ? `正在提交「${decision.choice}」`
          : `已选「${decision.choice}」，${UNDO_SECONDS} 秒后提交`}
      </span>
      {!decision.sent && (
        <Button variant="outline" size="sm" onClick={undo}>
          撤回
        </Button>
      )}
    </output>
  );
}
