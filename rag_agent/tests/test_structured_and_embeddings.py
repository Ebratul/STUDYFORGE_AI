from __future__ import annotations

import json

import httpx
import pytest
import respx
from pydantic import BaseModel, SecretStr

from app.errors import ErrorCode, ProviderError
from app.providers import openai_compat
from app.providers.base import EmbedRequest
from app.providers.groq import GroqProvider
from app.providers.openai import OpenAIProvider
from app.providers.openrouter import OpenRouterProvider
from tests.helpers import BASES, CANARY_KEY, chat_json, embed_json, err_body, req

KEY = SecretStr(CANARY_KEY)


class Answer(BaseModel):
    answer: str
    n: int


def chat_url(p):
    return BASES[p.id] + "/chat/completions"


# ------------------------------------------------------------------------------------------------ structured output
async def test_native_structured_output_sends_json_schema(settings):
    p = OpenAIProvider(settings)
    with respx.mock as m:
        route = m.post(chat_url(p)).mock(return_value=httpx.Response(200, json=chat_json('{"answer":"x","n":2}')))
        res = await p.generate_structured(req(KEY, model="gpt-4o"), Answer)
    assert res.method == "native" and not res.repaired and res.parsed == Answer(answer="x", n=2)
    rf = json.loads(route.calls.last.request.content)["response_format"]
    assert rf["type"] == "json_schema" and rf["json_schema"]["strict"] is True
    sch = rf["json_schema"]["schema"]
    assert sch["additionalProperties"] is False and sch["required"] == ["answer", "n"]
    assert res.usage.total_tokens == 15


async def test_prompt_fallback_when_model_is_not_known_to_support_native(settings):
    p = OpenAIProvider(settings)
    with respx.mock as m:
        route = m.post(chat_url(p)).mock(return_value=httpx.Response(200, json=chat_json('```json\n{"answer":"y","n":1}\n```')))
        res = await p.generate_structured(req(KEY, model="gpt-3.5-turbo", system="SYS"), Answer)
    assert res.method == "prompt" and res.parsed.answer == "y"
    body = json.loads(route.calls.last.request.content)
    assert "response_format" not in body
    assert body["messages"][0]["role"] == "system" and body["messages"][0]["content"].startswith("SYS") and "JSON Schema" in body["messages"][0]["content"]


async def test_unknown_support_uses_prompt_path(settings):
    p = GroqProvider(settings)
    with respx.mock as m:
        route = m.post(chat_url(p)).mock(return_value=httpx.Response(200, json=chat_json('Sure: {"answer":"z","n":3} done')))
        res = await p.generate_structured(req(KEY, model="llama-x"), Answer)
    assert res.method == "prompt" and res.parsed.n == 3
    assert "response_format" not in json.loads(route.calls.last.request.content)


async def test_groq_gpt_oss_uses_native(settings):
    p = GroqProvider(settings)
    with respx.mock as m:
        route = m.post(chat_url(p)).mock(return_value=httpx.Response(200, json=chat_json('{"answer":"z","n":3}')))
        res = await p.generate_structured(req(KEY, model="openai/gpt-oss-20b"), Answer)
    assert res.method == "native" and "response_format" in json.loads(route.calls.last.request.content)


async def test_capability_learned_from_listing_is_used(settings):
    p = OpenRouterProvider(settings)
    with respx.mock as m:
        m.get(BASES["openrouter"] + "/key").mock(return_value=httpx.Response(200, json={"data": {}}))
        m.get(BASES["openrouter"] + "/models").mock(return_value=httpx.Response(200, json={"data": [
            {"id": "v/native", "architecture": {"output_modalities": ["text"]}, "supported_parameters": ["structured_outputs"]}]}))
        m.get(BASES["openrouter"] + "/embeddings/models").mock(return_value=httpx.Response(404, json=err_body("x")))
        await p.list_models(KEY)
        route = m.post(chat_url(p)).mock(return_value=httpx.Response(200, json=chat_json('{"answer":"q","n":1}')))
        res = await p.generate_structured(req(KEY, model="v/native"), Answer)
    assert res.method == "native" and "response_format" in json.loads(route.calls.last.request.content)


