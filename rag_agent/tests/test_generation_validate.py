"""Deterministic validators for generated MCQ/CQ (no DB, no provider)."""

from __future__ import annotations

import pytest

from app.generation import validate as V
from app.generation.schemas import CqSpec, LlmAnswer, LlmCq, LlmCqPart, LlmEvidence, LlmMcq, LlmOption, McqSpec
from app.generation.sources import SourceChunk, context_budget, even_picks, select_for_batch, split_pasted
from app.generation.text import jaccard, script_ratios, token_set, truncate_words
from app.prompts import CANARY

SRC = SourceChunk("c1", "doc1", "Biology.pdf", 7, "Cells", "Mitochondria produce ATP through oxidative phosphorylation in the inner membrane of the organelle.")
SRC2 = SourceChunk("c2", "doc1", "Biology.pdf", 8, None, "Ribosomes assemble proteins from amino acids in the cytoplasm of every living cell.")
QUOTE = "Mitochondria produce ATP through oxidative phosphorylation"


def mcq_item(**kw) -> LlmMcq:
    base = dict(
        stem="Which organelle produces ATP?", options=[LlmOption(label=c, text=t) for c, t in zip("ABCD", ["Mitochondrion", "Ribosome", "Nucleus", "Golgi body"])],
        correct_label="A", explanation="The correct answer is A because mitochondria make ATP.", short_note="ATP is the energy currency.",
        difficulty="EASY", topic="Cell biology", tags=["ATP", " atp ", "Energy"], evidence=[LlmEvidence(source=1, quote=QUOTE)],
    )
    base.update(kw)
    return LlmMcq(**base)


def rules(grounding="SOURCE_ONLY", **spec) -> V.McqRules:
    return V.McqRules(McqSpec(count=3, **spec), grounding)


def ok(item, r=None, sel=(SRC,), pos=0):
    q, why = V.check_mcq(item, r or rules(), list(sel), pos)
    assert why is None, why
    return q


# ------------------------------------------------------------------------------------------------ MCQ integrity
def test_valid_mcq_is_normalised_and_verified():
    q = ok(mcq_item())
    assert q["kind"] == "MCQ" and q["id"].startswith("g_") and q["stimulus"] is None and q["parts"] == [] and q["answer"] is None
    assert len(q["options"]) == 4 and len({o["id"] for o in q["options"]}) == 4
    assert q["correct_option_id"] == q["options"][0]["id"] and q["options"][0]["text"] == "Mitochondrion"
    assert q["tags"] == ["atp", "energy"]  # lower-cased, trimmed, deduped
    assert q["sources"] == [{"document_id": "doc1", "document_name": "Biology.pdf", "chunk_id": "c1", "page": 7, "section": "Cells", "quote": QUOTE, "quote_verified": True}]
    assert q["source_support"] == "SOURCE_QUOTED" and q["review_reasons"] == []
    assert q["marks"] == 1 and q["negative_marks"] == 0 and q["difficulty"] == "EASY"


@pytest.mark.parametrize("label,expected", [("A", 0), ("b", 1), ("C)", 2), ("(d)", 3), ("Option B", 1), ("3", 2), ("Ans: D", 3)])
def test_correct_label_variants_resolve(label, expected):
    q = ok(mcq_item(correct_label=label))
    assert q["correct_option_id"] == q["options"][expected]["id"]


def test_correct_option_may_be_given_as_exact_text_and_bangla_labels():
    q = ok(mcq_item(correct_label="Nucleus"))
    assert q["correct_option_id"] == q["options"][2]["id"]
    bn = mcq_item(stem="কোন অঙ্গাণু শক্তি উৎপন্ন করে?", options=[LlmOption(label=c, text=t) for c, t in zip("ABCD", ["মাইটোকন্ড্রিয়া", "রাইবোসোম", "নিউক্লিয়াস", "গলজি বডি"])],
                  correct_label="খ", explanation=None, short_note=None)
    q = ok(bn, rules(language="bn"))
    assert q["correct_option_id"] == q["options"][1]["id"]


