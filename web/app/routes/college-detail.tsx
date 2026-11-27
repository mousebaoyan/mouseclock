import type { InferResponseType } from "hono/client";
import { data, Link, useFetcher, useRouteLoaderData } from "react-router";
import { cn } from "~/cn";
import { Follow } from "~/components/follow";
import { FormMessage } from "~/components/form";
import { ExternalLink } from "~/components/icons";
import { List, Row } from "~/components/list";
import { Empty, Page, Panel } from "~/components/page";
import { SchoolLogo } from "~/components/school-logo";
import { DateTime } from "~/components/time";
import { Button, buttonVariants } from "~/components/ui/button";
import { Reveal } from "~/components/ui/reveal";
import { UserAvatar } from "~/components/user-avatar";
import { ProgramCard, ProgramCards } from "~/components/program";
import { COLLEGE_KINDS, CollegeTags, pickedColor, Tag, TierTag } from "~/components/tags";
import { formText } from "../admin.server.ts";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { forgetTable } from "../table-cache.ts";
import { useNow } from "../time.ts";
import { TAG_THRESHOLD } from "../../server/modules/programs/tag-rules.ts";
import { beijingYear } from "../../server/modules/programs/time.ts";
import type { loader as rootLoader } from "../root.tsx";
import type { Route } from "./+types/college-detail.ts";

type Api = ReturnType<typeof createApi>;
type CollegeDetail = InferResponseType<Api["colleges"][":id"]["$get"], 200>;
type Votes = InferResponseType<Api["colleges"][":id"]["tags"][":tag"]["votes"]["$get"], 200>;

export function meta({ loaderData }: Route.MetaArgs) {
  const { college } = loaderData;
  return [{ title: `${college.school.name} ${college.name} · 鼠钟` }];
}

// `?votes=` opens who put a tag on, for admins (design §9.3).
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const api = context.get(apiContext).colleges[":id"];
  const tag = new URL(request.url).searchParams.get("votes");
  const [college, votes] = await Promise.all([
    api.$get({ param: { id: params.id } }).then(readApi<CollegeDetail>),
    tag === null
      ? null
      : api.tags[":tag"].votes
          .$get({ param: { id: params.id, tag } })
          .then(readApi<Votes>)
          .then((v) => ({ tag: Number(tag), votes: v.votes })),
  ]);
  return { college, votes, thisYear: beijingYear(new Date()), now: Math.floor(Date.now() / 1000) };
}

// Putting a tag on or taking it back, and for admins removing votes.
export async function action({ request, params, context }: Route.ActionArgs) {
  const api = context.get(apiContext);
  const form = await request.formData();
  const param = { id: params.id, tag: formText(form, "tag") };
  const intent = formText(form, "intent");
  const res =
    request.method === "PUT"
      ? await api.colleges[":id"].tags[":tag"].$put({ param })
      : request.method === "DELETE"
        ? await api.colleges[":id"].tags[":tag"].$delete({ param })
        : intent === "clear"
          ? await api.admin.colleges[":id"].tags[":tag"].$delete({ param })
          : await api.admin["tag-votes"][":id"].$delete({ param: { id: formText(form, "vote") } });
  if (res.status === 204) return null;
  return data({ error: (await res.json()).error.message }, res.status);
}

// The table filters by the tags that count.
export async function clientAction({ serverAction }: Route.ClientActionArgs) {
  forgetTable();
  return serverAction();
}

export default function CollegeDetail({ loaderData }: Route.ComponentProps) {
  const { college, votes, thisYear } = loaderData;
  const me = useRouteLoaderData<typeof rootLoader>("root")?.me;
  const { school } = college;
  const now = useNow(loaderData.now);
  return (
    <Page
      title={`${school.name} ${college.name}`}
      logo={<SchoolLogo school={school} size="lg" />}
      crumbs={[{ to: "/colleges", label: "院校清单" }]}
      meta={
        <>
          <TierTag tier={school.tier} />
          <CollegeTags tags={college.tags} />
          <span>{college.region}</span>
          {college.kind !== "college" && <span>{COLLEGE_KINDS[college.kind] ?? college.kind}</span>}
          {college.directions.length > 0 && <span>招生方向：{college.directions.join("、")}</span>}
        </>
      }
      actions={[
        <Follow
          key="follow"
          college={college.id}
          following={college.following}
          followers={college.followers}
          outlined
        />,
        // Not crawled yet: ask for it (design §10.1).
        !me?.muted && college.sources.every((source) => source.unavailable_reason) && (
          <Link
            key="ask"
            to={`/requests?new&college=${college.id}`}
            className={buttonVariants({ variant: "outline" })}
          >
            求收录
          </Link>
        ),
        ...college.sources.map((source) => (
          <a
            key={source.id}
            href={source.url}
            target="_blank"
            rel="nofollow noopener"
            title={source.unavailable_reason ?? source.url}
            className={buttonVariants({ variant: "outline" })}
          >
            {source.section || "学院通知"}
            {source.unavailable_reason && <Tag color="amber">暂停抓取</Tag>}
            <ExternalLink />
          </a>
        )),
      ]}
    >
      <CollegeTagPanel college={college} votes={votes} />
      {college.programs.length === 0 ? (
        <Empty>该学院尚无收录的项目</Empty>
      ) : (
        <section aria-label="历年项目">
          <ProgramCards>
            {college.programs.map((group) =>
              group.programs.map((program) => (
                <ProgramCard
                  key={program.id}
                  program={program}
                  now={now}
                  thisYear={thisYear}
                  place={<p className="text-[13px] font-medium">{group.cohort} 届</p>}
                />
              )),
            )}
          </ProgramCards>
        </section>
      )}
    </Page>
  );
}