async def test_bounded_repair_succeeds_on_second_attempt(settings):
    p = OpenAIProvider(settings)
    with respx.mock as m:
        route = m.post(chat_url(p)).mock(side_effect=[
            httpx.Response(200, json=chat_json('{"answer": "missing n"}')),
            httpx.Response(200, json=chat_json('{"answer":"fixed","n":9}')),
        ])
        res = await p.generate_structured(req(KEY, model="gpt-3.5-turbo"), Answer)
    assert res.repaired and res.parsed.n == 9 and route.call_count == 2
    repair_msgs = json.loads(route.calls.last.request.content)["messages"]
    assert repair_msgs[-1]["role"] == "user" and "n: missing" in repair_msgs[-1]["content"]
    assert res.usage.total_tokens == 30  # usage of both attempts is summed


async def test_repair_is_bounded_to_one_attempt(settings):
    p = OpenAIProvider(settings)
    with respx.mock as m:
        route = m.post(chat_url(p)).mock(return_value=httpx.Response(200, json=chat_json("not json at all")))
        with pytest.raises(ProviderError) as ei:
            await p.generate_structured(req(KEY, model="gpt-3.5-turbo"), Answer)
    assert ei.value.code == ErrorCode.STRUCTURED_OUTPUT_FAILED and route.call_count == 2
    assert not ei.value.retryable and "not json" not in ei.value.message


async def test_native_failure_then_repair_is_still_bounded(settings):
    p = OpenAIProvider(settings)
    with respx.mock as m:
        route = m.post(chat_url(p)).mock(return_value=httpx.Response(200, json=chat_json('{"wrong": 1}')))
        with pytest.raises(ProviderError) as ei:
            await p.generate_structured(req(KEY, model="gpt-4o"), Answer)
    assert ei.value.code == ErrorCode.STRUCTURED_OUTPUT_FAILED and route.call_count == 2


async def test_native_rejected_by_endpoint_falls_back_to_prompt_path_same_provider(settings):
    p = OpenAIProvider(settings)
    with respx.mock as m:
        route = m.post(chat_url(p)).mock(side_effect=[
            httpx.Response(400, json=err_body("response_format json_schema is not supported with this model")),
            httpx.Response(200, json=chat_json('{"answer":"ok","n":1}')),
        ])
        res = await p.generate_structured(req(KEY, model="gpt-4o"), Answer)
    assert res.method == "prompt" and route.call_count == 2
    assert "response_format" not in json.loads(route.calls.last.request.content)


async def test_structured_provider_errors_are_not_masked(settings):
    p = OpenAIProvider(settings)
    with respx.mock as m:
        m.post(chat_url(p)).mock(return_value=httpx.Response(401, json=err_body("bad")))
        with pytest.raises(ProviderError) as ei:
            await p.generate_structured(req(KEY, model="gpt-4o"), Answer)
    assert ei.value.code == ErrorCode.PROVIDER_AUTH_INVALID


def test_strict_schema_inlines_refs():
    class Inner(BaseModel):
        a: int = 1

    class Outer(BaseModel):
        items: list[Inner]
        flag: bool = False

    s = openai_compat.strict_json_schema(Outer)
    assert "$defs" not in json.dumps(s) and "$ref" not in json.dumps(s)
    assert s["required"] == ["items", "flag"] and s["properties"]["items"]["items"]["additionalProperties"] is False


# ------------------------------------------------------------------------------------------------ embeddings
async def test_openai_embeddings_batches_of_64_and_dimensions(settings):
    p = OpenAIProvider(settings)
    sizes: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        sizes.append(len(body["input"]))
        assert body["dimensions"] == 1536 and body["model"] == "text-embedding-3-large" and body["encoding_format"] == "float"
        return httpx.Response(200, json=embed_json(len(body["input"]), model=body["model"]))

    with respx.mock as m:
        route = m.post(BASES["openai"] + "/embeddings").mock(side_effect=handler)
        res = await p.embed(EmbedRequest("text-embedding-3-large", KEY, [f"t{i}" for i in range(130)], dimensions=1536, expected_dimension=1536))
    assert sizes == [64, 64, 2] and route.call_count == 3
    assert len(res.vectors) == 130 and all(len(v) == 1536 for v in res.vectors)
    # order is preserved: first vector of each batch carries the 0.01 marker
    assert res.vectors[0][0] == pytest.approx(0.01) and res.vectors[1][0] == pytest.approx(0.02)


