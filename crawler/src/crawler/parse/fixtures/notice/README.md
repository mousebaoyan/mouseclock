# 通知页结构样例

2026-11-09 通过 `Fetcher` 各读一页通知，只照抄正文和附件附近的结构。正文、标题、文件名、链接和图片地址全部换成自编的内容；没有通知原文、附件或学生信息。

| 样例 | 系统及结构依据 | 结构来源 |
| --- | --- | --- |
| `vsb.html` | Visual SiteBuilder（博达）：正文在 `v_news_content`；附件既有正文里带文件类型图标的链接，也有正文后 `ul` 里「附件【…】已下载 N 次」的列表，地址都是 `download.jsp?urltype=news.DownloadAttachUrl`；有的名称写成【附件2.xlsx】 | [北邮人工智能学院](https://ai.bupt.edu.cn/tzgg.htm)、[厦大信息学院](https://informatics.xmu.edu.cn/zsxx.htm)、[西电人工智能学院](https://sai.xidian.edu.cn/tzgg.htm) |
| `webplus.html` | WebPlus：正文在 `wp_articlecontent`；嵌入的 PDF 播放器只有 `pdfsrc` 和 `sudyfile-attr` 里的标题，正文为空；另一种是带 `sudy-attachment-icon` 的链接 | [东南大学电子学院](https://electronic.seu.edu.cn/11484/list.htm)、[东南大学研究生院](https://yzb.seu.edu.cn/6676/list.htm) |
| `trs.html` | TRS：正文在 `TRS_UEDITOR`，附件是 `insertfileTag` 里带 `download` 的链接；正文后的 `wrap-appendix` 附件区在 HTML 里是空的，附件的地址和名称写在页面脚本的 `appLinkStr`、`appDescStr` 里，由脚本填进去 | [自动化所](http://ia.cas.cn/yjsjy/zs/sszs/)、[信工所](http://iie.cas.cn/xsjy/zsxx/sszs/) |
| `gpower.html` | GPower：`gp-article` 里有标题、日期和 `gp-content` 正文 | [北科人工智能学院](https://ai.ustb.edu.cn/xwgg/tzgg/) |
| `gpower-article.html` | GPower 的另一种：正文直接在 `gp-article`，附件链接带 `download` | [北科自动化学院](https://saee.ustb.edu.cn/tzgg/index.htm) |
| `ustb-graduate.html` | 正文只标成 `wrapArticle` 里的 `article`，附件在正文后的 `Annex` | [北科研究生院](https://yzxc.ustb.edu.cn/xlytm/hdap/index.htm) |
| `ucas.html` | 国科大研招网的文章页：正文在 `b-abody`，外面的 `b-pagecontent` 还有发布单位和日期 | [国科大硕士招生](https://admission.ucas.ac.cn/showarticle/newslist/1beb211c-ea0d-4c97-b5ce-61efa7addfcd) |
| `ucas-unit.html` | 国科大研招网的招生单位页：没有 `b-abody`，正文是整个 `b-pagecontent` | [计算所硕士招生](https://www.ict.ac.cn/yjsjy/zsxx/sszs/)链到的招生目录 |
| `abody.html` | 国科大前沿交叉科学学院：正文在 `abody` | [国科大前沿交叉科学学院](https://sais.ucas.ac.cn/index.php/zh/xwgs/tgzs) |

导航、页脚、侧栏的「常用下载」和二维码图片这些正文以外的链接，`vsb.html` 里留了几个，测试它们不被当成附件。下载、跳转、验证码页和失败的情况在 `crawl/notice_test.py` 里用自编的页面和现生成的附件测，不访问外网。
