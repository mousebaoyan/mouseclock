// The tiers of schools, as tags and as the choices of filters.

// Highest first, the order tags show in. "other" picks the schools with none of them, and so
// has no tag of its own.
export const TIERS = [
  { value: "c9", label: "C9", color: "red" },
  { value: "985", label: "985", color: "violet" },
  { value: "211", label: "211", color: "blue" },
  { value: "double_first_class", label: "双一流", color: "teal" },
] as const;
export const TIER_FILTERS = [...TIERS, { value: "other", label: "其他", color: "gray" }] as const;

// A school's highest tier, or "other" with none. Filters pick schools by it: a 985 school is
// also 211, but someone who picks 211 is looking for the schools that are 211 and no higher.
export function topTier(tiers: string[]) {
  return TIERS.find((tier) => tiers.includes(tier.value))?.value ?? "other";
}
