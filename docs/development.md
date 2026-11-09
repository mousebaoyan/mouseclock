# 开发约定

写代码时的具体约定，按需阅读。总的原则见 [AGENTS.md](../AGENTS.md)；表结构的约定见[数据表 · 约定](data-model.md#约定)，接口的约定见[接口 · 约定](api.md#1-约定)。

## 1. 结构与分层

分两个部署单元，各自按领域分模块；同一件事的接口、业务逻辑、查询和测试放在一起，改一个功能通常只动一个目录。

```text
web/                    网站，写法照鼠洞
  app/                  页面（React Router）；routes/ 是路由模块，components/ 是共用的组件，api.server.ts 让页面在进程内调接口
  server/
    main.ts             进程入口：执行迁移，把 Hono 应用和 React Router 接在一起
    app.ts              组装 Hono 应用：健康检查和 /api/v1；接口测试直接对它发请求
    modules/            业务模块，一个领域一个目录：routes.ts（接口）、service.ts（业务逻辑）和测试
    platform/           和业务无关的基础设施：环境变量、数据库、迁移、错误格式、日志、权限、定时任务
  db/migrations/        SQL 迁移
  db/types.ts           kysely-codegen 从数据库生成的类型
  openapi/crawler.json  抓取节点接口的 OpenAPI 文档，由 `pnpm openapi` 生成
  scripts/              由 Node 直接运行的命令
  test/                 Vitest 的全局准备：测试用的数据库；假的鼠洞，开发版也用它
crawler/                抓取节点
  src/crawler/          一个领域一个包，测试和被测的文件放在一起，命名为 *_test.py
    crawl/fetch.py      所有对来源网站的请求都经过这里
    crawl/website.py    网站接口的客户端
    crawl/rounds.py     一个来源的一轮：列表、初筛、抓正文、抽取、交结果；各步由 Steps 传进来
    crawl/contract.py   网站接口的 Pydantic 模型，由 `uv run datamodel-codegen` 从 openapi/crawler.json 生成
  check.sh              全部检查
```

模块：

| 部署单元 | 模块 | 管什么 |
| --- | --- | --- |
| 网站 | `sources` | 学校、院校清单、来源和配置、试抓、求收录 |
| | `ingest` | 收抓取节点交来的结果：通知和快照、归并和版本、抽取拿不准等人审的条目、抓取看板 |
| | `programs` | 项目、字段、已核对、学院标签、我的报名 |
| | `accounts` | 鼠洞登录、会话、个人令牌、权限 |
| | `reminders` | 订阅、关注、邮件、群汇总 |
| | `review` | 反馈、修改申请、修改记录和撤销、争议、操作日志 |
| | `agents` | MCP 服务和 `/llms.txt` |
| 抓取节点 | `crawl` | 领活、抓列表页和正文、下载附件、交结果 |
| | `parse` | 从网页和附件里取出文字、链接、附件和日期写法，文字识别 |
| | `screening` | 初筛：调用判别接口 |
| | `extraction` | 抽取和证据校验：调用 LLM |

- 网站和抓取节点只通过[抓取节点接口](api.md#6-抓取节点)交接：不共享数据库，不互相引用代码。接口的类型由网站的定义生成，抓取节点不手写（[总体设计 §5.1](design.md#51-选定的方案)）：改了接口的 Zod 定义，运行 `pnpm openapi` 和 `uv run datamodel-codegen`，两边的 CI 都检查生成的文件是最新的。
- 抓取节点交的请求里，没有的值不写这个键，不传 `null`：Zod 用 `.optional()`，抓取节点用 Pydantic 的 `model_dump(mode="json", exclude_none=True)`。网站返回的空值写成 `null`；引用了命名 schema 的可空字段写成 `z.union([Schema, z.null()])`，`.nullable()` 会把空值并进那个 schema 本身。
- 网站里依赖只能单向：页面 → 接口 → 服务 → 数据库。网页、API 和 MCP 都调用服务导出的函数，不各写一套规则。
- 页面的 loader 和 action 用 `context.get(apiContext)` 拿到的 hc 客户端调接口，用它带类型的方法（`$get`、`$post`、`$patch`），不手拼请求，也不再校验接口的返回。权限和校验以接口为准：页面不另判权限；表单的值用接口的同一个 Zod schema 转成有类型的值再提交，这和接口是同一套规则；接口返回的错误抛给 ErrorBoundary，或者显示在表单上。
- 要人填的字段在 schema 上用 `named("中文名")` 起名（`platform/http.ts`），校验不通过时接口和表单的提示就会写明是哪一项、怎么改，比如「学校名称不能为空」「网址要写完整，以 http:// 或 https:// 开头」。抓取节点交来的字段没人看提示，不用起名。
- 页面上同一种东西用同一个组件，不用浏览器原生的下拉框和复选框：
  - 页面的框架、面板和并排的要点用 `components/page.tsx`：列表页不另写标题，详情页以名称为标题；不写介绍页面用途的说明句。列表上方的搜索和筛选用 `components/filters.tsx`，筛选条件放在地址里。能选几个的筛选（类型、层次、地区、方向）用 `facets.ts` 判断和计数：每个选项旁边写出在其他筛选条件下有多少条。
  - 下拉框、复选框、分段选择和展开收起在 `components/ui/`，菜单、弹出面板和手机上的导航抽屉在 `components/disclosure.tsx`。照鼠洞的做法都是手写或原生的，不用组件库：Base UI 的菜单和对话框连同定位库每页要多出约 55KB gzip。弹出面板放在页面最外层、按按钮定位，不会被面板的圆角裁掉；抽屉是原生 `<dialog>`，复选框是加了样式的原生 `<input>`，展开收起是 `<details>`。下拉框（`ui/select.tsx`）选项到 9 个就在列表上方带搜索；能选几个的用 `MultiSelect`，长列表还能全选、反选和清空。
  - 动效照鼠洞，短而轻，只动透明度和位置，系统设了减少动态效果时都关掉：从别的页面点进来的页面淡入，卡片和列表项依次上浮（`components/page-transition.tsx`，列表加 `stagger`）；筛选、标签和翻页的链接带 `viewTransition`，列表淡入淡出地换成新的；弹出面板和展开的内容从按钮那边展开，按钮按下时微微缩小。
  - 项目一个一张卡片（`components/program.tsx` 的 `ProgramCard`）：上面是校徽和学校学院，右上角是状态和类型，中间是项目名，底下是报名时间；整张卡片点进项目页。宽屏一行三张，手机一行一张。
  - 学校和学院写在一起时是一项，中间空一格：「北辰大学 计算机学院」；窄的地方只在两者之间折行（`break-keep`）。学校名旁边放 `components/school-logo.tsx` 的校徽，没有校徽的显示校名的第一个字。
  - 其他列表在宽屏上用 `components/ui/table.tsx` 的表格：一格只放一项，各列居中；表格按网格排，每列按内容定宽，多出的空白平均分给各列，所以列间距均匀；一对多的（学校和学院）用跨行的单元格。手机上同样的内容用 `components/list.tsx`，每项两行，状态放在右边、最多占一半宽，不靠横向滑动；只有一个链接的项整行都能点。
  - 手机和平板（触屏，`pointer-coarse`）上按钮和输入框加高，输入框的字不小于 16px，免得 iOS 点进去就放大页面；不便加高的小控件（展开收起、卡片里的外链）用 `app.css` 的 `touch-target` 把点按范围扩到 44px，样子不变。
  - 列表的分页用 `components/pagination.tsx`，每页条数可选；学校的层次、项目的类型和状态用 `components/tags.tsx` 的彩色标签，颜色在 `app.css`。
- 界面文案简明、正式，不用口语，单句的提示和空状态末尾不加句号：比如「列表页抓取失败：服务器返回错误（HTTP 403）」，不写「列表没读到，状态码不对。」
- 模块之间只通过对方服务导出的函数协作，每张表只由一个模块写入；读别的模块的表不受限制，查询里可以直接 join。模块之间不循环依赖：A 调了 B 的服务，B 就不再调 A 的。
- 审核页上的东西分属两个模块：抽取拿不准的条目归 `ingest`，处理时要归并、改版本；修改申请、争议和最近修改归 `review`。页面分别调两边的接口。
- 认证、令牌和 CSRF 这些全站的规矩在 `app.ts` 统一处理，权限规则在 `platform/access.ts`，模块里不各挂中间件再补一遍。
- 其余的写法（服务和事务、纯函数、文件命名）照[鼠洞的开发约定 §1](https://github.com/mousebaoyan/mousehole/blob/main/docs/development.md#1-结构与分层)。

## 2. 抓取和判别

- 接入来源时按通用抓取 → 配置 → 浏览器抓取 → 专用适配器的顺序试，前一种能抓就不用后一种（[总体设计 §7.2](design.md#72-怎么抓)）。
- 建站系统的模板放在代码里，和它的测试在一起；单个来源的配置存在网站的数据库里，在管理页面改，抓取节点领活时一起拿到。
- 所有对来源网站的请求都经过 `crawl/fetch.py` 的 `Fetcher`，整个进程共用一个，[总体设计 §7.3](design.md#73-频率和礼貌)的规矩由它保证：UA 写明鼠钟；同一个网站一次一个请求，多个任务同时抓也一样；跳转的每一步单独发，跳到别的网站按那个网站的间隔排队。浏览器抓取打开页面前，也要先过这些规矩。
- 浏览器抓取启动时关掉 Chromium 的自动化标记（`--disable-blink-features=AutomationControlled`），UA 用浏览器自己的，把 `HeadlessChrome` 写成 `Chrome`，末尾加上鼠钟的标识；瑞数这类脚本挑战两处都检查（[总体设计 §5.2](design.md#52-实测)）。不冒充别的浏览器和系统。
- 一轮里同一个网站共用一个无痕会话，抓完就关：脚本挑战设的 Cookie 在会话里有效，后面的页面不用再过挑战；不同网站、不同轮次之间不共享 Cookie。同时开的浏览器页面有上限，多的排队；拒绝弹窗和下载，附件由程序另外下载；不加载图片、字体和音视频，省对方的流量，也省内存。
- 解析和模型分工：`parse` 用程序取出能确定的东西，模型只做判断（[总体设计 §8.2](design.md#82-抽取)）。解析不猜：判断不了的交给模型或人，不硬配。
- 判别模型和 LLM 的提示词放在调用它的代码旁边。输出都按固定的结构解析，解析不了的当失败处理。
- 每一轮抓取都交一份抓取记录，失败也交，写明原因；不在一轮里反复重试。各步抓不成时抛 `FetchError`（`Fetcher` 抛的）或 `StepError`（写明失败类别，比如 `http_status` 和「HTTP 403」），一轮的流程把它记进抓取记录；别的异常是 bug，照常抛出。

### 2.1 列表配置

特殊列表通过 `ListConfig` 校验 `WorkSource.config`，管理员与 #46 的试抓生成使用同一格式。例如只能用 HTTP 的浙大计算机学院列表：

```json
{
  "selectors": {
    "items": "//div[contains(concat(' ',normalize-space(@class),' '),' jzlb ')]",
    "title": "./div[@class='btt3']/a",
    "link": "./div[@class='btt3']/a",
    "date": "./div[@class='fbsj4']",
    "next": "//a[@class='next']"
  },
  "force_http": true
}
```

- `selectors` 可省略，表示按重复条目结构及完整日期通用解析；填写时 `items`、`title`、`link` 必填。
- 选择器都是 XPath 1.0。`items` 相对于整页，选中条目元素；`title`、`link`、`date` 相对于条目；`next` 相对于整页。各字段取第一个匹配值；`title`、`date` 取字符串或元素文字，`link`、`next` 取字符串或元素的 `href`，按跳转后的页面地址解析成绝对网址。只接受 HTTP(S)，不执行脚本。
- `date`、`next` 可省略，分别表示日期未知、没有下一页。日期只认完整年月日，也支持日与年月分开写，不猜年份。
- `force_http` 默认 `false`，只有明确只能用 HTTP 的来源才设为 `true`；可单独配置 `{"force_http": true}`，对列表及同站翻页生效，不自动从 HTTPS 降级。

## 3. 时间

- 时刻存成带时区的时间戳；通知里写的"某天几点"一律按北京时间理解，时间值和换算的规则见[总体设计 §8.2](design.md#82-抽取)。
- 提醒时间（截止前 3 天的上午 9 点）按北京时间的日期算。
- 页面上显示时间值和项目的状态用 `app/time.ts` 的 `formatTime`、`formatWindow` 和 `statusOf`，照原文的写法，不显示换算出的时刻。
- 测试里固定时区和当前时间，覆盖跨午夜、跨年、没写年份、只有日期、「24 时」「X 日前」「前后」和只写到旬或月的写法。

## 4. 日志

- 抓取记关键事实：来源和网址、抓取方式、状态码、跳转、耗时、失败类别，以及模型的名称、用量和耗时。每页只写几条，不逐个链接地记。
- 不写正文、附件内容、模型的输入和输出、用户的数据和任何密钥；外部服务返回的错误可能夹带这些内容，只记失败类别。公开网页的网址可以写。
- 一轮抓取的日志都带同一个抓取记录的编号，方便从抓取看板查到对应的日志。

## 5. 测试

- 普通的逻辑用单元测试：新通知和变化的识别、时间规范化、证据校验、归并、重复交结果、权限、订阅上限、提醒时间、争议计数、撤销等。
- 网站的测试连真实的 PostgreSQL：开始前迁移一个模板库，每个测试文件复制一个自己的库，可以并行跑。
- 抓取节点的测试不连外网：请求用 httpx 的 `MockTransport`，时间用假的时钟，不真的等待（见 `crawl/fetch_test.py`）。
- **假的鼠洞**：`test/fake-mousehole.ts` 照鼠洞的接口实现了授权、换令牌和 `/me`，带几个各种权限的假用户。测试里 `fetch` 都转给它，请求别的网站直接报错；开发版的 `MOUSEHOLE_URL` 指向自己时（`.env.example` 就是这样），它挂在 `/fake-mousehole` 下，点「登录」可以挑用哪个假用户。
- **本地的真鼠洞**：要对着本地跑的鼠洞试登录时，在鼠洞后台的「应用」页登记鼠钟，回调地址填 `http://localhost:5174/login/callback`。鼠洞的开发版占着 5173，鼠钟换到 5174，命令行上的变量优先于 `.env`：`PUBLIC_URL=http://localhost:5174 MOUSEHOLE_URL=http://localhost:5173 MOUSEHOLE_CLIENT_ID=… MOUSEHOLE_CLIENT_SECRET=… pnpm dev --port 5174`。
- 测试数据：保存下来的列表页、固定的模型响应、假的邮件服务器和假的鼠洞授权方。保存的页面只用来测解析，不放正文和附件；某个网站出过问题的，把那一页存下来做测试数据。
- 判别和抽取的效果不写成单元测试，用标注集评估（[总体设计 §8.5](design.md#85-实验)）。

## 6. 术语

界面、文档、代码里同一个概念用同一个词。

| 中文 | 英文 | 说明 |
| --- | --- | --- |
| 学校 | school | |
| 学院 | college | 泛指招生单位，包括学院、研究所、研究生院 |
| 院校清单 | — | 全部学校和学院，没接入来源的也在里面 |
| 来源 | source | 一个通知列表页 |
| 试抓 | probe | 接入来源前先抓一次看看 |
| 抓取 | crawl | 一轮抓取叫 crawl run |
| 抓取节点 | crawler | 跑抓取、初筛和抽取的部署单元 |
| 通知 | notice | 官网上的一条通知 |
| 快照 | snapshot | 某次抓到的正文和附件 |
| 初筛 | screening | 判别接口看标题 |
| 抽取 | extraction | LLM 读正文、按字段输出 |
| 证据 | evidence | 原文里支撑某个字段的那句话 |
| 项目 | program | 一个学院面向某一届的一次招生活动，分批报名的每批算一个 |
| 届 | cohort | 本科毕业、研究生入学的那一年 |
| 字段 | field | 项目的一项信息，比如报名截止 |
| 版本 | version | 一条通知归到某个项目上，就是这个项目的一个版本 |
| 作用 | role | 通知对项目的作用：报名 `call`、补充 `update`、名单 `result` |
| 时间值 | time value | 原文里的时间，写到哪一步记到哪一步 |
| 归并 | — | 把通知归到项目，新建项目或者加一个版本 |
| 类型 | kind | 冬令营 `winter_camp`、夏令营 `summer_camp`、预推免 `pre_recommendation`、九推 `september_round` |
| 已核对 | verified | |
| 有争议 | disputed | |
| 订阅 | subscription | 订阅项目，截止前提醒 |
| 关注 | follow | 关注学院，有新通知就提醒 |
| 我的报名 | application | 进度叫 stage，备注叫 note |
| 学院标签 | college tag | 公开的，贴在学院上 |
| 反馈 | feedback | 包括修改申请 |
| 修改申请 | edit request | 给出改成什么的反馈 |
| 修改 | edit | |
| 依据 | basis | 人工修改和修改申请附上的原文链接或截图；和抽取的证据不是一回事 |
| 撤销 | revert | |
| 求收录 | inclusion request | 同求叫 vote |
| 抓取看板 | crawl dashboard | |
| 审核页 | review | |
| 个人令牌 | token | 抓取节点用的叫 crawler token |
| 群汇总 | summary | |
