"""Static provider catalogue: metadata + capability *rules* (patterns). Model lists come from the provider API.

VERIFIED-AT: 2026-10-22, against the official docs listed per provider below (fetched with WebFetch on that date).
Anything not covered by those pages is marked UNVERIFIED and is surfaced to callers as
`capability_source:"unverified"` / `"unknown"` rather than as a fact.

OpenAI
  * Base URL https://api.openai.com/v1 ; `GET /models` -> {object:"list", data:[{id, object, created, owned_by, shutdown_date?}]}
    (no context length, no capabilities in the payload) -- developers.openai.com/api/reference/resources/models
  * Embeddings: `POST /embeddings` {model, input, dimensions?, encoding_format?}. `dimensions` only for text-embedding-3+ models.
    text-embedding-3-small default 1536, text-embedding-3-large default 3072 (both shortenable via `dimensions`).
    Per input <= 8192 tokens, request <= 300k tokens total. -- developers.openai.com/api/docs/guides/embeddings
  * Structured outputs (`response_format: json_schema`): gpt-4o-mini, gpt-4o-2024-08-06 and later. Which *future* ids
    qualify is a pattern inference (see OPENAI_STRUCTURED_YES) -- UNVERIFIED beyond the documented snapshots.
  * Streaming usage via `stream_options={"include_usage": true}` is the long-standing documented behaviour, but the
    pages fetched on the verified date did not restate it: treated as UNVERIFIED-but-standard; the adapter degrades
    (usage=None) if no usage chunk arrives.
OpenRouter
  * Base URL https://openrouter.ai/api/v1 ; Bearer auth. `HTTP-Referer` / `X-OpenRouter-Title` (alias `X-Title`) are OPTIONAL
    (app attribution only). -- openrouter.ai/docs/api-reference/overview
  * `GET /models` is NOT a credential check (models list is public); the credential test uses the authenticated
    `GET /key` (401 on a bad key). -- openrouter.ai/docs/api/api-reference/api-keys/get-current-key
  * `GET /models` -> {data:[{id, name, context_length|null, architecture:{input_modalities, output_modalities, ...},
    supported_parameters:[...incl. "structured_outputs", "response_format", "tools", ...], top_provider, pricing,...}], ...}
  * Embeddings ARE offered: `POST /embeddings` {model, input, dimensions?, encoding_format?, ...} and `GET /embeddings/models`
    (same Model shape, output modality "embeddings"). Streaming is not applicable to embeddings.
  * Streaming: usage is returned exactly once in the final chunk before [DONE] (no `stream_options` needed).
  * Errors: {error:{code:int,message,metadata?}}; 401 bad key, 402 insufficient credits, 403 forbidden/moderation, 408 timeout,
    429 rate limited, 502 model down, 503 no provider; `Retry-After` may be sent on 429/503.
Groq
  * Base URL https://api.groq.com/openai/v1 ; `GET /models` -> {object:"list", data:[{id, object, created, owned_by, active,
    context_window, public_apps}]} -- console.groq.com/docs/api-reference
  * Embeddings: NOT offered. Neither the API reference nor the models page lists an embeddings endpoint or an embedding model
    (checked 2026-10-22). Adapter raises CAPABILITY_UNSUPPORTED without any network call.
  * Structured outputs (`json_schema`): documented for openai/gpt-oss-20b and openai/gpt-oss-120b (plus other ids named on
    the page, which are not pattern-matched here). `json_object` is listed for all models. -- console.groq.com/docs/structured-outputs
  * OpenAI-compat: `logprobs`, `logit_bias`, `top_logprobs`, `messages[].name` -> 400; `n` must be 1. -- console.groq.com/docs/openai
  * `stream_options.include_usage`: only third-party sources (LangChain Groq integration, Groq SDK docs) -- UNVERIFIED against Groq's own page.
Gemini (Google AI Studio, through its OpenAI-compatibility layer; docs fetched 2026-10-23)
  * Base URL https://generativelanguage.googleapis.com/v1beta/openai ; `Authorization: Bearer <key>` -- ai.google.dev/gemini-api/docs/openai
  * Chat model ids are bare names (`gemini-...`); the docs do not mention a `models/` prefix.
  * Embeddings: `POST /embeddings`; `gemini-embedding-001` (text) and `gemini-embedding-2` (multimodal) -- ai.google.dev/gemini-api/docs/embeddings.
    Native size 3072; the NATIVE API shortens with `output_dimensionality` (128-3072, recommended 768/1536/3072). Whether the OpenAI-compatible
    endpoint honours the OpenAI `dimensions` parameter is NOT documented (UNVERIFIED): this adapter therefore sends `dimensions` only when the
    user asked for a size, and the connection validation measures the real vector length, so an ignored parameter is reported, never assumed.
  * Structured outputs: the docs only show `beta.chat.completions.parse` examples, not strict `json_schema` rules (UNVERIFIED) -> capability
    "unknown", so generation uses the prompt-JSON path (always works, with the bounded repair attempt).
  * `GET /models` response shape is not described (UNVERIFIED). The parser accepts the OpenAI list shape and strips a leading `models/` from ids.
  * `max_tokens` vs `max_completion_tokens` and error body shape are not documented (UNVERIFIED): `max_tokens` is sent; an error body that is a
    one-element JSON list (a known Google quirk) is unwrapped before classification; HTTP 400 "API key not valid" is mapped to an auth error.
  * `stream_options.include_usage` is used in the docs' own example (implied support); usage degrades to null if no usage chunk arrives.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.providers.base import ModelCapabilities, ModelInfo, Tri

VERIFIED_AT = "2026-10-22"
EMBEDDING_DIMENSIONS = 1536


@dataclass(frozen=True)
class ProviderMeta:
    id: str
    name: str
    base_url: str
    docs_url: str
    key_hint: str
    chat: bool
    embeddings: bool
    structured_output: str
    embedding_dimensions_note: str
    verified_at: str = VERIFIED_AT


PROVIDERS: dict[str, ProviderMeta] = {
    "openai": ProviderMeta(
        id="openai",
        name="OpenAI",
        base_url="https://api.openai.com/v1",
        docs_url="https://platform.openai.com/docs/api-reference",
        key_hint="sk-...",
        chat=True,
        embeddings=True,
        structured_output="model-dependent",
        embedding_dimensions_note=(
            "The vector length is yours to choose: leave it automatic to use the model's native size, or enter a smaller size for models "
            "that accept the `dimensions` parameter (for example text-embedding-3-small/large). The size is verified with a live request."
        ),
    ),
    "openrouter": ProviderMeta(
        id="openrouter",
        name="OpenRouter",
        base_url="https://openrouter.ai/api/v1",
        docs_url="https://openrouter.ai/docs",
        key_hint="sk-or-v1-...",
        chat=True,
        embeddings=True,
        structured_output="model-dependent",
        embedding_dimensions_note=(
            "Embedding models vary in output size. Leave the dimension automatic to use the model's native size, or enter a smaller size "
            "if the model accepts the `dimensions` parameter. Support is verified with a live request, never assumed."
        ),
    ),
    "groq": ProviderMeta(
        id="groq",
        name="Groq",
        base_url="https://api.groq.com/openai/v1",
        docs_url="https://console.groq.com/docs",
        key_hint="gsk_...",
        chat=True,
        embeddings=False,
        structured_output="model-dependent",
        embedding_dimensions_note="Groq does not offer an embeddings API; pick OpenAI or OpenRouter for document embeddings.",
    ),
    "gemini": ProviderMeta(
        id="gemini",
        name="Gemini",
        base_url="https://generativelanguage.googleapis.com/v1beta/openai",
        docs_url="https://ai.google.dev/gemini-api/docs/openai",
        key_hint="AIza...",
        chat=True,
        embeddings=True,
        structured_output="model-dependent",
        embedding_dimensions_note=(
            "Gemini embedding models answer with 3072 numbers by default. Leave the dimension automatic to use that size, or enter a smaller size "
            "(Google recommends 768, 1536 or 3072); it is checked with a live request, because the OpenAI-compatible endpoint's support for a "
            "smaller size is not documented."
        ),
    ),
}

MOCK_META = ProviderMeta(
    id="mock",
    name="Mock (testing only)",
    base_url="mock://local",
    docs_url="https://example.invalid/mock",
    key_hint="mock-...",
    chat=True,
    embeddings=True,
    structured_output="model-dependent",
    embedding_dimensions_note="Deterministic hashing embeddings (test/demo only); mock-embed is 1536-d, mock-embed-<N> is N-d.",
)

# --------------------------------------------------------------------------------------------------
# Capability rules (patterns). These are RULES, not a list of verified model ids.
# --------------------------------------------------------------------------------------------------

# Documented: gpt-4o-mini, gpt-4o-2024-08-06 and later. Newer families are an inference ("and later").
OPENAI_STRUCTURED_YES = re.compile(r"^(gpt-4o(?!-2024-05-13)|gpt-4\.1|gpt-5|gpt-6|o1(?!-preview|-mini)|o3|o4)")
OPENAI_STRUCTURED_NO = re.compile(r"^(gpt-3\.5|gpt-4(?!o|\.1)|chatgpt-4o-latest$)|-2024-05-13$")
OPENAI_NON_CHAT = re.compile(
    r"(audio|realtime|transcribe|tts|image|dall-e|whisper|moderation|search-preview|computer-use|sora|davinci|babbage|embedding|instruct$|-instruct)",
    re.I,
)
OPENAI_CHAT_PREFIX = re.compile(r"^(gpt-|o\d|chatgpt-)")
OPENAI_EMBEDDING = re.compile(r"^text-embedding-")
# Models that reject sampling params (conservative: reasoning families).  UNVERIFIED rule, applied by the adapter.
OPENAI_NO_SAMPLING_PARAMS = re.compile(r"^(o\d|gpt-5)")

GROQ_NON_CHAT = re.compile(r"(whisper|orpheus|tts|playai|prompt-guard|guard|distil-whisper)", re.I)
GROQ_STRUCTURED_YES = re.compile(r"^openai/gpt-oss-(20b|120b)$")

# Gemini's model list mixes text, embedding, image, video, speech and live-audio models; only text generators belong in the chat list.
GEMINI_EMBEDDING = re.compile(r"embedding", re.I)
GEMINI_NON_CHAT = re.compile(r"(embedding|imagen|veo|tts|image|audio|live|aqa|robotics|computer-use|deep-research|lyria)", re.I)
GEMINI_CHAT_PREFIX = re.compile(r"^(gemini|gemma)", re.I)


def openai_no_sampling(model_id: str) -> bool:
    return bool(OPENAI_NO_SAMPLING_PARAMS.match(model_id))


# --------------------------------------------------------------------------------------------------
# Model-list merge: provider payload + rules -> ModelInfo
# --------------------------------------------------------------------------------------------------

MAX_MODELS = 500


def _caps(*, chat: bool, embeddings: bool, structured: Tri, tools: Tri) -> ModelCapabilities:
    return ModelCapabilities(chat=chat, embeddings=embeddings, streaming=chat, structured_output=structured, tools=tools)


def parse_openai_models(payload: dict) -> list[ModelInfo]:
    out: list[ModelInfo] = []
    for m in payload.get("data") or []:
        mid = m.get("id") if isinstance(m, dict) else None
        if not isinstance(mid, str):
            continue
        if OPENAI_EMBEDDING.match(mid):
            out.append(
                ModelInfo(
                    id=mid,
                    name=mid,
                    context_length=8192,  # per-input limit documented for all embedding models
                    capabilities=_caps(chat=False, embeddings=True, structured="no", tools="no"),
                    capability_source="catalogue",
                )
            )
            continue
        if not OPENAI_CHAT_PREFIX.match(mid) or OPENAI_NON_CHAT.search(mid):
            continue
        if OPENAI_STRUCTURED_YES.match(mid) and not OPENAI_STRUCTURED_NO.search(mid):
            so, src = "yes", "catalogue"
        elif OPENAI_STRUCTURED_NO.search(mid):
            so, src = "no", "catalogue"
        else:
            so, src = "unknown", "unverified"
        out.append(
            ModelInfo(
                id=mid,
                name=mid,
                context_length=None,  # OpenAI's /models does not report it
                capabilities=_caps(chat=True, embeddings=False, structured=so, tools="unknown"),  # type: ignore[arg-type]
                capability_source=src,  # type: ignore[arg-type]
            )
        )
    return out


def parse_groq_models(payload: dict) -> list[ModelInfo]:
    out: list[ModelInfo] = []
    for m in payload.get("data") or []:
        mid = m.get("id") if isinstance(m, dict) else None
        if not isinstance(mid, str) or GROQ_NON_CHAT.search(mid):
            continue
        if m.get("active") is False:
            continue
        ctx = m.get("context_window")
        yes = bool(GROQ_STRUCTURED_YES.match(mid))
        out.append(
            ModelInfo(
                id=mid,
                name=mid,
                context_length=ctx if isinstance(ctx, int) else None,
                capabilities=_caps(chat=True, embeddings=False, structured="yes" if yes else "unknown", tools="unknown"),
                capability_source="catalogue" if yes else "unverified",
            )
        )
    return out


def parse_gemini_models(payload: dict) -> list[ModelInfo]:
    """OpenAI-style list from Gemini's compatibility endpoint. Ids may arrive as `models/<id>`; the prefix is dropped."""
    out: list[ModelInfo] = []
    for m in payload.get("data") or []:
        raw = m.get("id") if isinstance(m, dict) else None
        if not isinstance(raw, str):
            continue
        mid = raw.removeprefix("models/")
        if not mid:
            continue
        if GEMINI_EMBEDDING.search(mid):
            out.append(
                ModelInfo(
                    id=mid,
                    name=mid,
                    context_length=None,
                    capabilities=_caps(chat=False, embeddings=True, structured="no", tools="no"),
                    capability_source="catalogue",
                )
            )
            continue
        if not GEMINI_CHAT_PREFIX.match(mid) or GEMINI_NON_CHAT.search(mid):
            continue
        out.append(
            ModelInfo(
                id=mid,
                name=mid,
                context_length=None,  # not reported by the compatibility endpoint
                capabilities=_caps(chat=True, embeddings=False, structured="unknown", tools="unknown"),
                capability_source="unverified",
            )
        )
    return out


