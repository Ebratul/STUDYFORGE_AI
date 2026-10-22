"""Shared implementation for OpenAI-compatible providers (OpenAI, OpenRouter, Groq) on LangChain + httpx."""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import AsyncIterator
from typing import Any, ClassVar

import httpx
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from pydantic import BaseModel, Field, SecretStr, ValidationError

from app.config import Settings
from app.errors import ErrorCode, ProviderError
from app.providers import catalogue
from app.providers.base import (
    ChatChunk,
    ChatMessage,
    ChatRequest,
    ChatResult,
    EmbedRequest,
    EmbedResult,
    ModelInfo,
    StructuredResult,
    TestResult,
    Tri,
    Usage,
)
from app.providers.errors import classify_http, normalize_exception
from app.providers.retry import with_retries
from app.redact import scrub

EMBED_BATCH = 64
LIST_TIMEOUT = 15.0

# capability knowledge learned from model listings (model properties only; never keys)
_STRUCT_CACHE: dict[tuple[str, str], Tri] = {}


class CompatChatOpenAI(ChatOpenAI):
    """ChatOpenAI whose token-limit parameter name can be chosen per provider."""

    token_param: str = Field(default="max_completion_tokens", exclude=True)

    def _get_request_payload(self, input_: Any, *, stop: list[str] | None = None, **kwargs: Any) -> dict:
        payload = super()._get_request_payload(input_, stop=stop, **kwargs)
        if self.token_param == "max_tokens" and "max_completion_tokens" in payload:
            payload["max_tokens"] = payload.pop("max_completion_tokens")
        return payload


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for p in content:
            if isinstance(p, str):
                parts.append(p)
            elif isinstance(p, dict) and p.get("type") in (None, "text") and isinstance(p.get("text"), str):
                parts.append(p["text"])
        return "".join(parts)
    return ""


def _usage(msg: Any) -> Usage:
    um = getattr(msg, "usage_metadata", None) or {}
    pt, ct, tt = um.get("input_tokens"), um.get("output_tokens"), um.get("total_tokens")
    return Usage(
        prompt_tokens=pt if isinstance(pt, int) else None,
        completion_tokens=ct if isinstance(ct, int) else None,
        total_tokens=tt if isinstance(tt, int) else None,
    )


def _add_usage(a: Usage, b: Usage) -> Usage:
    def s(x: int | None, y: int | None) -> int | None:
        return None if x is None and y is None else (x or 0) + (y or 0)

    return Usage(
        prompt_tokens=s(a.prompt_tokens, b.prompt_tokens),
        completion_tokens=s(a.completion_tokens, b.completion_tokens),
        total_tokens=s(a.total_tokens, b.total_tokens),
    )


def _to_lc(messages: list[ChatMessage]) -> list[BaseMessage]:
    out: list[BaseMessage] = []
    for m in messages:
        if m.role == "system":
            out.append(SystemMessage(content=m.content))
        elif m.role == "assistant":
            out.append(AIMessage(content=m.content))
        else:
            out.append(HumanMessage(content=m.content))
    return out


