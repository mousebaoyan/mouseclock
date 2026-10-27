"""The website's side of the crawl (docs/api.md §6). What to crawl comes from it and everything
found goes back to it; the crawler keeps nothing of its own between rounds."""

from typing import Self

import httpx
from pydantic import BaseModel

from crawler.crawl.contract import (
    Extraction,
    Listing,
    ListingResult,
    ProbeReport,
    Run,
    Screening,
    Snapshot,
    SnapshotResult,
    Work,
)

TIMEOUT = 60.0


class Website:
    def __init__(
        self, url: str, token: str, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self._client = httpx.AsyncClient(
            base_url=f"{url.rstrip('/')}/api/v1/crawler",
            headers={"Authorization": f"Bearer {token}"},
            timeout=TIMEOUT,
            transport=transport,
        )

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self._client.aclose()

    async def work(self) -> Work:
        return Work.model_validate_json(await self._call("GET", "/work"))

    async def listing(self, source_id: int, listing: Listing) -> ListingResult:
        body = await self._call("POST", f"/sources/{source_id}/listing", listing)
        return ListingResult.model_validate_json(body)

    async def screening(self, source_id: int, screening: Screening) -> None:
        await self._call("POST", f"/sources/{source_id}/screening", screening)

    async def snapshot(self, notice_id: int, snapshot: Snapshot) -> SnapshotResult:
        body = await self._call("POST", f"/notices/{notice_id}/snapshot", snapshot)
        return SnapshotResult.model_validate_json(body)

    async def attachment(self, snapshot_id: int, position: int, data: bytes) -> None:
        response = await self._client.put(
            f"/snapshots/{snapshot_id}/attachments/{position}",
            content=data,
            headers={"Content-Type": "application/octet-stream"},
        )
        response.raise_for_status()

    async def extraction(self, snapshot_id: int, extraction: Extraction) -> None:
        await self._call("POST", f"/snapshots/{snapshot_id}/extraction", extraction)

    async def removed(self, notice_id: int) -> None:
        await self._call("POST", f"/notices/{notice_id}/removed")

    async def run(self, run: Run) -> None:
        await self._call("POST", "/runs", run)

    async def probe(self, probe_id: int, report: ProbeReport) -> None:
        await self._call("POST", f"/probes/{probe_id}", report)

    async def _call(self, method: str, path: str, body: BaseModel | None = None) -> bytes:
        # Values the crawler doesn't have are left out rather than sent as null (development §1).
        json = None if body is None else body.model_dump(mode="json", exclude_none=True)
        response = await self._client.request(method, path, json=json)
        response.raise_for_status()
        return response.content
