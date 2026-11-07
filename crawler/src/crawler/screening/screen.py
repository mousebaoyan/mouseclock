import asyncio

from crawler.crawl.contract import PendingNotice, ScreeningResult, Usage, WorkSource
from crawler.screening.system_one import Call, SystemOne

# Calibrated on this model's labeled titles (design §8.1); changing the model requires
# rerunning crawler.screening.evaluate and selecting its threshold again.
MODEL = "SemIf"
THRESHOLD = 0.1
CONCURRENCY = 2


class ScreeningError(Exception):
    pass


class Screen:
    def __init__(self, provider: SystemOne) -> None:
        self.provider = provider

    async def __call__(
        self, source: WorkSource, notices: list[PendingNotice]
    ) -> tuple[list[ScreeningResult], list[Usage]]:
        async def score(notice: PendingNotice) -> tuple[ScreeningResult, Usage]:
            result = await self.provider.score(Call(model=MODEL, title=notice.title, section=None))
            if result.error is not None:
                raise ScreeningError(result.error)
            if result.score is None or result.usage is None or result.returned_model is None:
                raise ScreeningError("invalid_response")
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
        return results, usage
