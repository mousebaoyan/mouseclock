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
        self, source: WorkSource, notices: list[PendingNotice], usage: list[Usage]
    ) -> list[ScreeningResult]:
        async def score(notice: PendingNotice) -> ScreeningResult:
            async with self.slots:
                result = await self.provider.score(
                    Call(model=MODEL, title=notice.title, section=None)
                )
            # A call that answered costs what it says, even when the answer is no good.
            if result.usage is not None and result.returned_model is not None:
                usage.append(
                    Usage(
                        model=result.returned_model,
                        input_tokens=result.usage.input_tokens,
                        output_tokens=result.usage.output_tokens,
                    )
                )
            if result.error is not None:
                raise StepError("error", f"初筛失败: {result.error}")
            if result.score is None or result.usage is None:
                raise StepError("error", "初筛失败: invalid_response")
            return ScreeningResult(
                notice_id=notice.id, score=result.score, screened_in=result.score >= THRESHOLD
            )

        started = time.monotonic()
        results: list[ScreeningResult] = []
        for offset in range(0, len(notices), CONCURRENCY):
            # Stop scheduling after a failed chunk; never return partial screening. The chunk's
            # other calls are waited for, so what they cost is counted.
            outcomes = await asyncio.gather(
                *(score(n) for n in notices[offset : offset + CONCURRENCY]),
                return_exceptions=True,
            )
            for outcome in outcomes:
                if isinstance(outcome, BaseException):
                    raise outcome
                results.append(outcome)
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
        return results
