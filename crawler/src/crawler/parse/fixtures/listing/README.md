# 列表结构样例

2026-11-07 通过原版 `Fetcher` 各取一页，只截取列表及翻页结构。标题、摘要、日期、通知链接和图片地址全部替换为自编内容；没有通知正文、快照、附件或学生信息。样例中日期均为 2026-09-10、2026-09-09。

| 样例 | 系统及结构依据 | 结构来源 |
| --- | --- | --- |
| `vsb.html` | Visual SiteBuilder，原页有 `Announced by Visual SiteBuilder 9`；日期为日、年月分栏，标题与摘要分开 | [厦大信息学院招生信息](https://informatics.xmu.edu.cn/zsxx.htm) |
| `vsb-calendar.html` | 同一建站系统的另一种日期布局，链接有完整 `title` 属性 | [西电电子工程学院研究生列表](https://see.xidian.edu.cn/yjs/158.htm) |
| `webplus.html` | WebPlus，原页的 `webplus-list` 及 Sudy 资源；`news_list`、`news_title`、`news_meta` | [东南大学网安硕士生招生](https://cyber.seu.edu.cn/18210/list.htm) |
| `trs.html` | TRS 类静态发布，`YYYYMM/tYYYYMMDD_编号.html`，日期在独立 `pull-right` 中；包含一条跳往研招系统的置顶链接 | [计算所硕士招生](https://www.ict.ac.cn/yjsjy/zsxx/sszs/) |
| `gpower.html` | GPower 页面，原页的 `gpowersoft.js` 和 `/cms/web/`；`infoBox` 内标题、摘要、日期分开 | [北科大人工智能学院通知](https://ai.ustb.edu.cn/xwgg/tzgg/) |
| `drupal.html` | 原页明确声明 Drupal 10，Views 容器、`list-page`、`time/@datetime`；只有页码的翻页器 | [中大计算机学院硕士招生](https://cse.sysu.edu.cn/admission/master) |
| `configured.html` | 独立招生发布系统，作为需要配置的页面测试，不计入前述五种通用系统 | [国科大硕士招生](https://admission.ucas.ac.cn/showarticle/newslist/1beb211c-ea0d-4c97-b5ce-61efa7addfcd) |
| `zju-http.html` | WebPlus 的另一种布局，使用开发约定中的 XPath 配置和显式 HTTP，列出 `jzlb`、`btt3`、`fbsj4` | [浙大计算机招生信息](http://www.cs.zju.edu.cn/csen/27006/list.htm) |
| `opaque-links.html` | 通知链接为不带 `info/` 的字母数字文件名 | [北科大研究生院](https://yzxc.ustb.edu.cn/xlytm/hdap/index.htm) |
| `month-day-year.html` | 月日与年份分栏，标题和摘要在同一链接内 | [北科大计通学院](https://scce.ustb.edu.cn/xydt/tzgg.htm) |
| `year-month-day.html` | 年份与月日分栏 | [电子科大信通学院](https://www.sice.uestc.edu.cn/index/tzgg/yjsk.htm) |
| `table-rows.html` | 每条通知使用嵌套表格的行排版 | [东南大学研究生院](https://yzb.seu.edu.cn/6676/list.htm) |
| `date-in-link.html` | 日期在标题链接内部 | [西电人工智能学院](https://sai.xidian.edu.cn/tzgg.htm) |
| `plain-span.html` | 日期在无 class 的 `span` 内 | [西电研究生院](https://gr.xidian.edu.cn/yjsy/yjszs.htm) |
| `empty-link.html` | 通知链接前有一个空链接 | [西电网信学院](https://ce.xidian.edu.cn/sy/tzgg.htm) |
| `right-span.html` | 日期在 `right` 元素内 | [沈自](https://sia.cas.cn/zpjy/yjsjy/zs/zsgg/) |

Drupal 样例用于补充不同系统的解析覆盖，不改动 `data/sources.csv`。分页边界、未知日期、重复置顶、重定向、HTTP、非法配置和失败场景使用测试里自编的页面及 `MockTransport`，不访问外网。

`probe.html` 完全自编，每个条目同时包含通知链接和学院链接，用于验证通用解析为空后，通过试抓配置取出通知的流程；不来自真实网站。配套的 `page2.html` 是最后一页，两页各有两条通知；`notice/101.html` 至 `notice/104.html` 是虚构的通知正文，`department/a/`、`department/b/` 是虚构的学院介绍页。配套页面中的日期不限定为上述两个日期。

以本目录作为静态服务器根目录即可手动验证：试抓 `probe.html` 应返回甲、乙两条通知；采用同一配置试抓 `page2.html` 应返回丙、丁两条通知。首次正式抓取的列表阶段应翻到第二页，共得到四条通知，并因没有下一页而停止。通知正文和学院链接均可打开。后续初筛和正文抽取仍需要有效的模型密钥；这些页面不替代模型服务。
