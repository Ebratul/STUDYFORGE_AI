"""Deterministic verification of analysis / plan output (PART5_SPEC §6): every rejection rule."""

from __future__ import annotations

import pytest

from app.analysis.verify import numbers_in, verify_analysis, verify_plan
from app.prompts import CANARY
from tests.analysis_utils import CANARY_KEY, ctx_models, good_analysis, good_plan, plan_ctx_model, plan_payload, result_payload, topic
from app.providers.mock import VALID_KEY
from app.redact import bind_secrets


def ctx(**kw):
    return ctx_models(result_payload(**kw))


def check(out, c=None):
    c = c or ctx()
    return verify_analysis(out, c)


def assert_rejects(out, code: str, *, ungrounded: bool, c=None):
    content, reasons, ung, leak = check(out, c)
    assert content is None and not leak, reasons
    assert any(r.split(":", 1)[0] == code for r in reasons), reasons
    assert ung is ungrounded


# ---------------------------------------------------------------------------------------------------- acceptance
def test_good_output_is_accepted_and_normalised():
    content, reasons, ung, leak = check(good_analysis())
    assert reasons == [] and not ung and not leak
    assert content["strengths"] == [{"topic": "Energy", "detail": "6 of 6 correct."}]
    assert content["weaknesses"][0]["topic"] == "Cells" and content["next_steps"][0]["type"] == "REVIEW_NOTES"


@pytest.mark.parametrize("quote", ["62.5%", "63%", "62.50%"])
def test_percentage_forms_are_derivable(quote):
    out = good_analysis(summary=f"You scored {quote} overall.")
    assert check(out)[1] == []


def test_topic_names_may_contain_digits():
    topics = [topic("Chapter 12 Cells", 8, 3), topic("Energy", 6, 6)]
    c = ctx(topics=topics, weak=("Chapter 12 Cells",), strong=("Energy",), incorrect_items=[])
    out = good_analysis(weaknesses=[{"topic": "Chapter 12 Cells", "detail": "Practise Chapter 12 Cells.", "evidence": "3 of 8 correct"}],
                        next_steps=[{"type": "REVIEW_NOTES", "topic": "Chapter 12 Cells", "text": "Review Chapter 12 Cells."}, {"type": "ASK_ASSISTANT", "topic": None, "text": "Ask for help."}],
                        summary="You answered 9 of 14 questions correctly (64.29%).")
    assert verify_analysis(out, c)[1] == []


def test_advice_quantities_are_allowed_in_steps_only():
    ok = good_analysis(next_steps=[{"type": "REVIEW_NOTES", "topic": "Cells", "text": "Spend 20 minutes on 5 questions."}, {"type": "ASK_ASSISTANT", "topic": None, "text": "Ask for help."}])
    assert check(ok)[1] == []
    assert_rejects(good_analysis(summary="You should study 20 minutes more."), "number_not_in_data", ungrounded=True)
    too_big = good_analysis(next_steps=[{"type": "REVIEW_NOTES", "topic": "Cells", "text": "Spend 999 minutes on it."}, {"type": "ASK_ASSISTANT", "topic": None, "text": "Ask."}])
    assert_rejects(too_big, "number_not_in_data", ungrounded=True)


# ---------------------------------------------------------------------------------------------------- numbers
def test_invented_number_is_rejected():
    assert_rejects(good_analysis(summary="You improved a lot: 37% better than before."), "number_not_in_data", ungrounded=True)
    assert_rejects(good_analysis(summary="You answered 11 of 16 questions correctly."), "number_not_in_data", ungrounded=True)


def test_bangla_digits_are_normalised_before_checking():
    bn = ctx(language="bn")
    ok = good_analysis(summary="তুমি ১৬ টি প্রশ্নের মধ্যে ১০ টির সঠিক উত্তর দিয়েছ (৬২.৫%)।", strengths=[{"topic": "Energy", "detail": "৬ টির মধ্যে ৬ টি সঠিক।"}],
                       weaknesses=[{"topic": "Cells", "detail": "আরেকটু অনুশীলন দরকার।", "evidence": "৮ টির মধ্যে ৩ টি সঠিক"}],
                       next_steps=[{"type": "REVIEW_NOTES", "topic": "Cells", "text": "নোটগুলো আবার পড়ো।"}, {"type": "ASK_ASSISTANT", "topic": None, "text": "সাহায্য চাও।"}],
                       caveats=["এটি সীমিত ফলাফলের উপর ভিত্তি করে একটি প্রাথমিক পরামর্শ।"])
    assert verify_analysis(ok, bn)[1] == []
    bad = ok.model_copy(update={"summary": "তুমি ১৬ টি প্রশ্নের মধ্যে ৩৭ টির সঠিক উত্তর দিয়েছ।"})
    content, reasons, ung, _ = verify_analysis(bad, bn)
    assert content is None and ung and "number_not_in_data:37" in reasons
    assert numbers_in("৩৭ এবং ১২.৫", []) == [37, 12.5] or [str(n) for n in numbers_in("৩৭ এবং ১২.৫", [])] == ["37", "12.5"]


