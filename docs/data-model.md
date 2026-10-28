# 数据表

> 数据库是服务器上的 PostgreSQL 18（[总体设计 §5](design.md#5-技术选型)）。一期的表已经建好，以 `web/db/migrations/` 里的迁移为准，这里写每张表管什么、由哪个模块写；二期的表还没建，先列关键字段。

## 约定

- 表名是英文复数，字段用 snake_case，接口的 JSON 直接用同样的名字。
- 时间都存带时区的时间戳，显示时按北京时间。只有日期的（通知的发布日期）存 `date`，读出来是 `YYYY-MM-DD` 的字符串，不转成 `Date`。
- 判断新旧和有没有变化都用原值：网址、标题、正文的文字直接比较，不算哈希。只有会话、个人令牌和抓取节点令牌存 SHA-256。
- `jsonb` 列的格式写在代码的 Zod schema 里，查询时用 `sql<类型>` 或 `$narrowType` 标上类型，和鼠洞一样。
- 每张表只由一个模块写入（[开发约定 §1](development.md#1-结构与分层)），别的模块要改就调用它的服务函数。
- 这些表都在网站的数据库里；抓取节点不存业务数据。
- 项目只由管理员删除，做软删除（`deleted_at`），版本、快照和记录都保留。

## 账号

| 表 | 模块 | 说明 |
| --- | --- | --- |
| `users` | `accounts` | 鼠洞账号的副本（[总体设计 §6.1](design.md#61-登录)），登录时和每小时用 `mousehole_token` 刷新。`frozen` 按访客算；`muted` 为真、`muted_until` 为空是永久禁言；`qq` 只用来发邮件；`edit_revoked_at` 有值是管理员收回了在鼠钟的修改权限 |
| `sessions` | `accounts` | 网页会话，只存令牌的 SHA-256 |

## 学校与来源

| 表 | 模块 | 说明 |
| --- | --- | --- |
| `schools` | `sources` | 学校：名称、简称、层次（`c9`、`985`、`211`、`double_first_class`，可以有几个） |
| `colleges` | `sources` | 学院（泛指招生单位，`kind` 是学院、研究所或研究生院），院校清单就是这张表。`region` 是学生就读的地区：深圳校区、中科院的研究所和学校不在一地 |
| `sources` | `sources` | 一个通知列表页。`section` 是网站上的栏目名，初筛时一起看；`browser` 为真要用浏览器抓；`config` 是抓取节点的配置，格式由抓取节点定，为空就用通用抓取；`unavailable_reason` 有值就是暂时抓不了，不再抓。`crawled_at` 是上一轮结束的时间，为空说明还没抓过，第一轮要往回翻页补上往年的；`leased_until` 见抓取节点接口的租约 |
| `source_probes` | `sources` | 管理员要试抓的地址，和抓取节点交回的条目、建议的配置或失败原因；`finished_at` 为空就是还在等 |

## 抓取

| 表 | 模块 | 说明 |
| --- | --- | --- |
| `crawler_tokens` | `ingest` | 抓取节点令牌，只存 SHA-256；`last_seen_at` 是最近一次领活的时间，抓取看板用 |
| `crawl_runs` | `ingest` | 一个来源每一轮的结果，抓取看板用：`failure` 为空就是列表读到了，`detail` 写具体原因；各项计数；`notice_failures` 是没抓成的通知和原因 |
| `notices` | `ingest` | 列表里的一条通知，`(source_id, url)` 唯一。`screening_score` 和 `screened_in` 是初筛的分数和结论，为空就是还没初筛；`checked_at` 是上次抓正文的时间，重抓用；`removed_at` 有值是原文已删除。抽取出项目的才有版本，没有版本的就是无关 |
| `snapshots` | `ingest` | 某次抓到的正文，文字和上一份相同就不存新的；`extracted_at` 为空说明还没交抽取的结果 |
| `attachments` | `ingest` | 快照里的附件：名称、地址、类型、提取出的文字和文件本身。`position` 是在页面上的顺序，证据里的 `attachment` 指的就是它；文件在抓取节点上传后才有 |
| `model_calls` | `ingest` | 判别模型和 LLM 的用量，随产出的结果一起交来 |

## 项目

| 表 | 模块 | 说明 |
| --- | --- | --- |
| `programs` | `programs` | 一次招生活动（[总体设计 §9.1](design.md#91-学校学院和项目)）。`apply_start`、`apply_deadline` 是由报名时间字段换算出的时刻（[§8.2](design.md#82-抽取)），状态、排序、筛选和提醒用；`verified_by`、`verified_at` 是已核对 |
| `program_fields` | `programs` | 项目每个字段的当前值，`(program_id, key)` 唯一。`key` 是[总体设计 §8.2](design.md#82-抽取)里的字段名；报名时间、活动时间和其他时间每部分一行，`key` 是字段名加冒号加部分：`apply:start`、`apply:end`、`apply:rolling`，`event:start`、`event:end`、`event:mode`、`event:place`，其他时间是 `dates:` 加名称。这样每部分各带来源版本和证据，后来的通知只换它写了的部分（[§8.4](design.md#84-归并与版本)）。`value` 是抽取给的值，分部分的是那一部分的值，格式见 §8.2；`evidence` 和 `confidence` 是抽取给那个字段的。`version_id` 和 `edit_id` 有且只有一个：值来自哪个版本，或者是哪次人工修改设的；人工设的抓取不覆盖 |
| `program_versions` | `ingest` | 项目的版本：一条通知涉及几个项目，就是几个项目各自的版本。`role` 是这条通知对项目的作用，`fields` 是这一版抽出来的字段（原样留着），`changes` 是它改了的字段 |

## 纠错与审核

| 表 | 模块 | 说明 |
| --- | --- | --- |
| `edits` | `review` | 每次人工修改，包括撤销（`reverts_id`）：改的是字段，或者项目的名称、届、类型；改前改后的值、理由、依据（原文链接或截图）、谁、通过网页还是 Agent |
| `review_items` | `review` | 审核页上待人判断的：抽取时没上表的字段（证据找不到、置信度低、明显不对、和人工改的值冲突），以及没法直接归并的项目（编号或学院对不上、届不对、可能重复、报名通知没有截止）。`payload` 是抽取出来的原样，通过就照它上表：字段的带 `key`，`payload` 是 `program_fields` 那一行的 `value`、`evidence` 和 `confidence`；项目的是抽取给的整个项目（编号、学院、届、类型、名称、作用和字段） |
| `audit_log` | `review` | 管理员和站长的其他操作，别的模块调 `review` 的服务函数记 |

## 二期：订阅、关注和报名（还没建）

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `subscriptions` | `user_id`、`program_id`、`reminded_at` | 订阅；项目截止了就不占名额 |
| `follows` | `user_id`、`college_id` | 关注学院 |
| `applications` | `user_id`、`program_id`、`stage`、`note` | 我的报名，只有本人能看 |
| `college_tags` | `name`、`sort` | 学院标签的预设 |
| `college_tag_votes` | `college_id`、`tag_id`、`user_id` | 每人每个标签一票 |
| `email_settings` | `user_id`、`kind`、`enabled` | 每类邮件的开关，没有记录就是开 |
| `emails` | `user_id`、`kind`、`subject`、`body`、`status`、`attempts`、`send_after` | 待发和已发的邮件 |
| `feedback` | `program_id`、`user_id`、`field`、`proposed_value`、`reason`、`basis`、`status`（待审、通过、驳回）、`reviewed_by`、`reviewed_at`、`review_note` | 反馈和修改申请；`proposed_value` 为空就是只说有问题。上线后 `edits` 加 `feedback_id`，`programs` 加争议的 `disputed_at`、`dispute_cleared_at` |
| `inclusion_requests` | `school_id`、`college_id`、`college_name`、`url_hint`、`user_id`、`status`（排队中、接入中、已收录、暂时抓不了）、`reason` | 求收录；院校清单里没有的学院，`college_id` 为空，只填名字 |
| `inclusion_votes` | `request_id`、`user_id` | 同求 |

## 三期：Agent（还没建）

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `api_tokens` | `user_id`、`name`、`token_hash`、`scopes`、`last_used_at`、`revoked_at` | 个人令牌 |

## 热点查询

| 查询 | 怎么查 |
| --- | --- |
| 总表 | 按届、类型筛选，按 `apply_deadline` 排序：`programs_table (cohort, kind, apply_deadline)` |
| 抽取对照的项目、学院页 | 某所学校几届的项目：`programs_college (college_id, cohort)` |
| 新通知 | 列表里的网址见没见过：`notices (source_id, url)` 唯一 |
| 最新的快照 | `snapshots_notice (notice_id, id)` |
| 通知的版本 | `program_versions_snapshot (snapshot_id)` |
| 修改记录 | 项目的：`edits_program (program_id, id)`；某人的：`edits_user (user_id, id)`；全站最近的：`edits_recent (created_at)` |
| 审核页 | 待处理的：`review_items_pending (id) WHERE status = 'pending'` |
| 抓取看板 | 某天各来源的结果：`crawl_runs_started (started_at)`；某个来源最近几轮：`crawl_runs (source_id, started_at)` 唯一；用量：`model_calls_created (created_at)` |
