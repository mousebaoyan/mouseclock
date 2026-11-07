import asyncio
import json
from datetime import UTC, datetime, timedelta, timezone
from time import perf_counter
from typing import Annotated, Literal

import httpx
from pydantic import BaseModel, Field, JsonValue, TypeAdapter, ValidationError

from crawler.extraction.numbered import SelectedExtraction, indexed_input
from crawler.extraction.prompt import INSTRUCTIONS
from crawler.extraction.schema import Notice, response_schema
from crawler.parse.indexing import Document, Hyperlink, index_documents

API_URL = "https://api.siliconflow.cn/v1/chat/completions"
DEFAULT_MODELS = (
    "deepseek-ai/DeepSeek-V4.1-Flash",
    "tencent/Hy4-preview",
    "zai-org/GLM-5.3-Flash",
    "deepseek-ai/DeepSeek-V4-Flash",
    "Qwen/Qwen3.8-27B",
)
MAX_TOKENS = 8192
TIMEOUT = 180
# CNY per million tokens: input, output, cached input; official pricing on 2026-11-07.
# https://cloud-rd.siliconflow.cn/pricing
PRICES = {
    DEFAULT_MODELS[0]: (2.0, 8.0, 0.04),
    DEFAULT_MODELS[1]: (6.0, 18.0, 0.3),
    DEFAULT_MODELS[2]: (0.8, 2.8, 0.23),
    DEFAULT_MODELS[3]: (3.0, 9.0, 0.3),
    DEFAULT_MODELS[4]: (3.0, 12.0, 3.0),
}
type Mode = Literal["off", "low", "high"]
type Count = Annotated[int, Field(strict=True, ge=0)]


class TokenDetails(BaseModel):
    reasoning_tokens: Count | None = None
    cached_tokens: Count | None = None


class Usage(BaseModel):
    prompt_tokens: Count
    completion_tokens: Count
    completion_tokens_details: TokenDetails | None = None
    prompt_tokens_details: TokenDetails | None = None


class Message(BaseModel):
    content: str | None = None
    refusal: str | None = None


class Choice(BaseModel):
    message: Message
    finish_reason: str


class Completion(BaseModel):
    model: str
    choices: list[Choice]


class Result(BaseModel):
    usage: Usage | None = None
    returned_model: str | None = None
    content: str | None = None
    elapsed_seconds: float
    observed_at: datetime
    error: str | None = None


class Call(BaseModel):
    api_url: str = API_URL
    timeout_seconds: float = TIMEOUT
    payload: dict[str, JsonValue]


def make_call(
    notice: Notice,
    text: str,
    model: str,
    mode: Mode,
    *,
    hyperlinks: tuple[Hyperlink, ...] = (),
    api_url: str = API_URL,
) -> Call:
    data = notice.model_dump(mode="json", exclude={"programs"})
    data["indexed"] = indexed_input(
        index_documents([Document(text, hyperlinks=hyperlinks)], published_on=notice.published_on)
    )
    options: dict[str, JsonValue] = {}
    if api_url == API_URL:
        options["enable_thinking"] = mode != "off"
    if mode != "off":
        options["reasoning_effort"] = mode
    return Call(
        api_url=api_url,
        payload={
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": INSTRUCTIONS,
                },
                {"role": "user", "content": json.dumps(data, ensure_ascii=False)},
            ],
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "notice_extraction",
                    "strict": True,
                    "schema": response_schema(SelectedExtraction),
                },
            },
            "max_tokens": MAX_TOKENS,
            "temperature": 0,
            **options,
        },
    )


def cost_cny(model: str, result: Result, *, reference: bool = False) -> float | None:
    if result.usage is None or model not in PRICES:
        return None
    input_price, output_price, cache_price = PRICES[model]
    details = result.usage.prompt_tokens_details
    cached = 0 if reference else details.cached_tokens if details is not None else None
    if cached is None or cached > result.usage.prompt_tokens:
        return None
    hour = result.observed_at.astimezone(timezone(timedelta(hours=8))).hour
    factor = 0.5 if not reference and "deepseek-ai/" in model and 2 <= hour < 8 else 1.0
    return (
        factor
        * (
            (result.usage.prompt_tokens - cached) * input_price
            + cached * cache_price
            + result.usage.completion_tokens * output_price
        )
        / 1_000_000
    )


class LLM:
    def __init__(self, key: str, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.client = httpx.AsyncClient(
            headers={"Authorization": f"Bearer {key}"},
            timeout=TIMEOUT,
            transport=transport,
        )

    async def close(self) -> None:
        await self.client.aclose()

    async def extract(self, call: Call) -> Result:
        started = perf_counter()
        result = Result(elapsed_seconds=0, observed_at=datetime.now(UTC))
        try:
            async with asyncio.timeout(call.timeout_seconds):
                response = await self.client.post(call.api_url, json=call.payload)
            if response.status_code != 200:
                result.error = f"http_{response.status_code}"
            else:
                body = TypeAdapter(dict[str, JsonValue]).validate_json(response.content)
                raw_usage = body.get("usage")
                if raw_usage is not None:
                    result.usage = Usage.model_validate(raw_usage)
                completion = Completion.model_validate(body)
                result.returned_model = completion.model
                if not completion.choices:
                    result.error = "empty_choices"
                else:
                    choice = completion.choices[0]
                    result.content = choice.message.content
                    if choice.message.refusal:
                        result.error = "refusal"
                    elif choice.finish_reason != "stop":
                        result.error = "finish_" + choice.finish_reason
                    elif result.content is None:
                        result.error = "empty_content"
        except httpx.HTTPError as error:
            result.error = type(error).__name__
        except TimeoutError:
            result.error = "timeout"
        except ValidationError:
            result.error = "invalid_response"
        result.elapsed_seconds = perf_counter() - started
        return result
