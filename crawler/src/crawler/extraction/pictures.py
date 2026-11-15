"""Read the words in pictures with the LLM, as they are (design §5.2)."""

import base64

from pydantic import JsonValue

from crawler.crawl.contract import Usage
from crawler.crawl.rounds import StepError
from crawler.extraction.chat import MODEL, TEMPERATURE, Chat
from crawler.parse.image import Picture

INSTRUCTIONS = (
    "你是文字识别工具。把图片里的全部文字按阅读顺序原样转写成纯文本。"
    "要求:一字不差,不改字、不纠错、不补全、不翻译、不总结;保留原文的标点、空格和大小写;"
    "每个文本行单独写一行,表格的每一行写成一行、单元格之间用一个制表符分隔;"
    "看不清的字写成 □;不用 Markdown,只输出转写的文字,不加任何说明。"
    "有几张图片时,它们是同一张长图从上到下依次切开的几段,按顺序转写,不要重复,也不要遗漏。"
)
# A long screenshot can hold more words than an extraction's answer.
MAX_OUTPUT_TOKENS = 16384


class ReadPicture:
    def __init__(self, llm: Chat) -> None:
        self.llm = llm

    async def __call__(self, picture: Picture, usage: list[Usage]) -> str:
        images: list[JsonValue] = [
            {
                "type": "image_url",
                "image_url": {
                    "url": "data:image/png;base64," + base64.b64encode(strip).decode(),
                    "detail": "high",
                },
            }
            for strip in picture.strips
        ]
        response = await self.llm.generate(
            {
                "model": MODEL,
                "messages": [
                    {"role": "system", "content": INSTRUCTIONS},
                    {"role": "user", "content": images},
                ],
                "temperature": TEMPERATURE,
                "max_tokens": MAX_OUTPUT_TOKENS,
            }
        )
        tokens = response.usage
        if tokens is None:
            raise StepError("error", "读图失败: missing_usage")
        usage.append(
            Usage(
                model=response.model,
                input_tokens=tokens.prompt_tokens,
                output_tokens=tokens.completion_tokens,
            )
        )
        return response.output_text()
