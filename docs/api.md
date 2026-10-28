# 接口

> 状态：草案，只列约定和清单。请求和返回的格式写在代码里的 Zod schema 里，由它生成 OpenAPI 文档，不在这里重复。

## 1. 约定

- 前缀 `/api/v1`，请求和返回都是 JSON，字段用 snake_case，时间用 Unix 秒，和鼠洞一样。
- 错误统一返回 `{ "error": { "code": "...", "message": "..." } }`：`code` 是英文，给程序判断；`message` 是中文，给人看。
- **认证**：网页用会话 Cookie；Agent 和脚本用个人令牌，`Authorization: Bearer <令牌>`；抓取节点用抓取节点令牌（第 6 节）。带 `Authorization: Bearer` 的请求只按令牌认人，不看会话 Cookie。
- **令牌的权限范围**：`read` 只能查询；`personal` 还能订阅、关注、记报名、提交反馈和修改申请。直接修改、审核和管理的接口只认网页会话，带令牌调用返回 `403`。
- **权限**（[总体设计 §6.2](design.md#62-权限)）：访客调列表接口只拿到预览，调别的接口返回 `401 login_required`；冻结的按访客算，返回 `403 member_frozen`；禁言中的做不了的返回 `403 muted`，等级不够的 `403 level_required`，修改权限被收回的 `403 edit_revoked`，不是管理员或站长的 `403 forbidden`。
- **频率限制**：按会话和令牌分别限制，超了返回 `429`。

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
- **刷新**：令牌存在 `users` 里，每小时用它调一次鼠洞的 `/me` 更新资料；鼠洞返回 `401 invalid_token`（被封禁或撤销了授权）时，删掉这个人的所有会话。
- **退出**：`POST /auth/logout`，只退出鼠钟，鼠洞的登录不受影响。
- **CSRF**：网页的写请求校验 Origin，和鼠洞一样；带令牌的请求不受影响。

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/me` | 自己的资料：`id`、`display_name`、`avatar_url`（鼠洞上的绝对地址，没有为 `null`）、`level`、`role`、`frozen`、`muted`、`muted_until`（禁言到什么时候，没禁言或永久禁言为 `null`），以及 `can`：`edit`、`admin`、`owner`，按[总体设计 §6.2](design.md#62-权限) 算好，页面据此显示按钮 | 已登录，冻结了也可以 |
| POST | `/auth/logout` | 退出当前会话；没有登录时也返回成功 | 访客 |

## 3. 接口清单（草案）

| 分组 | 接口 | 说明 |
| --- | --- | --- |
| 项目 | `GET /programs` | 总表：按届、层次、地区、方向、类型、状态和学院标签筛选，按截止时间、发布时间、订阅人数排序，可以搜索 |
| | `GET /programs/{id}` | 详情：字段和证据、状态、订阅人数 |
| | `GET /programs/{id}/versions` | 版本和快照 |
| | `GET /programs/{id}/edits` | 修改记录 |
| 学院 | `GET /colleges`、`GET /colleges/{id}` | 院校清单、学院页 |
| 订阅和关注 | `PUT`、`DELETE /programs/{id}/subscription` | 订阅、取消；超过 10 个返回 `409 subscription_limit` |
| | `PUT`、`DELETE /colleges/{id}/follow` | 关注、取消 |
| 我的报名 | `PUT`、`DELETE /programs/{id}/application` | 进度和备注 |
| | `GET /me/applications` | 自己的报名记录，可以按进度筛选 |
| 学院标签 | `PUT`、`DELETE /colleges/{id}/tags/{tag}` | 贴标签、撤回 |
| 反馈和修改 | `POST /programs/{id}/feedback` | 反馈或修改申请 |
| | `PATCH /programs/{id}` | 直接修改，L3 以上，只认网页会话 |
| | `POST /edits/{id}/revert` | 撤销一次修改 |
| 审核 | `GET /review` | 审核页的各类待办和最近修改 |
| | `POST /feedback/{id}/approve`、`POST /feedback/{id}/reject` | 审核修改申请 |
| | `POST /programs/{id}/verify` | 标记已核对 |
| | `POST /programs/{id}/resolve-dispute` | 复核争议，管理员 |
| 求收录 | `GET`、`POST /inclusion-requests` | 列表、提交 |
| | `PUT`、`DELETE /inclusion-requests/{id}/vote` | 同求、撤回 |
| 抓取看板 | `GET /crawl-runs?date=` | 某天各来源的结果和用量 |
| 我的 | `GET /me`、`PATCH /me/email-settings` | 自己的资料和邮件开关 |
| | `GET`、`POST`、`DELETE /me/tokens` | 个人令牌，只认网页会话 |
| 数据下载 | `GET /export` | 全部项目和字段，登录后可用 |
| 群汇总 | `GET /bot/summary` | 插件每天来取的汇总，用插件专用的令牌 |
| 管理 | `GET`、`POST /admin/schools`，`GET`、`PATCH /admin/schools/{id}` | 管理员查询、新增、修改学校 |
| | `GET`、`POST /admin/colleges`，`GET`、`PATCH /admin/colleges/{id}` | 管理员查询、新增、修改学院 |
| | `GET`、`POST /admin/sources`，`GET`、`PATCH /admin/sources/{id}` | 管理员查询、接入、配置来源，暂停或恢复抓取 |
| | `/admin/tags`、`/admin/users`、`/admin/settings` | 标签预设、修改权限、系统设置 |

## 4. MCP

- 地址 `/mcp`，用 Streamable HTTP，认证和权限范围同第 1 节的个人令牌。
- MCP 是接口的薄包装：每个工具对应一个接口，名称、说明和参数都由接口的定义生成，不单独维护；权限、订阅上限和记录也就和接口完全一样。通过 MCP 做的操作，记录里标明「通过 Agent」。

| 工具 | 对应接口 | 权限范围 |
| --- | --- | --- |
| `search_programs` | `GET /programs` | `read` |
| `get_program` | `GET /programs/{id}`、`/versions` | `read` |
| `search_colleges`、`get_college` | `GET /colleges` | `read` |
| `crawl_status` | `GET /crawl-runs` | `read` |
| `list_mine` | 自己的订阅、关注和报名记录 | `read` |
| `subscribe`、`unsubscribe` | `/programs/{id}/subscription` | `personal` |
| `follow`、`unfollow` | `/colleges/{id}/follow` | `personal` |
| `set_application` | `/programs/{id}/application` | `personal` |
| `submit_feedback` | `POST /programs/{id}/feedback` | `personal` |

## 5. 给 Agent 的说明

- `/llms.txt`：说明鼠钟是什么、有哪些页面、MCP 怎么接、接口文档在哪。
- 网页的筛选条件都在网址里，比如 `/?cohort=2027&kind=summer_camp&tier=985`，用浏览器操作网页的 Agent 也能直接用。

## 6. 抓取节点

抓取节点用这组接口和网站交接（[总体设计 §4](design.md#4-架构)）。只有抓取节点主动调用，网站不连抓取节点。请求和返回的格式写在网站的 Zod schema 里，抓取节点的 Python 类型由它生成（[开发约定 §1](development.md#1-结构与分层)）。

- 认证：`Authorization: Bearer <抓取节点令牌>`。令牌由站长在系统设置里生成，只能调这一组接口。
- 抓取节点不存业务数据：要抓什么、哪些通知已经见过、哪些还没处理完，都由网站告诉它。
- 每一步都能安全地重做：中途断了，重新领活、重交一遍，不会多出通知、快照和版本。通知按 `(source_id, url)` 认，快照按通知和文字认。

| 接口 | 说明 |
| --- | --- |
| `GET /crawler/work` | 领活：到期要抓的来源和配置，管理员要试抓的地址。发出去的活带租约，到期前不再发；抓取节点中途断了，租约过期后重新发 |
| `POST /crawler/sources/{id}/listing` | 交来源列表页上的条目（网址、标题、日期）。返回这个来源要接着处理的通知：没初筛的；要抓正文的，也就是初筛通过、还没抽取的，以及项目还没截止、一天没抓过的（[总体设计 §7.4](design.md#74-发现变化)） |
| `POST /crawler/sources/{id}/screening` | 交一批通知的初筛分数和是否通过，带模型用量 |
| `POST /crawler/notices/{id}/snapshot` | 交抓到的正文、附件的名称、地址和文字。文字和上一份快照相同就不存新的。返回快照的编号和还缺文件的附件；要抽取时（有了新快照，或者上一份还没抽取），再附上抽取要对照的东西：通知的发布日期、这所学校在院校清单里的学院、这所学校发布那年到后两年这几届的项目（编号、学院、届、类型、名称、报名时间） |
| `PUT /crawler/snapshots/{id}/attachments/{position}` | 上传一个附件的文件，请求体就是文件本身 |
| `POST /crawler/snapshots/{id}/extraction` | 交抽取的结果，带模型用量。结果是通知涉及的项目，每个带编号（新建的没有）、学院、届、类型、名称、作用和字段，格式见[总体设计 §8.2](design.md#82-抽取)；网站按 §8.3、§8.4 校验和归并 |
| `POST /crawler/notices/{id}/removed` | 通知打不开（404、410），标成原文已删除；之后又能打开的，交新快照时取消 |
| `POST /crawler/runs` | 交一个来源这一轮的结果：开始和结束时间、成功还是失败和原因、列表里几条、新通知几条、其中有用的几条、哪些通知没抓成和原因。交了才算这一轮结束，失败了也等下一轮再抓 |
| `POST /crawler/probes/{id}` | 交试抓的结果：抓到的条目和生成的配置，或者失败的原因，带模型用量 |

一个来源的一轮：领活 → 抓列表页、交列表 → 对没初筛的初筛、交分数 → 对要抓正文的抓正文和附件、交快照、上传附件 → 要抽取的抽取、交结果 → 交这一轮的结果，没抓成的通知和原因写在里面。重抓正文也在来源的这一轮里，守同样的频率，失败了一样记进抓取记录。