// Every preset, how many put it on and whether one did; a click puts it on or takes it back
// (design §9.3). Muted members only see them.
function CollegeTagPanel({
  college,
  votes,
}: {
  college: CollegeDetail;
  votes: { tag: number; votes: Votes["votes"] } | null;
}) {
  const me = useRouteLoaderData<typeof rootLoader>("root")?.me;
  const opened = college.tag_counts.find((t) => t.id === votes?.tag);
  return (
    <Panel
      title="学院标签"
      description={`有人贴就显示在学院名下面；${TAG_THRESHOLD} 人以上贴的才算这个学院的标签，能用来筛选`}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {college.tag_counts.map((tag) => (
            <TagButton key={tag.id} tag={tag} muted={me?.muted ?? true} />
          ))}
        </div>
        {me?.muted && <p className="text-[13px] text-muted-foreground">禁言中，不能贴标签</p>}
        <Reveal label="这些标签是什么意思">
          <dl className="grid gap-x-4 gap-y-1.5 text-[13px] sm:grid-cols-[auto_minmax(0,1fr)]">
            {college.tag_counts.map((tag) => (
              <div key={tag.id} className="contents">
                <dt className="font-medium">{tag.name}</dt>
                <dd className="text-muted-foreground max-sm:mb-1">{tag.description}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
        {me?.can.admin && college.tag_counts.some((tag) => tag.count > 0) && (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
            谁贴的：
            {college.tag_counts
              .filter((tag) => tag.count > 0)
              .map((tag) => (
                <Link
                  key={tag.id}
                  to={tag.id === votes?.tag ? "?" : `?votes=${tag.id}`}
                  replace
                  preventScrollReset
                  className={cn(
                    "underline underline-offset-4 hover:text-primary",
                    tag.id === votes?.tag && "font-medium text-primary",
                  )}
                >
                  {tag.name}
                </Link>
              ))}
          </p>
        )}
        {votes && opened && <TagVotes tag={opened} votes={votes.votes} />}
      </div>
    </Panel>
  );
}

// While it goes it shows what it will be, until the page has the new count.
function TagButton({ tag, muted }: { tag: CollegeDetail["tag_counts"][number]; muted: boolean }) {
  const fetcher = useFetcher<typeof action>();
  const going = fetcher.formMethod === undefined ? null : fetcher.formMethod === "PUT";
  const on = going ?? tag.mine;
  const count = tag.count + (on === tag.mine ? 0 : on ? 1 : -1);
  return (
    <fetcher.Form method={on ? "delete" : "put"} className="relative">
      <input type="hidden" name="tag" value={tag.id} />
      {/* One at a time: the requests could otherwise land in another order than the clicks. */}
      <button
        type="submit"
        title={tag.description}
        aria-pressed={on}
        disabled={muted || fetcher.state !== "idle"}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px] whitespace-nowrap tabular-nums pointer-coarse:h-9 disabled:cursor-default",
          on
            ? cn("font-medium", pickedColor(tag.color))
            : "bg-card text-foreground/80 enabled:hover:border-input enabled:hover:text-foreground",
        )}
      >
        {tag.name}
        <span className="text-xs font-normal">{count}</span>
      </button>
      {fetcher.state === "idle" && fetcher.data && (
        <p
          role="alert"
          className="absolute top-full left-0 z-10 mt-1.5 w-max max-w-60 rounded-lg border bg-card px-3 py-2 text-xs shadow-card"
        >
          {fetcher.data.error}
        </p>
      )}
    </fetcher.Form>
  );
}

// Who put a tag on and when, for admins to remove what was put on at random.
function TagVotes({
  tag,
  votes,
}: {
  tag: CollegeDetail["tag_counts"][number];
  votes: Votes["votes"];
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  return (
    <div className="space-y-2.5 rounded-md border bg-muted/50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-medium">「{tag.name}」是谁贴的</p>
        {votes.length > 0 && (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="clear" />
            <input type="hidden" name="tag" value={tag.id} />
            <Button size="xs" variant="outline" disabled={busy}>
              清空这个标签
            </Button>
          </fetcher.Form>
        )}
      </div>
      <FormMessage error={fetcher.data?.error} />
      {votes.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">没有人贴</p>
      ) : (
        <List>
          {votes.map((vote) => (
            <Row
              key={vote.id}
              title={
                <span className="flex min-w-0 items-center gap-3">
                  <UserAvatar user={vote.user} className="size-7" />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">{vote.user.display_name}</span>
                    <span className="block text-xs text-muted-foreground">
                      <DateTime value={vote.created_at} />
                    </span>
                  </span>
                </span>
              }
              side={
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="remove_vote" />
                  <input type="hidden" name="vote" value={vote.id} />
                  <Button size="xs" variant="ghost" disabled={busy}>
                    删除
                  </Button>
                </fetcher.Form>
              }
            />
          ))}
        </List>
      )}
    </div>
  );
}
