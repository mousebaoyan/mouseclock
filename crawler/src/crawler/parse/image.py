"""Read text from image attachments."""

import logging
import threading
import time

import psutil
from rapidocr import RapidOCR
from rapidocr.utils.output import RapidOCROutput

logger = logging.getLogger(__name__)
_lock = threading.Lock()
_engine: RapidOCR | None = None
_process = psutil.Process()


def image_text(data: bytes) -> str:
    """Return recognized lines in reading order, with one OCR call at a time."""
    global _engine

    with _lock:
        start = time.perf_counter()
        if _engine is None:
            _engine = RapidOCR()
        result = _engine(data)
        if not isinstance(result, RapidOCROutput):
            raise TypeError("OCR did not return recognized text")
        elapsed_ms = round((time.perf_counter() - start) * 1000)
        rss_mib = round(_process.memory_info().rss / 1024**2)
        logger.info("Image OCR completed", extra={"duration_ms": elapsed_ms, "rss_mib": rss_mib})
        return "\n".join(result.txts or [])
