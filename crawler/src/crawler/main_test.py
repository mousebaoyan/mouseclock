import asyncio
import io
import json
import logging
from typing import Any, Never

import httpx
import pytest

from crawler.crawl.browser import Browser, PageSession
from crawler.crawl.contract import ListedItem, ProbeReport, Run, WorkProbe, WorkSource
from crawler.crawl.fetch import Fetcher
from crawler.crawl.probe_test import BODY, CONFIG
from crawler.crawl.rounds import StepError, Steps
from crawler.crawl.website import Website
from crawler.extraction.probe import ProbeConfig
from crawler.extraction.responses import Responses
from crawler.log import JsonFormatter
from crawler.main import load_config, serve


async def unused(*_: object) -> Never:
    raise AssertionError


def test_bad_configuration_is_named_without_its_values(caplog: pytest.LogCaptureFixture) -> None:
    environ = {"MOUSECLOCK_URL": "ftp://user:secret@site", "MOUSECLOCK_TOKEN": "token"}

    with pytest.raises(SystemExit):
        load_config(environ)

    line = JsonFormatter().format(caplog.records[0])
    assert json.loads(line)["variables"].keys() == {
        "MOUSECLOCK_URL",
        "SYSTEM_ONE_API_KEY",
        "LLM_API_KEY",
    }
    assert "secret" not in line


