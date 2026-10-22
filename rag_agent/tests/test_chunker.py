from __future__ import annotations

import re

from app.ingest.chunk import Block, chunk_blocks

LOREM = (
    "The mitochondria is the powerhouse of the cell. It produces ATP through oxidative phosphorylation! "
    "Does every cell have one? Not quite, red blood cells lack them. "
)


def words(s: str) -> list[str]:
    return s.split()


def test_deterministic():
    blocks = [Block(LOREM * 80)]
    a = chunk_blocks(blocks, target=500, overlap=80)
    b = chunk_blocks(blocks, target=500, overlap=80)
    assert a == b and len(a) > 3


def test_chunks_respect_target_and_never_split_words():
    text = LOREM * 120
    chunks = chunk_blocks([Block(text)], target=400, overlap=60)
    src_words = set(words(text))
    for c in chunks:
        assert len(c.content) <= 400
        assert set(words(c.content)) <= src_words  # every token is a whole source word


def test_overlap_between_consecutive_chunks():
    text = LOREM * 60
    chunks = chunk_blocks([Block(text)], target=400, overlap=100)
    shared = 0
    for a, b in zip(chunks, chunks[1:]):
        tail_words = words(a.content)[-12:]
        if any(w in words(b.content)[:15] for w in tail_words):
            shared += 1
        assert len(b.content) <= 400
    assert shared >= len(chunks) - 2


def test_zero_overlap_has_none():
    sentences = [f"Sentence number {i} is unique and standalone." for i in range(200)]
    chunks = chunk_blocks([Block(" ".join(sentences))], target=300, overlap=0)
    seen = set()
    for c in chunks:
        ids = set(re.findall(r"number (\d+)", c.content))
        assert not (ids & seen)
        seen |= ids


def test_pdf_chunks_never_span_pages():
    blocks = [Block(("Page one sentence. " * 100), page=1), Block(("Page two sentence. " * 100), page=2), Block("tiny third page text", page=3)]
    chunks = chunk_blocks(blocks, target=300, overlap=50, by_page=True)
    for c in chunks:
        assert c.page in (1, 2, 3)
        if c.page == 1:
            assert "two" not in c.content and "tiny" not in c.content
        if c.page == 2:
            assert "one" not in c.content
    assert {c.page for c in chunks} == {1, 2, 3}
    assert [c.index for c in chunks] == list(range(len(chunks)))


def test_bangla_danda_is_a_sentence_boundary():
    sent = "এটি একটি পরীক্ষামূলক বাক্য যা বেশ দীর্ঘ"
    text = "। ".join(f"{sent} {i}" for i in range(80)) + "।"
    chunks = chunk_blocks([Block(text)], target=300, overlap=50)
    assert len(chunks) > 2
    src = set(text.replace("।", " ").split())
    for c in chunks:
        assert set(c.content.replace("।", " ").split()) <= src
    # the boundary itself: a chunk (other than the last) ends right after a danda
    assert sum(c.content.endswith("।") for c in chunks[:-1]) >= len(chunks) - 2


def test_sections_follow_nearest_heading():
    blocks = [Block("Intro", section="Intro"), Block("intro text " * 30, section="Intro"),
              Block("Methods", section="Methods"), Block("method text " * 30, section="Methods")]
    chunks = chunk_blocks(blocks, target=250, overlap=30)
    assert chunks[0].section == "Intro" and chunks[-1].section == "Methods"
    assert all(c.page is None for c in chunks)


def test_empty_and_whitespace_blocks_dropped():
    assert chunk_blocks([Block("   \n\n  "), Block("")], target=300, overlap=30) == []
    chunks = chunk_blocks([Block(" \n "), Block("real text"), Block("\t")], target=300, overlap=30)
    assert [c.content for c in chunks] == ["real text"]


def test_giant_unbroken_token_is_hard_split_but_bounded():
    chunks = chunk_blocks([Block("x" * 2000)], target=300, overlap=30)
    assert all(len(c.content) <= 300 for c in chunks) and len(chunks) >= 7


def test_token_count_is_chars_over_four():
    c = chunk_blocks([Block("a" * 41)], target=300, overlap=30)[0]
    assert c.token_count == 11


def test_default_sizes_produce_reasonable_chunks():
    chunks = chunk_blocks([Block(LOREM * 400)], target=3200, overlap=400)
    assert all(len(c.content) <= 3200 for c in chunks) and len(chunks) >= 5
