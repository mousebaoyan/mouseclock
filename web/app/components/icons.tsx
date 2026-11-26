import * as lucide from "lucide";
import type { IconNode } from "lucide";

// Lucide's icons, each written into the page as one string, as in mousehole: React rendering
// every attribute of every path is slow on a long list. Size and strokes come from .lucide in
// app.css, which a size-* class overrides. Add the ones a page needs here.
function icon(node: IconNode) {
  const markup = {
    __html: node
      .map(([tag, attrs]) => {
        const pairs = Object.entries(attrs).map(([name, value]) => ` ${name}="${value}"`);
        return `<${tag}${pairs.join("")}/>`;
      })
      .join(""),
  };
  // Labelled ones say something; the rest only decorate the text beside them.
  return function Icon({
    className,
    "aria-label": label,
  }: {
    className?: string;
    "aria-label"?: string;
  }) {
    return (
      <svg
        viewBox="0 0 24 24"
        className={className ? `lucide ${className}` : "lucide"}
        role={label ? "img" : undefined}
        aria-label={label}
        aria-hidden={label ? undefined : true}
        dangerouslySetInnerHTML={markup}
      />
    );
  };
}

export type LucideIcon = ReturnType<typeof icon>;

export const Bell = icon(lucide.Bell);
export const BellPlus = icon(lucide.BellPlus);
export const BellRing = icon(lucide.BellRing);
export const Check = icon(lucide.Check);
export const ChevronDown = icon(lucide.ChevronDown);
export const ChevronLeft = icon(lucide.ChevronLeft);
export const ChevronRight = icon(lucide.ChevronRight);
export const Ellipsis = icon(lucide.Ellipsis);
export const ExternalLink = icon(lucide.ExternalLink);
export const Filter = icon(lucide.SlidersHorizontal);
export const LogOut = icon(lucide.LogOut);
export const Menu = icon(lucide.Menu);
export const Plus = icon(lucide.Plus);
export const Search = icon(lucide.Search);
export const User = icon(lucide.UserRound);
export const X = icon(lucide.X);
