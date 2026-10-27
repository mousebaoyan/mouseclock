# 数据表

> 状态：草案。数据库是服务器上的 PostgreSQL 18（[总体设计 §5](design.md#5-技术选型)）。这里先列表和关键字段，各模块实现时写成迁移，之后以迁移为准。

## 约定

- 表名是英文复数，字段用 snake_case，接口的 JSON 直接用同样的名字。
- 时间都存带时区的时间戳，显示时按北京时间。
- 判断新旧和有没有变化都用原值：网址、标题、正文的文字直接比较，不算哈希。只有会话、个人令牌和抓取节点令牌存 SHA-256。
- 这些表都在网站的数据库里；抓取节点不存业务数据。
- 项目只由管理员删除，做软删除（`deleted_at`），版本、快照和记录都保留。

## 学校与来源

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `schools` | `name`、`short_name`、`tiers`（C9、985、211、双一流……）、`region` | 学校 |
| `colleges` | `school_id`、`name`、`kind`（学院、研究所、研究生院）、`directions` | 招生单位，院校清单就是这张表；没接入来源的也在里面 |
| `sources` | `college_id`、`url`、`method`（`generic`、`config`、`browser`、`adapter`）、`template`、`config`、`unavailable_reason` | 一个通知列表页；`unavailable_reason` 有值就是暂时抓不了 |
| `crawl_runs` | `source_id`、`started_at`、`finished_at`、`ok`、`error`、`listed`、`new_count`、`useful_count` | 每一轮抓取的结果，抓取看板用 |
| `source_probes` | `url`、`config`、`requested_by`、`status`、`listed`、`suggested_config`、`error` | 管理员要试抓的来源和抓取节点交回的结果 |
| `crawler_tokens` | `name`、`token_hash`、`last_seen_at`、`revoked_at` | 抓取节点令牌；`last_seen_at` 是最近一次领活的时间，抓取看板用 |

## 通知与快照

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `notices` | `source_id`、`url`、`title`、`published_at`、`first_seen_at`、`removed_at`、`screening_score`、`category`（报名、补充、延期、名单或结果、无关） | 列表里的一条通知；`(source_id, url)` 唯一 |
| `snapshots` | `notice_id`、`fetched_at`、`html`、`text`、`attachments`（文件名、类型、存放位置、提取出的文字） | 每次抓到的正文和附件；文字和上一份相同就不存 |
| `model_calls` | `purpose`（初筛、抽取、生成配置）、`notice_id`、`model`、`input_tokens`、`output_tokens`、`created_at` | 判别模型和 LLM 的用量 |

## 项目

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `programs` | `college_id`、`year`、`kind`（冬令营、夏令营、预推免、九推）、`title`、`apply_start`、`apply_deadline`、`verified_by`、`verified_at`、`disputed_at`、`dispute_cleared_at`、`deleted_at` | 一次招生活动；排序、筛选和提醒要用的时间单独存成列 |
| `program_fields` | `program_id`、`key`、`value`、`evidence`、`confidence`、`version_id`、`edit_id` | 每个字段一行，带证据和来源的版本；`edit_id` 有值说明是人工改的，抓取不覆盖 |
| `program_versions` | `program_id`、`notice_id`、`snapshot_id`、`number`、`kind`（首发、补充、延期、重发）、`changes` | 项目的版本；`changes` 是和上一版相比改了的字段 |

## 用户

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `users` | `mousehole_id`、`display_name`、`avatar_url`、`level`、`role`、`muted`、`frozen`、`qq`、`edit_revoked_at`、`synced_at` | 鼠洞账号的副本，登录时和每小时更新；`edit_revoked_at` 有值就是被收回了修改权限 |
| `sessions` | `user_id`、`token_hash`、`expires_at` | 网页会话 |
| `api_tokens` | `user_id`、`name`、`token_hash`、`scopes`、`last_used_at`、`revoked_at` | 个人令牌 |
| `email_settings` | `user_id`、`kind`、`enabled` | 每类邮件的开关，没有记录就是开 |

## 订阅、关注和报名

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `subscriptions` | `user_id`、`program_id`、`reminded_at` | 订阅；项目截止了就不占名额 |
| `follows` | `user_id`、`college_id` | 关注学院 |
| `applications` | `user_id`、`program_id`、`stage`、`note` | 我的报名，只有本人能看 |
| `college_tags` | `name`、`sort` | 学院标签的预设 |
| `college_tag_votes` | `college_id`、`tag_id`、`user_id` | 每人每个标签一票 |

## 纠错与审核

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `feedback` | `program_id`、`user_id`、`field`、`proposed_value`、`reason`、`evidence`、`status`（待审、通过、驳回）、`reviewed_by`、`reviewed_at`、`review_note` | 反馈和修改申请；`proposed_value` 为空就是只说有问题 |
| `edits` | `program_id`、`field`、`old_value`、`new_value`、`reason`、`evidence`、`user_id`、`via`（`web`、`agent`）、`feedback_id`、`reverts_id` | 每次人工修改，包括审核通过的申请和撤销 |
| `audit_log` | `user_id`、`action`、`target_type`、`target_id`、`detail`、`created_at` | 管理员和站长的其他操作 |

## 求收录

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `inclusion_requests` | `school_id`、`college_id`、`college_name`、`url_hint`、`user_id`、`status`（排队中、接入中、已收录、暂时抓不了）、`reason` | 院校清单里没有的学院，`college_id` 为空，只填名字 |
| `inclusion_votes` | `request_id`、`user_id` | 同求 |

## 邮件

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `emails` | `user_id`、`kind`、`subject`、`body`、`status`、`attempts`、`send_after` | 待发和已发的邮件 |

## 热点查询

| 查询 | 怎么查 |
| --- | --- |
| 总表 | 按年份、类型筛选，按 `apply_deadline` 排序：`programs (year, kind, apply_deadline)` |
| 截止提醒 | 3 天后截止的项目的订阅：`programs (apply_deadline)`、`subscriptions (program_id)` |
| 订阅上限 | 某人订阅的、还没截止的项目有几个：`subscriptions (user_id)` |
| 新通知 | 列表里的网址见没见过：`notices (source_id, url)` 唯一 |
| 争议 | 某个项目 `dispute_cleared_at` 之后有几个不同的人反馈：`feedback (program_id, created_at)` |
| 抓取看板 | 某天各来源的结果：`crawl_runs (started_at)` |
