"""Exercise the existing round and HTTP client with fixed read and extraction responses."""

import asyncio
from datetime import date

import httpx

from crawler.crawl.contract import (
    Apply,
    ApplyUrl,
    ApplyValue,
    AttachmentInfo,
    CollegeRef,
    Contacts,
    ExtractedFields,
    ExtractedProgram,
    Extraction,
    ExtractionContext,
    ListedItem,
    PendingNotice,
    ProgramCandidate,
    Run,
    ScreeningResult,
    Snapshot,
    TimeToDay,
    TimeToMinute,
    Usage,
    WorkSource,
)
from crawler.crawl.fetch import Fetcher
from crawler.crawl.rounds import Attachment, NoticePage, Steps, crawl_source
from crawler.crawl.website import Website
from crawler.parse.indexing import Document, index_documents


def test_index_can_feed_the_existing_round_without_changing_its_contract() -> None:
    source = WorkSource(
        id=7,
        url="https://example.org/list",
        section="通知",
        browser=False,
        config=None,
        backfill=False,
    )
    notice_url = "https://example.org/notices/update.html"
    context = ExtractionContext(
        published_on=date(2027, 6, 10),
        colleges=[CollegeRef(id=2, name="示例学院")],
        programs=[
            ProgramCandidate(
                id=17,
                college_id=2,
                cohort=2028,
                kind="summer_camp",
                name="示例夏令营",
                apply=ApplyValue(
                    start=TimeToDay(date=date(2027, 6, 1)), end=TimeToDay(date=date(2027, 6, 18))
                ),
            )
        ],
    )
    page = NoticePage(
        html="<p>报名系统\uff1ahttps://apply.example.org/camp。</p>",
        text="报名系统\uff1ahttps://apply.example.org/camp。",
        attachments=[
            Attachment(
                AttachmentInfo(
                    name="unreadable.pdf",
                    url="https://example.org/empty.pdf",
                    content_type="application/pdf",
                    text="",
                ),
                b"",
            ),
            Attachment(
                AttachmentInfo(
                    name="update.pdf",
                    url="https://example.org/update.pdf",
                    content_type="application/pdf",
                    text="网上报名延期至6月28日17:00。\n材料接收邮箱camp@example.org。",
                ),
                b"synthetic attachment",
            ),
        ],
    )
    snapshots: list[Snapshot] = []
    extractions: list[Extraction] = []
    runs: list[Run] = []

    def handle(request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/api/v1/crawler")
        if path == "/sources/7/listing":
            return httpx.Response(
                200,
                json={
                    "new_count": 0,
                    "pending": [
                        {
                            "id": 9,
                            "url": notice_url,
                            "title": "延期通知",
                            "published_on": "2027-06-10",
                            "step": "fetch",
                        }
                    ],
                },
            )
        if path == "/notices/9/snapshot":
            snapshots.append(Snapshot.model_validate_json(request.content))
            return httpx.Response(
                200,
                json={
                    "snapshot_id": 90,
                    "missing_files": [],
                    "extraction": context.model_dump(mode="json"),
                },
            )
        if path == "/snapshots/90/extraction":
            # Only changed fields are sent; the previous application start is not copied.
            assert b'"start":' not in request.content
            assert b"null" not in request.content
            extractions.append(Extraction.model_validate_json(request.content))
            return httpx.Response(204)
        if path == "/runs":
            runs.append(Run.model_validate_json(request.content))
            return httpx.Response(204)
        raise AssertionError(f"Unexpected request: {path}")

    async def list_items(_fetcher: Fetcher, _source: WorkSource) -> list[ListedItem]:
        return [ListedItem(url=notice_url, title="延期通知", published_on=context.published_on)]

    async def screen(
        _source: WorkSource, _notices: list[PendingNotice]
    ) -> tuple[list[ScreeningResult], list[Usage]]:
        raise AssertionError("This notice was already screened")

    async def read(_fetcher: Fetcher, _source: WorkSource, _url: str) -> NoticePage:
        return page

    async def extract(
        incoming: NoticePage, extraction_context: ExtractionContext
    ) -> tuple[list[ExtractedProgram], list[Usage]]:
        documents = [Document(incoming.text)]
        documents.extend(
            Document(attachment.info.text, attachment=position, url=attachment.info.url)
            for position, attachment in enumerate(incoming.attachments)
        )
        # Steps.extract has no notice URL, so indexing must work without one.
        index = index_documents(documents, published_on=extraction_context.published_on)
        # Fixed choices simulate the output of #44's future model, not its implementation.
        deadline, platform, email = index.dates["D1"], index.links["L1"], index.emails["E1"]
        assert platform.target is not None
        assert email.target is not None
        candidate = extraction_context.programs[0]
        return [
            ExtractedProgram(
                program_id=candidate.id,
                college_id=candidate.college_id,
                cohort=candidate.cohort,
                kind=candidate.kind,
                name=candidate.name,
                role="update",
                fields=ExtractedFields(
                    apply=Apply(
                        value=ApplyValue(end=deadline.match.value),
                        evidence=[index.evidence(deadline.sentence_id)],
                        confidence=0.95,
                    ),
                    apply_url=ApplyUrl(
                        value=platform.target,
                        evidence=[index.evidence(platform.sentence_id)],
                        confidence=0.95,
                    ),
                    contacts=Contacts(
                        value=[email.target],
                        evidence=[index.evidence(email.sentence_id)],
                        confidence=0.95,
                    ),
                ),
            )
        ], []

    async def run() -> None:
        def no_source_requests(request: httpx.Request) -> httpx.Response:
            raise AssertionError(f"Unexpected external request: {request.url}")

        async with (
            Fetcher(httpx.MockTransport(no_source_requests)) as fetcher,
            Website(
                "https://website.example.org", "synthetic-token", httpx.MockTransport(handle)
            ) as website,
        ):
            await crawl_source(
                source,
                fetcher,
                website,
                Steps(list_items, screen, read, extract),
                clock=lambda: 1_800_000_000,
            )

    asyncio.run(run())
    [snapshot] = snapshots
    [extraction] = extractions
    [program] = extraction.programs
    [record] = runs
    assert program.program_id == 17
    assert program.fields.apply is not None
    assert program.fields.apply.value.start is None
    assert program.fields.apply.value.end == TimeToMinute(date=date(2027, 6, 28), time="17:00")
    assert program.fields.apply.evidence[0].attachment == 1
    assert program.fields.apply_url is not None
    assert program.fields.apply_url.value == "https://apply.example.org/camp"
    assert program.fields.contacts is not None
    assert program.fields.contacts.value == ["camp@example.org"]
    for field in (program.fields.apply, program.fields.apply_url, program.fields.contacts):
        for evidence in field.evidence:
            text = (
                snapshot.text
                if evidence.attachment is None
                else snapshot.attachments[evidence.attachment].text
            )
            assert evidence.quote in text
    assert record.notice_failures == []
