"""Deterministic, network-free provider for tests/dev. Exists only if ALLOW_MOCK_PROVIDER=1 and APP_ENV != production."""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
import unicodedata
from collections.abc import AsyncIterator

from pydantic import BaseModel, SecretStr

from app.config import Settings
from app.errors import ErrorCode, ProviderError
from app.providers.base import (
    ChatChunk,
    ChatMessage,
    ChatRequest,
    ChatResult,
    EmbedRequest,
    EmbedResult,
    ModelCapabilities,
    ModelInfo,
    StructuredResult,
    TestResult,
    Usage,
)

VALID_KEY = "mock-valid-key"
DIM = 1536
_SRC_BLOCK = re.compile(r"<<<SOURCES:([A-Za-z0-9]+)>>>(.*?)<<<END:\1>>>", re.S)
_SRC_SPLIT = re.compile(r"(?m)^\[(\d+)\] \(([^\n]*)\)\n")
_SPEC_BLOCK = re.compile(r"<<<SPEC:([A-Za-z0-9]+)>>>(.*?)<<<ENDSPEC:\1>>>", re.S)
_Q_BLOCK = re.compile(r"<<<QUESTIONS:([A-Za-z0-9]+)>>>(.*?)<<<ENDQUESTIONS:\1>>>", re.S)


def tokenize(text: str) -> list[str]:
    """Lowercase; words are runs of letters/digits/combining marks (so Bangla vowel signs stay inside words)."""
    out: list[str] = []
    cur: list[str] = []
    for ch in text.lower():
        if unicodedata.category(ch)[0] in ("L", "N", "M"):
            cur.append(ch)
        elif cur:
            out.append("".join(cur))
            cur = []
    if cur:
        out.append("".join(cur))
    return out


# Function words carry no topical signal; ignoring them keeps the mock embedder from "matching" unrelated
# questions on words like "the"/"of" (real embedding models behave the same way).
_STOPWORDS = frozenset(
    "a an the of is are was were be been am what which who whom whose when where why how do does did in on at to from by for "
    "with as that this these those it its they them their he she his her we our you your and or but not if then than so can could "
    "would should will shall may might about into over under".split()
)


def hash_embed(text: str) -> list[float]:
    vec = [0.0] * DIM
    all_toks = tokenize(text)
    toks = [t for t in all_toks if t not in _STOPWORDS] or all_toks or ["\x00empty"]
    for t in toks:
        idx = int.from_bytes(hashlib.sha256(t.encode()).digest()[:4], "big") % DIM
        vec[idx] += 1.0
    norm = math.sqrt(sum(v * v for v in vec))
    return [v / norm for v in vec]


def _last_user(messages: list[ChatMessage]) -> str:
    for m in reversed(messages):
        if m.role == "user":
            return m.content
    return ""


def parse_sources(user_text: str) -> dict[int, str]:
    m = _SRC_BLOCK.search(user_text)
    if not m:
        return {}
    parts = _SRC_SPLIT.split(m.group(2))
    out: dict[int, str] = {}
    # parts = [pre, n, header, text, n, header, text, ...]
    for i in range(1, len(parts) - 2, 3):
        out[int(parts[i])] = parts[i + 2].strip()
    return out


_KW_EN = ["origin", "purpose", "structure", "function", "limitation", "advantage", "example", "cause", "effect", "definition", "process", "principle",
          "application", "history", "comparison", "classification", "measurement", "importance", "risk", "benefit", "component", "stage", "method",
          "property", "role", "pattern", "factor", "outcome", "condition", "feature"]
_KW_BN = ["উৎপত্তি", "উদ্দেশ্য", "গঠন", "কাজ", "সীমাবদ্ধতা", "সুবিধা", "উদাহরণ", "কারণ", "ফলাফল", "সংজ্ঞা", "প্রক্রিয়া", "নীতি", "প্রয়োগ", "ইতিহাস",
          "তুলনা", "শ্রেণিবিভাগ", "পরিমাপ", "গুরুত্ব", "ঝুঁকি", "উপকারিতা"]
