"""The LLM, through Chat Completions on the ECNU platform (design §5.2). Its Responses endpoint
takes a JSON schema without holding the answer to it; Chat Completions holds it."""

import asyncio
import json
import logging
import time
from types import TracebackType
from typing import Annotated, Self

import httpx
from pydantic import BaseModel, Field, JsonValue, ValidationError

from crawler.crawl.rounds import StepError

API_URL = "https://chat.ecnu.edu.cn/open/api/v1/chat/completions"
# DeepSeek V4.1 Flash on the platform; it thinks only when asked to.
MODEL = "ecnu-max"
TEMPERATURE = 0
MAX_OUTPUT_TOKENS = 8192
TIMEOUT = 180
# The platform lets one key have 3 calls to a model in flight.
CONCURRENCY = 2
logger = logging.getLogger(__name__)
type TokenCount = Annotated[int, Field(strict=True, ge=0)]


class PromptDetails(BaseModel):
    cached_tokens: TokenCount | None = None


class CompletionUsage(BaseModel):
    prompt_tokens: TokenCount
    completion_tokens: TokenCount
    prompt_tokens_details: PromptDetails | None = None


class Message(BaseModel):
    content: str | None = None


class Choice(BaseModel):
    message: Message
    finish_reason: str | None = None


class Completion(BaseModel):
    model: str
    choices: list[Choice]
    usage: CompletionUsage | None = None

    @property
    def finished(self) -> bool:
        """One answer the model ended itself, not cut off at the token limit or filtered."""
        return [choice.finish_reason for choice in self.choices] == ["stop"]

    def output_text(self) -> str:
        if not self.finished:
            reasons = ",".join(str(choice.finish_reason) for choice in self.choices)
            raise StepError("error", f"模型调用失败: {reasons or 'no_choice'}")
        text = self.choices[0].message.content
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
        "messages": [
            {"role": "system", "content": instructions},
            {"role": "user", "content": json.dumps(school, ensure_ascii=False, sort_keys=True)},
            {"role": "user", "content": json.dumps(notice, ensure_ascii=False, sort_keys=True)},
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": name, "schema": schema, "strict": True},
        },
        "temperature": TEMPERATURE,
        "max_tokens": MAX_OUTPUT_TOKENS,
    }


class Chat:
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

    async def generate(self, payload: dict[str, JsonValue]) -> Completion:
        try:
            async with self.slots:
                started = time.monotonic()
                response = await self.client.post(API_URL, json=payload)
                elapsed = time.monotonic() - started
        except httpx.HTTPError as error:
            raise StepError("error", f"模型调用失败: {type(error).__name__}") from error
        if response.status_code != 200:
            raise StepError("error", f"模型调用失败: http_{response.status_code}")
        try:
            result = Completion.model_validate_json(response.content)
        except ValidationError as error:
            raise StepError("error", "模型调用失败: invalid_response") from error
        usage = result.usage
        details = usage.prompt_tokens_details if usage else None
        logger.info(
            "Model answered",
            extra={
                "model": result.model,
                "finish_reasons": [choice.finish_reason for choice in result.choices],
                "input_tokens": usage.prompt_tokens if usage else None,
                "output_tokens": usage.completion_tokens if usage else None,
                "cached_tokens": details.cached_tokens if details else None,
                "elapsed": elapsed,
            },
        )
        return result