# ---------------------------------------------------------------------------------------------------- topics
def test_unknown_topic_is_rejected():
    assert_rejects(good_analysis(next_steps=[{"type": "REVIEW_NOTES", "topic": "Quantum Basket Weaving", "text": "x"}, {"type": "ASK_ASSISTANT", "topic": None, "text": "y"}]),
                   "unknown_topic", ungrounded=True)


def test_strengths_and_weaknesses_only_use_the_supplied_lists():
    assert_rejects(good_analysis(strengths=[{"topic": "Cells", "detail": "Great."}]), "topic_not_allowed", ungrounded=True)  # Cells is weak, not strong
    assert_rejects(good_analysis(weaknesses=[{"topic": "Energy", "detail": "Hmm.", "evidence": "6 of 6 correct"}]), "topic_not_allowed", ungrounded=True)
    assert_rejects(good_analysis(weaknesses=[{"topic": "Genetics", "detail": "Hmm.", "evidence": "1 of 2 correct"}]), "topic_not_allowed", ungrounded=True)  # too few answers to label
    # with no strong topics supplied, no strengths may be claimed
    c = ctx(strong=())
    assert_rejects(good_analysis(), "topic_not_allowed", ungrounded=True, c=c)


def test_topic_matching_ignores_case_and_zero_width_characters():
    out = good_analysis(strengths=[{"topic": "ENERGY", "detail": "6 of 6 correct."}], weaknesses=[{"topic": "cel​ls", "detail": "More practice.", "evidence": "3 of 8 correct"}])
    content, reasons, *_ = check(out)
    assert reasons == [] and content["strengths"][0]["topic"] == "Energy" and content["weaknesses"][0]["topic"] == "Cells"


def test_weakness_evidence_must_quote_that_topics_own_numbers():
    assert_rejects(good_analysis(weaknesses=[{"topic": "Cells", "detail": "More practice.", "evidence": "a lot of mistakes"}]), "weakness_evidence", ungrounded=True)
    assert_rejects(good_analysis(weaknesses=[{"topic": "Cells", "detail": "More practice.", "evidence": "6 of 6 correct"}]), "weakness_evidence", ungrounded=True)  # Energy's numbers


# ---------------------------------------------------------------------------------------------------- claims
@pytest.mark.parametrize("phrase", ["You have mastered this topic.", "You are consistently improving.", "Your trend is upward.", "Great long-term progress."])
def test_mastery_and_trend_claims_are_rejected_for_initial_data(phrase):
    assert_rejects(good_analysis(summary=f"You scored 62.5%. {phrase}"), "mastery_claim", ungrounded=True)


def test_mastery_claims_are_allowed_only_with_history():
    history = ctx(level="BASED_ON_HISTORY", previous=(5000,), results_total=4)
    out = good_analysis(summary="You scored 62.5%, up from 50% last time, and you are improving steadily.", caveats=[])
    assert verify_analysis(out, history)[1] == []
    assert_rejects(out, "mastery_claim", ungrounded=True)  # same text, INITIAL context


def test_bangla_banned_phrases():
    bn = ctx(language="bn")
    out = good_analysis(summary="তুমি ১০ টির সঠিক উত্তর দিয়েছ। তুমি ক্রমাগত উন্নতি করছ।", strengths=[], weaknesses=[],
                        next_steps=[{"type": "ASK_ASSISTANT", "topic": None, "text": "সাহায্য চাও।"}, {"type": "PRACTICE_MCQ", "topic": None, "text": "অনুশীলন করো।"}],
                        caveats=["এটি একটি প্রাথমিক পরামর্শ।"])
    content, reasons, ung, _ = verify_analysis(out, bn)
    assert content is None and ung and "mastery_claim" in reasons


def test_initial_suggestions_need_a_caveat():
    assert_rejects(good_analysis(caveats=[]), "missing_caveat", ungrounded=False)
    assert check(good_analysis(caveats=[]), ctx(level="BASED_ON_HISTORY", previous=(5000,), results_total=3))[1] == []


