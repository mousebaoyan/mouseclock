import type { z } from "@hono/zod-openapi";
import type { ReactNode } from "react";
import { useFetcher } from "react-router";
import { Field, FormMessage } from "./form.tsx";
import { STAGES } from "./tags.tsx";
import { Button } from "./ui/button.tsx";
import { Select } from "./ui/select.tsx";
import type { ApplicationInput } from "../../server/modules/programs/schemas.ts";
import type { action } from "../routes/program-application.ts";

const STAGE_OPTIONS = Object.entries(STAGES).map(([value, { label }]) => ({ value, label }));

// One's record of applying to a program (design §9.4): how far it went and a note, which only
// they see. On the program's page and in 我的 · 报名; `next` is where to go once it is kept.
export function ApplicationForm({
  programId,
  application,
  next,
  cancel,
}: {
  programId: number;
  application: z.infer<typeof ApplicationInput> | null;
  next: string;
  cancel?: ReactNode;
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  return (
    <fetcher.Form
      method="post"
      action={`/programs/${programId}/application`}
      // Kept where one was, down 我的 · 报名, rather than back at the top.
      preventScrollReset
      className="space-y-3"
    >
      <input type="hidden" name="next" value={next} />
      <div className="grid gap-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
        <div className="space-y-1.5">
          <span className="block text-[13px] font-medium">进度</span>
          <Select
            name="stage"
            aria-label="进度"
            defaultValue={application?.stage ?? "want"}
            options={STAGE_OPTIONS}
          />
        </div>
        <Field label="备注" hint="只有自己看得到，最多 1000 字">
          <textarea
            name="note"
            rows={2}
            maxLength={1000}
            defaultValue={application?.note ?? ""}
            placeholder="例如：材料还差推荐信"
            className="field"
          />
        </Field>
      </div>
      <FormMessage error={fetcher.data?.error} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" name="intent" value="save" disabled={busy}>
          {busy ? "正在保存…" : "保存"}
        </Button>
        {application && (
          <Button size="sm" variant="outline" name="intent" value="clear" disabled={busy}>
            清除
          </Button>
        )}
        {cancel}
      </div>
    </fetcher.Form>
  );
}
