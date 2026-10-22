"""Request models (PART5_SPEC §3.2, §4) and the provider-facing structured-output schemas.

Provider-facing schemas avoid JSON-Schema constraint keywords (OpenAI strict mode rejects several of them);
every bound is enforced deterministically in `verify.py` instead. The request models DO enforce hard size caps,
because the backend is the only caller and anything larger than the spec is a bug (422).
"""

from __future__ import annotations

import json
import unicodedata
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.schemas import ChatConfig

Language = Literal["en", "bn"]
Band = Literal["EXCELLENT", "GOOD", "NEEDS_IMPROVEMENT", "BAD", "VERY_BAD"]
DataLevel = Literal["INITIAL", "BASED_ON_HISTORY"]
STEP_TYPES = ("REVIEW_NOTES", "REVISIT_QUESTIONS", "PRACTICE_MCQ", "PRACTICE_CQ", "COMPARE_ATTEMPTS", "ASK_ASSISTANT", "READ_DOCUMENT")

MAX_CONTEXT_CHARS = 12_000
MAX_TOPICS = 40
MAX_TOPIC_CHARS = 60
MAX_STEMS = 25


def _canon(s: str) -> str:
    return " ".join(unicodedata.normalize("NFC", s).replace("​", "").casefold().split())


class ExamInfo(BaseModel):
    title: str = Field(max_length=200)
    question_count: int = Field(ge=1, le=1000)
    percent_bp: int = Field(ge=0, le=10_000)
    band: Band
    correct: int = Field(ge=0, le=1000)
    incorrect: int = Field(ge=0, le=1000)
    unanswered: int = Field(ge=0, le=1000)

    @model_validator(mode="after")
    def _counts(self) -> "ExamInfo":
        if self.correct + self.incorrect + self.unanswered > self.question_count:
            raise ValueError("counts exceed question_count")
        return self


class TopicIn(BaseModel):
    topic: str = Field(min_length=1, max_length=MAX_TOPIC_CHARS)
    questions: int = Field(ge=0, le=100_000)
    correct: int = Field(ge=0, le=100_000)
    incorrect: int = Field(ge=0, le=100_000)
    unanswered: int = Field(ge=0, le=100_000)
    accuracy_bp: int = Field(ge=0, le=10_000)

    @model_validator(mode="after")
    def _counts(self) -> "TopicIn":
        if self.correct + self.incorrect + self.unanswered > self.questions:
            raise ValueError("topic counts exceed questions")
        return self


class IncorrectItem(BaseModel):
    topic: str = Field(min_length=1, max_length=MAX_TOPIC_CHARS)
    stem: str = Field(max_length=300)
    selected_text: str | None = Field(default=None, max_length=400)
    correct_text: str | None = Field(default=None, max_length=400)
    explanation: str | None = Field(default=None, max_length=400)
    note: str | None = Field(default=None, max_length=400)


class PreviousResult(BaseModel):
    percent_bp: int = Field(ge=0, le=10_000)


class TopicHistory(BaseModel):
    topic: str = Field(min_length=1, max_length=MAX_TOPIC_CHARS)
    answered: int = Field(ge=0, le=1_000_000)
    accuracy_bp: int = Field(ge=0, le=10_000)


class History(BaseModel):
    data_level: DataLevel
    results_total: int = Field(ge=0, le=100_000)
    previous_same_exam: list[PreviousResult] = Field(default_factory=list, max_length=10)
    topic_history: list[TopicHistory] = Field(default_factory=list, max_length=MAX_TOPICS)


class _TopicLists(BaseModel):
    topics: list[TopicIn] = Field(default_factory=list, max_length=MAX_TOPICS)
    # computed by the backend (PART5_SPEC §1); the model may only choose among them
    strong_topics: list[str] = Field(default_factory=list, max_length=8)
    weak_topics: list[str] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def _lists(self) -> "_TopicLists":
        names = [_canon(t.topic) for t in self.topics]
        if len(set(names)) != len(names):
            raise ValueError("duplicate topics")
        for lst in (self.strong_topics, self.weak_topics):
            for t in lst:
                if _canon(t) not in names:
                    raise ValueError("strong/weak topics must be listed in topics")
        return self


class ResultContext(_TopicLists):
    language: Language = "en"
    exam: ExamInfo
    incorrect_items: list[IncorrectItem] = Field(default_factory=list, max_length=MAX_STEMS)
    history: History

    @model_validator(mode="after")
    def _size(self) -> "ResultContext":
        names = {_canon(t.topic) for t in self.topics}
        for it in self.incorrect_items:
            if names and _canon(it.topic) not in names:
                raise ValueError("incorrect item topic is not in topics")
        if len(json.dumps(self.model_dump(), ensure_ascii=False)) > MAX_CONTEXT_CHARS:
            raise ValueError("context too large")
        return self


class PlanResultIn(BaseModel):
    percent_bp: int = Field(ge=0, le=10_000)


class PlanContext(_TopicLists):
    language: Language = "en"
    data_level: DataLevel
    results: list[PlanResultIn] = Field(default_factory=list, max_length=50)

    @model_validator(mode="after")
    def _size(self) -> "PlanContext":
        if len(json.dumps(self.model_dump(), ensure_ascii=False)) > MAX_CONTEXT_CHARS:
            raise ValueError("context too large")
        return self


class _Body(BaseModel):
    request_id: str = Field(min_length=1, max_length=128)
    user_id: str | None = Field(default=None, max_length=200)
    chat: ChatConfig

    @field_validator("request_id")
    @classmethod
    def _rid(cls, v: str) -> str:
        return v.strip() or "-"


class ResultBody(_Body):
    context: ResultContext


class PlanBody(_Body):
    context: PlanContext


# ---------------------------------------------------------------------------------------------- provider-facing output
class LlmStrength(BaseModel):
    topic: str
    detail: str


class LlmWeakness(BaseModel):
    topic: str
    detail: str
    evidence: str


class LlmResultStep(BaseModel):
    type: str
    topic: str | None
    text: str


class LlmAnalysis(BaseModel):
    summary: str
    strengths: list[LlmStrength]
    weaknesses: list[LlmWeakness]
    next_steps: list[LlmResultStep]
    caveats: list[str]


class LlmFocus(BaseModel):
    topic: str
    reason: str


class LlmPlanStep(BaseModel):
    type: str
    topic: str | None
    text: str
    minutes: int | None


class LlmPlan(BaseModel):
    headline: str
    focus: list[LlmFocus]
    steps: list[LlmPlanStep]
    caveats: list[str]
