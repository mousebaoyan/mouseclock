from pathlib import Path

import pytest

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
    ],
)
def test_site_system_templates_keep_the_body_and_its_attachments_in_order(
    name: str, text: str, attachments: list[tuple[str, str]]
) -> None:
    notice = parse_notice((FIXTURES / f"{name}.html").read_bytes(), URL, None)
    assert notice.text == text
    assert notice.attachments == [AttachmentLink(*attachment) for attachment in attachments]


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


def test_a_page_no_template_knows_is_not_guessed_at() -> None:
    with pytest.raises(ValueError, match="认不出正文"):
        parse_notice("<nav>导航</nav><div>自编的正文</div>".encode(), URL, None)
