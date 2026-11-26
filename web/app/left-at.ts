import { useEffect, useSyncExternalStore } from "react";
import { useLocation } from "react-router";

// Where each page was last left in this tab: a list's filters, sort and page live in its address
// (filters.tsx), so links back to it, the nav's and the crumbs', go back to it as it was. The tab's
// storage is the browser's, so the page as the server renders it, and as it hydrates, links to
// the other pages as they start.

// What opens an editor, a question or a notice on a page, rather than where its list is.
const OPENED = [
  "edit",
  "edit_school",
  "edit_college",
  "feedback",
  "saved",
  "probe",
  "adopt",
  "revoke",
  "votes",
  "delete",
  "new",
  "college",
  "asked",
];

// An address the page failed on is no place to go back to, so the page starts over.
function useHere(failed: boolean) {
  const { pathname, search } = useLocation();
  const params = new URLSearchParams(search);
  for (const name of OPENED) params.delete(name);
  return { pathname, here: failed || params.size === 0 ? "" : `?${params}` };
}

// Done once for every page, by the header.
export function useRememberLeft(failed: boolean) {
  const { pathname, here } = useHere(failed);
  useEffect(() => sessionStorage.setItem(`left:${pathname}`, here), [pathname, here]);
}

function unchanging() {
  return () => {};
}

export function useLeftAt(failed = false) {
  const { pathname, here } = useHere(failed);
  const hydrated = useSyncExternalStore(
    unchanging,
    () => true,
    () => false,
  );
  return (to: string) =>
    to + (to === pathname ? here : hydrated ? (sessionStorage.getItem(`left:${to}`) ?? "") : "");
}
