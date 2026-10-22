from __future__ import annotations

import pytest

from app.ingest import extract as ex
from app.ingest.sandbox import run_extract
from tests import fixtures_files as ff
from tests.conftest import make_settings

LIM = dict(max_pages=500, max_chars=2_000_000)


def run(kind, data, **kw):
    return ex.extract(kind, data, **{**LIM, **kw})


def codes(fn):
    with pytest.raises(ex.ExtractError) as ei:
        fn()
    return ei.value.code


# ------------------------------------------------------------------------------------------------ PDF
def test_pdf_pages_text_and_numbering():
    pdf = ff.make_pdf(["Alpha page one text " * 10, "Bravo page two text " * 10, "Charlie page three " * 10])
    r = run("pdf", pdf)
    assert r.page_count == 3 and not r.scanned
    assert [b.page for b in r.blocks] == [1, 2, 3]
    assert "Bravo" in r.blocks[1].text and "Alpha" not in r.blocks[1].text


def test_scanned_pdf_is_flagged_needs_ocr():
    r = run("pdf", ff.make_blank_pdf(3))
    assert r.scanned and r.blocks == [] and r.page_count == 3


def test_pdf_with_a_few_chars_per_page_is_scanned():
    r = run("pdf", ff.make_pdf(["x", "y", "z"]))
    assert r.scanned


def test_encrypted_pdf_rejected():
    assert codes(lambda: run("pdf", ff.make_encrypted_pdf())) == "ENCRYPTED_FILE"


def test_corrupt_pdf_rejected():
    assert codes(lambda: run("pdf", b"%PDF-1.4\n" + b"garbage" * 50)) == "CORRUPT_FILE"
    assert codes(lambda: run("pdf", ff.make_pdf(["hello " * 30])[:200])) == "CORRUPT_FILE"


def test_too_many_pages():
    assert codes(lambda: run("pdf", ff.make_pdf(["page text " * 10] * 4), max_pages=3)) == "TOO_MANY_PAGES"


def test_text_too_long():
    assert codes(lambda: run("pdf", ff.make_pdf(["word " * 400] * 3), max_chars=1500)) == "TEXT_TOO_LONG"
    assert codes(lambda: run("txt", b"a " * 5000, max_chars=1000)) == "TEXT_TOO_LONG"


# ------------------------------------------------------------------------------------------------ DOCX
def test_docx_headings_paragraphs_tables():
    data = ff.make_docx(
        [("Intro", "Heading 1"), ("First paragraph here.", None), ("Details", "Heading 2"), ("Second paragraph.", None)],
        table=[["Name", "Score"], ["Ana", "9"]],
    )
    r = run("docx", data)
    by_text = {b.text: b.section for b in r.blocks}
    assert by_text["Intro"] == "Intro" and by_text["First paragraph here."] == "Intro"
    assert by_text["Second paragraph."] == "Details"
    assert by_text["Name | Score"] == "Details" and by_text["Ana | 9"] == "Details"  # table text kept, in document order
    assert r.page_count is None


def test_docx_zip_bomb_rejected_by_ratio():
    assert codes(lambda: run("docx", ff.docx_bomb())) == "UNSAFE_ARCHIVE"


def test_docx_path_traversal_rejected():
    z = ff.make_zip({"[Content_Types].xml": b"<Types/>", "word/document.xml": b"<w:document/>", "../../evil.txt": b"x"})
    assert codes(lambda: run("docx", z)) == "UNSAFE_ARCHIVE"
    z = ff.make_zip({"[Content_Types].xml": b"<Types/>", "word/document.xml": b"<w:document/>", "/abs/evil": b"x"})
    assert codes(lambda: run("docx", z)) == "UNSAFE_ARCHIVE"


def test_docx_too_many_entries_rejected():
    z = ff.make_zip({f"f{i}.txt": b"x" for i in range(2100)} | {"[Content_Types].xml": b"<Types/>", "word/document.xml": b"<x/>"})
    assert codes(lambda: run("docx", z)) == "UNSAFE_ARCHIVE"


def test_plain_zip_is_not_a_docx():
    assert codes(lambda: run("docx", ff.make_zip({"a.txt": b"hello"}))) == "UNSUPPORTED_FILE"


def test_docx_with_broken_xml_is_corrupt():
    z = ff.make_zip({"[Content_Types].xml": b"<Types/>", "word/document.xml": b"<not-closed"})
    assert codes(lambda: run("docx", z)) == "CORRUPT_FILE"


def test_docx_xxe_entities_are_not_resolved(tmp_path):
    secret = tmp_path / "secret.txt"
    secret.write_text("TOPSECRETVALUE")
    xml = (
        f'<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file://{secret}">]>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
        "<w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>"
    ).encode()
    base = ff.make_docx([("hi", None)])
    import io, zipfile

    src = zipfile.ZipFile(io.BytesIO(base))
    entries = {n: src.read(n) for n in src.namelist()}
    entries["word/document.xml"] = xml
    try:
        r = run("docx", ff.make_zip(entries))
        assert "TOPSECRETVALUE" not in " ".join(b.text for b in r.blocks)
    except ex.ExtractError:
        pass  # rejecting is fine too