def parse_openrouter_models(payload: dict, *, embeddings_listing: bool = False) -> list[ModelInfo]:
    out: list[ModelInfo] = []
    for m in payload.get("data") or []:
        if not isinstance(m, dict) or not isinstance(m.get("id"), str):
            continue
        mid: str = m["id"]
        arch = m.get("architecture") if isinstance(m.get("architecture"), dict) else {}
        outputs = [str(x) for x in (arch.get("output_modalities") or [])]
        is_embed = embeddings_listing or "embeddings" in outputs
        ctx = m.get("context_length")
        ctx = ctx if isinstance(ctx, int) else None
        name = m.get("name") if isinstance(m.get("name"), str) else mid
        if is_embed:
            out.append(
                ModelInfo(
                    id=mid,
                    name=name,
                    context_length=ctx,
                    capabilities=_caps(chat=False, embeddings=True, structured="no", tools="no"),
                    capability_source="api",
                )
            )
            continue
        if outputs and "text" not in outputs:
            continue  # image/audio/video-only generators are not chat models
        params = m.get("supported_parameters")
        if isinstance(params, list):
            ps = {str(p) for p in params}
            if "structured_outputs" in ps:
                so = "yes"
            elif "response_format" in ps:
                so = "unknown"  # may be json_object only
            else:
                so = "no"
            tools = "yes" if "tools" in ps else "no"
            src = "api"
        else:
            so, tools, src = "unknown", "unknown", "unverified"
        out.append(
            ModelInfo(
                id=mid,
                name=name,
                context_length=ctx,
                capabilities=_caps(chat=True, embeddings=False, structured=so, tools=tools),  # type: ignore[arg-type]
                capability_source=src,  # type: ignore[arg-type]
            )
        )
    return out


def finalize(models: list[ModelInfo]) -> list[ModelInfo]:
    """De-duplicate by id, sort by id, cap at 500 (embedding models are kept preferentially so they are never cut)."""
    seen: dict[str, ModelInfo] = {}
    for m in models:
        seen.setdefault(m.id, m)
    items = sorted(seen.values(), key=lambda m: m.id)
    if len(items) <= MAX_MODELS:
        return items
    emb = [m for m in items if m.capabilities.embeddings]
    chat = [m for m in items if not m.capabilities.embeddings][: max(0, MAX_MODELS - len(emb))]
    return sorted(emb + chat, key=lambda m: m.id)[:MAX_MODELS]
