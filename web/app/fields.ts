import type { EditValue } from "../server/modules/review/schemas.ts";
import { PROGRAM_KINDS } from "./components/tags.tsx";
import { formatTime, formatWindow } from "./time.ts";

// The fields of design §8.2 and their keys in program_fields, as people say them.

export const MODES: Partial<Record<string, string>> = {
  online: "线上",
  offline: "线下",
  hybrid: "线上和线下",
};
export const DEGREES: Partial<Record<string, string>> = { master: "硕士", direct_phd: "直博" };

const LABELS: Partial<Record<string, string>> = {
  name: "名称",
  cohort: "届",
  kind: "类型",
  "apply:start": "报名开始",
  "apply:end": "报名截止",
  "apply:rolling": "额满即止",
  apply_url: "报名入口",
  "event:start": "活动开始",
  "event:end": "活动结束",
  "event:mode": "活动形式",
  "event:place": "活动地点",
  degrees: "招收类型",
  majors: "招收专业",
  requirements: "报名要求",
  materials: "要交的材料",
  assessment: "考核方式",
  quota: "名额",
  benefits: "待遇",
  contacts: "联系方式",
};

// A key of program_fields, or name, cohort or kind; one of the other dates goes by its own name.
export function fieldLabel(key: string) {
  return key.startsWith("dates:") ? key.slice("dates:".length) : (LABELS[key] ?? key);
}

// A value an edit changed, as the page shows the field.
export function formatValue(key: string, value: EditValue | null, thisYear: number) {
  if (value === null) return "空";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return `${value} 届`;
  if (typeof value === "string") {
    if (key === "kind") {
      return Object.entries(PROGRAM_KINDS).find(([kind]) => kind === value)?.[1].label ?? value;
    }
    return key === "event:mode" ? (MODES[value] ?? value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => (key === "degrees" ? (DEGREES[item] ?? item) : item)).join("；");
  }
  if ("date" in value || "month" in value) return formatTime(value, thisYear);
  return formatWindow(value, thisYear);
}