# ------------------------------------------------------------------------------------------------ TXT / MD
def test_txt_utf8_bom_and_utf16():
    assert run("txt", "﻿hello world\n\nsecond".encode("utf-8")).blocks[0].text == "hello world"
    r = run("txt", "হ্যালো বিশ্ব। দ্বিতীয় বাক্য।".encode("utf-16"))
    assert "বিশ্ব" in r.blocks[0].text


def test_txt_binary_rejected():
    assert codes(lambda: run("txt", b"abc\x00def" * 10)) == "UNSUPPORTED_FILE"
    assert codes(lambda: run("txt", b"\xff\xfe\xfa\xfb" * 10 + b"\x80")) == "UNSUPPORTED_FILE"


def test_markdown_headings_become_sections_and_code_fences_are_not_headings():
    md = "# Title\n\nIntro text.\n\n## Part A\n\nBody A.\n\n```\n# not a heading\n```\n\n## Part B\nBody B."
    r = run("md", md.encode())
    sec = {b.text: b.section for b in r.blocks}
    assert sec["Intro text."] == "Title" and sec["Body A."] == "Part A"
    assert any("# not a heading" in b.text and b.section == "Part A" for b in r.blocks)
    assert sec["Body B."] == "Part B"


# ------------------------------------------------------------------------------------------------ type resolution by CONTENT
@pytest.mark.parametrize(
    "ext,data",
    [
        ("pdf", ff.PNG_BYTES),  # renamed binary
        ("txt", ff.EXE_BYTES),
        ("md", ff.PNG_BYTES),
        ("docx", b"hello, i am plain text"),
        ("txt", b"%PDF-1.4\n" + b"x" * 100),  # a PDF pretending to be text
        ("pdf", b"just text"),
        ("docx", ff.make_pdf(["x" * 100])),
        ("exe", b"MZ"),
        ("", b"hello"),
    ],
)
def test_extension_must_match_content(ext, data):
    assert codes(lambda: ex.resolve_kind(ext, data)) == "UNSUPPORTED_FILE"


def test_resolve_kind_accepts_matching_types():
    assert ex.resolve_kind("pdf", ff.make_pdf(["hi " * 20])) == "pdf"
    assert ex.resolve_kind("DOCX", ff.make_docx([("a", None)])) == "docx"
    assert ex.resolve_kind("txt", b"hi") == "txt" and ex.resolve_kind("md", b"# hi") == "md" and ex.resolve_kind("markdown", b"hi") == "md"


def test_control_chars_and_nul_are_stripped_from_text():
    assert "\x00" not in ex.clean("a\x00b\x07c")


# ------------------------------------------------------------------------------------------------ sandbox (separate process)
async def test_sandbox_extracts_in_separate_process():
    s = make_settings()
    r = await run_extract("pdf", ff.make_pdf(["Hello sandbox world " * 10]), s)
    assert r.page_count == 1 and "sandbox" in r.blocks[0].text


async def test_sandbox_reports_expected_failures():
    s = make_settings()
    with pytest.raises(ex.ExtractError) as ei:
        await run_extract("pdf", ff.make_encrypted_pdf(), s)
    assert ei.value.code == "ENCRYPTED_FILE"
    with pytest.raises(ex.ExtractError) as ei:
        await run_extract("docx", ff.docx_bomb(), s)
    assert ei.value.code == "UNSAFE_ARCHIVE"


async def test_sandbox_wall_clock_timeout_kills_worker():
    s = make_settings(parse_timeout_seconds=0.05)
    with pytest.raises(ex.ExtractError) as ei:
        await run_extract("pdf", ff.make_pdf(["slow " * 50] * 30), s)
    assert ei.value.code == "PARSE_TIMEOUT"


async def test_sandbox_memory_limit_is_applied_and_contained(monkeypatch):
    """RLIMIT_AS is set by the worker on itself; a too-small limit makes only the worker fail (expected error code)."""
    from app.ingest import sandbox

    orig = sandbox.asyncio.create_subprocess_exec

    async def with_mem(mb):
        async def patched(*args, **kw):
            args = list(args)
            assert args[6].isdigit()  # memory_mb argv slot
            args[6] = str(mb)
            return await orig(*args, **kw)

        monkeypatch.setattr(sandbox.asyncio, "create_subprocess_exec", patched)

    await with_mem(20)  # cannot even import pypdf
    with pytest.raises(ex.ExtractError) as ei:
        await run_extract("pdf", ff.make_pdf(["x " * 100]), make_settings())
    assert ei.value.code in {"PARSE_MEMORY", "PARSE_FAILED"}
    await with_mem(1024)  # the service itself is unaffected: the default limit works
    r = await run_extract("pdf", ff.make_pdf(["fine " * 50]), make_settings())
    assert r.page_count == 1


async def test_sandbox_worker_environment_has_no_secrets(monkeypatch):
    monkeypatch.setenv("RAG_AGENT_TOKEN", "should-not-be-visible-to-parsers-xxxxxxxx")
    from app.ingest import sandbox
    import asyncio

    seen = {}
    orig = asyncio.create_subprocess_exec

    async def spy(*args, **kw):
        seen["env"] = kw.get("env")
        return await orig(*args, **kw)

    monkeypatch.setattr(sandbox.asyncio, "create_subprocess_exec", spy)
    await run_extract("txt", b"hello", make_settings())
    assert set(seen["env"]) <= {"PATH"}
