# 接口

> 状态：草案，只列约定和清单。技术栈定了以后补上请求和返回的格式；接口的类型从代码里的 schema 生成 OpenAPI 文档，不在这里重复。

## 1. 约定

- 前缀 `/api/v1`，请求和返回都是 JSON，字段用 snake_case，时间用 Unix 秒，和鼠洞一样。
- 错误统一返回 `{ "error": { "code": "...", "message": "..." } }`：`code` 是英文，给程序判断；`message` 是中文，给人看。
- **认证**：网页用会话 Cookie；Agent 和脚本用个人令牌，`Authorization: Bearer <令牌>`。
- **令牌的权限范围**：`read` 只能查询；`personal` 还能订阅、关注、记报名、提交反馈和修改申请。直接修改、审核和管理的接口只认网页会话，带令牌调用返回 `403`。
- **访客**：列表接口只返回预览（[总体设计 §6.2](design.md#62-权限)），别的接口返回 `401 login_required`。
- **频率限制**：按会话和令牌分别限制，超了返回 `429`。

## 2. 鼠洞登录

鼠洞做授权方，按 OAuth 2.0 授权码流程。鼠洞那边的接口在 mousehole 仓库里设计，这里写鼠钟这边要的流程：

| 步骤 | 做什么 |
| --- | --- |
| 1 | 没有会话的浏览器打开鼠钟，跳到鼠洞的授权地址，带上 `state` 和 `prompt=none` |
| 2 | 已经登录鼠洞的，鼠洞带着一次性的 `code` 跳回 `/login/callback`；没登录的带着 `error=login_required` 跳回，按访客显示 |
| 3 | 鼠钟的服务端用 `code` 向鼠洞换取用户资料：鼠洞用户 ID、名字、头像、等级、角色、禁言和冻结状态、QQ 号 |
| 4 | 鼠钟建自己的会话，写进 `users` |
| 5 | 点「登录」时重走一遍，不带 `prompt=none`：没登录鼠洞的先在鼠洞登录，再跳回来 |

- 自动跳转在一个浏览器会话里只试一次，免得没登录鼠洞的人来回跳。
- 登录期间每小时从鼠洞刷新一次资料，做法和鼠洞的授权接口一起定。

## 3. 接口清单（草案）

| 分组 | 接口 | 说明 |
| --- | --- | --- |
| 项目 | `GET /programs` | 总表：按年份、层次、地区、方向、类型、状态和学院标签筛选，按截止时间、发布时间、订阅人数排序，可以搜索 |
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
| 群汇总 | `GET /bot/digest` | 插件每天来取的汇总，用插件专用的 token |
| 管理 | `/admin/sources`、`/admin/colleges`、`/admin/tags`、`/admin/users`、`/admin/settings` | 来源、院校清单、标签预设、修改权限、系统设置 |

## 4. MCP

- 地址 `/mcp`，用 Streamable HTTP，认证和权限范围同第 1 节的个人令牌。
- 工具和接口调用同一组服务函数，权限、订阅上限和记录都一样；通过 MCP 做的操作，记录里标明「通过 Agent」。

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
- 网页的筛选条件都在网址里，比如 `/?year=2027&kind=summer_camp&tier=985`，用浏览器操作网页的 Agent 也能直接用。
