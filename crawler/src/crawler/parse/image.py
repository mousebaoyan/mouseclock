"""Read text from image attachments."""

import logging
import threading
import time
from importlib.resources import files

import psutil
from rapidocr import ModelType, RapidOCR
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
            model_dir = files("rapidocr") / "models"
            det_model = model_dir / "PP-OCRv6_det_small.onnx"
            cls_model = model_dir / "ch_ppocr_mobile_v2.0_cls_mobile.onnx"
            rec_model = model_dir / "PP-OCRv6_rec_small.onnx"
            if not all(model.is_file() for model in (det_model, cls_model, rec_model)):
                raise FileNotFoundError(
                    "PP-OCRv6 small models are missing; run "
                    "uv run rapidocr download_models --config ocr-models.yaml"
                )
            # The 2000 px default loses email characters in long tables (design §5.2).
            _engine = RapidOCR(
                params={
                    "Global.max_side_len": 4000,
                    "Det.model_type": ModelType.SMALL,
                    "Rec.model_type": ModelType.SMALL,
                    "Det.model_path": str(det_model),
                    "Cls.model_path": str(cls_model),
                    "Rec.model_path": str(rec_model),
                }
            )
        result = _engine(data)
        if not isinstance(result, RapidOCROutput):
            raise TypeError("OCR did not return recognized text")
        elapsed_ms = round((time.perf_counter() - start) * 1000)
        rss_mib = round(_process.memory_info().rss / 1024**2)
        logger.info("Image OCR completed", extra={"duration_ms": elapsed_ms, "rss_mib": rss_mib})
        return "\n".join(result.txts or [])
