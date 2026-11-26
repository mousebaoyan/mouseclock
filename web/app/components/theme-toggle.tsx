import { useSyncExternalStore, type MouseEvent } from "react";
import { Moon, Sun } from "~/components/icons";
import { Button } from "~/components/ui/button";

// Flips the theme the page has when the switch happens, so a second press before the first one's
// transition ran flips it back. Kept under the key root.tsx's script reads before the first paint;
// storage can be refused, as with blocked site data, and the switch then lasts only for this page.
function apply() {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("theme", theme);
  } catch {}
}

// As mousehole's: the new theme spreads in a circle from where the button was pressed, or from
// its middle when a key pressed it. Browsers without view transitions, such as older QQ ones,
// fade the colors instead.
function toggle(e: MouseEvent<HTMLButtonElement>) {
  const root = document.documentElement;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return apply();
  if (!("startViewTransition" in document)) {
    root.dataset.themeFade = "";
    apply();
    setTimeout(() => delete root.dataset.themeFade, 400);
    return;
  }
  const box = e.currentTarget.getBoundingClientRect();
  const [x, y] =
    e.detail === 0 ? [box.left + box.width / 2, box.top + box.height / 2] : [e.clientX, e.clientY];
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  // A quick second press skips the first transition, whose `ready` then rejects; its theme was
  // set all the same.
  document.startViewTransition(apply).ready.then(
    () =>
      root.animate(
        { clipPath: [`circle(0 at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 500, easing: "ease-in-out", pseudoElement: "::view-transition-new(root)" },
      ),
    () => {},
  );
}

// The theme is the page's data-theme, which only the browser knows.
function watchTheme(changed: () => void) {
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, { attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

// A switch read out as 深色模式, on or off.
export function ThemeToggle() {
  const dark = useSyncExternalStore(
    watchTheme,
    () => document.documentElement.dataset.theme === "dark",
    () => undefined,
  );
  return (
    <Button variant="ghost" size="icon" aria-label="深色模式" aria-pressed={dark} onClick={toggle}>
      <Sun className="size-5 dark:hidden" />
      <Moon className="hidden size-5 dark:block" />
    </Button>
  );
}
