"""OCR a generated attachment, without storing real notices in the repository."""

import io
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from crawler.parse.image import image_text


def test_image_text_reads_generated_attachment() -> None:
    image = Image.new("RGB", (1600, 500), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=52)
    draw.text((60, 50), "APPLICATION FORM 2027", fill="black", font=font)
    draw.text((60, 160), "DEADLINE 2027-08-10 17:00", fill="black", font=font)
    draw.text((60, 270), "SEND THE FORM BEFORE DEADLINE", fill="black", font=font)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")

    text = image_text(buffer.getvalue())

    assert "APPLICATION FORM 2027" in text
    assert "2027-08-10 17:00" in text
    assert "SEND THE FORM BEFORE DEADLINE" in text


def test_image_text_reads_generated_chinese_attachment() -> None:
    image = Image.new("RGB", (1600, 500), "white")
    draw = ImageDraw.Draw(image)
    # The bundled Noto Sans SC subset keeps Chinese glyphs available in offline CI.
    font = ImageFont.truetype(Path(__file__).with_name("NotoSansSC-test.ttf"), 64)
    draw.text((60, 50), "夏令营报名时间", fill="black", font=font)
    draw.text((60, 170), "7月6日10:00至8月10日17:00", fill="black", font=font)
    draw.text((60, 290), "请填写申请表", fill="black", font=font)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")

    text = image_text(buffer.getvalue())

    assert "夏令营报名时间" in text
    assert "7月6日10:00至8月10日17:00" in text
    assert "请填写申请表" in text


def test_image_text_returns_empty_for_blank_image() -> None:
    buffer = io.BytesIO()
    Image.new("RGB", (600, 300), "white").save(buffer, format="PNG")

    assert image_text(buffer.getvalue()) == ""
