import io
import zipfile
from pathlib import Path

import docx
import openpyxl
import pytest
from PIL import Image, ImageDraw, ImageFont

from crawler.parse.files import file_text


# Pillow saves a picture as a PDF the way a scanner does: one picture a page, no text layer.
@pytest.mark.parametrize("image_format", ["PNG", "PDF"])
def test_text_is_recognized_in_images_and_scanned_pdfs(image_format: str) -> None:
    image = Image.new("RGB", (1600, 500), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(Path(__file__).with_name("fixtures") / "NotoSansSC-test.ttf", 64)
    draw.text((60, 50), "夏令营报名时间", fill="black", font=font)
    draw.text((60, 170), "7月6日10:00至8月10日17:00", fill="black", font=font)
    draw.text((60, 290), "请填写申请表", fill="black", font=font)
    buffer = io.BytesIO()
    image.save(buffer, format=image_format)

    text = file_text(buffer.getvalue())

    assert "夏令营报名时间" in text
    assert "7月6日10:00至8月10日17:00" in text
    assert "请填写申请表" in text


def test_blank_image_has_no_words_to_read() -> None:
    buffer = io.BytesIO()
    Image.new("RGB", (600, 300), "white").save(buffer, format="JPEG")

    assert file_text(buffer.getvalue()) == ""


def test_word_keeps_paragraphs_and_tables_in_order_with_merged_cells_once() -> None:
    document = docx.Document()
    document.add_paragraph("报名截止6月30日。")
    table = document.add_table(rows=2, cols=3)
    table.cell(0, 0).merge(table.cell(0, 1)).text = "专业与方向"
    table.cell(0, 2).text = "名额"
    for column, value in enumerate(["计算机", "人工智能", "10"]):
        table.cell(1, column).text = value
    table.cell(1, 2).add_table(rows=1, cols=1).cell(0, 0).text = "截止9月20日"
    document.add_paragraph("")
    document.add_paragraph("以上名额为预计。")
    stream = io.BytesIO()
    document.save(stream)
    assert file_text(stream.getvalue()) == (
        "报名截止6月30日。\n专业与方向\t名额\n计算机\t人工智能\t10 截止9月20日\n以上名额为预计。"
    )


def test_excel_reads_each_sheet_by_rows() -> None:
    book = openpyxl.Workbook()
    sheet = book.active
    assert sheet is not None
    sheet.title = "专业目录"
    for row in (["专业", "名额"], ["计算机", 10], [None, None], ["人工智能", 5]):
        sheet.append(row)
    book.create_sheet("联系方式").append(["电话", "010-00000000"])
    stream = io.BytesIO()
    book.save(stream)
    assert file_text(stream.getvalue()) == (
        "专业目录\n专业\t名额\n计算机\t10\n人工智能\t5\n联系方式\n电话\t010-00000000"
    )


def pdf_file(content: bytes, to_unicode: bytes) -> bytes:
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R"
        b" /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(content), content),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>",
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(to_unicode), to_unicode),
    ]
    data = b"%PDF-1.4\n"
    offsets: list[int] = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(data))
        data += b"%d 0 obj\n%s\nendobj\n" % (number, body)
    xref = len(data)
    data += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    data += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    data += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n" % (len(objects) + 1, xref)
    return data + b"%%EOF\n"


def test_pdf_characters_mapped_to_look_alike_radicals_read_as_the_common_ones() -> None:
    # The font maps its glyph for 生 to the Kangxi radical ⽣ (U+2F63), as some PDFs do.
    to_unicode = (
        b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap"
        b" /CMapName /Example def 1 begincodespacerange <00> <FF> endcodespacerange"
        b" 2 beginbfchar <41> <5B66> <42> <2F63> endbfchar"
        b" endcmap CMapName currentdict /CMap defineresource pop end end"
    )
    data = pdf_file(b"BT /F1 12 Tf 10 50 Td (AB) Tj ET", to_unicode)
    assert file_text(data) == "学生"


def test_files_with_no_words_to_read_give_none() -> None:
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as files:
        files.writestr("说明.txt", "自编的说明")
    assert file_text(archive.getvalue()) == ""


def test_a_broken_file_is_an_error() -> None:
    with pytest.raises(ValueError, match="BadZipFile"):
        file_text(b"PK\x03\x04" + b"\x00" * 30)
    with pytest.raises(ValueError, match="UnidentifiedImageError"):
        file_text(b"\x89PNG\r\n\x1a\n")
