import asyncio
import io
import json
import logging
from typing import Any, Never

import httpx
import pytest

from crawler.crawl.browser import Browser, PageSession
from crawler.crawl.contract import ListedItem, WorkSource
from crawler.crawl.fetch import Fetcher
from crawler.crawl.rounds import StepError, Steps
from crawler.crawl.website import Website
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
                website, Browser(fetcher), Steps(list_items, unused, unused, unused), stopping
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
                website, Browser(fetcher), Steps(list_items, unused, unused, unused), stopping
            )

    asyncio.run(main())

    assert "POST /runs" in calls
    failures = [r for r in caplog.records if r.getMessage() == "Asking for work failed"]
    assert [vars(r)["error"] for r in failures[:2]] == ["ValidationError", "LocalProtocolError"]
    assert all("token-secret" not in JsonFormatter().format(r) for r in caplog.records)