@pytest.mark.parametrize("kw,why", [
    (dict(correct_label="Z"), "invalid_correct_option"),
    (dict(correct_label=""), "invalid_correct_option"),
    (dict(stem="   "), "empty_stem"),
    (dict(stem="x" * 2001), "stem_too_long"),
    (dict(options=[LlmOption(label="A", text="Only"), LlmOption(label="B", text="Two")]), "wrong_option_count"),
    (dict(options=[LlmOption(label=c, text=t) for c, t in zip("ABCD", ["Same", "same!", "Nucleus", "Golgi"])]), "duplicate_options"),
    (dict(options=[LlmOption(label=c, text=t) for c, t in zip("ABCD", ["One", "", "Three", "Four"])]), "empty_option"),
    (dict(options=[LlmOption(label=c, text=t) for c, t in zip("ABCD", ["One", "y" * 501, "Three", "Four"])]), "option_too_long"),
])
def test_malformed_mcq_is_rejected_with_a_reason(kw, why):
    q, got = V.check_mcq(mcq_item(**kw), rules(), [SRC], 0)
    assert q is None and got == why


def test_ambiguous_label_reference_is_never_guessed():
    # model labels are all "A": the key reference "A" cannot be resolved by label, falls back to the positional letter A (first option)
    item = mcq_item(options=[LlmOption(label="A", text=t) for t in ["Mitochondrion", "Ribosome", "Nucleus", "Golgi body"]], correct_label="A")
    assert ok(item)["correct_option_id"]
    q, why = V.check_mcq(mcq_item(options=[LlmOption(label="x", text=t) for t in ["Mitochondrion", "Ribosome", "Nucleus", "Golgi body"]], correct_label="the best one"), rules(), [SRC], 0)
    assert q is None and why == "invalid_correct_option"


def test_option_count_follows_the_spec():
    five = mcq_item(options=[LlmOption(label=c, text=t) for c, t in zip("ABCDE", ["a1", "b2", "c3", "d4", "e5"])])
    q, why = V.check_mcq(five, rules(), [SRC], 0)
    assert why == "wrong_option_count"
    assert V.check_mcq(five, rules(option_count=5), [SRC], 0)[0] is not None


def test_explanations_and_notes_follow_include_flags_and_are_capped():
    q = ok(mcq_item(explanation="E" * 5000), rules(include_short_notes=False))
    assert q["short_note"] is None and len(q["explanation"]) <= V.EXPLANATION_MAX
    q = ok(mcq_item(), rules(include_explanations=False))
    assert q["explanation"] is None and q["short_note"]


def test_difficulty_setting_is_forced_and_mixed_keeps_valid_labels():
    assert ok(mcq_item(difficulty="HARD"), rules(difficulty="EASY"))["difficulty"] == "EASY"
    assert ok(mcq_item(difficulty="hard"), rules(difficulty="MIXED"))["difficulty"] == "HARD"
    assert ok(mcq_item(difficulty="whatever"), rules(difficulty="MIXED"), pos=1)["difficulty"] == "MEDIUM"  # cycles by position


def test_marks_come_from_the_spec_negative_never_exceeds_marks():
    q = ok(mcq_item(), rules(marks=2, negative_marks=0.5))
    assert (q["marks"], q["negative_marks"]) == (2, 0.5)
    assert ok(mcq_item(), rules(marks=1, negative_marks=5))["negative_marks"] == 1


# ------------------------------------------------------------------------------------------------ evidence / grounding
def test_fabricated_evidence_is_dropped_and_source_only_rejects():
    fake = mcq_item(evidence=[LlmEvidence(source=1, quote="Totally invented sentence that is nowhere in the source")])
    assert V.check_mcq(fake, rules("SOURCE_ONLY"), [SRC], 0) == (None, "no_evidence")
    q = ok(fake, rules("SOURCE_PREFERRED"))
    assert q["sources"] == [] and q["source_support"] == "MODEL_ONLY"
    # out-of-range source numbers, too-short quotes and quotes pointing at the wrong chunk are not evidence
    for ev in (LlmEvidence(source=9, quote=QUOTE), LlmEvidence(source=0, quote=QUOTE), LlmEvidence(source=1, quote="ATP"), LlmEvidence(source=2, quote=QUOTE)):
        assert V.check_mcq(mcq_item(evidence=[ev]), rules("SOURCE_ONLY"), [SRC, SRC2], 0)[1] == "no_evidence"


