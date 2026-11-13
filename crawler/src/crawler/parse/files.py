"""The words in the files notices attach (design §5.1): images, PDF, Word and Excel, including
the old binary formats. Archives and other files have none to read."""

import io
import unicodedata
import zipfile
from collections.abc import Iterable, Iterator

import docx
import openpyxl
import xlrd
from docx.table import Table
from docx.text.paragraph import Paragraph
from legacy_doc import extract_text
from pypdf import PdfReader

from crawler.parse.image import image_text

_PDF = b"%PDF"
_ZIP = b"PK\x03\x04"
_OLE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
_IMAGE_HEADERS = (
    b"\x89PNG\r\n\x1a\n",
    b"\xff\xd8\xff",
    b"GIF87a",
    b"GIF89a",
    b"BM",
    b"II*\x00",
    b"MM\x00*",
)
# Old Word files keep their text in a stream of this name; old Excel files have none.
_WORD = "WordDocument".encode("utf-16-le")
# Some PDFs map common characters to the Kangxi radicals that look like them, ⽣ for 生.
_RADICALS = {code: unicodedata.normalize("NFKC", chr(code)) for code in range(0x2F00, 0x2FD6)}


def file_text(data: bytes) -> str:
    """Raises ValueError when the file is broken."""
    try:
        if data.startswith(_IMAGE_HEADERS) or (data.startswith(b"RIFF") and data[8:12] == b"WEBP"):
            return image_text(data)
        if data.startswith(_PDF):
            pages = PdfReader(io.BytesIO(data)).pages
            return "\n".join(page.extract_text() for page in pages).translate(_RADICALS)
        if data.startswith(_ZIP):
            parts = set(zipfile.ZipFile(io.BytesIO(data)).namelist())
            if "word/document.xml" in parts:
                return _docx(data)
            if "xl/workbook.xml" in parts:
                return _xlsx(data)
        elif data.startswith(_OLE):
            return extract_text(data).text if _WORD in data else _xls(data)
    # The files come from the colleges' sites, and parsers fail on broken ones in all sorts of ways.
    except Exception as error:
        raise ValueError(type(error).__name__) from error
    return ""


def _lines(lines: Iterable[str]) -> str:
    # Blank lines, and the empty cells that end a row, carry nothing.
    return "\n".join(line.rstrip("\t") for line in lines if line.strip())


def _docx(data: bytes) -> str:
    return _lines(_blocks(docx.Document(io.BytesIO(data)).iter_inner_content()))


def _blocks(blocks: Iterator[Paragraph | Table]) -> Iterator[str]:
    for block in blocks:
        if not isinstance(block, Table):
            yield block.text
            continue
        for row in block.rows:
            cells = row.cells
            texts: list[str] = []
            index = 0
            # A merged cell repeats for each grid column it spans.
            while index < len(cells):
                # A cell's paragraphs, and any table inside it, stay on its row's line.
                lines = _blocks(cells[index].iter_inner_content())
                texts.append(" ".join(line for line in lines if line.strip()))
                index += cells[index].grid_span
            yield "\t".join(texts)


def _xlsx(data: bytes) -> str:
    book = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    lines: list[str] = []
    for sheet in book.worksheets:
        lines.append(sheet.title)
        lines += (
            "\t".join("" if value is None else str(value) for value in row)
            for row in sheet.iter_rows(values_only=True)
        )
    book.close()
    return _lines(lines)


def _xls(data: bytes) -> str:
    book = xlrd.open_workbook(file_contents=data)

    def value(cell: xlrd.sheet.Cell) -> str:
        if cell.ctype == xlrd.XL_CELL_DATE:
            return str(xlrd.xldate_as_datetime(float(cell.value), book.datemode))
        if cell.ctype == xlrd.XL_CELL_NUMBER and float(cell.value).is_integer():
            return str(int(cell.value))
        return str(cell.value)

    lines: list[str] = []
    for sheet in book.sheets():
        lines.append(sheet.name)
        lines += ("\t".join(value(cell) for cell in sheet.row(row)) for row in range(sheet.nrows))
    return _lines(lines)
