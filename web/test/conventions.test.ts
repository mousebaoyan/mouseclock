import { glob, readFile } from "node:fs/promises";
import { parseSync, traverse, types } from "@babel/core";
import { expect, test } from "vitest";

const CLOCK =
  /\b(?:now|clock_timestamp|statement_timestamp|transaction_timestamp)\s*\(\s*\)|\b(?:current_timestamp|current_date|current_time|localtimestamp|localtime)\b/gi;

// Each clock a `sql` template asks the database for, with the property it is set to, if any.
function clocks(source: string) {
  const found: string[] = [];
  const ast = parseSync(source, {
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ["typescript"] },
  });
  if (!ast) throw new Error("Nothing parsed");
  traverse(ast, {
    TaggedTemplateExpression(path) {
      if (!types.isIdentifier(path.node.tag, { name: "sql" })) return;
      const text = path.node.quasi.quasis.map((quasi) => quasi.value.raw).join(" ");
      const parent = path.parentPath.node;
      const key =
        types.isObjectProperty(parent) && types.isIdentifier(parent.key)
          ? parent.key.name
          : "query";
      for (const [clock] of text.matchAll(CLOCK)) found.push(`${key} = ${clock.toLowerCase()}`);
    },
  });
  return found;
}

// Queries take the current time from the process, which tests control (development.md §3). Feedback
// and a dispute's review are put in order by the database's clock as each is written.
test("no query asks the database for the time but the two that order feedback", async () => {
  const found = [];
  for await (const file of glob("{server,scripts}/**/*.ts")) {
    for (const clock of clocks(await readFile(file, "utf8"))) found.push(`${file}: ${clock}`);
  }
  expect(found).toEqual([
    "server/modules/review/feedback.ts: created_at = clock_timestamp()",
    "server/modules/review/feedback.ts: resolved_at = clock_timestamp()",
  ]);
});

test("the check finds clocks wherever a sql template has them, and only there", () => {
  const source = [
    "// A query can start with sql`",
    'const a = sql`select ${sql.val("{")} where x < now()`;',
    "const b = sql`a ${sql`1`} ${`b ${1} c`} CURRENT_DATE`;",
    "const c = sql<Date>`x \\` NOW ()`;",
    "const d = { created_at: sql<Date>`clock_timestamp()` };",
    "const now = () => 1; now(); // now()",
  ].join("\n");
  expect(clocks(source)).toEqual([
    "query = now()",
    "query = current_date",
    "query = now ()",
    "created_at = clock_timestamp()",
  ]);
});
