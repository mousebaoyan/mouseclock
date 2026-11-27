import { useFetcher } from "react-router";
import { cn } from "~/cn";
import { Check, Plus } from "./icons.tsx";
import { buttonVariants } from "./ui/button.tsx";
import type { action } from "../routes/college-follow.ts";

// 关注 a college (design §11.4): on its page with how many follow it, a small plain one in
// 院校清单 and 我的 · 关注. While it goes it shows what it will be, until the page has it.
export function Follow({
  college,
  following,
  followers,
  outlined,
}: {
  college: number;
  following: boolean;
  followers?: number;
  outlined?: boolean;
}) {
  const fetcher = useFetcher<typeof action>();
  const going = fetcher.formMethod === undefined ? null : fetcher.formMethod === "PUT";
  const on = going ?? following;
  return (
    <fetcher.Form
      method={on ? "delete" : "put"}
      action={`/colleges/${college}/follow`}
      className="relative"
    >
      {/* One at a time: the requests could otherwise land in another order than the clicks. */}
      <button
        type="submit"
        aria-pressed={on}
        disabled={fetcher.state !== "idle"}
        className={buttonVariants({
          variant: outlined ? "outline" : "ghost",
          size: outlined ? "default" : "xs",
          className: cn("touch-target tabular-nums", on && "text-primary hover:text-primary"),
        })}
      >
        {on ? <Check /> : <Plus />}
        {on ? "已关注" : "关注"}
        {followers !== undefined && (
          <span className="text-muted-foreground">
            {followers + (on === following ? 0 : on ? 1 : -1)}
          </span>
        )}
      </button>
      {fetcher.state === "idle" && fetcher.data && (
        <p
          role="alert"
          className="absolute top-full right-0 z-10 mt-1.5 w-max max-w-60 rounded-lg border bg-card px-3 py-2 text-xs shadow-card"
        >
          {fetcher.data.message}
        </p>
      )}
    </fetcher.Form>
  );
}
