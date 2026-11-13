import { useState, type ReactNode } from "react";
import { NavigationType, useLocation, useNavigationType } from "react-router";

// Each page fades in as it's opened from another by a link, as mousehole's do: not on the first
// load, whose navigation type is POP on the server and in the browser alike, nor going back.
// Keyed by the path, so the new page is mounted afresh and plays it.
export function PageTransition({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <Opened key={pathname}>{children}</Opened>;
}

function Opened({ children }: { children: ReactNode }) {
  // Settled as the page is put up: a change of its filters later is a navigation too, and would
  // otherwise play it over again.
  const [opened] = useState(useNavigationType() !== NavigationType.Pop);
  return <div className={opened ? "page-in" : undefined}>{children}</div>;
}
