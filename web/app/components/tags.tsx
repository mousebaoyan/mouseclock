import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "~/cn";
import { Check } from "~/components/icons";
import type { Kind, Role } from "../../server/modules/programs/schemas.ts";
import { TIERS } from "../tiers.ts";
import type { Status } from "../time.ts";

// Tags tell tiers, kinds and statuses apart at a glance: text in a hue on a light wash of it
// (app.css). A filter's chip takes the same hue, with a border of it once picked.
const COLORS = {
  red: { tag: "bg-tag-red/10 text-tag-red", on: "border-tag-red/60 bg-tag-red/8 text-tag-red" },
  orange: {
    tag: "bg-tag-orange/10 text-tag-orange",
    on: "border-tag-orange/60 bg-tag-orange/8 text-tag-orange",
  },
  amber: {
    tag: "bg-tag-amber/12 text-tag-amber",
    on: "border-tag-amber/60 bg-tag-amber/8 text-tag-amber",
  },
  green: {
    tag: "bg-tag-green/10 text-tag-green",
    on: "border-tag-green/60 bg-tag-green/8 text-tag-green",
  },
  teal: {
    tag: "bg-tag-teal/10 text-tag-teal",
    on: "border-tag-teal/60 bg-tag-teal/8 text-tag-teal",
  },
  sky: { tag: "bg-tag-sky/10 text-tag-sky", on: "border-tag-sky/60 bg-tag-sky/8 text-tag-sky" },
  blue: {
    tag: "bg-tag-blue/10 text-tag-blue",
    on: "border-tag-blue/60 bg-tag-blue/8 text-tag-blue",
  },
  violet: {
    tag: "bg-tag-violet/10 text-tag-violet",
    on: "border-tag-violet/60 bg-tag-violet/8 text-tag-violet",
  },
  pink: {
    tag: "bg-tag-pink/10 text-tag-pink",
    on: "border-tag-pink/60 bg-tag-pink/8 text-tag-pink",
  },
  gray: {
    tag: "bg-tag-gray/10 text-tag-gray",
    on: "border-tag-gray/60 bg-tag-gray/8 text-foreground",
  },
};
export type TagColor = keyof typeof COLORS;

export function Tag({ color, children }: { color: TagColor; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-sm px-1.5 text-xs font-medium whitespace-nowrap",
        COLORS[color].tag,
      )}
    >
      {children}
    </span>
  );
}

// One of a filter's choices, any number of which can be picked, as a link that picks or unpicks
// it: the address holds the filters, so a link shares them. `count` says how many it would show.
export function Chip({
  to,
  on,
  color,
  count,
  children,
}: {
  to: string;
  on: boolean;
  color: TagColor;
  count?: number;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      replace
      preventScrollReset
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-[13px] whitespace-nowrap pointer-coarse:h-9",
        on
          ? cn("font-medium", COLORS[color].on)
          : "border-border bg-card text-foreground/80 hover:border-input hover:text-foreground",
      )}
    >
      {on && <Check aria-label="已选" className="-ml-0.5 size-3.5" />}
      {children}
      {count !== undefined && (
        <span className="ml-0.5 text-xs font-normal tabular-nums opacity-60">{count}</span>
      )}
    </Link>
  );
}

export function TierTag({ tier }: { tier: string | null }) {
  const found = TIERS.find((item) => item.value === tier);
  return found ? <Tag color={found.color}>{found.label}</Tag> : null;
}

// What a college is to its school.
export const COLLEGE_KINDS: Partial<Record<string, string>> = {
  college: "学院",
  institute: "研究所",
  graduate_school: "研究生院",
};

export const PROGRAM_KINDS: Record<Kind, { label: string; color: TagColor }> = {
  winter_camp: { label: "冬令营", color: "sky" },
  summer_camp: { label: "夏令营", color: "orange" },
  pre_recommendation: { label: "预推免", color: "pink" },
  september_round: { label: "九推", color: "amber" },
};

export function KindTag({ kind }: { kind: Kind }) {
  return <Tag color={PROGRAM_KINDS[kind].color}>{PROGRAM_KINDS[kind].label}</Tag>;
}

export const STATUS_COLORS: Record<Status, TagColor> = {
  upcoming: "blue",
  open: "green",
  closed: "gray",
};

// What a notice was to a program (design §8.2).
const ROLES: Record<Role, { label: string; color: TagColor }> = {
  call: { label: "招生通知", color: "blue" },
  update: { label: "补充通知", color: "amber" },
  result: { label: "名单公示", color: "violet" },
};

export function RoleTag({ role }: { role: Role }) {
  return <Tag color={ROLES[role].color}>{ROLES[role].label}</Tag>;
}
