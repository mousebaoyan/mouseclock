// Filters of lists that take any number of choices, such as regions: none picked lets everything
// through, and otherwise what has any of the picked passes. Beside each choice goes how many it
// would show with the other filters as they are.

export function anyOf(picked: string[], values: string[]) {
  return picked.length === 0 || values.some((value) => picked.includes(value));
}

// How many have each value.
export function tally(values: string[]) {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

const collator = new Intl.Collator("zh-CN");

// What a filter offers: each value once, in pinyin order.
export function choices(values: string[]) {
  return [...new Set(values)].sort(collator.compare);
}
