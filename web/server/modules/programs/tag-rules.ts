// 学院标签 (design §9.3). Pages import this, so it stays free of Zod.

// One member's view isn't the members' impression, so a tag counts as the college's, and
// filters, once this many put it on.
export const TAG_THRESHOLD = 3;

// The hues admins give the presets, each one of the pages' tags (app/components/tags.tsx).
export const TAG_COLORS = [
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "sky",
  "blue",
  "violet",
  "pink",
  "gray",
] as const;
