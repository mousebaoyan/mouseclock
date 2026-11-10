import asyncio
import logging
import time

from crawler.crawl.contract import PendingNotice, ScreeningResult, Usage, WorkSource
from crawler.crawl.rounds import StepError
from crawler.screening.system_one import Call, SystemOne

# Calibrated on this model's labeled titles (design §8.1); changing the model requires
# rerunning crawler.screening.evaluate and selecting its threshold again.
MODEL = "SemIf"
THRESHOLD = 0.1
# Calls in flight at once, across all the rounds that share this Screen.
CONCURRENCY = 2
logger = logging.getLogger(__name__)


class Screen:
    def __init__(self, provider: SystemOne) -> None:
        self.provider = provider
        self.slots = asyncio.Semaphore(CONCURRENCY)

    async def __call__(
        self, source: WorkSource, notices: list[PendingNotice]
    ) -> tuple[list[ScreeningResult], list[Usage]]:
        async def score(notice: PendingNotice) -> tuple[ScreeningResult, Usage]:
            async with self.slots:
                result = await self.provider.score(
                    Call(model=MODEL, title=notice.title, section=None)
                )
            if result.error is not None:
                raise StepError("error", f"初筛失败: {result.error}")
            if result.score is None or result.usage is None or result.returned_model is None:
                raise StepError("error", "初筛失败: invalid_response")
            return (
                ScreeningResult(
                    notice_id=notice.id,
                    score=result.score,
                    screened_in=result.score >= THRESHOLD,
                ),
                Usage(
                    model=result.returned_model,
                    input_tokens=result.usage.input_tokens,
                    output_tokens=result.usage.output_tokens,
                ),
            )

        started = time.monotonic()
        results: list[ScreeningResult] = []
        usage: list[Usage] = []
        for offset in range(0, len(notices), CONCURRENCY):
            # Stop scheduling after a failed chunk; never return partial screening.
            outcomes = await asyncio.gather(
                *(score(n) for n in notices[offset : offset + CONCURRENCY]),
            )
            for result, tokens in outcomes:
                results.append(result)
                usage.append(tokens)
        logger.info(
            "Screened",
            extra={
                "model": MODEL,
                "notices": len(results),
                "input_tokens": sum(u.input_tokens for u in usage),
                "output_tokens": sum(u.output_tokens for u in usage),
                "elapsed": time.monotonic() - started,
            },
        )
        return results, usage
