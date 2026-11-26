# 数据表

> 数据库是服务器上的 PostgreSQL 18（[总体设计 §5](design.md#5-技术选型)）。一期的表已经建好，以 `web/db/migrations/` 里的迁移为准，这里写每张表管什么、由哪个模块写；二期和三期的表，有迁移的就是已经建好的，其余的先列关键字段，做的时候照周围的写法补全。

## 约定

- 表名是英文复数，字段用 snake_case，接口的 JSON 直接用同样的名字。
- 时间都存带时区的时间戳，显示时按北京时间。只有日期的（通知的发布日期）存 `date`，读出来是 `YYYY-MM-DD` 的字符串，不转成 `Date`。
- 判断新旧和有没有变化都用原值：网址、标题、正文的文字直接比较，不算哈希。只有会话、个人令牌和抓取节点令牌存 SHA-256。
- `jsonb` 列的格式写在代码的 Zod schema 里，查询时用 `sql<类型>` 或 `$narrowType` 标上类型，和鼠洞一样。
- 每张表只由一个模块写入（[开发约定 §1](development.md#1-结构与分层)），别的模块要改就调用它的服务函数。
- 这些表都在网站的数据库里；抓取节点不存业务数据。
- 项目由管理员删除，或者在审核页并进别的项目，都做软删除（`deleted_at`），版本、快照和记录都保留。

## 账号

| 表 | 模块 | 说明 |
| --- | --- | --- |
| `users` | `accounts` | 鼠洞账号的副本（[总体设计 §6.1](design.md#61-登录)），登录时和每小时用 `mousehole_token` 刷新。`frozen` 按访客算；`muted` 为真、`muted_until` 为空是永久禁言；`qq` 只用来发邮件；`edit_revoked_at` 有值是管理员收回了在鼠钟的修改权限；`token_refused_at` 有值是刷新时鼠洞不认令牌了（封禁或收回了授权），不再收消息和邮件，也不再刷新，重新登录后清空 |
| `sessions` | `accounts` | 网页会话，只存令牌的 SHA-256 |

## 学校与来源

| 表 | 模块 | 说明 |
| --- | --- | --- |
| `schools` | `sources` | 学校：名称、简称（可以有几个，只用来搜索）、层次（`c9`、`985`、`211`、`double_first_class` 中最高的一个，没有为空） |
| `school_logos` | `sources` | 学校的校徽：图片、类型和修改时间。页面从鼠钟取校徽，不去学校的网站拿 |
| `colleges` | `sources` | 学院（泛指招生单位，`kind` 是学院、研究所或研究生院），院校清单就是这张表。`region` 是学生就读的地区：深圳校区、中科院的研究所和学校不在一地 |
| `sources` | `sources` | 一个通知列表页。`section` 是网站上的栏目名，页面上拿它称呼这个来源（抓取看板、学院页、来源管理），抓取节点用不到；`browser` 为真要用浏览器抓；`keep_all` 为真是全收，每条新通知都送去抽取，不看初筛的分数（总体设计 §8.1）；`config` 是抓取节点的配置，格式由抓取节点定，为空就用通用抓取；`unavailable_reason` 有值就是暂时抓不了，不再抓。`crawled_at` 是上一轮结束的时间，为空说明还没抓过，第一轮要往回翻页补上往年的；`leased_until` 见抓取节点接口的租约 |
| `source_probes` | `sources` | 管理员要试抓的地址，和抓取节点交回的条目、建议的配置或失败原因；`finished_at` 为空就是还在等 |

## 抓取

| 表 | 模块 | 说明 |
| --- | --- | --- |
| `crawler_tokens` | `ingest` | 抓取节点令牌，只存 SHA-256；`last_seen_at` 是最近一次领活的时间，抓取看板用 |
| `crawl_runs` | `ingest` | 一个来源每一轮的结果，抓取看板用：`failure` 为空就是列表读到了，`detail` 写具体原因；各项计数；`notice_failures` 是没抓成的通知和原因，`attachment_failures` 是抓到的通知里没读成的前 100 个附件和原因，`attachment_failure_count` 是一共几个 |
| `notices` | `ingest` | 列表里的一条通知，`(source_id, url)` 唯一。`screening_score` 和 `screened_in` 是初筛的分数和结论，为空就是还没初筛；`checked_at` 是上次抓正文的时间，重抓用；`removed_at` 有值是原文已删除。抽取出项目的才有版本，没有版本的就是无关 |
| `snapshots` | `ingest` | 某次抓到的正文，文字和上一份相同就不存新的；`extracted_at` 为空说明还没交抽取的结果 |
| `attachments` | `ingest` | 快照里的附件：名称、地址、类型、提取出的文字和文件本身。`read_from_pictures` 为真的，文字里有 LLM 从图片或扫描页读出来的部分，证据在这里的字段要审核（总体设计 §8.3）。`position` 是在页面上的顺序，证据里的 `attachment` 指的就是它；文件在抓取节点上传后才有。`failure` 不为空的没读成（总体设计 §7.4）：`download_failed` 下载不成、`too_large` 超过 10MB、`unreadable` 读不出来（文件照样存），`detail` 写具体原因，这样的没有文字；记下原因以前存的，`failure` 为空 |
| `model_calls` | `ingest` | 判别模型和 LLM 的用量，随产出的结果一起交来；中途失败、结果没交上来的随一轮的记录交来，`snapshot_id` 为空 |

## 项目

| 表 | 模块 | 说明 |
| --- | --- | --- |
| `programs` | `programs` | 一次招生活动（[总体设计 §9.1](design.md#91-学校学院和项目)）。`apply_start`、`apply_deadline` 是由报名时间字段换算出的时刻（[§8.2](design.md#82-抽取)），排序、筛选和提醒用，状态还要看活动时间和届（[§9.1](design.md#91-学校学院和项目)）；`verified_by`、`verified_at` 是已核对；`merged_into` 是并进了哪个项目，它的链接跳到那里，之前并进它的也改成指向那里 |
| `program_fields` | `programs` | 项目每个字段的当前值，`(program_id, key)` 唯一。`key` 是[总体设计 §8.2](design.md#82-抽取)里的字段名；报名时间、活动时间和其他时间每部分一行，`key` 是字段名加冒号加部分：`apply:start`、`apply:end`、`apply:rolling`，`event:start`、`event:end`、`event:mode`、`event:place`，其他时间是 `dates:` 加名称。这样每部分各带来源版本和证据，后来的通知只换它写了的部分（[§8.4](design.md#84-归并与版本)）。`value` 是抽取给的值，分部分的是那一部分的值，格式见 §8.2；`evidence` 和 `confidence` 是抽取给那个字段的。`version_id` 和 `edit_id` 有且只有一个：值来自哪个版本，或者是哪次人工修改设的；人工设的抓取不覆盖 |
| `program_versions` | `ingest` | 项目的版本：一条通知涉及几个项目，就是几个项目各自的版本。`role` 是这条通知对项目的作用，`fields` 是这一版抽出来的字段（原样留着），`changes` 是它改了的字段 |

## 纠错与审核

| 表 | 模块 | 说明 |
| --- | --- | --- |
| `edits` | `review` | 每次人工修改，包括撤销（`reverts_id`）：改的是字段（`field` 是 `program_fields` 的 `key`，分部分的字段一部分一行），或者项目的名称、届、类型；改前改后的值、理由、依据（原文或截图的链接，或者一句说明）、谁、通过网页还是 Agent；照修改申请改的，`feedback_id` 指向那条申请。改前的值为空是原来没有，改后的为空是清空。`old_version_id`、`old_edit_id` 是改前的来源，撤销时连来源一起放回去，也用来判断这次修改还在不在（[总体设计 §12.4](design.md#124-记录和撤销)）：来自哪个版本，或者是哪次修改设的；都为空是原来没有，名称、届、类型是建项目时的。撤销的理由和依据为空 |
| `review_items` | `ingest` | 审核页上待人判断的：抽取时没上表的字段（证据找不到、证据在图片里、置信度低、明显不对、和人工改的值冲突），以及没法直接归并的项目（编号或学院对不上、届不对、可能重复、报名通知没有截止、原文时间无法识别）。`payload` 是抽取出来的原样，除未识别日期只记处理结果外，通过就照它上表：字段的带 `key`，`payload` 是 `program_fields` 那一行的 `value`、`evidence` 和 `confidence`；项目的是抽取给的整个项目（编号、学院、届、类型、名称、作用和字段）；`unparsed_date` 的项目还带 `unresolved_dates` 原文和证据，其他确定字段可已合并，关闭这一待审只记处理结果，不把原文换算或写入时间值 |
| `audit_log` | `platform` | 管理员和站长的其他操作，各模块在做这件事的事务里调 `platform/audit.ts` 的 `recordAudit` 记；改的是设置的（邮件规则、发信邮箱），`target_id` 为空 |

## 二期和三期

按[总体设计 §17](design.md#二期和三期按功能分工)的功能分组，括号里是写这些表的模块。

### 消息、邮件和订阅（`reminders`）

这几张表已经建好。

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `messages` | `user_id`、`kind`、`title`、`body`、`link`、`created_at`、`seen_at` | 站内消息（[总体设计 §11.1](design.md#111-站内消息)），`seen_at` 为空是还没看过 |
| `email_rules` | `kind`、`rule` | 站长给每类消息定的邮件规则：`default_on`、`default_off`、`never`；没有记录的照总体设计 §11.1 的默认 |
| `email_settings` | `user_id`、`kind`、`enabled` | 成员自己动过的邮件开关；没动过的没有记录，跟着站长的规则 |
| `emails` | `user_id`、`message_id`、`subject`、`body`、`html`、`attempts`、`next_at`、`sent_at`、`dropped_at`、`created_at` | 待发和已发的邮件，一条消息一封，`message_id` 唯一，和消息在同一个事务里写（[总体设计 §11.2](design.md#112-邮件)）；一个人收过几封从这里数 |
| `mail_accounts` | `sort`、`host`、`port`、`username`、`password` | 发信邮箱，按 `sort` 的顺序用，`username` 也是发件地址；端口 465 一开始就走 TLS，其他的必须先用 STARTTLS 加密再登录，加密不了就不发。`password` 用 `APP_SECRET` 加密 |
| `subscriptions` | `user_id`、`program_id`、`deadline`、`deadline_value`、`remind_at`、`created_at` | 订阅，`(user_id, program_id)` 唯一（[总体设计 §11.3](design.md#113-订阅和截止提醒)）。`deadline` 和 `deadline_value` 是成员上次知道的报名截止：换算出的时刻和原文的写法，为空是没有截止。每分钟和项目的 `apply_deadline` 比一次，时刻不同了发「截止变了」，写法用来写「原为」。`remind_at` 是提醒这个截止的时候，提醒过了、订阅时已截止或没有截止为空。合并项目时挪到留下的那个，原样带着这几列 |

### 关注学院（`reminders`）

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `follows` | `user_id`、`college_id`、`created_at` | 关注学院，`(user_id, college_id)` 唯一（[总体设计 §11.4](design.md#114-关注学院)）。抓取节点不用改：一个来源每交一轮、审核把它的一个项目放好时，网站把它还没发过的通知发给关注者 |
| `announced_notices` | `notice_id`、`college_id` | 哪条通知已经告诉过哪个学院的关注者，每对只发一次。没记上的、有项目的通知就是新通知，除非来源第一轮成功读列表以前就有（往回翻补的），或者同一个网址在别的来源里先见过；建表时已经在表上的都记上，不算新的 |

### 我的报名（`programs`）

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `applications` | `user_id`、`program_id`、`stage`、`note`、`updated_at` | `(user_id, program_id)` 唯一，只有本人能看。`stage` 是想报 `want`、已报名 `applied`、已交材料 `submitted`、入营 `admitted`、优营 `excellent`、未通过 `failed`、放弃 `gave_up`；`note` 最多 1000 字，没写为空串。项目删了记录留着、不显示，合并时挪到留下的项目上（`deleteProgram`） |

### 学院标签（`programs`）

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `college_tags` | `name`、`description`、`color`、`sort` | 管理员预设的标签和说明。`name` 唯一；`color` 是页面上标签的一种颜色（`red`、`orange`、`amber`、`green`、`teal`、`sky`、`blue`、`violet`、`pink`、`gray`）；`sort` 从 1 起连着排，调一个的位置，别的跟着挪 |
| `college_tag_votes` | `college_id`、`tag_id`、`user_id`、`created_at` | 每人每个标签一票，`(college_id, tag_id, user_id)` 唯一；有人贴的都带着人数写在院校清单和学院页上，3 人以上贴的才算学院的标签（[总体设计 §9.3](design.md#93-学院标签)），总表和院校清单按它筛选，总表的 `tableVersion` 算上这张表。删预设连同它的票一起删 |

### 反馈、修改申请和争议（`review`）

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `feedback` | `program_id`、`user_id`、`kind`、`field`、`old_value`、`proposed_value`、`reason`、`basis`、`status`、`via`、`created_at`、`reviewed_by`、`reviewed_at`、`review_note` | 反馈和修改申请（[总体设计 §12.1](design.md#121-反馈)）。`kind` 是只说有问题 `problem` 还是修改申请 `edit`；`field` 是 `program_fields` 的键，或者 `name`、`cohort`、`kind`，为空是说整个项目；`old_value` 是提的时候这一处的值，审核时和现在的比，不一样就标出来；修改申请的 `proposed_value` 为空是要清空。`status` 是 `pending`、`accepted`（通过、已改正）、`rejected`（驳回、没问题）、`withdrawn`（撤回）；同一个人对同一个项目的同一处只有一条 `pending`（部分唯一索引，`field` 为空也算同一处），再提就删掉那一条、新建一条，审核的人手上的旧编号就失效了，不会通过没看过的内容；`created_at` 取写入的时刻，不取事务开始的时刻：复核时等着项目锁的反馈算在复核以后。`review_note` 只有处理了的才有，驳回的必须有。项目删了，待处理的记成 `rejected`、`review_note` 写「项目已删除」 |
| `disputes` | `program_id`、`opened_at`、`resolved_by`、`resolved_at`、`result`、`note` | 每次争议一行，`resolved_at` 为空是还在争议中，一个项目同时只有一条；`result` 是改正了 `corrected` 还是确认没错 `confirmed`；争议的人数从上一次的 `resolved_at` 以后数，`resolved_at` 和反馈的 `created_at` 一样取写入的时刻（[总体设计 §12.3](design.md#123-争议)） |

### 求收录（`sources`）

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `inclusion_requests` | `school_id`、`school_name`、`college_id`、`college_name`、`url_hint`、`note`、`user_id`、`status`、`reason`、`created_at`、`resolved_at` | 求收录（[总体设计 §10.1](design.md#101-求收录)）。选了清单里的学院的只有 `college_id`；清单里没有的学院写 `college_name`，学校是清单里的填 `school_id`，不是的写 `school_name`；管理员对上清单后换成编号。每个学院只有一条（`college_id`、`(school_id, college_name)`、`(school_name, college_name)` 各自唯一），再提算同求。关注了还没收录、也没人提过的学院时，替关注的人建一条。`status` 是排队中 `queued`、接入中 `onboarding`、已收录 `included`、暂时抓不了 `unavailable`（`reason` 写原因），后两种有 `resolved_at`，已收录的一定对上了 `college_id`。学院有了在抓的来源（没有 `unavailable_reason`）就算已收录。排队中的没人同求了就删掉，接入中的改回排队中时也是 |
| `inclusion_votes` | `request_id`、`user_id`、`created_at` | 同求，提的人自己也有一行；合并时挪到留下的那条，同一个人只留一行。关注了这个学院的人不存在这里，数人数时和它合在一起，同一个人只算一次 |

### Agent 接入（`accounts`）

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `api_tokens` | `user_id`、`name`、`token_hash`、`scope`、`created_at`、`last_used_at`、`revoked_at` | 个人令牌（[总体设计 §13](design.md#13-agent-接入)），只存 SHA-256；`scope` 是只能查询的 `read`，或者还能做个人操作的 `personal`。`last_used_at` 一小时内只写一次；没作废、最后一次用（没用过的按生成）在 90 天内的才能用，每人最多 10 个这样的；在鼠洞被封禁的，刷新时全部作废 |

## 热点查询

| 查询 | 怎么查 |
| --- | --- |
| 总表 | 按届、类型筛选，按 `apply_deadline` 排序：`programs_table (cohort, kind, apply_deadline)` |
| 抽取对照的项目、学院页 | 某所学校几届的项目：`programs_college (college_id, cohort)` |
| 新通知 | 列表里的网址见没见过：`notices (source_id, url)` 唯一 |
| 最新的快照 | `snapshots_notice (notice_id, id)` |
| 通知的版本 | `program_versions_snapshot (snapshot_id)` |
| 修改记录 | 项目的：`edits_program (program_id, id)`；某人的：`edits_user (user_id, id)`；全站最近的按主键倒着取 |
| 审核页 | 待处理的：`review_items_pending (id) WHERE status = 'pending'` |
| 抓取看板 | 某天各来源的结果：`crawl_runs_started (started_at)`；某个来源最近几轮：`crawl_runs (source_id, started_at)` 唯一；用量：`model_calls_created (created_at)` |
