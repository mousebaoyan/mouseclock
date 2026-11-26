from pathlib import Path

import pytest

from crawler.parse import ParseError
from crawler.parse.notice import AttachmentLink, parse_notice

FIXTURES = Path(__file__).parent / "fixtures" / "notice"
URL = "https://example.edu.cn/info/1001/101.htm"
VSB_FILE = "https://example.edu.cn/system/_content/download.jsp?urltype=news.DownloadAttachUrl&owner=1&wbfileid="


@pytest.mark.parametrize(
    ("name", "text", "attachments"),
    [
        (
            "vsb",
            "为做好示例学院2027年推免生接收工作\uff0c现将有关事项通知如下。\n"
            "一、报名时间\uff1a2026年9月1日至9月20日。\n"
            "报名网址\uff1a报名系统\uff0c咨询邮箱 yz@example.edu.cn。\n"
            "专业\t名额\n"
            "计算机科学与技术\t10\n"
            "附件1\uff1a示例申请表.doc",
            [
                ("example_1.png", "https://example.edu.cn/__local/1/AB/CD/example_1.png"),
                ("附件1\uff1a示例申请表.doc", VSB_FILE + "101"),
                ("附件2.xlsx", VSB_FILE + "102"),
            ],
        ),
        (
            "webplus",
            "示例学院2027年接收推免生考核结果如下。\n示例拟录取名单.pdf",
            [
                (
                    "示例考核结果.pdf",
                    "https://example.edu.cn/_upload/article/files/aa/bb/example/1.pdf",
                ),
                (
                    "示例拟录取名单.pdf",
                    "https://example.edu.cn/_upload/article/files/aa/bb/example/2.pdf",
                ),
            ],
        ),
        (
            "trs",
            "示例研究所2027年接收推荐免试研究生\uff0c报名截止2026年9月20日。\n附件1.示例报名表.doc",
            [
                (
                    "附件1.示例报名表.doc",
                    "https://example.edu.cn/info/1001/P020260901000000000001.doc",
                ),
                ("示例专业目录.pdf", "https://example.edu.cn/info/1001/P020260901000000000002.pdf"),
            ],
        ),
        ("gpower", "为做好2027年推免生接收工作\uff0c制定本办法。\n一、组织管理", []),
        (
            "gpower-article",
            "我院2027年接收推免生工作已经结束\uff0c拟录取名单见附件。\n示例拟录取名单",
            [("示例拟录取名单.pdf", "https://example.edu.cn/info/docs/2026-10/example.pdf")],
        ),
        (
            "ustb-graduate",
            "欢迎优秀应届本科毕业生申请推荐免试攻读示例大学研究生。\n一、申请条件",
            [
                (
                    "附件1\uff1a示例专业目录.xlsx",
                    "https://example.edu.cn/docs/2026-09/example1.xlsx",
                ),
                ("附件2\uff1a示例鉴定表.doc", "https://example.edu.cn/docs/2026-09/example2.doc"),
            ],
        ),
        ("ucas", "示例大学2027年有若干个培养单位招收硕士研究生。\n一、培养目标", []),
        ("ucas-unit", "示例研究所创建于1956年。\n单位代码\t80000", []),
        ("abody", "根据评审细则\uff0c现将推荐名单公示如下。\n序号\t姓名\n1\t张三\n示例学院", []),
        (
            "wechat",
            "为促进优秀大学生交流\uff0c我院拟举办2027年优秀大学生学术沙龙。\n"
            "报名时间\uff1a即日起至6月30日12点",
            [
                ("图片", "https://mmbiz.qpic.cn/mmbiz_gif/example/640?wx_fmt=gif"),
                ("图片", "https://mmbiz.qpic.cn/mmbiz_png/example/640?wx_fmt=png"),
            ],
        ),
        (
            "drupal",
            "示例学院位于示例校区。\n一、招收对象\n附件\uff1a示例申请表.docx",
            [
                (
                    "示例申请表.docx",
                    "https://example.edu.cn/sites/default/files/2026-06/example.docx",
                )
            ],
        ),
        (
            "gpower-page-article",
            "欢迎优秀应届本科毕业生推荐免试攻读示例学院研究生。\n一、招收类别",
            [],
        ),
        (
            "trs-editor",
            "根据示例大学2027年推免工作安排\uff0c现将有关事项通知如下。\n学院\t网址\n示例学院\thttps://example.edu.cn/",
            [],
        ),
        ("tinymce", "院系代码\t院系名称\n010\t示例学院", []),
        (
            "sustech",
            "示例系2027年接收推荐免试研究生预报名现已开始。\n示例报名表.pdf",
            [("示例报名表.pdf", "https://example.edu.cn/upload/example.pdf")],
        ),
        (
            "newsinfo",
            "示例学院现面向本校2027届本科毕业生开展推免选拔。\n示例名额表.xlsx",
            [("示例名额表.xlsx", "https://example.edu.cn/upload/2026/example.xlsx")],
        ),
        ("article-content", "根据示例文件\uff0c现将示例计划有关事项通知如下。", []),
        (
            "embedded-file",
            "",
            [
                (
                    "示例通知.pdf",
                    "https://example.edu.cn/Assets/userfiles/files/%E7%A4%BA%E4%BE%8B%E9%80%9A%E7%9F%A5.pdf",
                )
            ],
        ),
        ("vsb-id", "示例学院\t示例研究院", []),
        (
            "blog",
            "经学生申请、学院考核\uff0c同意以下12名学生进入示例计划\uff0c现予公示。\n示例名单.pdf",
            [("示例名单.pdf", "https://example.edu.cn/upload/2025/example.pdf")],
        ),
    ],
)
def test_site_system_templates_keep_the_body_and_its_attachments_in_order(
    name: str, text: str, attachments: list[tuple[str, str]]
) -> None:
    notice = parse_notice((FIXTURES / f"{name}.html").read_bytes(), URL, None)
    assert notice.text == text
    assert notice.attachments == [AttachmentLink(*attachment) for attachment in attachments]


