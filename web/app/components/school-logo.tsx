import { cn } from "~/cn";

// A school's emblem, which tells schools apart at a glance. A school without one yet gets the
// first character of its name in the same circle, so a list keeps its line. The name is always
// written beside it, so screen readers skip it.

const SIZES = {
  xs: "size-5 text-[10px]",
  sm: "size-7 text-xs",
  md: "size-10 text-base",
  lg: "size-14 text-2xl",
};

export function SchoolLogo({
  school,
  size,
}: {
  school: { name: string; logo: string | null };
  size: keyof typeof SIZES;
}) {
  const frame = cn(
    "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border select-none",
    SIZES[size],
  );
  return school.logo ? (
    <img
      src={school.logo}
      alt=""
      loading="lazy"
      decoding="async"
      // Emblems are drawn for white paper, dark mode included.
      className={cn(frame, "bg-white object-contain p-0.5")}
    />
  ) : (
    <span aria-hidden="true" className={cn(frame, "bg-primary-soft font-semibold text-primary/75")}>
      {school.name.slice(0, 1)}
    </span>
  );
}
