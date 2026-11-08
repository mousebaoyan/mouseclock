// The tiers of schools, highest first, as tags and as the choices of filters. A school has only
// its highest (design §9.1). "other" picks the schools with none, and so has no tag of its own.
export const TIERS = [
  { value: "c9", label: "C9", color: "red" },
  { value: "985", label: "985", color: "violet" },
  { value: "211", label: "211", color: "blue" },
  { value: "double_first_class", label: "双一流", color: "teal" },
] as const;
export const TIER_FILTERS = [...TIERS, { value: "other", label: "其他", color: "gray" }] as const;
