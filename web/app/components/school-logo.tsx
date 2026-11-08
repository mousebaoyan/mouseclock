import { cn } from "~/cn";

// A school's emblem, which tells schools apart at a glance. Emblems come round, square and wide,
// so each sits whole in a rounded square. A school without one yet gets the first character of
// its name in the same square, tinted so it still catches the eye. The name is always written
// beside it, so screen readers skip it.

const SIZES = {
  sm: "size-9 rounded-md text-base",
  md: "size-12 rounded-lg text-xl",
  lg: "size-16 rounded-xl text-3xl",
};

export function SchoolLogo({
  school,
  size,
}: {
  school: { name: string; logo: string | null };
  size: keyof typeof SIZES;
}) {
  const frame = cn(
    "inline-flex shrink-0 items-center justify-center overflow-hidden border select-none",
    SIZES[size],
  );
  return school.logo ? (
    <img
      src={school.logo}
      alt=""
      loading="lazy"
      decoding="async"
      // Emblems are drawn for white paper, dark mode included.
      className={cn(frame, "bg-white object-contain p-1")}
    />
  ) : (
    <span
      aria-hidden="true"
      className={cn(frame, "border-primary/20 bg-primary-soft font-bold text-primary")}
    >
      {school.name.slice(0, 1)}
    </span>
  );
}