def test_evidence_matching_ignores_whitespace_case_and_nfkc_and_names_come_from_the_chunk():
    ev = LlmEvidence(source=1, quote="  MITOCHONDRIA   produce\nATP through  oxidative phosphorylation ")
    q = ok(mcq_item(evidence=[ev]))
    assert q["sources"][0]["quote_verified"] and q["sources"][0]["document_name"] == "Biology.pdf" and q["sources"][0]["page"] == 7
    assert q["sources"][0]["quote"] == QUOTE.replace("Mitochondria", "MITOCHONDRIA")  # whitespace collapsed, case as quoted


def test_general_grounding_never_attaches_sources():
    q = ok(mcq_item(), rules("GENERAL"), sel=())
    assert q["sources"] == [] and q["source_support"] == "MODEL_ONLY"


def test_leaked_key_or_canary_blocks_the_question(monkeypatch):
    from app.redact import bind_secrets

    assert V.check_mcq(mcq_item(explanation=f"debug {CANARY}"), rules(), [SRC], 0) == (None, "leak")
    with bind_secrets(["sk-SECRETKEY-123456"]):
        assert V.check_mcq(mcq_item(stem="What is sk-SECRETKEY-123456?"), rules(), [SRC], 0) == (None, "leak")


# ------------------------------------------------------------------------------------------------ review flags
def test_explanation_naming_another_option_is_flagged_not_rejected():
    q = ok(mcq_item(explanation="The correct answer is C, the nucleus."))
    assert q["review_reasons"] == [V.EXPLANATION_NAMES_OTHER_OPTION]
    assert ok(mcq_item(explanation="The correct answer is A."))["review_reasons"] == []
    assert ok(mcq_item(explanation="The answer is a combination of factors."))["review_reasons"] == []  # prose, not a label


def test_bangla_explanation_naming_other_option_is_flagged():
    opts = [LlmOption(label=c, text=t) for c, t in zip("ABCD", ["মাইটোকন্ড্রিয়া", "রাইবোসোম", "নিউক্লিয়াস", "গলজি বডি"])]
    item = mcq_item(stem="কোন অঙ্গাণু শক্তি উৎপন্ন করে?", options=opts, correct_label="A", explanation="সঠিক উত্তর হলো গ।", short_note=None, evidence=[])
    q = ok(item, rules("GENERAL", language="bn"), sel=())
    assert V.EXPLANATION_NAMES_OTHER_OPTION in q["review_reasons"]


def test_key_not_in_evidence_only_when_a_distractor_clearly_matches():
    item = mcq_item(
        stem="What produces ATP?",
        options=[LlmOption(label=c, text=t) for c, t in zip("ABCD", ["the Golgi body secretes", "oxidative phosphorylation in the inner membrane", "a vacuole", "lysosome"])],
        correct_label="A", evidence=[LlmEvidence(source=1, quote=QUOTE + " in the inner membrane")], explanation=None,
    )
    assert V.KEY_NOT_IN_EVIDENCE in ok(item)["review_reasons"]
    assert V.KEY_NOT_IN_EVIDENCE not in ok(mcq_item())["review_reasons"]


