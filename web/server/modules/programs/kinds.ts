// The kinds of program (design §9.1) and their names. Pages import this, so it stays free of Zod.
export const KINDS = [
  "winter_camp",
  "summer_camp",
  "pre_recommendation",
  "september_round",
] as const;

export const KIND_LABELS: Record<(typeof KINDS)[number], string> = {
  winter_camp: "冬令营",
  summer_camp: "夏令营",
  pre_recommendation: "预推免",
  september_round: "九推",
};
