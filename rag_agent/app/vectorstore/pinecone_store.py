"""Pinecone backend, speaking the data-plane REST API directly over httpx (no SDK, so nothing extra to install and every call is mockable).

Security properties:
  * The API key lives only in this process. It is sent only to a validated `*.pinecone.io` index host (see app.config) and is registered
    with the redaction layer for every call.
  * Namespaces are built in ONE place (`namespace_for`) from a validated owner id; callers cannot name a namespace or write a filter.
  * Every query carries a mandatory ownerId filter (defence in depth even in per-user namespace mode).
  * Only ids, scores and small metadata are exchanged. Chunk text never leaves PostgreSQL.

Nothing here contacts Pinecone unless a method is called; constructing the store performs no I/O.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from collections import defaultdict
from collections.abc import Sequence
from typing import Any

import httpx

from app.config import PineconeIndexRef, Settings
from app.errors import AppError, ErrorCode
from app.logging import log_event
from app.providers import retry as retry_mod
from app.redact import bind_secrets
from app.vectorstore.base import Candidate, Identity, VectorRecord, VectorStore, split_key, valid_id, vector_key

log = logging.getLogger("rag.vectors.pinecone")

API_VERSION = "2025-10"
UPSERT_BYTE_BUDGET = 1_500_000  # Pinecone allows 2 MB per upsert request; stay clear of it
UPSERT_MAX_RECORDS = 100
DELETE_BATCH = 1000  # Pinecone: at most 1000 ids per delete request
FETCH_BATCH = 100
LIST_PAGE = 100
MAX_TOP_K = 1000
RETRY_AFTER_CAP = 10.0


def upsert_batch_size(dimension: int) -> int:
    """A JSON float is ~16 bytes; keep every request well under Pinecone's 2 MB limit."""
    return max(1, min(UPSERT_MAX_RECORDS, UPSERT_BYTE_BUDGET // (dimension * 16)))


class PineconeStore(VectorStore):
    name = "pinecone"

    def __init__(self, settings: Settings, *, client: httpx.AsyncClient | None = None) -> None:
        self._indexes: dict[int, PineconeIndexRef] = settings.validate_pinecone()
        self._key = settings.pinecone_api_key.get_secret_value()
        self._prefix = settings.pinecone_namespace_prefix
        self._per_user = settings.pinecone_namespace_mode == "per-user"
        self._timeout = settings.pinecone_timeout_seconds
        self._max_retries = settings.pinecone_max_retries
        self._visible_timeout = settings.pinecone_visibility_timeout_seconds
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(self._timeout), follow_redirects=False)
        self._owns_client = client is None

    # ------------------------------------------------------------------------------------------------ configuration facts
    def supported_dimensions(self) -> list[int]:
        return sorted(self._indexes)

    @property
    def per_user(self) -> bool:
        return self._per_user

    def supports(self, dimension: int) -> bool:
        return dimension in self._indexes

    def namespace_for(self, owner_id: str) -> str:
        """The only place a namespace name is built. Per-user mode isolates tenants physically; shared mode relies on the ownerId filter."""
        if not valid_id(owner_id):
            raise AppError(ErrorCode.VALIDATION, "Invalid owner id.")
        return f"{self._prefix}-u-{owner_id}" if self._per_user else f"{self._prefix}-shared"

    def _index(self, dimension: int) -> PineconeIndexRef:
        ref = self._indexes.get(dimension)
        if ref is None:
            raise AppError(ErrorCode.VECTOR_DIMENSION_UNSUPPORTED, f"No Pinecone index is configured for {dimension}-dimensional vectors. Supported sizes: {', '.join(map(str, self.supported_dimensions()))}.")
        return ref

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    # ------------------------------------------------------------------------------------------------ HTTP core
    async def _request(self, ref: PineconeIndexRef, method: str, path: str, *, json: Any = None, params: dict | list | None = None,
                       ok_404: bool = False) -> dict[str, Any]:
        url = f"https://{ref.host}{path}"
        headers = {"Api-Key": self._key, "X-Pinecone-Api-Version": API_VERSION, "Accept": "application/json"}
        attempt = 0
        with bind_secrets([self._key]):
            while True:
                err: AppError
                try:
                    res = await self._client.request(method, url, json=json, params=params, headers=headers, timeout=self._timeout)
                except httpx.TimeoutException:
                    err = _unavailable(path, None)
                except httpx.TransportError:
                    err = _unavailable(path, None)
                else:
                    if res.status_code < 300:
                        try:
                            body = res.json() if res.content else {}
                        except ValueError:
                            raise AppError(ErrorCode.VECTOR_STORE_ERROR, diagnostics={"endpoint": path, "status": res.status_code}) from None
                        return body if isinstance(body, dict) else {}
                    if res.status_code == 404 and ok_404:
                        return {}
                    err = _from_status(path, res.status_code, res.headers.get("retry-after"))
                if not err.retryable or attempt >= self._max_retries:
                    log_event(log, "pinecone_request_failed", logging.WARNING, endpoint=path, code=err.code.value, attempts=attempt + 1,
                              status=(err.diagnostics or {}).get("status"))
                    raise err
                await asyncio.sleep(retry_mod.compute_delay(attempt, err.retry_after_seconds))
                attempt += 1

    # ------------------------------------------------------------------------------------------------ writes
    async def upsert(self, records: Sequence[VectorRecord]) -> None:
        if not records:
            return
        by_dim: dict[int, list[VectorRecord]] = defaultdict(list)
        for r in records:
            if not (valid_id(r.owner_id) and valid_id(r.document_id) and valid_id(r.id)):
                raise AppError(ErrorCode.VALIDATION, "Invalid owner, document or chunk id.")
            if len(r.values) != r.identity.dimension:
                raise AppError(ErrorCode.EMBEDDING_DIMENSION_MISMATCH, retryable=False)  # never repaired: no padding, no truncation
            if any(not math.isfinite(x) for x in r.values):
                raise AppError(ErrorCode.PROVIDER_ERROR, "The AI provider returned an unexpected embedding response.", retryable=False)
            by_dim[r.identity.dimension].append(r)
        for dim in by_dim:  # fail before writing anything when any size has no index
            self._index(dim)
        for dim, group in by_dim.items():
            ref = self._index(dim)
            by_ns: dict[str, list[VectorRecord]] = defaultdict(list)
            for r in group:
                by_ns[self.namespace_for(r.owner_id)].append(r)
            size = upsert_batch_size(dim)
            for ns, rows in by_ns.items():
                for i in range(0, len(rows), size):
                    batch = rows[i : i + size]
                    body = {"namespace": ns, "vectors": [{"id": vector_key(r.document_id, r.id), "values": list(r.values), "metadata": _metadata(r)} for r in batch]}
                    await self._request(ref, "POST", "/vectors/upsert", json=body)
                await self._await_visible(ref, ns, [vector_key(rows[0].document_id, rows[0].id), vector_key(rows[-1].document_id, rows[-1].id)])

    async def _await_visible(self, ref: PineconeIndexRef, namespace: str, keys: list[str]) -> None:
        """Pinecone is eventually consistent. Writes to one namespace are applied in order, so the first and last record of an upsert
        being fetchable is taken as "the whole upsert is visible". Bounded: gives up with a retryable error, never loops forever."""
        if self._visible_timeout <= 0:
            return
        deadline = time.monotonic() + self._visible_timeout
        want = sorted(set(keys))
        delay = 0.25
        while True:
            found = await self._fetch(ref, namespace, want)
            if all(k in found for k in want):
                return
            if time.monotonic() >= deadline:
                raise AppError(ErrorCode.VECTOR_STORE_UNAVAILABLE, "The document search index has not made the new vectors searchable yet.", retryable=True)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 2.0)

    async def _fetch(self, ref: PineconeIndexRef, namespace: str, keys: list[str]) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for i in range(0, len(keys), FETCH_BATCH):
            params = [("ids", k) for k in keys[i : i + FETCH_BATCH]] + [("namespace", namespace)]
            body = await self._request(ref, "GET", "/vectors/fetch", params=params)
            vectors = body.get("vectors")
            if isinstance(vectors, dict):
                out.update({k: (v if isinstance(v, dict) else {}) for k, v in vectors.items()})
        return out

    # ------------------------------------------------------------------------------------------------ reads
    async def query(self, *, owner_id, document_ids, vector, identity: Identity, top_k, versions=None) -> list[Candidate]:
        ref = self._index(identity.dimension)
        if len(vector) != identity.dimension:
            raise AppError(ErrorCode.EMBEDDING_DIMENSION_MISMATCH, retryable=False)
        docs = sorted({d for d in document_ids if valid_id(d)})
        if not docs:
            return []
        flt: dict[str, Any] = {
            "ownerId": {"$eq": owner_id},  # mandatory, even when the namespace is already per-user
            "documentId": {"$in": docs},
            "embeddingProvider": {"$eq": identity.provider},
            "embeddingModel": {"$eq": identity.model},
        }
        if versions:
            flt["processingVersion"] = {"$in": sorted(set(int(v) for v in versions))}
        body = {"namespace": self.namespace_for(owner_id), "vector": list(vector), "topK": max(1, min(int(top_k), MAX_TOP_K)),
                "includeValues": False, "includeMetadata": False, "filter": flt}
        res = await self._request(ref, "POST", "/query", json=body)
        allowed = set(docs)
        out: list[Candidate] = []
        for m in res.get("matches") or []:
            parts = split_key(m.get("id")) if isinstance(m, dict) and isinstance(m.get("id"), str) else None
            score = m.get("score") if isinstance(m, dict) else None
            if parts is None or parts[0] not in allowed or isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score):
                continue  # malformed or outside the requested documents: never even surfaces as a candidate
            out.append(Candidate(parts[1], float(score)))
        return out

    async def count_document(self, *, owner_id, document_id, dimension) -> int | None:
        return len(await self._list(self._index(dimension), self.namespace_for(owner_id), f"{document_id}:"))

    async def describe(self, dimension: int) -> dict[str, Any]:
        """Read-only facts about one index (POST /describe_index_stats). Used only by the operator-run check tool and the opt-in live test."""
        body = await self._request(self._index(dimension), "POST", "/describe_index_stats", json={})
        namespaces = body.get("namespaces")
        return {"dimension": body.get("dimension"), "metric": body.get("metric"), "vector_type": body.get("vectorType"),
                "total_vectors": body.get("totalVectorCount"), "namespaces": len(namespaces) if isinstance(namespaces, dict) else None}

    async def list_keys(self, *, owner_id: str, dimension: int, prefix: str = "") -> list[str]:
        """Vector ids (`{documentId}:{chunkId}`) in the owner's namespace, optionally under a document prefix. Used by the reconcile tool."""
        return await self._list(self._index(dimension), self.namespace_for(owner_id), prefix)

    # ------------------------------------------------------------------------------------------------ deletes (idempotent)
    async def _list(self, ref: PineconeIndexRef, namespace: str, prefix: str) -> list[str]:
        ids: list[str] = []
        token: str | None = None
        while True:
            params: dict[str, Any] = {"prefix": prefix, "namespace": namespace, "limit": LIST_PAGE}
            if token:
                params["paginationToken"] = token
            body = await self._request(ref, "GET", "/vectors/list", params=params, ok_404=True)
            ids.extend(v["id"] for v in body.get("vectors") or [] if isinstance(v, dict) and isinstance(v.get("id"), str))
            token = (body.get("pagination") or {}).get("next") if isinstance(body.get("pagination"), dict) else None
            if not token:
                return ids

    async def _delete_keys(self, ref: PineconeIndexRef, namespace: str, keys: list[str]) -> int:
        for i in range(0, len(keys), DELETE_BATCH):
            await self._request(ref, "POST", "/vectors/delete", json={"namespace": namespace, "ids": keys[i : i + DELETE_BATCH]}, ok_404=True)
        return len(keys)

    async def delete_document(self, *, owner_id, document_id) -> int:
        if not valid_id(document_id):
            raise AppError(ErrorCode.VALIDATION, "Invalid document id.")
        ns, total = self.namespace_for(owner_id), 0
        for ref in self._indexes.values():  # a document can hold vectors of several sizes (active + staged)
            keys = await self._list(ref, ns, f"{document_id}:")
            if not self._per_user:  # a shared namespace holds everyone's vectors: only remove what metadata proves is this owner's
                keys = await self._owned(ref, ns, keys, owner_id)
            total += await self._delete_keys(ref, ns, keys)
        return total

    async def _owned(self, ref: PineconeIndexRef, namespace: str, keys: list[str], owner_id: str) -> list[str]:
        found = await self._fetch(ref, namespace, keys)
        return [k for k in keys if (found.get(k, {}).get("metadata") or {}).get("ownerId") == owner_id]

    async def delete_user(self, *, owner_id, document_ids: Sequence[str] = ()) -> int:
        ns = self.namespace_for(owner_id)
        if self._per_user:
            for ref in self._indexes.values():
                await self._request(ref, "POST", "/vectors/delete", json={"namespace": ns, "deleteAll": True}, ok_404=True)
            return -1
        # Shared namespace: delete the user's documents one by one. (Orphans without a document row are found by the reconcile tool.)
        return sum([await self.delete_document(owner_id=owner_id, document_id=d) for d in sorted(set(document_ids)) if valid_id(d)])

    async def delete_identity(self, *, owner_id, identity: Identity, chunks: Sequence[tuple[str, str]], verify: bool = True) -> int:
        """Deletes exact `(document_id, chunk_id)` vectors of one identity (no listing needed). Unless `verify=False`, each vector's metadata
        is fetched first and only those that are this owner's AND this identity's are removed (a vector that is not visible yet is left;
        the reconcile tool collects such leftovers)."""
        ref = self._index(identity.dimension)
        ns = self.namespace_for(owner_id)
        keys = [vector_key(d, c) for d, c in chunks if valid_id(d) and valid_id(c)]
        if not keys:
            return 0
        if verify:
            found = await self._fetch(ref, ns, keys)
            keys = [k for k in keys if k in found and _meta_matches(found[k], owner_id, identity)]
        return await self._delete_keys(ref, ns, keys)


