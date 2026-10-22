"""Request models (PART3_SPEC §7) and the provider-facing structured-output schemas.

Provider-facing schemas avoid JSON-Schema constraint keywords on purpose (OpenAI strict mode rejects several of them);
every bound is enforced deterministically in `validate.py` instead.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.schemas import ChatConfig, EmbeddingConfigIn

Grounding = Literal["SOURCE_ONLY", "SOURCE_PREFERRED", "GENERAL"]
DifficultySetting = Literal["EASY", "MEDIUM", "HARD", "MIXED"]
Language = Literal["en", "bn"]
CqMode = Literal["QUESTIONS_ONLY", "WITH_ANSWERS"]
CqStructure = Literal["stimulus_4part", "descriptive", "multipart"]
StimulusSetting = Literal["required", "optional", "none"]

MAX_AVOID = 60
MAX_AVOID_CHARS = 300
LEVELS = ("KNOWLEDGE", "COMPREHENSION", "APPLICATION", "HIGHER_ORDER")
BN_PART_LABELS = ("ক", "খ", "গ", "ঘ", "ঙ", "চ")
EN_PART_LABELS = ("a", "b", "c", "d", "e", "f")


class GenSources(BaseModel):
    topic: str | None = Field(default=None, max_length=2000)
    pasted_text: str | None = Field(default=None, max_length=300_000)
    document_ids: list[str] = Field(default_factory=list, max_length=50)

    @model_validator(mode="after")
    def _ids(self) -> "GenSources":
        for d in self.document_ids:
            if not d or len(d) > 200:
                raise ValueError("invalid document id")
        return self

    @property
    def has_material(self) -> bool:
        """Material that can be quoted: pasted text or documents (a topic alone is not a source)."""
        return bool((self.pasted_text or "").strip() or self.document_ids)


class GenLimits(BaseModel):
    batch_size: int = Field(default=10, ge=1, le=50)
    max_llm_calls: int = Field(default=16, ge=1, le=64)
    max_context_chars: int = Field(default=14_000, ge=1000, le=100_000)
    timeout_seconds: float = Field(default=240, ge=5, le=900)
    max_regen_per_batch: int = Field(default=2, ge=0, le=4)


class McqSpec(BaseModel):
    count: int = Field(ge=1, le=100)
    difficulty: DifficultySetting = "MIXED"
    language: Language = "en"
    option_count: int = Field(default=4, ge=2, le=6)
    include_explanations: bool = True
    include_short_notes: bool = True
    marks: float = Field(default=1, ge=0, le=100)
    negative_marks: float = Field(default=0, ge=0, le=100)
    subject: str | None = Field(default=None, max_length=120)


class CqSpec(BaseModel):
    count: int = Field(ge=1, le=100)
    mode: CqMode = "WITH_ANSWERS"
    structure: CqStructure = "descriptive"
    part_count: int | None = Field(default=None, ge=2, le=6)
    part_marks: list[float] | None = Field(default=None, max_length=6)
    total_marks: float = Field(default=10, gt=0, le=100)
    stimulus: StimulusSetting = "optional"
    difficulty: DifficultySetting = "MIXED"
    language: Language = "en"
    subject: str | None = Field(default=None, max_length=120)

    @model_validator(mode="after")
    def _structure(self) -> "CqSpec":
        marks = self.part_marks
        if marks is not None and any(m <= 0 for m in marks):
            raise ValueError("part marks must be positive")
        if self.structure == "descriptive":
            if marks:
                raise ValueError("descriptive questions have no parts")
        elif self.structure == "stimulus_4part":
            if marks is not None and len(marks) != 4:
                raise ValueError("stimulus_4part needs exactly 4 part marks")
        else:  # multipart
            n = self.part_count if self.part_count is not None else (len(marks) if marks else 3)
            if marks is not None and len(marks) != n:
                raise ValueError("part_marks must match part_count")
        if marks is not None and abs(sum(marks) - self.total_marks) > 0.01:
            raise ValueError("part marks must add up to total_marks")
        return self

    def resolved_part_marks(self) -> list[float]:
        """[] for descriptive; else the marks of each part (explicit, 4-part 1:2:3:4 scaled to total, or an even split)."""
        if self.structure == "descriptive":
            return []
        if self.part_marks:
            return [round(m, 2) for m in self.part_marks]
        if self.structure == "stimulus_4part":
            return [round(self.total_marks * w / 10, 2) for w in (1, 2, 3, 4)]
        n = self.part_count or 3
        share = round(self.total_marks / n, 2)
        marks = [share] * n
        marks[-1] = round(self.total_marks - share * (n - 1), 2)
        return marks

    @property
    def effective_stimulus(self) -> StimulusSetting:
        return "required" if self.structure == "stimulus_4part" else self.stimulus


class _GenBase(BaseModel):
    request_id: str = Field(min_length=1, max_length=128)
    user_id: str = Field(min_length=1, max_length=200)
    chat: ChatConfig
    embedding: EmbeddingConfigIn | None = None
    context_tokens: int | None = Field(default=None, ge=1000, le=10_000_000)
    grounding: Grounding
    sources: GenSources = Field(default_factory=GenSources)
    avoid: list[str] = Field(default_factory=list, max_length=MAX_AVOID)
    cross_check: bool = True
    limits: GenLimits = Field(default_factory=GenLimits)

    @model_validator(mode="after")
    def _policy(self) -> "_GenBase":
        for a in self.avoid:
            if len(a) > MAX_AVOID_CHARS:
                raise ValueError("avoid entries are too long")
        topic = (self.sources.topic or "").strip()
        if self.grounding == "GENERAL":
            if self.sources.has_material:
                raise ValueError("GENERAL grounding takes no pasted text or documents")
            if not topic:
                raise ValueError("GENERAL grounding needs a topic")
        elif not self.sources.has_material:
            raise ValueError("source-grounded generation needs pasted text or documents")
        return self


class McqGenBody(_GenBase):
    spec: McqSpec


class CqGenBody(_GenBase):
    spec: CqSpec


# ------------------------------------------------------------------------------------------------ provider-facing output
class LlmEvidence(BaseModel):
    source: int
    quote: str


class LlmOption(BaseModel):
    label: str
    text: str


class LlmMcq(BaseModel):
    stem: str
    options: list[LlmOption]
    correct_label: str
    explanation: str | None
    short_note: str | None
    difficulty: str
    topic: str | None
    tags: list[str]
    evidence: list[LlmEvidence]


class LlmMcqBatch(BaseModel):
    questions: list[LlmMcq]


class LlmAnswer(BaseModel):
    text: str
    supported: bool
    evidence: list[LlmEvidence]


class LlmCqPart(BaseModel):
    label: str
    level: str
    prompt: str
    marks: float
    answer: LlmAnswer | None


class LlmCq(BaseModel):
    stimulus: str | None
    stem: str
    parts: list[LlmCqPart]
    answer: LlmAnswer | None
    difficulty: str
    topic: str | None
    tags: list[str]
    evidence: list[LlmEvidence]


class LlmCqBatch(BaseModel):
    questions: list[LlmCq]


class SolverAnswer(BaseModel):
    index: int
    label: str


class SolverBatch(BaseModel):
    answers: list[SolverAnswer]