def test_language_check_rejects_wrong_script_and_flags_mixed():
    assert V.language_verdict("Which organelle produces ATP in the cell?", "en") == "ok"
    assert V.language_verdict("কোন অঙ্গাণু শক্তি উৎপন্ন করে?", "bn") == "ok"
    assert V.language_verdict("কোন অঙ্গাণু শক্তি উৎপন্ন করে?", "en") == "reject"
    assert V.language_verdict("Which organelle produces ATP in the cell?", "bn") == "reject"
    assert V.language_verdict("12345 + 6", "bn") == "ok"  # no letters, nothing to judge
    mixed = "কোন অঙ্গাণু ATP mitochondria produces energy for the whole cell organelle"
    assert V.language_verdict(mixed, "bn") == "flag"
    q, why = V.check_mcq(mcq_item(), rules(language="bn"), [SRC], 0)
    assert q is None and why == "wrong_language"


def test_script_ratio_and_tokens_handle_bangla():
    bn, latin = script_ratios("কোন অঙ্গাণু শক্তি উৎপন্ন করে ATP")
    assert bn > 0.8 and latin < 0.2
    assert token_set("কোন অঙ্গাণু শক্তি?") == frozenset({"কোন", "অঙ্গাণু", "শক্তি"})
    assert jaccard(token_set("a b c"), token_set("a b c d")) == 0.75


# ------------------------------------------------------------------------------------------------ duplicates
def test_duplicates_exact_near_and_conflicting_and_avoid():
    idx = V.DuplicateIndex.seeded(["What is the powerhouse of the cell?"])
    assert idx.check("what is the POWERHOUSE of the cell") == "duplicate"  # exact after normalisation (also vs `avoid`)
    assert idx.check("Which organelle is the powerhouse of the cell?") is None
    idx.add("Which organelle produces most of the ATP in a eukaryotic cell?", "Mitochondrion")
    assert idx.check("Which organelle produces most of the ATP in eukaryotic cell?", "Mitochondrion") == "duplicate"  # near (Jaccard >= .8)
    assert idx.check("Which organelle produces most of the ATP in eukaryotic cell?", "Ribosome") == "conflicting_duplicate"
    assert idx.check("What shape is DNA?") is None
    assert 0.0 <= idx.nearest("What shape is DNA?") < 0.65


# ------------------------------------------------------------------------------------------------ CQ
CQ_SRC = SourceChunk("c9", "doc2", "Ecology.docx", None, "Intro", "Energy flows through an ecosystem from producers to consumers and decomposers, losing most of it as heat at every trophic level.")
CQ_Q = "Energy flows through an ecosystem from producers to consumers"


def cq_item(parts=4, answers=True, evidence=True, **kw) -> LlmCq:
    ev = [LlmEvidence(source=1, quote=CQ_Q)] if evidence else []
    mk = lambda i: LlmCqPart(label="?", level="x", prompt=f"Part {i} question?", marks=0,  # noqa: E731
                             answer=LlmAnswer(text=f"Answer {i}", supported=evidence, evidence=ev) if answers else None)
    base = dict(stimulus="A farmer notices energy loss in a food chain.", stem="Read the stimulus and answer.", parts=[mk(i) for i in range(parts)], answer=None,
                difficulty="MEDIUM", topic="Ecology", tags=["energy"], evidence=ev)
    base.update(kw)
    return LlmCq(**base)


def cq_rules(grounding="SOURCE_ONLY", **spec) -> V.CqRules:
    spec.setdefault("structure", "stimulus_4part")
    return V.CqRules(CqSpec(count=2, **spec), grounding)


def test_cq_four_part_structure_labels_levels_and_marks_come_from_the_spec():
    q, why = V.check_cq(cq_item(), cq_rules(language="bn", mode="WITH_ANSWERS"), [CQ_SRC], 0)
    assert q is None and why == "wrong_language"
    q, why = V.check_cq(cq_item(), cq_rules(mode="WITH_ANSWERS"), [CQ_SRC], 0)
    assert why is None
    assert [p["label"] for p in q["parts"]] == ["a", "b", "c", "d"]
    assert [p["level"] for p in q["parts"]] == ["KNOWLEDGE", "COMPREHENSION", "APPLICATION", "HIGHER_ORDER"]
    assert [p["marks"] for p in q["parts"]] == [1, 2, 3, 4] and q["marks"] == 10 and q["negative_marks"] == 0
    assert all(p["answer"]["basis"] == "SOURCE_SUPPORTED" and p["answer"]["sources"][0]["quote"] == CQ_Q for p in q["parts"])
    assert q["options"] == [] and q["correct_option_id"] is None and q["explanation"] is None and q["source_support"] == "SOURCE_QUOTED"
    assert V.MARKS_ADJUSTED not in q["review_reasons"]  # the model gave no marks: nothing to adjust


