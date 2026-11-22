import { glob, readFile } from "node:fs/promises";
import { expect, test } from "vitest";

// Each table is written by the one module docs/data-model.md gives it (AGENTS.md).

const WRITES = new RegExp(
  [
    String.raw`(?:insertInto|updateTable|deleteFrom)\(\s*"(\w+)`,
    String.raw`\b(?:insert\s+into|delete\s+from|truncate(?:\s+table)?)\s+"?(\w+)`,
    String.raw`\bupdate\s+"?(\w+)"?(?:\s+(?:as\s+)?\w+)?\s+set\b`,
  ].join("|"),
  "gi",
);

test("every table has one module that writes it, and only that module does", async () => {
  const owner = new Map<string, string>();
  const repeated = [];
  let section: string | undefined;
  for (const line of (await readFile("../docs/data-model.md", "utf8")).split("\n")) {
    if (line.startsWith("#")) section = /（`(\w+)`）$/.exec(line)?.[1];
    const row = /^\| `(\w+)` \| (?:`(\w+)` \|)?/.exec(line);
    if (!row) continue;
    if (owner.has(row[1])) repeated.push(row[1]);
    owner.set(row[1], row.at(2) ?? section ?? "");
  }
  expect(repeated).toEqual([]);

  const tables = [];
  for await (const file of glob("db/migrations/*.sql")) {
    for (const [, table] of (await readFile(file, "utf8")).matchAll(/CREATE TABLE (\w+)/g)) {
      tables.push(table);
    }
  }
  expect(tables.filter((table) => !owner.get(table))).toEqual([]);

  const strays = [];
  for await (const file of glob("server/{modules/*,platform}/**/*.ts", {
    exclude: (name) => name.endsWith(".test.ts"),
  })) {
    const module = /^server\/(?:modules\/)?(\w+)/.exec(file)?.[1];
    for (const write of (await readFile(file, "utf8")).matchAll(WRITES)) {
      const table = (write.at(1) ?? write.at(2) ?? write[3]).toLowerCase();
      // Words in comments that happen to follow "update" aren't tables.
      if (owner.has(table) && owner.get(table) !== module) strays.push(`${file} writes ${table}`);
    }
  }
  expect(strays).toEqual([]);
});