_BN_LABELS = ["ক", "খ", "গ", "ঘ", "ঙ", "চ"]
_EN_FRAMES = ["Which option best continues this statement from the source:", "Complete the following sentence taken from the material:",
              "According to the text, what follows after:", "Select the phrase that correctly finishes:", "Identify the correct continuation of:",
              "Choose how the passage goes on after:", "What does the material state immediately after:", "Pick the option that completes this excerpt:"]
_TOPIC_FRAMES = ["Which of the following best describes the {a} of {topic}?", "What is the main {b} associated with {topic} and its {a}?",
                 "Why does the {a} matter when studying {topic}?", "Select the statement that correctly relates {a} to {b} in {topic}.",
                 "How would you recognise the {b} of {topic}?", "Which claim about the {a} of {topic} is accurate?",
                 "Identify the true statement regarding {b} and {topic}.", "When analysing {topic}, which view of {a} is correct?"]
_BN_FRAMES = ["{a} বিষয়ে নিচের কোনটি সঠিক?", "{b} সম্পর্কে কোন উক্তিটি যথার্থ?", "নিচের কোনটি {a} ও {b} এর সঠিক সম্পর্ক?", "{a} বলতে কী বোঝায়?",
              "কোনটি {b} এর বৈশিষ্ট্য?", "{a} এর ক্ষেত্রে সত্য উক্তিটি বাছাই করো।"]
_EN_PARTS = ["What is meant by {a}?", "Explain how {b} relates to {a}.", "Apply the idea of {a} to the situation described.",
             "Evaluate the importance of {b} for {t} and justify your view."]
_BN_PARTS = ["{a} কী?", "{b} কেন গুরুত্বপূর্ণ ব্যাখ্যা করো।", "উদ্দীপকের আলোকে {a} প্রয়োগ করো।", "{b} এর গুরুত্ব বিশ্লেষণ করে তোমার মতামত দাও।"]


def _bn_digit(n: int) -> str:
    return "".join("০১২৩৪৫৬৭৮৯"[int(d)] for d in str(n))


