import { KINDS, type TimeValue } from "../server/modules/programs/schemas.ts";
import type { ProgramEdit } from "../server/modules/review/schemas.ts";
import { formText } from "./admin.server.ts";
import { parseTime, TIME_HINT } from "./time.ts";

type Values = Omit<ProgramEdit, "reason" | "basis">;

// What people typed that can't be sent as it is, said so they can fix it.
export class FormError extends Error {}

const LISTS = [
  "majors",
  "requirements",
  "materials",
  "assessment",
  "benefits",
  "contacts",
] as const;

// The values an edit form (components/program-edit.tsx) sets. A field left empty is cleared.
export function editValues(field: string, form: FormData): Values {
  const text = (name: string) => formText(form, name).trim();
  const time = (name: string, label: string) => timeOf(text(name), label);
  const all = (name: string) =>
    form.getAll(name).map((value) => (typeof value === "string" ? value.trim() : ""));
  if (field === "program") {
    return {
      name: text("name"),
      cohort: Number(text("cohort")),
      kind: KINDS.find((kind) => kind === text("kind")),
    };
  }
  if (field === "apply") {
    const start = time("start", "报名开始");
    const end = time("end", "报名截止");
    const rolling = form.has("rolling") ? (true as const) : undefined;
    return { apply: start || end || rolling ? { start, end, rolling } : null };
  }
  if (field === "event") {
    const event = {
      start: time("start", "活动开始"),
      end: time("end", "活动结束"),
      mode: (["online", "offline", "hybrid"] as const).find((mode) => mode === text("mode")),
      place: text("place") || undefined,
    };
    return { event: Object.values(event).some(Boolean) ? event : null };
  }
  if (field === "dates") {
    const starts = all("start");
    const ends = all("end");
    const dates = all("label").flatMap((label, i) => {
      const start = timeOf(starts[i], `「${label}」的开始`);
      const end = timeOf(ends[i], `「${label}」的结束`);
      if (!label && !start && !end) return [];
      if (!label) throw new FormError("每个时间都要写上名称，比如「初试」");
      if (!start && !end) throw new FormError(`「${label}」要写开始或结束的时间`);
      return [{ label, start, end }];
    });
    return { dates: dates.length > 0 ? dates : null };
  }
  if (field === "degrees") {
    const degrees = (["master", "direct_phd"] as const).filter((degree) =>
      all("degrees").includes(degree),
    );
    return { degrees: degrees.length > 0 ? degrees : null };
  }
  const values: Values = {};
  if (field === "apply_url" || field === "quota") {
    values[field] = text("value") || null;
    return values;
  }
  const list = LISTS.find((name) => name === field);
  if (!list) throw new FormError("不能改这一项");
  const items = text("value")
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
  values[list] = items.length > 0 ? items : null;
  return values;
}

function timeOf(text: string, label: string): TimeValue | undefined {
  if (!text) return undefined;
  const value = parseTime(text);
  if (!value) throw new FormError(`${label}的写法不对，${TIME_HINT}`);
  return value;
}
