// What the table's search looks in (design §10): the school's name and short names, the college's
// name and the program's. The page searches the cohort in the browser and the API's `q` on the
// server, both with this.
export function matchesSearch(
  program: {
    school: { name: string; short_names: string[] };
    college: { name: string };
    name: string;
  },
  q: string,
) {
  const query = q.toLowerCase();
  // Most often empty, and the page asks this of every program several times on each change.
  if (query === "") return true;
  return [
    program.school.name,
    ...program.school.short_names,
    program.college.name,
    program.name,
  ].some((text) => text.toLowerCase().includes(query));
}
