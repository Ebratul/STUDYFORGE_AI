from __future__ import annotations

import uuid
from typing import Any

from app.graphs.runner import make_context, run_chat
from app.providers.mock import VALID_KEY, hash_embed
from app.providers.registry import ProviderRegistry
from app.schemas import ChatBody
from tests.conftest import CANARY_KEY, make_settings
from pgvector import Vector


async def put_chunk(pool, doc, owner, idx, content, *, version=1, model="mock-embed", page=None, section=None):
    async with pool.connection() as conn:
        await conn.execute(
            'INSERT INTO "DocumentChunk" ("id","documentId","ownerId","chunkIndex","processingVersion","page","section","content","tokenCount","embeddingModel","embedding") '
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (uuid.uuid4().hex, doc, owner, idx, version, page, section, content, 1, model, Vector(hash_embed(content))),
        )


def body(mode="DOCUMENT_ONLY", *, question="What do mitochondria produce?", user="alice", docs=(), history=(), use_documents=True,
         embedding: dict | None | str = "default", chat_provider="fake", retrieval=None, key=CANARY_KEY) -> ChatBody:
    emb = {"provider": "mock", "api_key": VALID_KEY, "model": "mock-embed"} if embedding == "default" else embedding
    return ChatBody.model_validate({
        "request_id": uuid.uuid4().hex, "user_id": user, "mode": mode,
        "chat": {"provider": chat_provider, "api_key": key, "model": "m", "params": {"temperature": 0.2}},
        "embedding": emb,
        "messages": [*history, {"role": "user", "content": question}],
        "document_ids": list(docs), "use_documents": use_documents, "retrieval": retrieval,
    })


async def run(pool, fake, b: ChatBody, *, registry_extra=(), settings=None) -> list[tuple[str, dict[str, Any]]]:
    settings = settings or make_settings()
    reg = ProviderRegistry(settings)
    reg.register_for_tests(fake)
    for p in registry_extra:
        reg.register_for_tests(p)
    ctx = make_context(settings, reg, pool, b)
    return [ev async for ev in run_chat(ctx)]


def names(events) -> list[str]:
    return [e for e, _ in events]


def get(events, name):
    return [d for e, d in events if e == name]
