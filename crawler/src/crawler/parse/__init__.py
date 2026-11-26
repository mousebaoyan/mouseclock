class ParseError(Exception):
    """A page or file there is no making out. Anything else raised while parsing is a bug."""


def without_nul(text: str) -> str:
    """The website's database can't store NUL. It stands for a character that couldn't be made
    out, such as a PDF glyph its font maps to nothing, so it becomes one that says so, as lxml
    shows it in pages, rather than letting the words on either side run together."""
    return text.replace("\x00", "\ufffd")