def _meta_matches(vec: dict, owner_id: str, identity: Identity) -> bool:
    m = vec.get("metadata") or {}
    return m.get("ownerId") == owner_id and m.get("embeddingProvider") == identity.provider and m.get("embeddingModel") == identity.model


def _metadata(r: VectorRecord) -> dict[str, Any]:
    """The minimum retrieval needs. Deliberately no text, filename, page or section: those are read from PostgreSQL."""
    return {"ownerId": r.owner_id, "documentId": r.document_id, "processingVersion": r.processing_version,
            "embeddingProvider": r.identity.provider, "embeddingModel": r.identity.model}


def _unavailable(path: str, status: int | None) -> AppError:
    return AppError(ErrorCode.VECTOR_STORE_UNAVAILABLE, diagnostics={"endpoint": path, **({"status": status} if status else {})})


def _from_status(path: str, status: int, retry_after: str | None) -> AppError:
    diag = {"endpoint": path, "status": status}
    if status == 429:
        wait = None
        if retry_after and retry_after.strip().isdigit():
            wait = min(int(retry_after.strip()), int(RETRY_AFTER_CAP))
        return AppError(ErrorCode.VECTOR_STORE_RATE_LIMITED, retry_after_seconds=wait, diagnostics=diag)
    if status in (401, 403):
        return AppError(ErrorCode.VECTOR_STORE_AUTH, retryable=False, diagnostics=diag)
    if status >= 500 or status in (408, 409):
        return _unavailable(path, status)
    return AppError(ErrorCode.VECTOR_STORE_ERROR, retryable=False, diagnostics=diag)
