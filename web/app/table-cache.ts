import { hc, type InferResponseType } from "hono/client";
import { data } from "react-router";
import type { ApiType } from "../server/app.ts";

type Api = ReturnType<typeof hc<ApiType>>;
type TableData = InferResponseType<Api["programs"]["$get"], 200>;

// The programs one subscribes to, for 已订阅 on their cards; none for guests and frozen accounts.
export async function subscribedTo(api: Api) {
  const res = await api.me.subscriptions.$get();
  if (res.status === 200) return (await res.json()).programs.map((p) => p.id);
  const { error } = await res.json();
  if (error.code === "login_required" || error.code === "member_frozen") return [];
  throw data(error.message, { status: res.status });
}

// One's records of applying, by program, for its page to change it and the note; none for guests
// and frozen accounts.
export async function applicationsOf(api: Api) {
  const res = await api.me.applications.$get({ query: {} });
  if (res.status === 200) {
    const { applications } = await res.json();
    return Object.fromEntries(
      applications.map(({ program, stage, note }) => [program.id, { stage, note }]),
    );
  }
  const { error } = await res.json();
  if (error.code === "login_required" || error.code === "member_frozen") return {};
  throw data(error.message, { status: res.status });
}

// The cards show only how far each went, not the notes.
export async function stagesOf(api: Api) {
  return Object.fromEntries(
    Object.entries(await applicationsOf(api)).map(([id, { stage }]) => [id, stage]),
  );
}

// The browser keeps the whole cohort and filters, sorts and pages it itself (design §14). It asks
// again for another cohort, after a while, or once one's own subscriptions or records of applying
// changed, which show on the cards; the server answers 304 while nothing changed.
let kept: {
  cohort: string;
  at: number;
  table: TableData;
  subscribed: number[];
  stages: Awaited<ReturnType<typeof stagesOf>>;
} | null = null;
const KEEP_MS = 5 * 60_000;

export async function keptTable(cohort: string, now: number) {
  if (kept?.cohort !== cohort || now - kept.at > KEEP_MS) {
    const api = hc<ApiType>("/api/v1");
    const res = await api.programs.$get({ query: { cohort } });
    if (res.status !== 200) throw data((await res.json()).error.message, { status: res.status });
    const table = await res.json();
    const [subscribed, stages] = table.preview
      ? [[], {}]
      : await Promise.all([subscribedTo(api), stagesOf(api)]);
    kept = { cohort, at: now, table, subscribed, stages };
  }
  return kept;
}

export function forgetTable() {
  kept = null;
}