def test_cq_bangla_labels_and_marks_adjusted_flag():
    item = cq_item(stimulus="একটি পরিস্থিতি বিবেচনা করো।", stem="উদ্দীপকটি পড়ো এবং উত্তর দাও।", evidence=False, answers=False)
    for p in item.parts:
        p.prompt = "এটি কী? ব্যাখ্যা করো।"
        p.marks = 5  # differs from the requested distribution
    q, why = V.check_cq(item, cq_rules("GENERAL", language="bn", mode="QUESTIONS_ONLY"), [], 0)
    assert why is None and [p["label"] for p in q["parts"]] == ["ক", "খ", "গ", "ঘ"] and [p["marks"] for p in q["parts"]] == [1, 2, 3, 4]
    assert q["review_reasons"] == [V.MARKS_ADJUSTED]


def test_cq_questions_only_never_carries_answers():
    q, why = V.check_cq(cq_item(), cq_rules(mode="QUESTIONS_ONLY"), [CQ_SRC], 0)
    assert why is None and all(p["answer"] is None for p in q["parts"]) and q["answer"] is None


def test_cq_source_only_unsupported_parts_become_insufficient_evidence_never_invented():
    item = cq_item()
    item.parts[2].answer = LlmAnswer(text="A confident but unsupported answer", supported=False, evidence=[])
    q, why = V.check_cq(item, cq_rules(mode="WITH_ANSWERS"), [CQ_SRC], 0)
    assert why is None
    assert q["parts"][2]["answer"] == {"text": "", "basis": "INSUFFICIENT_EVIDENCE", "sources": []}
    assert V.PART_INSUFFICIENT_EVIDENCE in q["review_reasons"]


def test_cq_source_only_with_no_supported_answer_is_rejected():
    q, why = V.check_cq(cq_item(evidence=False), cq_rules(mode="WITH_ANSWERS"), [CQ_SRC], 0)
    assert q is None and why == "no_supported_answer"
    q, why = V.check_cq(cq_item(evidence=False, answers=False), cq_rules(mode="QUESTIONS_ONLY"), [CQ_SRC], 0)
    assert q is None and why == "no_evidence"


def test_cq_preferred_and_general_label_unsupported_answers_as_general_reasoning():
    q, why = V.check_cq(cq_item(evidence=False), cq_rules("SOURCE_PREFERRED", mode="WITH_ANSWERS"), [CQ_SRC], 0)
    assert why is None and q["source_support"] == "MODEL_ONLY"
    assert all(p["answer"]["basis"] == "GENERAL_REASONING" and p["answer"]["sources"] == [] for p in q["parts"])


@pytest.mark.parametrize("kw,spec,why", [
    (dict(parts=3), dict(), "wrong_part_count"),
    (dict(stimulus=None), dict(), "missing_stimulus"),
    (dict(stem=" "), dict(), "empty_stem"),
])
def test_cq_structural_rejections(kw, spec, why):
    assert V.check_cq(cq_item(**kw), cq_rules(mode="WITH_ANSWERS", **spec), [CQ_SRC], 0) == (None, why)


def test_cq_descriptive_has_no_parts_and_a_question_level_answer_and_optional_stimulus():
    rules_ = cq_rules(structure="descriptive", stimulus="none", total_marks=8, mode="WITH_ANSWERS")
    item = cq_item(parts=0, stimulus="ignored", stem="Discuss energy flow in ecosystems.", answer=LlmAnswer(text="Energy flows one way.", supported=True, evidence=[LlmEvidence(source=1, quote=CQ_Q)]))
    q, why = V.check_cq(item, rules_, [CQ_SRC], 0)
    assert why is None and q["parts"] == [] and q["stimulus"] is None and q["marks"] == 8
    assert q["answer"]["basis"] == "SOURCE_SUPPORTED"
    assert V.check_cq(cq_item(parts=2), rules_, [CQ_SRC], 0) == (None, "unexpected_parts")


