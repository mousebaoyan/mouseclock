import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "~/cn";
import { Search, X } from "~/components/icons";

// Panels that open from a button: menus, dropdowns and the phones' drawer. Hand-rolled, as
// mousehole's are: the header is on every page, and Base UI's menus and dialogs with their
// positioning library added ~55KB gzip of JavaScript to each (design §14).

// Closes an open panel on a press outside every one of `inside`, or on Esc, after which the
// focus goes back to the panel's button (`escaped`).
export function useDismiss(
  open: boolean,
  close: (escaped: boolean) => void,
  inside: RefObject<HTMLElement | null>[],
) {
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") close(true);
    }
    function onPointer(e: PointerEvent) {
      const target = e.target;
      if (target instanceof Node && !inside.some((ref) => ref.current?.contains(target))) {
        close(false);
      }
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, close, inside]);
}

// A panel beside `anchor`: below it, or above where there is more room, lined up with its start
// edge unless that would run off the screen. In the body and fixed, so a box that clips what it
// holds, such as a panel's rounded corners, can't cut it off; it follows the anchor as the page
// scrolls.
export function Popup({
  anchor,
  panel,
  className,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  panel: RefObject<HTMLDivElement | null>;
  className?: string;
  children: ReactNode;
}) {
  // Unseen until placed, but there to take the focus.
  const [place, setPlace] = useState<CSSProperties>({ opacity: 0 });
  useLayoutEffect(() => {
    function fit(e?: Event) {
      const box = anchor.current?.getBoundingClientRect();
      const self = panel.current;
      if (!box || !self || (e?.target instanceof Node && self.contains(e.target))) return;
      // Against clientWidth: a phone widens innerWidth to take in what sticks out.
      const width = document.documentElement.clientWidth;
      const below = innerHeight - box.bottom;
      const up = below < Math.min(self.scrollHeight, 320) && box.top > below;
      setPlace({
        minWidth: box.width,
        maxHeight: Math.min((up ? box.top : below) - 12, 352),
        left: Math.max(8, Math.min(box.left, width - self.offsetWidth - 8)),
        ...(up ? { bottom: innerHeight - box.top + 4 } : { top: box.bottom + 4 }),
        transformOrigin: up ? "bottom" : "top",
      });
    }
    fit();
    addEventListener("scroll", fit, { capture: true, passive: true });
    addEventListener("resize", fit);
    return () => {
      removeEventListener("scroll", fit, { capture: true });
      removeEventListener("resize", fit);
    };
  }, [anchor, panel]);
  return createPortal(
    <div
      ref={panel}
      style={place}
      className={cn(
        "pop-in fixed z-50 flex max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-lg border bg-popover text-sm shadow-pop",
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}

// Arrow keys, Home and End move between the items of `list`, as in a menu; above the first, the
// focus goes back to `before`, such as a search box over them.
export function moveFocus(e: KeyboardEvent, list: HTMLElement | null, before?: HTMLElement | null) {
  const items = [...(list?.querySelectorAll<HTMLElement>("[data-item]") ?? [])];
  const at = items.findIndex((item) => item === document.activeElement);
  const to = new Map([
    ["ArrowDown", at + 1],
    ["ArrowUp", at - 1],
    ["Home", 0],
    ["End", items.length - 1],
  ]).get(e.key);
  if (to === undefined) return false;
  e.preventDefault();
  if (to < 0 && before) before.focus();
  else items.at(Math.min(Math.max(to, 0), items.length - 1))?.focus();
  return true;
}

export function matching<T extends { label: string }>(items: readonly T[], query: string) {
  const q = query.trim().toLowerCase();
  return q === "" ? items : items.filter((item) => item.label.toLowerCase().includes(q));
}

// The box that narrows a long list. Takes the focus only with a mouse: on a phone the keyboard
// would cover the list before anyone asked to type.
export function PopupSearch({
  label,
  value,
  onChange,
  onKeyDown,
  input,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  input: RefObject<HTMLInputElement | null>;
}) {
  useEffect(() => {
    if (matchMedia("(pointer: fine)").matches) input.current?.focus();
  }, [input]);
  return (
    <div className="border-b p-1.5">
      <label className="relative block">
        <span className="sr-only">搜索{label}</span>
        <Search className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-subtle-foreground" />
        <input
          ref={input}
          type="search"
          enterKeyHint="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`搜索${label}`}
          className="field h-8 pl-8 pointer-coarse:h-10"
        />
      </label>
    </div>
  );
}

export const menuItem =
  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left outline-none select-none hover:bg-accent focus-visible:bg-accent pointer-coarse:py-2.5";

// A menu of links or actions under a button, such as the account's, in the page right after its
// button, so Tab goes through it in order. Callers key it by the path, so going to another page
// closes it.
export function Dropdown({
  label,
  trigger,
  triggerClassName,
  align,
  className,
  children,
}: {
  label: string;
  trigger: ReactNode;
  triggerClassName: string;
  // Which edge of the button the menu lines up with.
  align: "start" | "end";
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useDismiss(
    open,
    (escaped) => {
      setOpen(false);
      if (escaped) button.current?.focus();
    },
    [root],
  );
  return (
    <div ref={root} className="relative flex items-stretch">
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open && (
        <div
          className={cn(
            "pop-in absolute top-full z-50 mt-1 flex flex-col gap-0.5 rounded-lg border bg-popover p-1 text-sm shadow-pop",
            align === "start" ? "left-0 origin-top-left" : "right-0 origin-top-right",
            className,
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

// The phones' panel of pages, sliding in from the side. A native modal dialog: in the top layer,
// which the header's backdrop-filter can't trap as it would a fixed box, with Esc and the focus
// looked after by the browser. Callers key it by the location, so following a link closes it.
export function Drawer({
  label,
  trigger,
  triggerClassName,
  children,
}: {
  label: string;
  trigger: ReactNode;
  triggerClassName: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
  }, [open]);
  return (
    <>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open && (
        <dialog
          ref={dialog}
          aria-label={label}
          onClose={() => setOpen(false)}
          className="fixed inset-0 m-0 size-full max-h-none max-w-none bg-transparent p-0 text-foreground backdrop:bg-transparent"
        >
          <button
            type="button"
            aria-label="关闭"
            tabIndex={-1}
            onClick={() => dialog.current?.close()}
            className="fade-in absolute inset-0 bg-black/30"
          />
          <div className="slide-in absolute inset-y-0 right-0 flex w-72 max-w-[85vw] flex-col bg-card shadow-xl">
            <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
              <p className="font-semibold">{label}</p>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => dialog.current?.close()}
                className="btn btn-ghost btn-icon-sm"
              >
                <X className="size-5" />
              </button>
            </div>
            {children}
          </div>
        </dialog>
      )}
    </>
  );
}
