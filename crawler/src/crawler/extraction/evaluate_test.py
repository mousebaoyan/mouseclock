import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from pydantic import JsonValue, TypeAdapter

from crawler.crawl.contract import Contacts, Evidence, ExtractedProgram, ExtractionContext
from crawler.crawl.fetch import Fetcher
from crawler.crawl.rounds import NoticePage
from crawler.extraction.evaluate import CachedCall, Options, Result, cost_cny, evaluate
from crawler.extraction.extract import RoundSelection, prepare
from crawler.extraction.metrics import Evaluation, pair_programs
from crawler.extraction.numbered import SelectedFields
from crawler.extraction.pages import Page, article, read_page, save_page
from crawler.extraction.responses import MODEL, InputDetails, Response, Responses, ResponseUsage
from crawler.extraction.schema import Extraction, LabelProgram, Notice
from crawler.parse.indexing import NoticeIndex


def sources(path: Path) -> Path:
    result = path / "sources.csv"
    result.write_text("school,college\nExample University,Computer Science\n", encoding="utf-8")
    return result


def make_call(item: Notice, text: str) -> dict[str, JsonValue]:
    context = ExtractionContext.model_validate(
        {
            "published_on": item.published_on,
            "colleges": [{"id": 1, "name": "Computer Science"}],
            "programs": [],
        }
    )
    return prepare(item.title, NoticePage("", text, [], hyperlinks=()), context)[0]


def completion(content: str) -> dict[str, JsonValue]:
    return {
        "model": MODEL,
        "status": "completed",
        "output": [{"type": "message", "content": [{"type": "output_text", "text": content}]}],
        "usage": {
            "input_tokens": 12,
            "output_tokens": 7,
            "input_tokens_details": {"cached_tokens": 0},
        },
    }


def notice() -> Notice:
    return Notice.model_validate(
        {
            "url": "https://example.edu.cn/notice/1",
            "title": "2026 summer camp",
            "school": "Example University",
            "published_on": "2026-05-01",
            "programs": [
                {
                    "college": "Computer Science",
                    "cohort": 2027,
                    "kind": "summer_camp",
                    "role": "call",
                    "fields": {
                        "apply": {"end": {"date": "2026-06-30", "time": "24:00"}},
                    },
                }
            ],
        }
    )


def extraction() -> Extraction:
    return Extraction.model_validate_json(
        json.dumps(
            {
                "programs": [
                    {
                        "college": "Computer Science",
                        "cohort": 2027,
                        "kind": "summer_camp",
                        "role": "call",
                        "name": "Summer camp",
                        "fields": {
                            "apply": {
                                "value": {"end": {"date": "2026-06-30", "time": "24:00"}},
                                "confidence": 0.9,
                                "evidence": [{"quote": "Deadline: June 30, 24:00."}],
                            },
                            "apply_url": None,
                            "event": None,
                            "degrees": None,
                        },
                    }
                ],
            }
        ),
        strict=True,
    )


def selected_extraction() -> RoundSelection:
    fields = dict.fromkeys(SelectedFields.model_fields)
    fields["apply"] = {
        "value": {"start": None, "end": {"date_id": "D1", "edge": "first"}, "rolling": None},
        "evidence": ["S1"],
        "confidence": 0.9,
    }
    return RoundSelection.model_validate(
        {
            "programs": [
                {
                    "college_id": 1,
                    "program_id": None,
                    "unresolved_dates": [],
                    "cohort": 2027,
                    "kind": "summer_camp",
                    "role": "call",
                    "name": "Summer camp",
                    "fields": fields,
                }
            ]
        }
    )


def test_missing_deadline_and_false_positive_are_not_rewarded_for_absence() -> None:
    metric = Evaluation()
    item = notice()
    metric.add(item, Extraction(programs=[]), "")
    negative = item.model_copy(update={"programs": []})
    metric.add(negative, extraction(), "Deadline: June 30, 24:00.")
    result = metric.metrics["apply.end"]
    assert (result.correct, result.expected, result.predicted, result.missing, result.extra) == (
        0,
        1,
        1,
        1,
        1,
    )
    assert metric.exact_notices == 0


def test_reordered_projects_are_matched_once_each() -> None:
    first = notice().programs[0]
    second = LabelProgram.model_validate(
        {
            **first.model_dump(mode="json"),
            "college": "Mathematics",
            "fields": {"apply": {"end": {"date": "2026-07-10"}}},
        }
    )
    pairs = pair_programs([first, second], [second, first])
    assert len(pairs) == 2
    assert all(expected == actual for expected, actual in pairs)
    pairs = pair_programs([first, second], [first])
    assert sum(actual is None for _, actual in pairs) == 1


