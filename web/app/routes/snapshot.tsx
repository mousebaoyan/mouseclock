import type { InferResponseType } from "hono/client";
import { Link } from "react-router";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { CrawlTime, linkClass, panelClass } from "../components/admin.tsx";
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
    <main className="mx-auto max-w-4xl space-y-5 px-3 py-6 sm:px-5">
      <p className="text-sm">
        <Link to="/" className={linkClass}>
          总表
        </Link>
        <span className="text-muted-foreground"> / 快照</span>
      </p>
      <header>
        <p className="text-sm text-muted-foreground">
          快照 · <CrawlTime value={snapshot.fetched_at} /> 抓取
        </p>
        <h1 className="mt-1.5 text-xl font-semibold text-pretty">{notice.title}</h1>
        <p className="mt-2 text-sm">
          <a href={notice.url} target="_blank" rel="nofollow noopener" className={linkClass}>
            打开原文
          </a>
          {notice.removed && <span className="ml-2 text-warning">原文已删除</span>}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          鼠钟抓取时存下的原文，只留了文字、表格和链接，图片和样式都去掉了。
        </p>
      </header>
      {snapshot.attachments.length > 0 && (
        <section className={panelClass}>
          <h2 className="font-semibold">附件</h2>
          <ul className="mt-2 space-y-1.5 text-sm">
            {snapshot.attachments.map((attachment) => (
              <li key={attachment.position}>
                {attachment.size === null ? (
                  <>
                    {attachment.name}
                    <span className="text-muted-foreground">（文件还没存下来）</span>
                  </>
                ) : (
                  <>
                    <a
                      href={`/api/v1/snapshots/${snapshot.id}/attachments/${attachment.position}`}
                      download
                      className={linkClass}
                    >
                      {attachment.name}
                    </a>
                    <span className="text-muted-foreground"> · {size(attachment.size)}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <article
        className={`${panelClass} snapshot text-sm`}
        // Sanitized on the server against an allowlist (programs/sanitize.ts).
        dangerouslySetInnerHTML={{ __html: snapshot.html }}
      />
    </main>
  );
}

function size(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
