"""Cut images into strips for the LLM to read (design §5.2). It scales every image down to about
PIXEL_BUDGET pixels, which leaves a long screenshot's characters too small to read."""

import io
from dataclasses import dataclass
from itertools import pairwise

from PIL import Image

PIXEL_BUDGET = 1300 * 1300
# Wider images are scaled down to at most this: the characters of a big scan or poster stay
# legible without cutting it into dozens of strips. The model takes at most 4096 pixels a side
# once a request has 15 images.
MAX_WIDTH = 2048
# How far a pixel's gray is from the background's for it to count as ink.
INK = 40


@dataclass(frozen=True)
class Picture:
    """An image as PNG strips from top to bottom, each within the pixel budget."""

    strips: list[bytes]


def picture(data: bytes) -> Picture:
    with Image.open(io.BytesIO(data)) as opened:
        image = opened.convert("RGB")
    if image.width > MAX_WIDTH:
        image = image.reduce(-(-image.width // MAX_WIDTH))
    width, height = image.size
    step = PIXEL_BUDGET // width
    margin = step // 10
    # Even cuts, each free to move by a margin to the row with the least ink; every strip still
    # stays within a step.
    count = -(-height // (step - 2 * margin))
    ink = _ink(image)
    cuts = [0]
    for index in range(1, count):
        low = index * height // count - margin
        window = ink[low : low + 2 * margin]
        cuts.append(low + window.index(min(window)))
    cuts.append(height)
    return Picture([_png(image.crop((0, top, width, bottom))) for top, bottom in pairwise(cuts)])


def _ink(image: Image.Image) -> list[int]:
    """How many pixels in each row are unlike the background."""
    gray = image.convert("L")
    histogram = gray.histogram()
    background = histogram.index(max(histogram))
    marks = gray.tobytes().translate(bytes(abs(value - background) > INK for value in range(256)))
    width = image.width
    return [marks.count(1, top, top + width) for top in range(0, len(marks), width)]


def _png(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()
