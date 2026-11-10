# legacy-doc ships no types; this covers the part parse/files.py uses.
class DocExtractionResult:
    text: str

def extract_text(document_bytes: bytes) -> DocExtractionResult: ...
