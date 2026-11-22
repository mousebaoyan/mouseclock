"""Each library in one module (AGENTS.md). Tests may import them all, to make their fixtures."""

import ast
from collections.abc import Iterator
from pathlib import Path

ROOT = Path(__file__).parent

ALLOWED = {
    "httpx": {
        "crawl/fetch.py",
        "crawl/website.py",
        "extraction/chat.py",
        "screening/system_one.py",
        "main.py",
    },
    "playwright": {"crawl/browser.py"},
    "lxml": {"parse/listing.py", "parse/notice.py", "parse/webpage.py"},
    "PIL": {"parse/image.py"},
    "pypdf": {"parse/files.py"},
    "docx": {"parse/files.py"},
    "openpyxl": {"parse/files.py"},
    "xlrd": {"parse/files.py"},
    "legacy_doc": {"parse/files.py"},
}


def _imports(path: Path) -> Iterator[str]:
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            yield from (alias.name.partition(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            yield node.module.partition(".")[0]


def test_each_library_is_imported_only_in_its_own_files() -> None:
    strays = [
        f"{name} imports {library}"
        for path in sorted(ROOT.rglob("*.py"))
        if not path.name.endswith("_test.py")
        for name in [path.relative_to(ROOT).as_posix()]
        for library in _imports(path)
        if name not in ALLOWED.get(library, {name})
    ]
    assert strays == []
