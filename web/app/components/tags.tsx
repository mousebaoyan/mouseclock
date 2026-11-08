import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "~/cn";
import type { Kind, Role } from "../../server/modules/programs/schemas.ts";
import { STATUS_LABELS, type Status } from "../time.ts";

// Tags tell tiers, kinds and statuses apart at a glance, as mousehole's chips do: text in a hue
// on a light wash of it (app.css).
const COLORS = {
  red: { bg: "bg-tag-red/12", text: "text-tag-red" },
  orange: { bg: "bg-tag-orange/12", text: "text-tag-orange" },
  amber: { bg: "bg-tag-amber/14", text: "text-tag-amber" },
  green: { bg: "bg-tag-green/12", text: "text-tag-green" },
  teal: { bg: "bg-tag-teal/12", text: "text-tag-teal" },
  sky: { bg: "bg-tag-sky/12", text: "text-tag-sky" },
  blue: { bg: "bg-tag-blue/12", text: "text-tag-blue" },
  violet: { bg: "bg-tag-violet/12", text: "text-tag-violet" },
  pink: { bg: "bg-tag-pink/12", text: "text-tag-pink" },
  gray: { bg: "bg-muted", text: "text-muted-foreground" },
};
export type TagColor = keyof typeof COLORS;

const tagClass =
  "inline-flex items-center rounded-full px-2 py-px text-xs font-medium whitespace-nowrap";

export function Tag({ color, children }: { color: TagColor; children: ReactNode }) {
  return <span className={cn(tagClass, COLORS[color].bg, COLORS[color].text)}>{children}</span>;
}

// A filter's choice as a link that ticks or unticks it. Not a checkbox or radio button: after a
// change React puts back their default, so the tick would come off again.
export function Chip({
  to,
  on,
  color,
  children,
}: {
  to: string;
  on: boolean;
  color: TagColor;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      replace
      preventScrollReset
      aria-current={on ? "true" : undefined}
      className={cn(
        tagClass,
        "border px-2.5 py-1 transition-colors",
        COLORS[color].text,
        on
          ? cn("border-transparent font-semibold", COLORS[color].bg)
          : "border-border hover:bg-accent",
      )}
    >
      {children}
    </Link>
  );
}

// Highest first, the order tags show in.
export const TIERS = [
  { value: "c9", label: "C9", color: "red" },
  { value: "985", label: "985", color: "violet" },
  { value: "211", label: "211", color: "blue" },
  { value: "double_first_class", label: "双一流", color: "teal" },
] as const satisfies { value: string; label: string; color: TagColor }[];

export function TierTags({ tiers }: { tiers: string[] }) {
  return TIERS.filter((tier) => tiers.includes(tier.value)).map((tier) => (
    <Tag key={tier.value} color={tier.color}>
      {tier.label}
    </Tag>
  ));
}

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

// Null: the notice gave no times.
export function StatusTag({ status }: { status: Status | null }) {
  return status ? (
    <Tag color={STATUS_COLORS[status]}>{STATUS_LABELS[status]}</Tag>
  ) : (
    <Tag color="gray">未说明</Tag>
  );
}

// What a notice was to a program (design §8.2).
const ROLES: Record<Role, { label: string; color: TagColor }> = {
  call: { label: "报名", color: "blue" },
  update: { label: "补充", color: "amber" },
  result: { label: "名单", color: "violet" },
};

export function RoleTag({ role }: { role: Role }) {
  return <Tag color={ROLES[role].color}>{ROLES[role].label}</Tag>;
}
