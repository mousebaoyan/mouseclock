# 接口

> 状态：草案，只列约定和清单。请求和返回的格式写在代码里的 Zod schema 里，由它生成 OpenAPI 文档，不在这里重复。

## 1. 约定

- 前缀 `/api/v1`，请求和返回都是 JSON（下载的文件除外），字段用 snake_case，时间用 Unix 秒，和鼠洞一样。
- 错误统一返回 `{ "error": { "code": "...", "message": "..." } }`：`code` 是英文，给程序判断；`message` 是中文，给人看。
- **认证**：网页用会话 Cookie；Agent 和脚本用个人令牌，`Authorization: Bearer <令牌>`；抓取节点用抓取节点令牌（第 6 节）。带 `Authorization: Bearer` 的请求只按令牌认人，不看会话 Cookie；令牌不对、作废了或者 90 天没用过的返回 `401 invalid_token`。
- **令牌的权限范围**：`read` 只能查询；`personal` 还能订阅、关注、记报名、提交反馈和修改申请，`read` 的令牌调这些返回 `403 token_scope`。直接修改、审核、管理和管令牌的接口只认网页会话，带令牌调用返回 `403 web_only`。通过令牌提的反馈记成「通过 Agent」，每人 24 小时内最多 10 条，超了返回 `429 agent_feedback_limit`。
- **权限**（[总体设计 §6.2](design.md#62-权限)）：访客调总表 `GET /programs` 只拿到预览，清单里写着「不用登录」的谁都能调，调别的接口返回 `401 login_required`；冻结的按访客算，返回 `403 member_frozen`；禁言中的做不了的返回 `403 muted`，等级不够的 `403 level_required`，修改权限被收回的 `403 edit_revoked`，不是管理员或站长的 `403 forbidden`。
- **频率限制**：每个令牌每分钟最多 60 次，超了返回 `429 rate_limited`，`Retry-After` 是要等的秒数。MCP 的一次请求算一次，工具在里面调的接口不另算。
- **分页**：列表用 `page` 和 `per_page`（20、50 或 100，默认 20），返回这一页的 `items` 和全部的条数 `total`。

## 2. 鼠洞登录

鼠洞是 OAuth 2.1 的授权服务器，鼠钟是在鼠洞登记的自家应用，有密钥，范围只要 `profile`。鼠洞那边的地址和参数见鼠洞的[接口 §8.3](https://github.com/mousebaoyan/mousehole/blob/main/docs/api.md#83-oauth-授权)，这里写鼠钟这边：

| 步骤 | 做什么 |
| --- | --- |
| 1 | `GET /login?next=<路径>`：生成 `state` 和 PKCE 的 `code_verifier`，连同 `next` 放进 10 分钟有效的 Cookie，跳到鼠洞的 `/oauth/authorize`，回调地址是 `/login/callback` |
| 2 | 鼠洞跳回 `/login/callback`，带 `code`、`state`、`iss`；`state` 和 Cookie 里的、`iss` 和鼠洞的地址对不上的不认，按访客跳回 `next` |
| 3 | 鼠钟的服务端调鼠洞的 `/oauth/token` 换令牌，再调 `/api/v1/me` 取资料：鼠洞用户 ID、名字、头像、等级、角色、冻结、禁言、QQ 号 |
| 4 | 写进 `users`，建鼠钟的会话，跳回 `next` |

- **自动登录**：没有会话的浏览器打开页面（`Sec-Fetch-Mode: navigate`、`Sec-Fetch-Dest: document`）时，直接走第 1 步，带 `prompt=none`。没登录鼠洞的，鼠洞带着 `error=login_required` 跳回，按访客显示。一个浏览器会话里只自动试一次，退出后也不再自动登录；搜索引擎和脚本不带这两个请求头，不跳。
- **点「登录」**：`GET /login`，不带 `prompt=none`，没登录鼠洞的先在鼠洞登录。
- **会话**：Cookie `mouseclock_session`，HttpOnly、SameSite=Lax，90 天有效，超过一小时没用过的会话在下次使用时续期。名字带前缀，本地开发时不和同在 `localhost` 的鼠洞的 `session` 混在一起。
- **刷新**：令牌存在 `users` 里，每小时用它调一次鼠洞的 `/me` 更新资料，登录着的、有订阅或关注的、有个人令牌的都刷新；鼠洞返回 `401 invalid_token`（被封禁或撤销了授权）时，删掉这个人的所有会话，作废这个人的个人令牌。
- **退出**：`POST /auth/logout`，只退出鼠钟，鼠洞的登录不受影响。
- **CSRF**：网页的写请求校验 Origin，和鼠洞一样；带令牌的请求不受影响。

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/me` | 自己的资料：`id`、`display_name`、`avatar_url`（鼠洞上的绝对地址，没有为 `null`）、`level`、`role`、`frozen`、`muted`、`muted_until`（禁言到什么时候，没禁言或永久禁言为 `null`）、`unseen_messages`（没看过的消息条数，顶栏的铃铛用），以及 `can`：`edit`、`admin`、`owner`，按[总体设计 §6.2](design.md#62-权限) 算好，页面据此显示按钮 | 已登录，冻结了也可以 |
| POST | `/auth/logout` | 退出当前会话；没有登录时也返回成功 | 访客 |

## 3. 接口清单（草案）

| 分组 | 接口 | 说明 |
| --- | --- | --- |
| 项目 | `GET /programs?cohort=` | 总表：一届的全部项目，按截止时间排好，只带总表用得上的字段，包括订阅人数、有没有争议和学院 3 人以上贴的标签；筛选、排序、搜索和分页在浏览器里做（[总体设计 §14](design.md#14-性能与资源)）。登录后的响应带 `ETag`，数据没变时返回 `304`；访客只拿到预览。读不了一整届的（比如 Agent）可以带 `q`（学校名、简称、学院名或项目名里有它）、`kind`、`closed`（是否已截止）让服务端先筛，网页不用；带了的不带 `ETag`，访客也只在预览里筛 |
| | `GET /programs/{id}` | 详情：原文、字段和证据、已核对、订阅人数、有没有争议和待处理的反馈有几条；分部分的字段（报名时间、活动时间、其他时间）每部分各带证据和来自哪一版。并进了别的项目的返回 `308`，`Location` 是留下的那个，body 是 `{ merged_into }` |
| | `GET /programs/{id}/versions` | 版本：各版的通知、作用、改了哪些字段、快照和附件，最新的在前 |
| | `GET /snapshots/{id}`、`GET /snapshots/{id}/attachments/{position}` | 快照：净化过的正文和附件列表；下载附件 |
| | `GET /programs/{id}/edits` | 修改记录：修改、撤销和争议的复核，最新的在前 |
| 学院 | `GET /colleges`、`GET /colleges/{id}` | 院校清单、学院页。学院带 3 人以上贴的标签；学院页还带关注人数、每个标签几个人贴了，以及自己关注没有、贴了哪些 |
| | `GET /schools/{id}/logo` | 校徽图片，不用登录。学校的 `logo` 字段就是这个地址，带着最后修改的时间（`?v=`），换了图片地址就变，所以响应可以一直缓存；SVG 加了 `sandbox`，单独打开也不会运行脚本 |
| 消息 | `GET /messages` | 自己的消息，最新的在前，分页；每条带 `seen`，这一次新来的为 `false`（[总体设计 §11.1](design.md#111-站内消息)） |
| | `POST /messages/seen` | `{ up_to }`：把这一条和更早的标成看过了；消息页打开后，用页上最新的那条调，之后才到的不受影响 |
| 订阅和关注 | `PUT`、`DELETE /programs/{id}/subscription` | 订阅、取消；到了上限返回 `409 subscription_limit`；订阅时已过提醒时候、还没截止的，马上来一条「快截止了」（[总体设计 §11.3](design.md#113-订阅和截止提醒)） |
| | `GET /me/subscriptions` | 自己订阅的项目，字段同总表，还没截止的按截止排在前，截止了的在后；以及最多能订几个（`limit`）。「我的 · 订阅」和总表卡片上的「已订阅」用 |
| | `DELETE /me/subscriptions/closed` | 取消全部已截止的订阅 |
| | `PUT`、`DELETE /colleges/{id}/follow` | 关注、取消（[总体设计 §11.4](design.md#114-关注学院)）；关注还没收录的学院，算替它求收录 |
| | `GET /me/follows?cohort=` | 自己关注的学院，每个带 `cohort` 这一届的项目数、最近一条通知的日期，没收录的带求收录的进度；院校清单上的「已关注」也用它 |
| 我的报名 | `PUT`、`DELETE /programs/{id}/application` | 记报名：进度和备注；清除（[总体设计 §9.4](design.md#94-我的报名)） |
| | `GET /me/applications?stage=` | 自己的报名记录，带各进度的条数；总表卡片上的进度也用它 |
| 学院标签 | `PUT`、`DELETE /colleges/{id}/tags/{tag}` | 贴标签、撤回（[总体设计 §9.3](design.md#93-学院标签)） |
| | `GET /colleges/{id}/tags/{tag}/votes` | 谁、什么时候贴的，管理员 |
| | `DELETE /admin/tag-votes/{id}`、`DELETE /admin/colleges/{id}/tags/{tag}` | 管理员删一票、清空这个学院的这个标签；记进操作日志 |
| 反馈和修改 | `POST /programs/{id}/feedback` | 反馈或修改申请（[总体设计 §12.1](design.md#121-反馈)）：`kind` 是只说有问题 `problem` 还是修改申请 `edit`，说的是哪一处（`field`，为空是整个项目，只有 `problem` 能为空），修改申请再带改成什么（`value`，`null` 是清空，名称、届、类型不能清空），以及理由和依据（修改申请必填）；这个人对这一处已有待处理的，换掉那一条，返回新的编号 |
| | `GET /programs/{id}/feedback` | 这个项目待处理的反馈 |
| | `GET /feedback/{id}` | 一条反馈和它的处理结果，修改记录里链接到的申请用它打开；成员都能看 |
| | `DELETE /feedback/{id}` | 撤回自己待处理的反馈 |
| | `GET /me/feedback` | 自己提过的反馈和处理结果，分页 |
| | `PATCH /programs/{id}` | 直接修改，L3 以上，只认网页会话：改字段，或者项目的名称、届、类型，写明理由和依据；值为 `null` 是清空。分部分的字段只记改了的部分，每个改了的字段或部分记一条（[总体设计 §12.4](design.md#124-记录和撤销)）；值和现在一样返回 `400 no_change` |
| | `POST /edits/{id}/revert` | 撤销一次修改，L3 以上，只认网页会话：字段连同来源回到修改前；这一项之后又改过或撤销过的返回 `409 edit_superseded`，先撤销后来的那次 |
| | `GET /edits` | 全站最近的修改，「修改记录」页用，分页 |
| 审核 | `GET /review-items?reason=` | 抽取拿不准的字段和归并，一次列一种，带各种的条数；L3 以上，只认网页会话 |
| | `POST /review-items/{id}/accept`、`POST /review-items/{id}/reject` | 通过或驳回，效果见[总体设计 §12.2](design.md#122-审核)；通过时，对不上的项目要从这所学校里选好放到哪，可能重复的选出原来的那个；用不上的选择返回 400 |
| | `GET /feedback` | 待处理的反馈，先提的在前，分页，审核页用：每条带这一处现在的值和来源（`current_version`），提了以后又变过的标出来（`changed`）。L3 以上，只认网页会话 |
| | `POST /feedback/{id}/accept`、`POST /feedback/{id}/reject` | 处理反馈（[总体设计 §12.2](design.md#122-审核)）：修改申请通过就照申请改，只说有问题的是「已改正」；驳回和「没问题」要带 `{ note }`。L3 以上，只认网页会话；处理自己提的返回 `403 own_feedback` |
| | `POST /programs/{id}/verify` | 标记已核对，L3 以上，只认网页会话 |
| | `GET /disputes` | 有争议的项目和上次复核以后的反馈，各带现在的状态，审核页用；管理员 |
| | `POST /disputes/{id}/resolve` | 复核这条争议，管理员，只认网页会话：带 `{ result, note }`，`result` 是改正了 `corrected` 还是确认没错 `confirmed`；这个项目待处理的反馈照它一起关掉（[总体设计 §12.3](design.md#123-争议)）。已经复核过的返回 `409 already_resolved` |
| | `DELETE /programs/{id}` | 删除项目，管理员，只认网页会话：带 `{ reason }`，理由必填。软删除，版本、快照和记录都留着，它待审的条目一起关掉，记进操作日志 |
| 求收录 | `GET /inclusion-requests?status=`、`POST /inclusion-requests` | 列表、提交（[总体设计 §10.1](design.md#101-求收录)）：学院已收录的返回 `409 already_included`；有人提过、还没收录的算同求，返回那一条。列表里关注着这个学院的也算同求：`votes` 每人算一次，`mine` 是自己同求了或关注着，`following` 是关注着 |
| | `PUT`、`DELETE /inclusion-requests/{id}/vote` | 同求、撤回；撤回只撤自己点的那一票，关注算的那一票取消关注才撤 |
| | `PATCH /admin/inclusion-requests/{id}`、`POST /admin/inclusion-requests/{id}/merge` | 管理员改进度和原因、对上清单里的学校和学院；把一条并进另一条（`{ into }`），同求合在一起；对上了学院的不能并进没对上的（`409 merge_into_matched`）。都记进操作日志 |
| 抓取看板 | `GET /crawl-runs?date=&source_id=` | 某天（北京时间，默认今天）各来源的各轮结果和用量，标红、标黄的在前，分页；带这一天按用途和模型的总用量，以及抓取节点上次来领活的时间。`source_id` 只看一个来源。登录后能看（[总体设计 §7.5](design.md#75-抓取看板)） |
| 我的 | `GET`、`PATCH /me/email-settings` | 每类消息发不发邮件：站长定成不发的不列，没动过的带站长的默认；也说能不能收邮件，没有 QQ 号的收不到（[总体设计 §11.2](design.md#112-邮件)）。`PATCH` 只改给出的几类 |
| | `GET`、`POST /me/tokens`，`DELETE /me/tokens/{id}` | 个人令牌，只认网页会话：列出还能用的；生成时返回的令牌只出现这一次，每人最多 10 个（[总体设计 §13](design.md#13-agent-接入)） |
| 数据下载 | `GET /export?cohort=&format=` | 一届的全部项目，`csv` 或 `json`，作为文件下载，登录后可用；和总表一样带 ETag（[总体设计 §13](design.md#13-agent-接入)） |
| 群汇总 | `GET /bot/summary` | `{ text }`：写好的整段汇总，没什么可发时为 `null`（[总体设计 §11.5](design.md#115-群汇总)）。不用登录 |
| 管理 | `GET`、`POST /admin/schools`，`GET`、`PATCH /admin/schools/{id}` | 管理员查询、新增、修改学校 |
| | `PUT`、`DELETE /admin/schools/{id}/logo` | 管理员上传、更换或移除校徽：请求体就是图片本身，PNG、JPEG、WebP 或 SVG，不超过 16 KB |
| | `GET`、`POST /admin/colleges`，`GET`、`PATCH /admin/colleges/{id}` | 管理员查询、新增、修改学院 |
| | `GET`、`POST /admin/sources`，`GET`、`PATCH /admin/sources/{id}` | 管理员查询、接入、配置来源，暂停或恢复抓取 |
| | `POST /admin/source-probes`，`GET /admin/source-probes/{id}` | 管理员发起试抓（网址、要不要浏览器、可选的配置），查看结果：抓到的条目和生成的配置，或者失败的原因；`finished_at` 为空是还在等抓取节点。发起记进操作日志；采用结果就是用它的配置保存来源（[总体设计 §7.2](design.md#72-怎么抓)） |
| | `POST /admin/users/{id}/revoke-edits` | 撤销某人的全部修改，收回这个人在鼠钟的修改权限 |
| | `GET /admin/users`，`POST /admin/users/{id}/restore-edits` | 管理员查看收回了修改权限的人，恢复某人的修改权限：收回时撤销的修改不跟着回来；没被收回的返回 `409 not_revoked`。恢复记进操作日志 |
| | `GET`、`POST /admin/crawler-tokens`，`POST /admin/crawler-tokens/{id}/revoke` | 站长查询、生成、作废抓取节点令牌：生成时返回的令牌只出现这一次，作废马上生效；生成和作废记进操作日志 |
| | `GET`、`POST /admin/tags`，`PATCH`、`DELETE /admin/tags/{id}` | 管理员管学院标签的预设：名字、说明、顺序；删除连同大家贴的一起删。都记进操作日志 |
| | `GET`、`PUT /admin/email-rules` | 站长查看、设定每类消息的邮件规则：默认发、默认不发、不发；记进操作日志 |
| | `GET`、`PUT /admin/mail-accounts`，`POST /admin/mail-accounts/test` | 站长查看、保存发信邮箱，按顺序整个替换；密码只写不读，返回时只说设没设过。测试时填站长自己的 QQ 号，每个邮箱各给它发一封，返回各自成没成。保存记进操作日志 |

## 4. MCP

- 地址 `/mcp`，用 Streamable HTTP，不保留会话；认证和权限范围同第 1 节的个人令牌，只认个人令牌，没带的返回 `401 token_required`。连接时给 Agent 一段使用说明（总体设计 §13）。
- MCP 是接口的薄包装：每个工具对应一个接口，名字照下表；说明和参数都由 `openapi.json` 里这个接口的定义生成，不单独维护：路径和查询参数照原名，请求体放在 `body` 里，不是参数的直接报错。工具在进程内以令牌的主人调这个接口，返回接口的响应原文（成功了没有内容的返回「完成」），出错的标成错误；权限、订阅上限和记录也就和接口完全一样。通过 MCP 做的操作，记录里标明「通过 Agent」。
- 查询类的工具标成只读，`DELETE` 的标成会删东西。

| 工具 | 对应接口 | 权限范围 |
| --- | --- | --- |
| `search_programs` | `GET /programs` | `read` |
| `get_program`、`get_program_versions` | `GET /programs/{id}`、`GET /programs/{id}/versions` | `read` |
| `search_colleges`、`get_college` | `GET /colleges`、`GET /colleges/{id}` | `read` |
| `crawl_status` | `GET /crawl-runs` | `read` |
| `list_subscriptions`、`list_follows`、`list_applications`、`list_feedback` | `GET /me/subscriptions`、`/me/follows`、`/me/applications`、`/me/feedback` | `read` |
| `list_messages` | `GET /messages`，不标成看过 | `read` |
| `subscribe`、`unsubscribe` | `PUT`、`DELETE /programs/{id}/subscription` | `personal` |
| `follow`、`unfollow` | `PUT`、`DELETE /colleges/{id}/follow` | `personal` |
| `set_application`、`clear_application` | `PUT`、`DELETE /programs/{id}/application` | `personal` |
| `submit_feedback`、`withdraw_feedback` | `POST /programs/{id}/feedback`、`DELETE /feedback/{id}` | `personal` |

## 5. 给 Agent 的说明

- `/llms.txt`：说明鼠钟是什么、有哪些页面、MCP 怎么接、接口文档在哪。
- `/api/v1/openapi.json`：开放 API 的 OpenAPI 文档，由接口的 Zod 定义生成。
- 网页的筛选条件都在网址里，比如 `/?cohort=2027&kind=summer_camp&tier=985`，用浏览器操作网页的 Agent 也能直接用。

## 6. 抓取节点

抓取节点用这组接口和网站交接（[总体设计 §4](design.md#4-架构)）。只有抓取节点主动调用，网站不连抓取节点。请求和返回的格式写在网站的 Zod schema 里，抓取节点的 Python 类型由它生成（[开发约定 §1](development.md#1-结构与分层)）。

- 认证：`Authorization: Bearer <抓取节点令牌>`。令牌由站长在系统设置里生成，只能调这一组接口。
- 抓取节点不存业务数据：要抓什么、哪些通知已经见过、哪些还没处理完，都由网站告诉它。
- 每一步都能安全地重做：中途断了，重新领活、重交一遍，不会多出通知、快照和版本。通知按 `(source_id, url)` 认，快照按通知和文字认。

| 接口 | 说明 |
| --- | --- |
| `GET /crawler/work` | 领活：到期要抓的来源（网址、要不要浏览器、是不是全收、配置），管理员要试抓的地址。发出去的活带租约，到期前不再发；抓取节点中途断了，租约过期后重新发 |
| `POST /crawler/sources/{id}/listing` | 交来源列表页上的条目（网址、标题、日期）。返回这个来源要接着处理的通知：没初筛的；要抓正文的，也就是初筛通过、还没抽取的，以及项目还没截止、这一轮还没抓过的（[总体设计 §7.4](design.md#74-发现变化)） |
| `POST /crawler/sources/{id}/screening` | 交一批通知的初筛分数和是否通过，带模型用量 |
| `POST /crawler/notices/{id}/snapshot` | 交抓到的正文、附件的名称、地址和文字。文字和上一份快照相同就不存新的。返回快照的编号和还缺文件的附件；要抽取时（有了新快照，或者上一份还没抽取），再附上抽取要对照的东西：通知的发布日期、这所学校在院校清单里的学院、这所学校发布那年到后两年这几届的项目（编号、学院、届、类型、名称、报名时间） |
| `PUT /crawler/snapshots/{id}/attachments/{position}` | 上传一个附件的文件，请求体就是文件本身，最大 10MB |
| `POST /crawler/snapshots/{id}/extraction` | 交抽取的结果，带模型用量。结果是通知涉及的项目，每个带编号（新建的没有）、学院、届、类型、名称、作用和字段，格式见[总体设计 §8.2](design.md#82-抽取)；网站按 §8.3、§8.4 校验和归并 |
| `POST /crawler/notices/{id}/removed` | 通知打不开（404、410），标成原文已删除；之后又能打开的，交新快照时取消 |
| `POST /crawler/runs` | 交一个来源这一轮的结果：开始和结束时间、成功还是失败和原因、列表里几条、新通知几条、其中有用的几条、哪些通知没抓成和原因，以及没随初筛或抽取交上来的模型用量（[总体设计 §8.6](design.md#86-成本)）。交了才算这一轮结束，失败了也等下一轮再抓 |
| `POST /crawler/probes/{id}` | 交试抓的结果：抓到的条目和生成的配置，或者失败的原因，带模型用量 |

一个来源的一轮：领活 → 抓列表页、交列表 → 对没初筛的初筛、交分数 → 对要抓正文的抓正文和附件、交快照、上传附件 → 要抽取的抽取、交结果 → 交这一轮的结果，没抓成的通知和原因写在里面；初筛不成的新通知也算没抓成，下一轮再初筛。重抓正文也在来源的这一轮里，守同样的频率，失败了一样记进抓取记录。