async def test_dimensions_param_not_sent_for_ada_002(settings):
    p = OpenAIProvider(settings)
    with respx.mock as m:
        route = m.post(BASES["openai"] + "/embeddings").mock(return_value=httpx.Response(200, json=embed_json(1)))
        await p.embed(EmbedRequest("text-embedding-ada-002", KEY, ["x"]))
    assert "dimensions" not in json.loads(route.calls.last.request.content)


async def test_openrouter_embeddings(settings):
    p = OpenRouterProvider(settings)
    with respx.mock as m:
        route = m.post(BASES["openrouter"] + "/embeddings").mock(return_value=httpx.Response(200, json=embed_json(2)))
        res = await p.embed(EmbedRequest("openai/text-embedding-3-small", KEY, ["a", "b"], dimensions=1536, expected_dimension=1536))
    assert len(res.vectors) == 2
    sent = route.calls.last.request
    assert sent.headers["x-title"] == "StudyForge AI" and sent.url.host == "openrouter.ai"
    assert json.loads(sent.content)["dimensions"] == 1536


async def test_openrouter_other_models_do_not_get_dimensions(settings):
    p = OpenRouterProvider(settings)
    with respx.mock as m:
        route = m.post(BASES["openrouter"] + "/embeddings").mock(return_value=httpx.Response(200, json=embed_json(1)))
        await p.embed(EmbedRequest("vendor/some-embed", KEY, ["a"]))
    assert "dimensions" not in json.loads(route.calls.last.request.content)


async def test_embedding_dimension_mismatch(settings):
    p = OpenAIProvider(settings)
    with respx.mock as m:
        m.post(BASES["openai"] + "/embeddings").mock(return_value=httpx.Response(200, json=embed_json(1, dim=768)))
        with pytest.raises(ProviderError) as ei:
            await p.embed(EmbedRequest("text-embedding-3-small", KEY, ["x"], expected_dimension=1536))
    assert ei.value.code == ErrorCode.EMBEDDING_DIMENSION_MISMATCH and ei.value.http_status == 422


async def test_embedding_count_mismatch_is_provider_error(settings):
    p = OpenAIProvider(settings)
    with respx.mock as m:
        m.post(BASES["openai"] + "/embeddings").mock(return_value=httpx.Response(200, json=embed_json(1)))
        with pytest.raises(ProviderError) as ei:
            await p.embed(EmbedRequest("text-embedding-3-small", KEY, ["x", "y"]))
    assert ei.value.code in (ErrorCode.PROVIDER_ERROR,)


async def test_groq_embeddings_unsupported_without_network(settings):
    p = GroqProvider(settings)
    with respx.mock(assert_all_called=False) as m:
        any_route = m.route().mock(return_value=httpx.Response(500))
        with pytest.raises(ProviderError) as ei:
            await p.embed(EmbedRequest("whatever", KEY, ["x"]))
    assert ei.value.code == ErrorCode.CAPABILITY_UNSUPPORTED and any_route.call_count == 0 and ei.value.http_status == 422


@pytest.mark.parametrize("status,code", [(401, ErrorCode.PROVIDER_AUTH_INVALID), (404, ErrorCode.MODEL_NOT_FOUND),
                                         (429, ErrorCode.PROVIDER_RATE_LIMITED), (500, ErrorCode.PROVIDER_UNAVAILABLE)])
async def test_embedding_errors_normalised(settings, status, code):
    p = OpenAIProvider(settings)
    with respx.mock as m:
        m.post(BASES["openai"] + "/embeddings").mock(return_value=httpx.Response(status, json=err_body("nope " + CANARY_KEY)))
        with pytest.raises(ProviderError) as ei:
            await p.embed(EmbedRequest("text-embedding-3-small", KEY, ["x"]))
    assert ei.value.code == code and CANARY_KEY not in ei.value.message
