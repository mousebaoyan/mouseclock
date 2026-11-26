import { Link, useFetcher, useLocation, useRouteLoaderData } from "react-router";
import { cn } from "~/cn";
import { BellPlus, BellRing } from "./icons.tsx";
import { buttonVariants } from "./ui/button.tsx";
import type { loader as rootLoader } from "../root.tsx";
import type { action } from "../routes/program-subscription.ts";

// 订阅 and how many subscribe (design §11.3), on a program's card and its page. Guests log in
// first. While it goes it shows what it will be, until the page has the new count.
export function Subscribe({
  program,
  subscribed,
  outlined,
}: {
  program: { id: number; subscribers: number };
  subscribed: boolean;
  // On a program's page, beside its other buttons; a small plain one on cards.
  outlined?: boolean;
}) {
  const fetcher = useFetcher<typeof action>();
  const { pathname, search } = useLocation();
  const me = useRouteLoaderData<typeof rootLoader>("root")?.me;
  const going = fetcher.formMethod === undefined ? null : fetcher.formMethod === "PUT";
  const on = going ?? subscribed;
  const count = program.subscribers + (on === subscribed ? 0 : on ? 1 : -1);
  const looks = buttonVariants({
    variant: outlined ? "outline" : "ghost",
    size: outlined ? "default" : "xs",
    className: cn(
      "touch-target relative z-1 tabular-nums",
      on && "text-primary hover:text-primary",
    ),
  });
  const label = (
    <>
      {on ? <BellRing /> : <BellPlus />}
      {on ? "已订阅" : "订阅"}
      <span className="text-muted-foreground">{count}</span>
    </>
  );
  // Frozen accounts are no longer in the group and see only the preview.
  if (me?.frozen) return null;
  if (!me) {
    // A page of the server, not of the router: it goes on to mousehole.
    return (
      <a href={`/login?next=${encodeURIComponent(pathname + search)}`} className={looks}>
        {label}
      </a>
    );
  }
  return (
    <fetcher.Form
      method={on ? "delete" : "put"}
      action={`/programs/${program.id}/subscription`}
      className="relative z-1"
    >
      {/* One at a time: the requests could otherwise land in another order than the clicks. */}
      <button type="submit" aria-pressed={on} disabled={fetcher.state !== "idle"} className={looks}>
        {label}
      </button>
      {fetcher.state === "idle" && fetcher.data && (
        <p
          role="alert"
          className="absolute top-full right-0 z-10 mt-1.5 w-max max-w-60 rounded-lg border bg-card px-3 py-2 text-xs shadow-card"
        >
          {fetcher.data.message}
          {fetcher.data.full && (
            <Link to="/me/subscriptions" className="mt-1 block text-primary hover:underline">
              去「我的 · 订阅」取消
            </Link>
          )}
        </p>
      )}
    </fetcher.Form>
  );
}
