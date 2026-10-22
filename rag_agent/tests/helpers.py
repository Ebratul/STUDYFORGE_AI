from __future__ import annotations

import json

import httpx

from app.providers.base import ChatMessage, ChatParams, ChatRequest

CANARY_KEY = "sk-CANARYKEY-do-not-leak-0123456789abcdef"
BASES = {
    "openai": "https://api.openai.com/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "groq": "https://api.groq.com/openai/v1",
}


def chat_json(text: str = "hello there", *, usage: bool = True) -> dict:
    d = {
        "id": "chatcmpl-1",
        "object": "chat.completion",
        "created": 1,
        "model": "m",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
    }
    if usage:
        d["usage"] = {"prompt_tokens": 11, "completion_tokens": 4, "total_tokens": 15}
    return d


def sse_body(deltas: list[str], *, usage: dict | None = None, usage_in_final_choice_chunk: bool = False) -> str:
    chunks = []
    for i, d in enumerate(deltas):
        last = i == len(deltas) - 1
        chunks.append(
            {
                "id": "c", "object": "chat.completion.chunk", "created": 1, "model": "m",
                "choices": [{"index": 0, "delta": ({"role": "assistant"} if i == 0 else {}) | {"content": d},
                             "finish_reason": "stop" if last else None}],
            }
        )
    if usage:
        chunks.append({"id": "c", "object": "chat.completion.chunk", "created": 1, "model": "m", "choices": [], "usage": usage})
    return "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"


def sse_response(deltas, usage=None) -> httpx.Response:
    return httpx.Response(200, text=sse_body(deltas, usage=usage), headers={"content-type": "text/event-stream"})


def err_body(message: str, *, code: str | None = None, type_: str = "invalid_request_error") -> dict:
    return {"error": {"message": message, "type": type_, "code": code, "param": None}}


def req(key, model="test-model", text="hello", system: str | None = None, **params) -> ChatRequest:
    msgs = ([ChatMessage(role="system", content=system)] if system else []) + [ChatMessage(role="user", content=text)]
    return ChatRequest(model, key, msgs, ChatParams(**params))


def embed_json(n: int, dim: int = 1536, model: str = "text-embedding-3-small") -> dict:
    return {
        "object": "list",
        "model": model,
        "data": [{"object": "embedding", "index": i, "embedding": [0.01 * (i + 1)] * dim} for i in range(n)],
        "usage": {"prompt_tokens": n, "total_tokens": n},
    }
