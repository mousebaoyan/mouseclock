import type { InferResponseType } from "hono/client";
import { ExternalLink } from "~/components/icons";
import { Page, Panel } from "~/components/page";
import { DateTime } from "~/components/time";
import { buttonVariants } from "~/components/ui/button";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import type { Route } from "./+types/snapshot.ts";

type Snapshot = InferResponseType<ReturnType<typeof createApi>["snapshots"][":id"]["$get"], 200>;

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `快照 · ${loaderData.snapshot.notice.title} · 鼠钟` }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const snapshot = await readApi<Snapshot>(
    await context.get(apiContext).snapshots[":id"].$get({ param: { id: params.id } }),
  );
  return { snapshot };
}

export default function SnapshotPage({ loaderData }: Route.ComponentProps) {
  const { snapshot } = loaderData;
  const { notice } = snapshot;
  return (
    <Page
      title={notice.title}
      crumbs={[{ to: "/", label: "项目总表" }]}
      description={
        <>
          通知快照，抓取于 <DateTime value={snapshot.fetched_at} />
        </>
      }
      actions={
        <a
          href={notice.url}
          target="_blank"
          rel="nofollow noopener"
          className={buttonVariants({ variant: "outline" })}
        >
          打开原文
          <ExternalLink />
        </a>
      }
    >
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <article
          className="snapshot min-w-0 rounded-xl border bg-card shadow-card p-5 text-sm sm:p-7"
          // Sanitized on the server against an allowlist (programs/sanitize.ts).
          dangerouslySetInnerHTML={{ __html: snapshot.html }}
        />
        <aside className="space-y-4 lg:sticky lg:top-20">
          <Panel title="关于快照">
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              快照是鼠钟抓取时保存的原文，仅保留文字、表格和链接，不含图片与样式。
            </p>
            {notice.removed && (
              <p className="mt-3 rounded-md bg-warning/8 px-3 py-2 text-[13px] text-warning">
                原文已被删除。
              </p>
            )}
          </Panel>
          {snapshot.attachments.length > 0 && (
            <Panel title="附件" flush>
              <ul className="divide-y text-[13px]">
                {snapshot.attachments.map((attachment) => (
                  <li key={attachment.position} className="px-4 py-2.5">
                    {attachment.size === null ? (
                      <>
                        {attachment.name}
                        <span className="block text-xs text-muted-foreground">文件尚未保存</span>
                      </>
                    ) : (
                      <>
                        <a
                          href={`/api/v1/snapshots/${snapshot.id}/attachments/${attachment.position}`}
                          download
                          className="link break-all"
                        >
                          {attachment.name}
                        </a>
                        <span className="block text-xs text-muted-foreground">
                          {size(attachment.size)}
                        </span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </aside>
      </div>
    </Page>
  );
}

function size(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