def test_metadata_mismatch_does_not_turn_a_correct_deadline_into_missing_and_extra() -> None:
    prediction = extraction()
    prediction.programs[0].college = "Different college name"
    evaluation = Evaluation()
    evaluation.add(notice(), prediction, "Deadline: June 30, 24:00.")
    assert evaluation.metrics["college"].wrong == 1
    deadline = evaluation.metrics["apply.end"]
    assert (deadline.correct, deadline.missing, deadline.extra) == (1, 0, 0)


def test_partial_match_does_not_take_another_projects_exact_match() -> None:
    first = notice().programs[0]
    second = first.model_copy(update={"college": "Mathematics"})
    changed = first.model_copy(update={"cohort": 2028})
    assert pair_programs([first, second], [second, changed]) == [(first, changed), (second, second)]


def test_evidence_only_ignores_whitespace() -> None:
    metric = Evaluation()
    metric.add(notice(), extraction(), "Deadline:\n June 30,  24:00.")
    assert (metric.quotes, metric.missing_quotes) == (1, 0)
    metric.add(notice(), extraction(), "Deadline: June 30; 24:00.")
    assert (metric.quotes, metric.missing_quotes) == (2, 1)
    prediction = extraction()
    prediction.programs[0].fields.contacts = Contacts(
        value=["apply@example.edu.cn"],
        confidence=0.9,
        evidence=[Evidence(quote="Invented contact sentence")],
    )
    metric.add(notice(), prediction, "Deadline: June 30, 24:00.")
    assert (metric.quotes, metric.missing_quotes) == (4, 2)


def test_article_excludes_navigation_scripts_and_resolves_body_link() -> None:
    html = (
        '<nav>Wrong deadline</nav><div class="v_news_content"><p>Apply now.</p>'
        '<script>Untrusted code</script><a href="../apply">Portal</a></div><footer>Footer</footer>'
    )
    text, links = article(html, "https://example.edu.cn/news/1")
    assert text.strip() == "Apply now.\nPortal"
    assert len(links) == 1
    assert links[0].href == "https://example.edu.cn/apply"
    assert text[links[0].start : links[0].end] == "Portal"
    assert "https://example.edu.cn/apply" not in text


def test_reuse_only_uses_cached_body_and_response_without_network(tmp_path: Path) -> None:
    item = notice()
    dataset = tmp_path / "labels.json"
    dataset.write_text(TypeAdapter(list[Notice]).dump_json([item]).decode(), encoding="utf-8")
    text = "报名截止6月30日24时。"
    save_page(
        Page(
            url=item.url, final_url=item.url, text=text, fetched_at=datetime(2026, 5, 1, tzinfo=UTC)
        ),
        tmp_path / "pages.json",
    )
    entry = CachedCall(
        call=make_call(item, text),
        result=Result(
            response=Response.model_validate(completion(selected_extraction().model_dump_json())),
            elapsed_seconds=1,
            observed_at=datetime(2026, 5, 1, tzinfo=UTC),
        ),
    )
    (tmp_path / "calls.jsonl").write_text(entry.model_dump_json() + "\n", encoding="utf-8")
    status = asyncio.run(
        evaluate(
            Options(
                dataset=dataset,
                output=tmp_path,
                sources=sources(tmp_path),
                reuse_only=True,
                prepare_only=False,
            )
        )
    )
    assert status == 0
    report = json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))
    assert report["experiments"][MODEL]["exact_notices"] == 1
    assert report["experiments"][MODEL]["estimated_total_cny"] is not None


def test_invalid_selection_replays_raw_response_after_resolver_fix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    item = notice()
    dataset = tmp_path / "labels.json"
    dataset.write_bytes(TypeAdapter(list[Notice]).dump_json([item]))
    save_page(
        Page(
            url=item.url,
            final_url=item.url,
            text="报名截止6月30日24时。",
            fetched_at=datetime(2026, 5, 1, tzinfo=UTC),
        ),
        tmp_path / "pages.json",
    )
    calls = 0

    def respond(_: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        content = selected_extraction().model_dump_json().replace("D1", "D999")
        return httpx.Response(200, json=completion(content))

    def local_llm(key: str) -> Responses:
        return Responses(key, httpx.MockTransport(respond))

    monkeypatch.setenv("LLM_API_KEY", "local-test-credential")
    monkeypatch.setattr("crawler.extraction.evaluate.Responses", local_llm)
    options = Options(
        dataset=dataset,
        output=tmp_path,
        sources=sources(tmp_path),
        reuse_only=False,
        prepare_only=False,
    )
    assert asyncio.run(evaluate(options)) == 1
    entry = CachedCall.model_validate_json(
        (tmp_path / "calls.jsonl").read_text(encoding="utf-8").strip()
    )
    assert entry.result.error is None
    assert entry.result.response is not None
    assert entry.result.response.usage == ResponseUsage(
        input_tokens=12, output_tokens=7, input_tokens_details=InputDetails(cached_tokens=0)
    )
    assert asyncio.run(evaluate(options)) == 1
    assert calls == 1
    from crawler.extraction.extract import resolve_programs as original_resolve

    def fixed_resolve(
        selection: RoundSelection, index: NoticeIndex, context: ExtractionContext
    ) -> list[ExtractedProgram]:
        return original_resolve(
            RoundSelection.model_validate_json(selection.model_dump_json().replace("D999", "D1")),
            index,
            context,
        )

    monkeypatch.setattr("crawler.extraction.evaluate.resolve_programs", fixed_resolve)
    assert asyncio.run(evaluate(options)) == 0
    assert calls == 1
    report = json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))
    assert report["experiments"][MODEL]["exact_notices"] == 1