@pytest.mark.parametrize(
    ("page", "text"),
    [
        # A system's own mark comes before an editor's within it, which would lose the rest.
        (
            '<div class="gp-content"><div class="TRS_Editor"><p>编辑器里的段落</p></div>'
            '<p><a href="/a.doc">报名表.doc</a></p></div>',
            "编辑器里的段落\n报名表.doc",
        ),
        # A mark that sits elsewhere than its system puts it is no body.
        (
            '<div class="side"><div class="article-content">侧栏</div></div>'
            '<div class="wrapArticle"><div class="article">正文</div></div>',
            "正文",
        ),
        (
            '<div class="pageArticle"><div class="side"><div class="article">侧栏</div></div>'
            '<div class="wrapArticle"><div class="article">正文</div></div></div>',
            "正文",
        ),
        ('<div class="wrapArticle"><div class="article">正文</div></div>', "正文"),
    ],
)
def test_where_systems_mark_their_bodies_decides_between_marks(page: str, text: str) -> None:
    assert parse_notice(page.encode(), URL, None).text == text


def test_a_shell_without_its_body_is_no_body() -> None:
    page = '<div class="detail-sticky-left-content"><h2>标题</h2><p>发布日期</p></div>'
    with pytest.raises(ParseError):
        parse_notice(page.encode(), URL, None)


def test_only_files_framed_in_the_body_are_attachments_named_by_their_files() -> None:
    page = (
        '<div class="view-cnt"><iframe src="/files/%E9%80%9A%E7%9F%A5.pdf" title="预览"></iframe>'
        '<iframe src="/embed/player" title="讲座资料.pdf"></iframe>'
        '<iframe src="/viewer.html" pdfsrc="/files/b.pdf"></iframe></div>'
        '<div class="Annex"><iframe src="/outside.pdf"></iframe></div>'
    )
    assert parse_notice(page.encode(), URL, None).attachments == [
        AttachmentLink("通知.pdf", "https://example.edu.cn/files/%E9%80%9A%E7%9F%A5.pdf"),
        AttachmentLink("b.pdf", "https://example.edu.cn/files/b.pdf"),
    ]


def test_links_keep_where_their_words_are_and_resolve_against_the_final_address() -> None:
    page = (
        '<meta charset="gbk"><div class="v_news_content"><p>请在<a href="../apply/">'
        "<span>报名</span><b>系统</b></a>填报\uff0c或发邮件至"
        '<a href="mailto:yz@example.edu.cn">yz@example.edu.cn</a>。'
        '<a href="javascript:void(0)">打印</a></p></div>'
    )
    notice = parse_notice(page.encode("gbk"), "https://example.edu.cn/info/1001/101.htm", None)
    assert notice.text == "请在报名系统填报\uff0c或发邮件至yz@example.edu.cn。打印"
    assert [(notice.text[link.start : link.end], link.href) for link in notice.hyperlinks] == [
        ("报名系统", "https://example.edu.cn/info/apply/"),
        ("yz@example.edu.cn", "mailto:yz@example.edu.cn"),
    ]


def test_links_too_broken_to_read_are_skipped_and_the_rest_kept() -> None:
    page = (
        '<div class="v_news_content"><p><a href="http://[broken">坏链接</a>'
        '<a href="/files/b.pdf">简章.pdf</a></p><img src="http://[broken.png">'
        "<script>var appLinkStr='http://[broken|/files/c.doc';"
        "var appDescStr='坏附件|报名表.doc';</script></div>"
    )
    notice = parse_notice(page.encode(), URL, None)
    assert notice.attachments == [
        AttachmentLink("简章.pdf", "https://example.edu.cn/files/b.pdf"),
        AttachmentLink("报名表.doc", "https://example.edu.cn/files/c.doc"),
    ]
    assert [link.href for link in notice.hyperlinks] == ["https://example.edu.cn/files/b.pdf"]


@pytest.mark.parametrize(
    ("base", "link", "resolved"),
    [
        ("http://[broken", "/files/a.pdf", "https://example.edu.cn/files/a.pdf"),
        ("https://example.edu.cn/b/", "a.pdf", "https://example.edu.cn/b/a.pdf"),
    ],
)
def test_a_broken_link_against_the_pages_base_spoils_only_itself(
    base: str, link: str, resolved: str
) -> None:
    page = (
        f'<base href="{base}"><div class="v_news_content"><p>示例'
        f'<a href="http://[broken">坏链接</a><a href="{link}">简章.pdf</a></p></div>'
    )
    notice = parse_notice(page.encode(), URL, None)
    assert notice.text == "示例坏链接简章.pdf"
    assert notice.attachments == [AttachmentLink("简章.pdf", resolved)]


def test_a_page_no_template_knows_is_not_guessed_at() -> None:
    with pytest.raises(ParseError, match="认不出正文"):
        parse_notice("<nav>导航</nav><div>自编的正文</div>".encode(), URL, None)


def test_a_picture_is_taken_from_data_src_only_while_src_is_a_placeholder() -> None:
    page = (
        '<div class="v_news_content"><p>示例</p><img src="/full.png" data-src="/thumb.png">'
        '<img src="data:image/gif;base64,R0lGOD" data-src="/lazy.png"></div>'
    )
    notice = parse_notice(page.encode(), URL, None)
    assert notice.attachments == [
        AttachmentLink("full.png", "https://example.edu.cn/full.png"),
        AttachmentLink("lazy.png", "https://example.edu.cn/lazy.png"),
    ]