def test_a_failing_round_leaves_the_others_and_stopping_waits_for_them() -> None:
    sources = [
        WorkSource(id=n, url=f"http://a{n}/list.htm", browser=False, config=None, backfill=False)
        for n in (1, 2)
    ]
    calls: list[tuple[str, Any]] = []

    def handle(request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/api/v1/crawler")
        calls.append((f"{request.method} {path}", request.content and json.loads(request.content)))
        if path == "/work":
            work = {"sources": [s.model_dump(mode="json") for s in sources], "probes": []}
            return httpx.Response(200, json=work)
        return httpx.Response(204)

    async def list_items(_pages: PageSession, source: WorkSource) -> list[ListedItem]:
        if source.id == 1:
            raise RuntimeError("bug")
        raise StepError("no_items")

    async def main() -> None:
        stopping = asyncio.Event()
        stopping.set()
        nowhere = httpx.MockTransport(lambda _: httpx.Response(500))
        async with (
            Fetcher(nowhere) as fetcher,
            Website("http://site", "token", httpx.MockTransport(handle)) as website,
        ):
            await serve(
                website,
                Browser(fetcher),
                Steps(list_items, unused, unused, unused),
                stopping,
                unused,
            )

    # Formatted as they are logged, inside the round.
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    logging.getLogger("crawler").addHandler(handler)
    try:
        asyncio.run(main())
    finally:
        logging.getLogger("crawler").removeHandler(handler)

    assert [call for call, _ in calls] == ["GET /work", "POST /runs"]
    assert calls[1][1]["source_id"] == 2
    lines = [json.loads(line) for line in stream.getvalue().splitlines()]
    [failed] = [line for line in lines if line["msg"] == "Round failed"]
    assert failed["source_id"] == 1
    assert isinstance(failed["started_at"], int)
    assert "RuntimeError: bug" in failed["stack"]


def test_asking_for_work_that_fails_leaves_the_rounds_and_logs_no_details(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr("crawler.main.POLL", 0)
    source = WorkSource(id=1, url="http://a/list.htm", browser=False, config=None, backfill=False)
    calls: list[str] = []
    stopping = asyncio.Event()
    failed_twice = asyncio.Event()

    def handle(request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/api/v1/crawler")
        calls.append(f"{request.method} {path}")
        if path != "/work":
            return httpx.Response(204)
        polls = calls.count("GET /work")
        if polls == 1:
            work = {"sources": [source.model_dump(mode="json")], "probes": []}
            return httpx.Response(200, json=work)
        if polls == 2:
            # A website that no longer matches this crawler's contract.
            return httpx.Response(200, json={"sources": "invalid", "probes": []})
        failed_twice.set()
        raise httpx.LocalProtocolError(f"Illegal header value {request.headers['authorization']}")

    # Still in progress while the next two asks fail.
    async def list_items(_pages: PageSession, _source: WorkSource) -> list[ListedItem]:
        await failed_twice.wait()
        stopping.set()
        raise StepError("no_items")

    async def main() -> None:
        nowhere = httpx.MockTransport(lambda _: httpx.Response(500))
        async with (
            Fetcher(nowhere) as fetcher,
            Website("http://site", "token-secret", httpx.MockTransport(handle)) as website,
        ):
            await serve(
                website,
                Browser(fetcher),
                Steps(list_items, unused, unused, unused),
                stopping,
                unused,
            )

    asyncio.run(main())

    assert "POST /runs" in calls
    failures = [r for r in caplog.records if r.getMessage() == "Asking for work failed"]
    assert [vars(r)["error"] for r in failures[:2]] == ["ValidationError", "LocalProtocolError"]
    assert all("token-secret" not in JsonFormatter().format(r) for r in caplog.records)


def test_probe_from_work_generates_preview_while_other_tasks_fail_and_stop_waits() -> None:
    source = WorkSource(
        id=1, url="https://regular.example/list", browser=False, config=None, backfill=False
    )
    probes = [
        WorkProbe(id=46, url="https://probe.example/list", browser=False, config=None),
        WorkProbe(id=47, url="https://broken.example/list", browser=False, config=None),
    ]
    reports: list[ProbeReport] = []
    runs: list[Run] = []
    requests: list[str] = []
    at_model = asyncio.Event()
    release_model = asyncio.Event()

    def website_response(request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/api/v1/crawler")
        if path == "/work":
            return httpx.Response(
                200,
                json={
                    "sources": [source.model_dump(mode="json")],
                    "probes": [probe.model_dump(mode="json") for probe in probes],
                },
            )
        if path == "/probes/46":
            reports.append(ProbeReport.model_validate_json(request.content))
        elif path == "/runs":
            runs.append(Run.model_validate_json(request.content))
        else:
            raise AssertionError(f"Unexpected submission: {path}")
        return httpx.Response(204)

    def source_response(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        if request.url.host == "broken.example":
            raise RuntimeError("probe bug")
        return httpx.Response(200, content=BODY)

    async def model_response(_request: httpx.Request) -> httpx.Response:
        at_model.set()
        await release_model.wait()
        assert CONFIG.selectors is not None
        return httpx.Response(
            200,
            json={
                "model": "fixed-model",
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "content": [
                            {
                                "type": "output_text",
                                "text": CONFIG.selectors.model_dump_json(),
                            }
                        ],
                    }
                ],
                "usage": {"input_tokens": 120, "output_tokens": 40},
            },
        )

    async def list_items(_pages: PageSession, _source: WorkSource) -> list[ListedItem]:
        raise StepError("no_items")

    async def main() -> None:
        stopping = asyncio.Event()
        async with (
            asyncio.timeout(5),
            Fetcher(httpx.MockTransport(source_response)) as fetcher,
            Website(
                "https://website.example", "fake-token", httpx.MockTransport(website_response)
            ) as website,
            Responses("fake-key", httpx.MockTransport(model_response)) as model,
        ):
            running = asyncio.create_task(
                serve(
                    website,
                    Browser(fetcher),
                    Steps(list_items, unused, unused, unused),
                    stopping,
                    ProbeConfig(model).generate,
                )
            )
            await at_model.wait()
            stopping.set()
            await asyncio.sleep(0)
            assert not running.done()
            release_model.set()
            await running

    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    logging.getLogger("crawler").addHandler(handler)
    try:
        asyncio.run(main())
    finally:
        logging.getLogger("crawler").removeHandler(handler)
    [report] = reports
    assert report.failure is None
    assert [item.title for item in report.items] == ["自编招生通知甲", "自编招生通知乙"]
    assert report.items[0].url == "https://probe.example/notice/101.html"
    assert report.suggested_config is not None
    assert report.usage[0].input_tokens == 120
    assert report.usage[0].output_tokens == 40
    assert sorted(requests) == ["https://broken.example/list", "https://probe.example/list"]
    [run] = runs
    assert run.source_id == 1
    assert run.failure == "no_items"
    lines = [json.loads(line) for line in stream.getvalue().splitlines()]
    [entry] = [line for line in lines if line["msg"] == "Probe failed"]
    assert entry["probe_id"] == 47
    assert "RuntimeError: probe bug" in entry["stack"]