def test_cache_cannot_be_used_for_another_url(tmp_path: Path) -> None:
    path = tmp_path / "page.json"
    save_page(
        Page(
            url="https://example.edu.cn/1",
            final_url="https://example.edu.cn/1",
            text="text",
            fetched_at=datetime(2026, 5, 1, tzinfo=UTC),
        ),
        path,
    )

    async def run() -> None:
        async with Fetcher(httpx.MockTransport(lambda _: httpx.Response(500))) as fetcher:
            with pytest.raises(ValueError, match="page_cache_missing"):
                await read_page("https://example.edu.cn/2", path, fetcher, reuse_only=True)

    asyncio.run(run())


def test_fixed_denominator_separates_wrong_missing_and_extra() -> None:
    from crawler.extraction.metrics import Metric

    metric = Metric()
    metric.add("a", "a")
    metric.add("b", "wrong")
    metric.add("c", None)
    metric.add(None, "extra")
    report = metric.report()
    assert report["expected"] == 3
    assert report["accuracy"] == 1 / 3
    assert (report["correct"], report["wrong"], report["missing"], report["extra"]) == (1, 1, 1, 1)


def test_failed_requests_are_not_cached_and_retry_on_next_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    item = notice()
    dataset = tmp_path / "labels.json"
    dataset.write_bytes(TypeAdapter(list[Notice]).dump_json([item]))
    save_page(
        Page(
            url=item.url,
            final_url=item.url,
            text="报名截止6月30日24时。",
            fetched_at=datetime(2026, 5, 1, tzinfo=UTC),
        ),
        tmp_path / "pages.json",
    )
    calls = 0

    def respond(_: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return (
            httpx.Response(503)
            if calls == 1
            else httpx.Response(200, json=completion(selected_extraction().model_dump_json()))
        )

    monkeypatch.setenv("LLM_API_KEY", "local-test-credential")

    def local_llm(key: str) -> Responses:
        return Responses(key, httpx.MockTransport(respond))

    monkeypatch.setattr("crawler.extraction.evaluate.Responses", local_llm)
    options = Options(
        dataset=dataset,
        output=tmp_path,
        sources=sources(tmp_path),
        reuse_only=False,
        prepare_only=False,
    )
    assert asyncio.run(evaluate(options)) == 1
    assert not (tmp_path / "calls.jsonl").exists()
    assert asyncio.run(evaluate(options)) == 0
    assert calls == 2


def test_page_reader_honors_declared_gbk_encoding(tmp_path: Path) -> None:
    async def run() -> Page:
        body = '<meta charset="gbk"><div class="v_news_content">自编通知正文。</div>'.encode("gbk")
        async with Fetcher(
            httpx.MockTransport(lambda _: httpx.Response(200, content=body))
        ) as fetcher:
            return await read_page(
                "https://example.edu.cn/gbk", tmp_path / "pages.json", fetcher, reuse_only=False
            )

    assert asyncio.run(run()).text.strip() == "自编通知正文。"


def test_unknown_usage_is_not_free_and_cached_input_uses_the_official_rate() -> None:
    result = Result(elapsed_seconds=1, observed_at=datetime(2026, 11, 9, tzinfo=UTC))
    assert cost_cny(result) is None
    result.response = Response.model_validate(completion("{}"))
    assert cost_cny(result) == (12 * 2 + 7 * 8) / 1e6
    assert cost_cny(result, off_peak=True) == (12 * 2 + 7 * 8) / 2e6
    assert result.response.usage is not None
    result.response.usage.input_tokens_details = None
    assert cost_cny(result) is None
    assert cost_cny(result, cached=False) is not None