# ---------------------------------------------------------------------------------------------------- shape / size
def test_length_caps_and_counts():
    assert_rejects(good_analysis(summary="x" * 601), "too_long", ungrounded=False)
    assert_rejects(good_analysis(next_steps=[{"type": "ASK_ASSISTANT", "topic": None, "text": "only one"}]), "too_few_steps", ungrounded=False)
    many = [{"type": "ASK_ASSISTANT", "topic": None, "text": f"step {chr(97 + i)}"} for i in range(6)]
    assert_rejects(good_analysis(next_steps=many), "too_many_steps", ungrounded=False)
    assert_rejects(good_analysis(caveats=["a", "b", "c", "d"]), "too_many_caveats", ungrounded=False)
    assert_rejects(good_analysis(summary="   "), "empty_text", ungrounded=False)


def test_step_type_must_be_in_the_enum():
    assert_rejects(good_analysis(next_steps=[{"type": "BUY_A_COURSE", "topic": None, "text": "x"}, {"type": "ASK_ASSISTANT", "topic": None, "text": "y"}]), "bad_step_type", ungrounded=False)


@pytest.mark.parametrize("text", ["See https://evil.example/x for more.", "Visit www.evil.example", "[click here](http://x.y)", "<a href='x'>go</a>", "javascript:alert(1)"])
def test_links_and_markup_are_rejected(text):
    assert_rejects(good_analysis(summary=text), "link_or_markup", ungrounded=False)


def test_language_script_check():
    assert_rejects(good_analysis(summary="তুমি ভালো করেছ।" * 6, strengths=[], weaknesses=[], next_steps=[{"type": "ASK_ASSISTANT", "topic": None, "text": "সাহায্য চাও।"}, {"type": "PRACTICE_MCQ", "topic": None, "text": "অনুশীলন করো।"}],
                                caveats=["প্রাথমিক পরামর্শ।"]), "wrong_language", ungrounded=False)  # English requested, Bangla returned
    assert_rejects(good_analysis(), "wrong_language", ungrounded=False, c=ctx(language="bn"))  # Bangla requested, English returned


def test_leak_filter_blocks_keys_and_canary():
    with bind_secrets([CANARY_KEY, VALID_KEY]):
        for secret in (CANARY_KEY, CANARY, VALID_KEY):
            content, reasons, ung, leak = check(good_analysis(summary=f"Your key is {secret}"))
            assert content is None and leak and reasons == ["leak"]
    content, _, _, leak = check(good_analysis(caveats=[f"internal {CANARY}"]))
    assert content is None and leak


# ---------------------------------------------------------------------------------------------------- plan
def pctx(**kw):
    return plan_ctx_model(plan_payload(**kw))


def test_plan_accepted():
    content, reasons, ung, leak = verify_plan(good_plan(), pctx())
    assert reasons == [] and content["focus"] == [{"topic": "Cells", "reason": "3 of 8 correct (37.5%)."}]
    assert content["steps"][0]["minutes"] == 15 and "label" not in content


def test_plan_focus_must_come_from_weak_topics_or_any_topic_when_none_are_weak():
    bad = good_plan(focus=[{"topic": "Energy", "reason": "6 of 6 correct"}])
    content, reasons, ung, _ = verify_plan(bad, pctx())
    assert content is None and ung and "topic_not_allowed:focus" in reasons
    ok = verify_plan(bad, pctx(weak=()))
    assert ok[1] == []
    unknown = verify_plan(good_plan(focus=[{"topic": "Nope", "reason": "x"}]), pctx(weak=()))
    assert unknown[0] is None and unknown[2]


def test_plan_rules_numbers_minutes_claims_caveats():
    assert verify_plan(good_plan(headline="You improved by 37% this month."), pctx())[2] is True
    assert "bad_minutes" in verify_plan(good_plan(steps=[{"type": "REVIEW_NOTES", "topic": "Cells", "text": "a", "minutes": 500}, {"type": "ASK_ASSISTANT", "topic": None, "text": "b", "minutes": 5}]), pctx())[1]
    assert "mastery_claim" in verify_plan(good_plan(headline="You are consistently improving."), pctx())[1]
    assert "missing_caveat" in verify_plan(good_plan(caveats=[]), pctx())[1]
    assert verify_plan(good_plan(headline="You are improving steadily.", caveats=[]), pctx(level="BASED_ON_HISTORY", results=(5000, 6250, 7000)))[1] == []