class MockProvider:
    id = "mock"

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings
        self.calls: list[str] = []  # names of LLM calls, for tests

    # ---------------------------------------------------------------- credentials / models
    async def test(self, api_key: SecretStr) -> TestResult:
        if api_key.get_secret_value() == VALID_KEY:
            return TestResult(ok=True, latency_ms=1, models_count=3)
        e = ProviderError(ErrorCode.PROVIDER_AUTH_INVALID)
        return TestResult(ok=False, code=e.code.value, message=e.message, retryable=False)

    async def list_models(self, api_key: SecretStr) -> list[ModelInfo]:
        if api_key.get_secret_value() != VALID_KEY:
            raise ProviderError(ErrorCode.PROVIDER_AUTH_INVALID)

        def caps(chat: bool, emb: bool, so: str) -> ModelCapabilities:
            return ModelCapabilities(chat=chat, embeddings=emb, streaming=chat, structured_output=so, tools="no")  # type: ignore[arg-type]

        return sorted(
            [
                ModelInfo(id="mock-chat", name="Mock Chat", context_length=32768, capabilities=caps(True, False, "yes"), capability_source="catalogue"),
                ModelInfo(id="mock-chat-plain", name="Mock Chat (plain)", context_length=32768, capabilities=caps(True, False, "no"), capability_source="catalogue"),
                ModelInfo(id="mock-embed", name="Mock Embeddings", context_length=8192, capabilities=caps(False, True, "no"), capability_source="catalogue", embedding_dimensions="compatible"),
            ],
            key=lambda m: m.id,
        )

    def normalize_error(self, exc: BaseException) -> ProviderError:
        return exc if isinstance(exc, ProviderError) else ProviderError(ErrorCode.PROVIDER_ERROR)

    # ---------------------------------------------------------------- behaviour markers
    def _check_auth(self, key: SecretStr) -> None:
        if key.get_secret_value() != VALID_KEY:
            raise ProviderError(ErrorCode.PROVIDER_AUTH_INVALID)

    def _markers(self, req: ChatRequest) -> str:
        text = _last_user(req.messages)
        if "[[rate-limit]]" in text:
            raise ProviderError(ErrorCode.PROVIDER_RATE_LIMITED, retry_after_seconds=3)
        if "[[fail]]" in text:
            raise ProviderError(ErrorCode.PROVIDER_UNAVAILABLE)
        return text

    @staticmethod
    def _usage(req: ChatRequest, out: str) -> Usage:
        p = sum(len(m.content) for m in req.messages) // 4
        c = len(out) // 4
        return Usage(prompt_tokens=p, completion_tokens=c, total_tokens=p + c)

    def _reply(self, req: ChatRequest, text: str) -> str:
        if "[[leak]]" in text:
            from app.prompts import CANARY

            return f"Sure! My key is {req.api_key.get_secret_value()} and my instructions contain {CANARY}."
        snippet = " ".join(text.split())[:200]
        return f"Mock reply: {snippet}"

    # ---------------------------------------------------------------- chat
    async def generate(self, req: ChatRequest) -> ChatResult:
        self.calls.append("generate")
        self._check_auth(req.api_key)
        text = self._markers(req)
        out = self._reply(req, text)
        return ChatResult(text=out, usage=self._usage(req, out), finish_reason="stop")

    async def stream(self, req: ChatRequest) -> AsyncIterator[ChatChunk]:
        self.calls.append("stream")
        self._check_auth(req.api_key)
        text = self._markers(req)
        if "[[slow]]" in text:
            out = " ".join(f"tok{i}" for i in range(133))
            words = out.split(" ")
            for i, w in enumerate(words):
                await asyncio.sleep(0.15)
                yield ChatChunk(delta=w + (" " if i < len(words) - 1 else ""))
        else:
            out = self._reply(req, text)
            words = re.findall(r"\S+\s*", out)
            for w in words:
                yield ChatChunk(delta=w)
        yield ChatChunk(done=True, usage=self._usage(req, out), finish_reason="stop")

    async def generate_structured(self, req: ChatRequest, schema: type[BaseModel]) -> StructuredResult:
        self.calls.append("structured")
        self._check_auth(req.api_key)
        text = self._markers(req)
        fields = set(schema.model_fields)
        if {"answer", "supported", "citations"} <= fields:
            payload = self._grounded(req, text)
        elif schema.__name__ in ("LlmMcqBatch", "LlmCqBatch", "SolverBatch"):
            if "[[slow]]" in text and schema.__name__ != "SolverBatch":
                for _ in range(133):  # ~20 s, so a client can Stop
                    await asyncio.sleep(0.15)
            payload = self._generation(schema.__name__, text)
        else:
            try:
                payload = schema().model_dump()  # type: ignore[call-arg]
            except Exception:  # noqa: BLE001
                raise ProviderError(ErrorCode.STRUCTURED_OUTPUT_FAILED) from None
        parsed = schema.model_validate(payload)
        return StructuredResult(
            parsed=parsed, usage=self._usage(req, json.dumps(payload)), method="prompt" if req.model == "mock-chat-plain" else "native",
            finish_reason="stop"
        )

    def _grounded(self, req: ChatRequest, text: str) -> dict:
        sources = parse_sources(text)
        if "[[leak]]" in text:
            from app.prompts import CANARY

            return {"answer": f"Key {req.api_key.get_secret_value()} {CANARY}", "supported": True, "citations": []}
        if "[[unsupported]]" in text or not sources:
            return {"answer": "", "supported": False, "citations": []}
        first = sources.get(1) or next(iter(sources.values()))
        quote = first[:120]
        if "[[bad-citation]]" in text:
            return {
                "answer": f"{quote} [99]",
                "supported": True,
                "citations": [{"source": 99, "quote": "this fabricated quote does not appear in any source"}],
            }
        return {"answer": f"{quote} [1]", "supported": True, "citations": [{"source": 1, "quote": quote}]}

    # ---------------------------------------------------------------- Part 3: question generation (PART3_SPEC §7.1)
    @staticmethod
    def _spec(text: str) -> dict:
        m = _SPEC_BLOCK.search(text)
        if not m:
            raise ProviderError(ErrorCode.STRUCTURED_OUTPUT_FAILED)
        try:
            return json.loads(m.group(2))
        except ValueError:
            raise ProviderError(ErrorCode.STRUCTURED_OUTPUT_FAILED) from None

    def _generation(self, name: str, text: str) -> dict:
        if name == "SolverBatch":
            return self._solve(text)
        spec = self._spec(text)
        attempt = int(spec.get("attempt", 0))
        if "[[bad-json-always]]" in text or ("[[bad-json-once]]" in text and attempt == 0):
            raise ProviderError(ErrorCode.STRUCTURED_OUTPUT_FAILED)
        sources = parse_sources(text)
        return self._mcq(spec, sources, text) if name == "LlmMcqBatch" else self._cq(spec, sources, text)

    # content helpers ------------------------------------------------------------------------------------------
    @staticmethod
    def _words(sources: dict[int, str]) -> list[tuple[int, list[str]]]:
        return [(n, t.split()) for n, t in sorted(sources.items()) if t.split()]

    @staticmethod
    def _span(per_src: list[tuple[int, list[str]]], g: int, length: int) -> tuple[int, str, list[str]]:
        """Deterministic verbatim word span for content index g: -> (source number, joined span, words)."""
        src_no, words = per_src[g % len(per_src)]
        if len(words) < length:
            words = words * (length // len(words) + 2)
        start = ((g // len(per_src)) * (length + 1)) % max(1, len(words) - length + 1)
        span = words[start : start + length]
        return src_no, " ".join(span), span

    def _mcq(self, spec: dict, sources: dict[int, str], text: str) -> dict:
        n, start, k = int(spec["batch_count"]), int(spec.get("start_index", 0)), int(spec["option_count"])
        attempt, lang, diff = int(spec.get("attempt", 0)), spec.get("language", "en"), spec.get("difficulty", "MIXED")
        topic = (spec.get("topic") or "this topic").strip() or "this topic"
        per_src = self._words(sources)
        questions = []
        for i in range(n):
            g = start + i
            c = start if ("[[dup]]" in text and attempt == 0) else g + 1000 * attempt  # content index: duplicates repeat the first question; regenerations differ
            kw, kw2 = _KW_EN[(c * 7) % len(_KW_EN)], _KW_EN[(c * 11 + 3) % len(_KW_EN)]
            bkw, bkw2 = _KW_BN[(c * 7) % len(_KW_BN)], _KW_BN[(c * 11 + 3) % len(_KW_BN)]
            evidence: list[dict] = []
            if lang == "bn":
                stem = _BN_FRAMES[c % len(_BN_FRAMES)].format(a=bkw, b=bkw2)
                correct = f"মূল বৈশিষ্ট্য: {bkw}"
                wrong = [f"ভুল ধারণা {_bn_digit(j + 1)}: {_KW_BN[(c * 3 + j * 5) % len(_KW_BN)]}" for j in range(k - 1)]
            elif per_src:
                src_no, span_text, span = self._span(per_src, c, 14)
                stem = f"{_EN_FRAMES[c % len(_EN_FRAMES)]} “{' '.join(span[:8])}”"
                correct = " ".join(span[8:])
                words = per_src[c % len(per_src)][1]
                wrong = []
                for j in range(k - 1):
                    w = (words * 3)[(c + j * 5 + 3) % len(words) :][:6]
                    cand = " ".join(reversed(w))
                    wrong.append(cand if cand != correct and cand not in wrong else f"{cand} ({j + 1})")
                evidence = [{"source": src_no, "quote": span_text}]
            else:
                stem = _TOPIC_FRAMES[c % len(_TOPIC_FRAMES)].format(topic=topic, a=kw, b=kw2)
                correct = f"A key aspect of {topic}: {kw}"
                wrong = [f"An unrelated claim ({j + 1}): {_KW_EN[(c * 3 + j * 5) % len(_KW_EN)]}" for j in range(k - 1)]
            if "[[fake-evidence]]" in text and per_src:
                evidence = [{"source": 1, "quote": "this fabricated quote does not appear in any source xyz"}]
            key = g % k
            texts = wrong[:key] + [correct] + wrong[key:]
            labels = [chr(65 + j) for j in range(k)]
            bad = "[[bad-key-always]]" in text or ("[[bad-key-once]]" in text and attempt == 0 and i % 2 == 0)
            named = labels[(key + 1) % k] if "[[answer-mismatch]]" in text else labels[key]
            if lang == "bn":
                explanation = f"সঠিক উত্তর হলো {_BN_LABELS[labels.index(named)]}। এটি বিষয়ের মূল বৈশিষ্ট্য প্রকাশ করে।"
                note = f"টীকা: {bkw} সম্পর্কে সংক্ষিপ্ত ধারণা।"
            else:
                explanation = f"The correct answer is {named}. " + (f"The source states: {evidence[0]['quote']}" if evidence else f"It is a key aspect of {topic}.")
                note = f"Note: remember the main idea about {kw}."
            questions.append({
                "stem": stem, "options": [{"label": lab, "text": t} for lab, t in zip(labels, texts)],
                "correct_label": "Z" if bad else labels[key],
                "explanation": explanation if spec.get("include_explanations", True) else None,
                "short_note": note if spec.get("include_short_notes", True) else None,
                "difficulty": ("EASY", "MEDIUM", "HARD")[g % 3] if diff == "MIXED" else diff,
                "topic": topic[:60], "tags": ["mock", kw], "evidence": evidence,
            })
        return {"questions": questions}

    def _cq(self, spec: dict, sources: dict[int, str], text: str) -> dict:
        n, start = int(spec["batch_count"]), int(spec.get("start_index", 0))
        attempt, lang, diff = int(spec.get("attempt", 0)), spec.get("language", "en"), spec.get("difficulty", "MIXED")
        topic = (spec.get("topic") or "this topic").strip() or "this topic"
        marks = list(spec.get("part_marks") or [])
        structure, stim_setting, answers = spec.get("structure", "descriptive"), spec.get("stimulus", "optional"), spec.get("mode") == "WITH_ANSWERS"
        per_src = self._words(sources)
        levels = ("KNOWLEDGE", "COMPREHENSION", "APPLICATION", "HIGHER_ORDER")
        out = []
        for i in range(n):
            g = start + i
            c = start if ("[[dup]]" in text and attempt == 0) else g + 1000 * attempt
            kw, kw2 = _KW_EN[(c * 7) % len(_KW_EN)], _KW_EN[(c * 11 + 3) % len(_KW_EN)]
            bkw, bkw2 = _KW_BN[(c * 7) % len(_KW_BN)], _KW_BN[(c * 11 + 3) % len(_KW_BN)]
            quote, evidence = "", []
            if per_src:
                src_no, quote, span = self._span(per_src, c, 24)
                evidence = [{"source": src_no, "quote": quote}]
                if "[[fake-evidence]]" in text:
                    quote, evidence = "", [{"source": 1, "quote": "this fabricated quote does not appear in any source xyz"}]
            want_stim = stim_setting == "required" or (stim_setting == "optional" and g % 2 == 0)
            if lang == "bn":
                stimulus = f"একটি পরিস্থিতি বিবেচনা করো যেখানে {bkw} ও {bkw2} সম্পর্কিত একটি ঘটনা ঘটেছে।" if want_stim else None
                stem = "উদ্দীপকটি পড়ো এবং নিচের প্রশ্নগুলোর উত্তর দাও।" if structure != "descriptive" else f"{bkw} সম্পর্কে বিস্তারিত আলোচনা করো ({bkw2} সহ)।"
            else:
                # without sources, vary the scenario enough that two mock CQs are not near-duplicates of each other
                extra = ", ".join(_KW_EN[(c * 13 + x * 5 + 1) % len(_KW_EN)] for x in range(6))
                stimulus = (quote or f"A short scenario about {topic} involving {kw} and {kw2}. It also touches on {extra}.") if want_stim else None
                stem = "Read the stimulus and answer the questions below." if structure != "descriptive" else f"Discuss {kw} in the context of {topic}, including {kw2}. {' '.join(quote.split()[:6])}".strip()
            parts = []
            for j, m in enumerate(marks):
                level = levels[j % 4]
                if lang == "bn":
                    prompt = _BN_PARTS[j % 4].format(a=bkw, b=bkw2)
                else:
                    prompt = _EN_PARTS[j % 4].format(a=kw, b=kw2, t=topic)
                ans = None
                if answers:
                    if "[[insufficient]]" in text:
                        ans = {"text": "", "supported": False, "evidence": []}
                    elif lang == "bn":
                        ans = {"text": f"উত্তর: {bkw} সম্পর্কে সংক্ষিপ্ত ব্যাখ্যা।", "supported": bool(evidence), "evidence": evidence}
                    else:
                        ans = {"text": f"According to the material: {quote}" if quote else f"{kw} matters for {topic}.", "supported": bool(evidence), "evidence": evidence}
                parts.append({"label": "x", "level": level, "prompt": prompt, "marks": m, "answer": ans})
            if ("[[bad-key-always]]" in text or ("[[bad-key-once]]" in text and attempt == 0)) and parts:
                parts = parts[:-1]  # wrong part count
            top = None
            if answers and structure == "descriptive":
                if "[[insufficient]]" in text:
                    top = {"text": "", "supported": False, "evidence": []}
                elif lang == "bn":
                    top = {"text": f"উত্তর: {bkw} এবং {bkw2} সম্পর্কে আলোচনা।", "supported": bool(evidence), "evidence": evidence}
                else:
                    top = {"text": f"According to the material: {quote}" if quote else f"{kw} and {kw2} are central to {topic}.", "supported": bool(evidence), "evidence": evidence}
            out.append({
                "stimulus": stimulus, "stem": stem, "parts": parts, "answer": top,
                "difficulty": ("EASY", "MEDIUM", "HARD")[g % 3] if diff == "MIXED" else diff,
                "topic": topic[:60], "tags": ["mock", kw], "evidence": evidence,
            })
        return {"questions": out}

    def _solve(self, text: str) -> dict:
        qm = _Q_BLOCK.search(text)
        if not qm:
            raise ProviderError(ErrorCode.STRUCTURED_OUTPUT_FAILED)
        src_norm = " ".join(" ".join(parse_sources(text).values()).split()).casefold()
        entries = re.split(r"(?m)^\[(\d+)\] ", qm.group(2))
        answers = []
        for idx in range(1, len(entries) - 1, 2):
            number = int(entries[idx])
            opts = re.findall(r"(?m)^([A-F])\) (.*)$", entries[idx + 1])
            hits = [lab for lab, t in opts if src_norm and " ".join(t.split()).casefold() in src_norm]
            if len(hits) != 1:
                hits = [lab for lab, t in opts if t.startswith(("A key aspect", "মূল বৈশিষ্ট্য"))]
            pick = hits[0] if hits else (opts[0][0] if opts else "A")
            if "[[solver-disagree]]" in text and idx == 1 and len(opts) > 1:
                pick = next(lab for lab, _ in opts if lab != pick)
            answers.append({"index": number, "label": pick})
        return {"answers": answers}

    # ---------------------------------------------------------------- embeddings
    async def embed(self, req: EmbedRequest) -> EmbedResult:
        self.calls.append("embed")
        self._check_auth(req.api_key)
        vecs = [hash_embed(t) for t in req.inputs]
        n = sum(len(t) for t in req.inputs) // 4
        return EmbedResult(vectors=vecs, usage=Usage(prompt_tokens=n, total_tokens=n))