def test_cq_dedupe_text_uses_stem_stimulus_and_prompts():
    q, _ = V.check_cq(cq_item(), cq_rules(mode="QUESTIONS_ONLY"), [CQ_SRC], 0)
    assert "farmer" in V.cq_dedupe_text(q) and "Part 0" in V.cq_dedupe_text(q)


# ------------------------------------------------------------------------------------------------ cq spec resolution
def test_cq_spec_part_marks_resolution_and_validation():
    assert CqSpec(count=1, structure="stimulus_4part").resolved_part_marks() == [1, 2, 3, 4]
    assert CqSpec(count=1, structure="stimulus_4part", total_marks=20).resolved_part_marks() == [2, 4, 6, 8]
    assert CqSpec(count=1, structure="multipart", part_count=3, total_marks=10).resolved_part_marks() == [3.33, 3.33, 3.34]
    assert CqSpec(count=1, structure="descriptive").resolved_part_marks() == []
    assert CqSpec(count=1, structure="stimulus_4part").effective_stimulus == "required"
    for bad in (dict(structure="stimulus_4part", part_marks=[1, 2, 3]), dict(structure="multipart", part_count=3, part_marks=[1, 2]),
                dict(structure="multipart", part_marks=[1, 2], total_marks=10), dict(structure="descriptive", part_marks=[10])):
        with pytest.raises(ValueError):
            CqSpec(count=1, **bad)


# ------------------------------------------------------------------------------------------------ source pool helpers
def test_split_pasted_is_deterministic_bounded_and_marks_pasted_origin():
    text = "\n\n".join(f"Paragraph {i}. " + "Sentence about topic. " * 30 for i in range(12))
    a, b = split_pasted(text, 1500), split_pasted(text, 1500)
    assert a == b and len(a) > 3 and all(len(c.content) <= 1500 for c in a)
    assert all(c.document_id is None and c.document_name == "Pasted text" and c.chunk_id == f"paste:{i}" for i, c in enumerate(a))
    assert split_pasted("   ") == [] and split_pasted("x" * 5000, 1000)[0].content


def test_select_for_batch_rotates_wraps_and_keeps_at_least_one():
    pool = [SourceChunk(f"c{i}", None, "p", None, None, "x" * 400) for i in range(5)]
    sel, nxt, trunc = select_for_batch(pool, 0, 900)
    assert [c.chunk_id for c in sel] == ["c0", "c1"] and nxt == 2 and not trunc
    sel, nxt, _ = select_for_batch(pool, 4, 900)
    assert [c.chunk_id for c in sel] == ["c4", "c0"] and nxt == 1
    sel, _, trunc = select_for_batch([SourceChunk("big", None, "p", None, None, "y" * 5000)], 0, 1200)
    assert len(sel) == 1 and len(sel[0].content) == 1200 and trunc
    assert select_for_batch([], 0, 100) == ([], 0, False)


def test_even_picks_and_context_budget():
    assert even_picks(10, 3) == [2, 6, 9]
    assert even_picks(4, 10) == [1, 2, 3, 4] and even_picks(1, 1) == [1]
    assert all(1 <= p <= 100 for p in even_picks(100, 7)) and len(set(even_picks(100, 7))) == 7
    assert context_budget(14000, None, None) == 14000
    assert context_budget(14000, 128_000, 4000) == 14000
    assert context_budget(14000, 8_000, 2000) == 8400  # min(14000, 0.6 * 8000 * 3 - 2000 * 3)
    assert context_budget(14000, 4_000, 4000) == 1200  # floor


def test_truncate_words_never_cuts_mid_word():
    assert truncate_words("alpha beta gamma delta", 14) == "alpha beta…"
    assert truncate_words("short", 50) == "short"
