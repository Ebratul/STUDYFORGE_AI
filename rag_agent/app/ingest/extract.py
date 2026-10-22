"""Pure extraction functions. These run INSIDE the isolated worker process (see worker.py / sandbox.py).

Only text is read. Nothing is rendered, executed or written to disk; macros, links and embedded objects are ignored.
"""

from __future__ import annotations

import io
import posixpath
import re
import zipfile
from dataclasses import dataclass, field

from app.ingest.chunk import Block

MIN_CHARS_PER_PAGE = 20

DOCX_MAX_UNCOMPRESSED = 200 * 1024 * 1024
DOCX_MAX_RATIO = 100
DOCX_MAX_ENTRIES = 2000
DOCX_MAX_XML_BYTES = 100 * 1024 * 1024  # word/document.xml specifically


class ExtractError(Exception):
    """Expected, user-facing failure. `code` is the FAILED status code reported to the backend."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass
class Extracted:
    kind: str
    page_count: int | None
    blocks: list[Block] = field(default_factory=list)
    scanned: bool = False

    @property
    def text_length(self) -> int:
        return sum(len(b.text) for b in self.blocks)


_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def clean(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace(" ", " ")
    text = _CTRL.sub("", text)
    # lone surrogates cannot be stored in UTF-8 Postgres text
    return text.encode("utf-8", "ignore").decode("utf-8")


# ---------------------------------------------------------------------------------------------- sniffing
EXT_KINDS = {"pdf": "pdf", "docx": "docx", "txt": "txt", "md": "md", "markdown": "md"}


def sniff_kind(data: bytes) -> str:
    """Content-based type: 'pdf' | 'zip' | 'text' | 'binary'."""
    head = data[:1024]
    if b"%PDF-" in head:
        return "pdf"
    if data[:4] in (b"PK\x03\x04", b"PK\x05\x06"):
        return "zip"
    if _looks_like_text(data):
        return "text"
    return "binary"


def _decode_text(data: bytes) -> str | None:
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8")
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16")  # BOM-aware
    if b"\x00" in data:
        return None
    return data.decode("utf-8")


def _looks_like_text(data: bytes) -> bool:
    try:
        s = _decode_text(data[: 1024 * 1024 + 4] if len(data) > 1024 * 1024 else data)
    except UnicodeDecodeError:
        # a truncated multi-byte char at the sampling cut is fine; retry with a trimmed sample
        try:
            s = _decode_text(data[: 1024 * 1024 - 4])
        except UnicodeDecodeError:
            return False
    if s is None:
        return False
    if not s:
        return True
    bad = len(_CTRL.findall(s))
    return bad / len(s) < 0.02


def resolve_kind(ext: str, data: bytes) -> str:
    """Decide the parser. The extension must agree with the CONTENT; mismatches are UNSUPPORTED_FILE."""
    want = EXT_KINDS.get(ext.lower().lstrip("."))
    if want is None:
        raise ExtractError("UNSUPPORTED_FILE")
    got = sniff_kind(data)
    if want == "pdf" and got == "pdf":
        return "pdf"
    if want == "docx" and got == "zip":
        return "docx"
    if want in ("txt", "md") and got == "text":
        return want
    raise ExtractError("UNSUPPORTED_FILE")


# ---------------------------------------------------------------------------------------------- PDF
def extract_pdf(data: bytes, *, max_pages: int, max_chars: int) -> Extracted:
    from pypdf import PdfReader
    from pypdf.errors import PyPdfError

    try:
        reader = PdfReader(io.BytesIO(data), strict=False)
        if reader.is_encrypted:
            raise ExtractError("ENCRYPTED_FILE")
        n = len(reader.pages)
    except ExtractError:
        raise
    except (PyPdfError, ValueError, KeyError, TypeError, AttributeError, OSError, RecursionError, EOFError, IndexError):
        raise ExtractError("CORRUPT_FILE") from None
    if n > max_pages:
        raise ExtractError("TOO_MANY_PAGES")
    if n == 0:
        raise ExtractError("CORRUPT_FILE")

    blocks: list[Block] = []
    total = 0
    useful = 0
    for i in range(n):
        try:
            txt = clean(reader.pages[i].extract_text() or "")
        except ExtractError:
            raise
        except Exception:  # noqa: BLE001  one bad page must not kill extraction
            txt = ""
        txt = txt.strip()
        useful += len(re.sub(r"\s+", "", txt))
        total += len(txt)
        if total > max_chars:
            raise ExtractError("TEXT_TOO_LONG")
        if txt:
            blocks.append(Block(text=txt, page=i + 1))
    scanned = (useful / n) < MIN_CHARS_PER_PAGE
    return Extracted(kind="pdf", page_count=n, blocks=blocks if not scanned else [], scanned=scanned)


# ---------------------------------------------------------------------------------------------- DOCX
def check_zip_safety(data: bytes) -> zipfile.ZipFile:
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, ValueError, OSError, EOFError):
        raise ExtractError("CORRUPT_FILE") from None
    infos = zf.infolist()
    if len(infos) > DOCX_MAX_ENTRIES:
        raise ExtractError("UNSAFE_ARCHIVE")
    total = 0
    for zi in infos:
        name = zi.filename
        norm = posixpath.normpath(name)
        if name.startswith(("/", "\\")) or ".." in norm.split("/") or "\\" in name or (len(name) > 1 and name[1] == ":"):
            raise ExtractError("UNSAFE_ARCHIVE")
        if zi.flag_bits & 0x1:
            raise ExtractError("ENCRYPTED_FILE")
        total += zi.file_size
        if total > DOCX_MAX_UNCOMPRESSED:
            raise ExtractError("UNSAFE_ARCHIVE")
        if zi.compress_size > 0 and zi.file_size / zi.compress_size > DOCX_MAX_RATIO and zi.file_size > 1024 * 1024:
            raise ExtractError("UNSAFE_ARCHIVE")
    if len(data) > 0 and total / len(data) > DOCX_MAX_RATIO and total > 1024 * 1024:
        raise ExtractError("UNSAFE_ARCHIVE")
    names = {zi.filename for zi in infos}
    if "word/document.xml" not in names or "[Content_Types].xml" not in names:
        raise ExtractError("UNSUPPORTED_FILE")
    if zf.getinfo("word/document.xml").file_size > DOCX_MAX_XML_BYTES:
        raise ExtractError("UNSAFE_ARCHIVE")
    return zf


_HEADING_STYLE = re.compile(r"^(heading\s*\d+|title|subtitle)$", re.I)


def extract_docx(data: bytes, *, max_chars: int) -> Extracted:
    check_zip_safety(data)
    try:
        from docx import Document
        from docx.table import Table
        from docx.text.paragraph import Paragraph

        doc = Document(io.BytesIO(data))
        body = doc.element.body
    except ExtractError:
        raise
    except Exception:  # noqa: BLE001
        raise ExtractError("CORRUPT_FILE") from None

    blocks: list[Block] = []
    section: str | None = None
    total = 0

    def add(text: str, sec: str | None) -> None:
        nonlocal total
        text = clean(text).strip()
        if not text:
            return
        total += len(text)
        if total > max_chars:
            raise ExtractError("TEXT_TOO_LONG")
        blocks.append(Block(text=text, section=sec))

    try:
        for child in body.iterchildren():
            tag = child.tag.rsplit("}", 1)[-1]
            if tag == "p":
                p = Paragraph(child, doc)
                text = p.text
                style = (p.style.name if p.style is not None else "") or ""
                if _HEADING_STYLE.match(style) and text.strip():
                    section = clean(text).strip()[:200]
                add(text, section)
            elif tag == "tbl":
                tbl = Table(child, doc)
                for row in tbl.rows:
                    seen: list[str] = []
                    for cell in row.cells:
                        t = clean(cell.text).strip()
                        if t and (not seen or seen[-1] != t):  # merged cells repeat
                            seen.append(t)
                    if seen:
                        add(" | ".join(seen), section)
    except ExtractError:
        raise
    except Exception:  # noqa: BLE001
        raise ExtractError("CORRUPT_FILE") from None
    return Extracted(kind="docx", page_count=None, blocks=blocks)


# ---------------------------------------------------------------------------------------------- TXT / MD
_MD_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$")
_FENCE = re.compile(r"^\s{0,3}(```|~~~)")


def extract_text(data: bytes, *, markdown: bool, max_chars: int) -> Extracted:
    try:
        raw = _decode_text(data)
    except UnicodeDecodeError:
        raise ExtractError("UNSUPPORTED_FILE") from None
    if raw is None:
        raise ExtractError("UNSUPPORTED_FILE")
    text = clean(raw)
    if len(text) > max_chars:
        raise ExtractError("TEXT_TOO_LONG")
    blocks: list[Block] = []
    section: str | None = None
    if not markdown:
        for para in re.split(r"\n\s*\n", text):
            if para.strip():
                blocks.append(Block(text=para.strip()))
        return Extracted(kind="txt", page_count=None, blocks=blocks)

    in_fence = False
    cur: list[str] = []

    def flush() -> None:
        if cur and "".join(cur).strip():
            blocks.append(Block(text="\n".join(cur).strip(), section=section))
        cur.clear()

    for line in text.split("\n"):
        if _FENCE.match(line):
            in_fence = not in_fence
            cur.append(line)
            continue
        if not in_fence:
            m = _MD_HEADING.match(line)
            if m:
                flush()
                section = m.group(1).strip()[:200]
                blocks.append(Block(text=section, section=section))
                continue
            if not line.strip():
                flush()
                continue
        cur.append(line)
    flush()
    return Extracted(kind="md", page_count=None, blocks=blocks)


def extract(kind: str, data: bytes, *, max_pages: int, max_chars: int) -> Extracted:
    if kind == "pdf":
        return extract_pdf(data, max_pages=max_pages, max_chars=max_chars)
    if kind == "docx":
        return extract_docx(data, max_chars=max_chars)
    if kind in ("txt", "md"):
        return extract_text(data, markdown=(kind == "md"), max_chars=max_chars)
    raise ExtractError("UNSUPPORTED_FILE")