def strict_json_schema(schema: type[BaseModel]) -> dict:
    """Pydantic schema -> OpenAI strict-mode compatible JSON schema (inlined $refs, additionalProperties:false, all required)."""
    raw = schema.model_json_schema()
    defs = raw.pop("$defs", {})

    def walk(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node:
                return walk(defs[node["$ref"].split("/")[-1]])
            node = {k: walk(v) for k, v in node.items() if k not in ("title", "default")}
            if node.get("type") == "object" and "properties" in node:
                node["additionalProperties"] = False
                node["required"] = list(node["properties"].keys())
            return node
        if isinstance(node, list):
            return [walk(v) for v in node]
        return node

    return walk(raw)


_FENCE = re.compile(r"^```[a-zA-Z0-9_-]*\s*|\s*```$")


def extract_json(text: str) -> Any:
    t = _FENCE.sub("", text.strip()).strip()
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        start, end = t.find("{"), t.rfind("}")
        if start == -1 or end <= start:
            raise
        return json.loads(t[start : end + 1])


def _validation_summary(exc: Exception) -> str:
    if isinstance(exc, ValidationError):
        return "; ".join(f"{'.'.join(str(x) for x in e['loc'])}: {e['type']}" for e in exc.errors()[:8])
    return "output was not valid JSON"


class OpenAICompatProvider:
    id: ClassVar[str]
    base_url: ClassVar[str]
    supports_embeddings: ClassVar[bool] = True
    stream_usage: ClassVar[bool | None] = True
    token_param: ClassVar[str] = "max_completion_tokens"
    extra_headers: ClassVar[dict[str, str]] = {}

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    # ------------------------------------------------------------------ hooks
    def rule_structured(self, model: str) -> Tri:
        return "unknown"

    def drop_sampling(self, model: str) -> bool:
        return False

    def embedding_dimensions_param(self, model: str) -> int | None:
        return self.settings.embedding_dimensions if catalogue.wants_dimensions_param(self.id, model) else None

    def parse_models(self, payload: dict) -> list[ModelInfo]:
        raise NotImplementedError

    async def _check_credentials(self, client: httpx.AsyncClient, headers: dict[str, str]) -> None:
        """Hook for providers whose /models is public (OpenRouter)."""

    async def _fetch_models(self, client: httpx.AsyncClient, headers: dict[str, str]) -> list[ModelInfo]:
        data = await self._get_json(client, "/models", headers, where="models")
        return self.parse_models(data)

    # ------------------------------------------------------------------ errors
    def normalize_error(self, exc: BaseException, *, where: str = "chat") -> ProviderError:
        return normalize_exception(exc, where=where)

    # ------------------------------------------------------------------ httpx helpers
    def _auth_headers(self, api_key: SecretStr) -> dict[str, str]:
        return {"Authorization": f"Bearer {api_key.get_secret_value()}", "Accept": "application/json", **self.extra_headers}

    def _client(self) -> httpx.AsyncClient:
        # no redirects: the Authorization header must never follow a redirect to another host
        return httpx.AsyncClient(
            base_url=self.base_url, timeout=httpx.Timeout(LIST_TIMEOUT, connect=10.0), follow_redirects=False
        )

    async def _get_json(self, client: httpx.AsyncClient, path: str, headers: dict[str, str], *, where: str) -> dict:
        resp = await client.get(path, headers=headers)
        if resp.status_code != 200:
            raise classify_http(resp.status_code, _safe_json(resp), resp.headers, where=where)
        try:
            data = resp.json()
        except ValueError:
            raise ProviderError(ErrorCode.PROVIDER_ERROR, "The AI provider returned an unexpected response.", retryable=False) from None
        if not isinstance(data, dict):
            raise ProviderError(ErrorCode.PROVIDER_ERROR, "The AI provider returned an unexpected response.", retryable=False)
        return data

    # ------------------------------------------------------------------ test / list
    async def test(self, api_key: SecretStr) -> TestResult:
        started = time.perf_counter()
        headers = self._auth_headers(api_key)
        try:
            async with asyncio.timeout(LIST_TIMEOUT):
                async with self._client() as client:
                    await self._check_credentials(client, headers)
                    count = await self._count_models(client, headers)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            err = self.normalize_error(exc, where="models")
            return TestResult(ok=False, code=err.code.value, message=err.message, retryable=err.retryable)
        return TestResult(ok=True, latency_ms=int((time.perf_counter() - started) * 1000), models_count=count)

    async def _count_models(self, client: httpx.AsyncClient, headers: dict[str, str]) -> int:
        data = await self._get_json(client, "/models", headers, where="models")
        items = data.get("data")
        if not isinstance(items, list):
            raise ProviderError(ErrorCode.PROVIDER_ERROR, "The AI provider returned an unexpected response.", retryable=False)
        return len(items)

    async def list_models(self, api_key: SecretStr) -> list[ModelInfo]:
        headers = self._auth_headers(api_key)
        try:
            async with asyncio.timeout(LIST_TIMEOUT * 2):
                async with self._client() as client:
                    await self._check_credentials(client, headers)
                    models = await self._fetch_models(client, headers)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise self.normalize_error(exc, where="models") from None
        models = catalogue.finalize(models)
        for m in models:
            _STRUCT_CACHE[(self.id, m.id)] = m.capabilities.structured_output
        return models

    # ------------------------------------------------------------------ chat plumbing
    def structured_support(self, model: str) -> Tri:
        return _STRUCT_CACHE.get((self.id, model)) or self.rule_structured(model)

    def _llm(self, req: ChatRequest, *, stream: bool, response_format: dict | None = None) -> Any:
        p = req.params
        s = self.settings
        kwargs: dict[str, Any] = {}
        if not self.drop_sampling(req.model):
            if p.temperature is not None:
                kwargs["temperature"] = p.temperature
            if p.top_p is not None:
                kwargs["top_p"] = p.top_p
        if p.max_output_tokens is not None:
            kwargs["max_tokens"] = p.max_output_tokens
        timeout = httpx.Timeout(
            connect=10.0,
            read=s.stream_idle_timeout_seconds if stream else s.provider_timeout_seconds,
            write=30.0,
            pool=10.0,
        )
        llm = CompatChatOpenAI(
            model=req.model,
            api_key=req.api_key,
            base_url=self.base_url,
            max_retries=0,
            timeout=timeout,
            default_headers=dict(self.extra_headers) or None,
            streaming=stream,
            stream_usage=bool(self.stream_usage) if stream else None,
            use_responses_api=False,
            token_param=self.token_param,
            **kwargs,
        )
        if response_format is not None:
            return llm.bind(response_format=response_format)
        return llm

    async def _invoke(self, req: ChatRequest, *, response_format: dict | None = None) -> ChatResult:
        async def once() -> ChatResult:
            llm = self._llm(req, stream=False, response_format=response_format)
            async with asyncio.timeout(self.settings.provider_timeout_seconds):
                msg = await llm.ainvoke(_to_lc(req.messages))
            fr = (getattr(msg, "response_metadata", None) or {}).get("finish_reason")
            return ChatResult(text=_text(msg.content), usage=_usage(msg), finish_reason=fr if isinstance(fr, str) else None)

        return await with_retries(once, self.normalize_error)

    async def generate(self, req: ChatRequest) -> ChatResult:
        return await self._invoke(req)

    async def stream(self, req: ChatRequest) -> AsyncIterator[ChatChunk]:
        idle = self.settings.stream_idle_timeout_seconds
        started_output = False
        attempt = 0
        from app.providers.retry import MAX_RETRIES, compute_delay
        from app.providers.errors import RETRYABLE_CODES

        while True:
            llm = self._llm(req, stream=True)
            agen = llm.astream(_to_lc(req.messages)).__aiter__()
            usage: Usage | None = None
            finish: str | None = None
            try:
                while True:
                    try:
                        chunk = await asyncio.wait_for(agen.__anext__(), idle)
                    except StopAsyncIteration:
                        break
                    um = _usage(chunk)
                    if um.total_tokens is not None or um.prompt_tokens is not None or um.completion_tokens is not None:
                        usage = um
                    fr = (getattr(chunk, "response_metadata", None) or {}).get("finish_reason")
                    if isinstance(fr, str):
                        finish = fr
                    text = _text(chunk.content)
                    if text:
                        started_output = True
                        yield ChatChunk(delta=text)
                yield ChatChunk(done=True, usage=usage or Usage(), finish_reason=finish)
                return
            except asyncio.CancelledError:
                raise
            except GeneratorExit:
                raise
            except Exception as exc:  # noqa: BLE001
                err = self.normalize_error(exc)
                if started_output or attempt >= MAX_RETRIES or err.code not in RETRYABLE_CODES:
                    raise err from None
                await asyncio.sleep(compute_delay(attempt, err.retry_after_seconds))
                attempt += 1
            finally:
                aclose = getattr(agen, "aclose", None)
                if aclose is not None:
                    try:
                        await aclose()
                    except Exception:  # noqa: BLE001
                        pass

    # ------------------------------------------------------------------ structured output
    async def generate_structured(self, req: ChatRequest, schema: type[BaseModel]) -> StructuredResult:
        usage = Usage()
        native = self.structured_support(req.model) == "yes"
        last_text = ""
        method = "prompt"
        if native:
            rf = {
                "type": "json_schema",
                "json_schema": {"name": schema.__name__, "strict": True, "schema": strict_json_schema(schema)},
            }
            try:
                res = await self._invoke(req, response_format=rf)
                usage = _add_usage(usage, res.usage)
                last_text = res.text
                method = "native"
                try:
                    return StructuredResult(
                        parsed=schema.model_validate(extract_json(res.text)), usage=usage, method="native", finish_reason=res.finish_reason
                    )
                except (ValueError, ValidationError) as exc:
                    problem = _validation_summary(exc)
            except ProviderError as exc:
                if exc.code != ErrorCode.PROVIDER_ERROR:
                    raise
                # the endpoint rejected native structured output: same provider+model, prompt path instead
                native = False
                problem = ""
        if not native:
            msgs = self._prompt_messages(req.messages, schema)
            res = await self._invoke(ChatRequest(req.model, req.api_key, msgs, req.params))
            usage = _add_usage(usage, res.usage)
            last_text = res.text
            try:
                return StructuredResult(
                    parsed=schema.model_validate(extract_json(res.text)), usage=usage, method="prompt", finish_reason=res.finish_reason
                )
            except (ValueError, ValidationError) as exc:
                problem = _validation_summary(exc)
        # one bounded repair attempt
        repair_msgs = self._prompt_messages(req.messages, schema) + [
            ChatMessage(role="assistant", content=last_text[:4000]),
            ChatMessage(
                role="user",
                content=f"That reply was not valid for the required JSON schema ({problem}). "
                "Reply again with ONLY the corrected JSON object and nothing else.",
            ),
        ]
        res = await self._invoke(ChatRequest(req.model, req.api_key, repair_msgs, req.params))
        usage = _add_usage(usage, res.usage)
        try:
            return StructuredResult(
                parsed=schema.model_validate(extract_json(res.text)),
                usage=usage,
                method="prompt" if method != "native" else "native",
                repaired=True,
                finish_reason=res.finish_reason,
            )
        except (ValueError, ValidationError):
            raise ProviderError(ErrorCode.STRUCTURED_OUTPUT_FAILED, retryable=False) from None

    @staticmethod
    def _prompt_messages(messages: list[ChatMessage], schema: type[BaseModel]) -> list[ChatMessage]:
        instruction = (
            "OUTPUT FORMAT: Respond with ONLY one JSON object (no prose, no markdown fences) that validates against this JSON Schema:\n"
            + json.dumps(strict_json_schema(schema), ensure_ascii=False)
        )
        out = [m.model_copy() for m in messages]
        if out and out[0].role == "system":
            out[0] = ChatMessage(role="system", content=out[0].content + "\n\n" + instruction)
        else:
            out.insert(0, ChatMessage(role="system", content=instruction))
        return out

    # ------------------------------------------------------------------ embeddings
    async def embed(self, req: EmbedRequest) -> EmbedResult:
        if not self.supports_embeddings:
            raise ProviderError(
                ErrorCode.CAPABILITY_UNSUPPORTED,
                "This provider does not offer embeddings. Choose OpenAI or OpenRouter for document embeddings.",
            )
        dims = self.settings.embedding_dimensions
        dim_param = self.embedding_dimensions_param(req.model)
        s = self.settings
        vectors: list[list[float]] = []
        for i in range(0, len(req.inputs), EMBED_BATCH):
            batch = req.inputs[i : i + EMBED_BATCH]

            async def once(batch: list[str] = batch) -> list[list[float]]:
                emb = OpenAIEmbeddings(
                    model=req.model,
                    api_key=req.api_key,
                    base_url=self.base_url,
                    dimensions=dim_param,
                    check_embedding_ctx_length=False,
                    chunk_size=EMBED_BATCH,
                    max_retries=0,
                    timeout=httpx.Timeout(connect=10.0, read=s.provider_timeout_seconds, write=30.0, pool=10.0),
                    default_headers=dict(self.extra_headers) or None,
                    model_kwargs={"encoding_format": "float"},
                )
                async with asyncio.timeout(s.provider_timeout_seconds):
                    return await emb.aembed_documents(batch)

            got = await with_retries(once, lambda e: self.normalize_error(e, where="embed"))
            if len(got) != len(batch):
                raise ProviderError(ErrorCode.PROVIDER_ERROR, "The AI provider returned an unexpected response.", retryable=False)
            for v in got:
                if not isinstance(v, list) or len(v) != dims:
                    raise ProviderError(ErrorCode.EMBEDDING_DIMENSION_MISMATCH, retryable=False)
            vectors.extend(got)
        return EmbedResult(vectors=vectors, usage=Usage())


def _safe_json(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except ValueError:
        return None
