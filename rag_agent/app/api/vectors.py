"""Service-token protected vector maintenance for the backend: removal of vectors it can no longer reach through the database
(PostgreSQL deletes its own rows by cascade, but a remote vector store has nothing to cascade).

Deletion is idempotent (deleting what is already gone succeeds), scoped by owner, and never takes a namespace, index or filter from the
caller. In pgvector mode there is nothing to do here: the rows ARE the vectors.
"""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field, field_validator, model_validator

from app.errors import AppError, ErrorCode
from app.logging import log_event
from app.schemas import EmbeddingIdentityIn
from app.security import require_service_token
from app.vectorstore import Identity, valid_id

log = logging.getLogger("rag.vectors")
router = APIRouter(prefix="/v1/vectors", dependencies=[Depends(require_service_token)])

MAX_CHUNKS = 1000
MAX_DOCUMENTS = 5000


class VectorDeleteBody(BaseModel):
    scope: Literal["document", "user", "chunks"]
    owner_id: str
    document_id: str | None = None  # scope=document
    document_ids: list[str] = Field(default_factory=list, max_length=MAX_DOCUMENTS)  # scope=user (shared namespaces delete document by document)
    identity: EmbeddingIdentityIn | None = None  # scope=chunks
    chunks: list[tuple[str, str]] = Field(default_factory=list, max_length=MAX_CHUNKS)  # scope=chunks: (document_id, chunk_id)

    @field_validator("owner_id")
    @classmethod
    def _owner(cls, v: str) -> str:
        if not valid_id(v):
            raise ValueError("invalid owner id")
        return v

    @model_validator(mode="after")
    def _shape(self) -> "VectorDeleteBody":
        if self.scope == "document" and not (self.document_id and valid_id(self.document_id)):
            raise ValueError("document_id is required for scope=document")
        if self.scope == "chunks":
            if self.identity is None or not self.chunks:
                raise ValueError("identity and chunks are required for scope=chunks")
            if not all(valid_id(d) and valid_id(c) for d, c in self.chunks):
                raise ValueError("invalid document or chunk id")
        if not all(valid_id(d) for d in self.document_ids):
            raise ValueError("invalid document id")
        return self


@router.get("/status")
async def status(request: Request) -> dict:
    """Mode and supported embedding sizes only (never hosts, index names or keys)."""
    return request.app.state.vectors.status()


@router.post("/delete")
async def delete_vectors(body: VectorDeleteBody, request: Request) -> dict:
    rt = request.app.state.vectors
    if not rt.pinecone_writes:
        return {"status": "noop", "mode": rt.mode, "deleted": 0}
    store = rt.pinecone
    if body.scope == "document":
        deleted = await store.delete_document(owner_id=body.owner_id, document_id=body.document_id)  # type: ignore[arg-type]
    elif body.scope == "user":
        deleted = await store.delete_user(owner_id=body.owner_id, document_ids=body.document_ids)
    else:
        ident = body.identity
        if not store.supports(ident.dimension):  # type: ignore[union-attr]
            # nothing of this size can exist in this store: success, not an error (the job must be able to finish)
            return {"status": "ok", "mode": rt.mode, "deleted": 0}
        deleted = await store.delete_identity(owner_id=body.owner_id, identity=Identity(ident.provider, ident.model, ident.dimension),  # type: ignore[union-attr]
                                              chunks=[(d, c) for d, c in body.chunks])
    log_event(log, "vectors_deleted", scope=body.scope, deleted=deleted, mode=rt.mode)
    return {"status": "ok", "mode": rt.mode, "deleted": deleted}
