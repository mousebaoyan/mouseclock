import asyncio
import json
from types import TracebackType
from typing import Annotated, Literal, Self

import httpx
from pydantic import BaseModel, Field, JsonValue, ValidationError

from crawler.crawl.rounds import StepError

API_URL = "https://api.deepseek.com/responses"
MODEL = "deepseek-flash"
REASONING_EFFORT = "none"
TEMPERATURE = 0
MAX_OUTPUT_TOKENS = 8192
TIMEOUT = 180
CONCURRENCY = 2
type TokenCount = Annotated[int, Field(strict=True, ge=0)]


class InputDetails(BaseModel):
    cached_tokens: TokenCount | None = None


class ResponseUsage(BaseModel):
    input_tokens: TokenCount
    output_tokens: TokenCount
    input_tokens_details: InputDetails | None = None


class Content(BaseModel):
    type: str
    text: str | None = None


class Output(BaseModel):
    type: str
    content: list[Content] = []


class Response(BaseModel):
    model: str
    status: Literal["in_progress", "completed", "incomplete", "failed"]
    output: list[Output]
    usage: ResponseUsage | None = None

    def output_text(self) -> str:
        if self.status != "completed":
            raise StepError("error", f"模型调用失败: {self.status}")
        parts = [part for item in self.output if item.type == "message" for part in item.content]
        if any(part.type != "output_text" or part.text is None for part in parts):
            raise StepError("error", "模型调用失败: non_text_output")
        text = "".join(part.text for part in parts if part.text is not None)
        if not text:
            raise StepError("error", "模型调用失败: empty_output")
        return text


def make_request(
    instructions: str,
    school: dict[str, JsonValue],
    notice: dict[str, JsonValue],
    schema: dict[str, JsonValue],
    *,
    name: str = "notice_extraction",
) -> dict[str, JsonValue]:
    # Keep shared context ahead of notice data and independent of mapping insertion order.
    return {
        "model": MODEL,
        "instructions": instructions,
        "input": [
            {"role": "user", "content": json.dumps(school, ensure_ascii=False, sort_keys=True)},
            {"role": "user", "content": json.dumps(notice, ensure_ascii=False, sort_keys=True)},
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": name,
                "schema": schema,
                "strict": True,
            }
        },
        "reasoning": {"effort": REASONING_EFFORT},
        "temperature": TEMPERATURE,
        "max_output_tokens": MAX_OUTPUT_TOKENS,
        "store": False,
    }


class Responses:
    def __init__(self, key: str, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.client = httpx.AsyncClient(
            headers={"Authorization": f"Bearer {key}"}, timeout=TIMEOUT, transport=transport
        )
        self.slots = asyncio.Semaphore(CONCURRENCY)

    async def __aenter__(self) -> Self:
        await self.client.__aenter__()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.client.__aexit__(exc_type, exc, tb)

    async def generate(self, payload: dict[str, JsonValue]) -> Response:
        try:
            async with self.slots:
                response = await self.client.post(API_URL, json=payload)
        except httpx.HTTPError as error:
            raise StepError("error", f"模型调用失败: {type(error).__name__}") from error
        if response.status_code != 200:
            raise StepError("error", f"模型调用失败: http_{response.status_code}")
        try:
            return Response.model_validate_json(response.content)
        except ValidationError as error:
            raise StepError("error", "模型调用失败: invalid_response") from error
