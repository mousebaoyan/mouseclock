"""Read text from image attachments."""

import logging
import resource
import threading
import time

from rapidocr import RapidOCR
from rapidocr.utils.output import RapidOCROutput

logger = logging.getLogger(__name__)
_lock = threading.Lock()
_engine: RapidOCR | None = None


def image_text(data: bytes) -> str:
    """Return recognized lines in reading order, with one OCR call at a time."""
    global _engine

    with _lock:
        start = time.monotonic()
        if _engine is None:
            _engine = RapidOCR(
                params={
                    # Find lines on a smaller copy, then crop the legible text from the original.
                    "Global.use_preprocess_img": False,
                    "Det.limit_type": "max",
                    "Det.limit_side_len": 2000,
                    # A batch is padded to its widest line; one line at a time keeps the peak low.
                    "Rec.rec_batch_num": 1,
                }
            )
        result = _engine(data)
        if not isinstance(result, RapidOCROutput):
            raise TypeError("OCR did not return recognized text")
        logger.info(
            "Image OCR completed",
            extra={
                "elapsed": time.monotonic() - start,
                "peak_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
            },
        )
        return "\n".join(result.txts or [])
