"""Run with `uv run python -m crawler.parse.example`; inputs and choices are synthetic."""

from datetime import date

from pydantic import TypeAdapter

from crawler.crawl.contract import Apply, ApplyUrl, ApplyValue, ExtractedFields
from crawler.parse.indexing import Document, Hyperlink, NoticeIndex, index_documents


def main() -> None:
    text = (
        "网上报名自即日起至6月18日17:00。\n"
        "请通过研究生招生系统完成报名\uff1b系统操作说明见帮助页面。\n"
        "申请材料请于6月20日前发送至camp@example.org。\n"
        "夏令营拟于7月上旬举行\uff0c具体安排另行通知。\n"
        "附件\uff1a申请材料说明.pdf。"
    )
    platform = text.index("研究生招生系统")
    help_page = text.index("帮助页面")
    documents = [
        Document(
            text,
            hyperlinks=(
                Hyperlink(
                    platform,
                    platform + len("研究生招生系统"),
                    "https://apply.example.org/camp?year=2028",
                ),
                Hyperlink(help_page, help_page + len("帮助页面"), "/help/camp.html"),
            ),
        ),
        Document(
            "邮件主题请写姓名与所在学校。\n材料接收邮箱\uff1acamp@example.org。",
            attachment=0,
            url="https://admissions.example.org/files/materials.pdf",
        ),
    ]
    index = index_documents(
        documents,
        published_on=date(2027, 6, 1),
        source_url="https://admissions.example.org/notices/2027-camp.html",
    )
    print("Indexed notice:")
    print(TypeAdapter(NoticeIndex).dump_json(index, indent=2).decode())

    # These fixed choices stand in for a model response, not an actual model call.
    application = index.dates["D1"]
    platform_link = index.links["L1"]
    if platform_link.target is None:
        raise ValueError("Selected link has an invalid target")
    fields = ExtractedFields(
        apply=Apply(
            value=ApplyValue(start=application.match.value, end=application.match.end_value),
            evidence=[index.evidence(application.sentence_id)],
            confidence=0.95,
        ),
        apply_url=ApplyUrl(
            value=platform_link.target,
            evidence=[index.evidence(platform_link.sentence_id)],
            confidence=0.95,
        ),
    )
    print("Fields assembled from simulated choices D1 and L1:")
    print(fields.model_dump_json(indent=2, exclude_none=True))


if __name__ == "__main__":
    main()
