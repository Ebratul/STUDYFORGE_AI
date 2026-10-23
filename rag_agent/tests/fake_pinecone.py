"""An in-process stand-in for the Pinecone data-plane REST API (httpx.MockTransport). No network, no real index.

Behaviour that matters to PineconeStore is modelled: per-namespace storage, metadata filters ($eq/$in), cosine scores, id listing with
pagination, eventual consistency (records become fetchable only after N fetch calls), scripted faults, and a request log for assertions.
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable
from urllib.parse import parse_qsl, urlparse

import httpx

API_KEY = "pcsk_TESTKEY_do_not_leak_0123456789abcdef"


class FakePinecone:
    def __init__(self, hosts: dict[str, int]) -> None:
        """hosts: index host -> its dimension."""
        self.hosts = hosts
        self.data: dict[tuple[str, str], dict[str, dict]] = {}  # (host, namespace) -> id -> {values, metadata}
        self.requests: list[dict] = []
        self.faults: list[Callable[[httpx.Request, dict], httpx.Response | Exception | None]] = []
        self.invisible_fetches = 0  # the next N fetch calls report nothing (eventual consistency)
        self.always_invisible = False
        self.metric: str | None = "cosine"  # what describe_index_stats reports (None = the field is absent)
        self.reported_dimension: dict[str, int] = {}  # host -> a dimension different from the one the index really has (misconfiguration)

    # ---------------------------------------------------------------------------------------------------- plumbing
    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self._handle))

    def ns(self, host: str, namespace: str) -> dict[str, dict]:
        return self.data.setdefault((host, namespace), {})

    def all_ids(self, host: str | None = None) -> set[tuple[str, str]]:
        return {(ns, i) for (h, ns), recs in self.data.items() if host in (None, h) for i in recs}

    def fail_next(self, status: int, times: int = 1, *, path: str | None = None, headers: dict | None = None) -> None:
        """Answer the next `times` matching requests with `status` (then behave normally)."""
        left = {"n": times}

        def fault(req: httpx.Request, body: dict):
            if left["n"] > 0 and (path is None or req.url.path == path):
                left["n"] -= 1
                return httpx.Response(status, json={"code": status, "message": "scripted fault", "details": []}, headers=headers or {})
            return None

        self.faults.append(fault)

    def raise_next(self, exc: Exception, times: int = 1, *, path: str | None = None) -> None:
        left = {"n": times}

        def fault(req: httpx.Request, body: dict):
            if left["n"] > 0 and (path is None or req.url.path == path):
                left["n"] -= 1
                return exc
            return None

        self.faults.append(fault)

    def requests_to(self, path: str) -> list[dict]:
        return [r for r in self.requests if r["path"] == path]

    # ---------------------------------------------------------------------------------------------------- server
    def _handle(self, req: httpx.Request) -> httpx.Response:
        host = req.url.host
        body = json.loads(req.content) if req.content else {}
        query = parse_qsl(urlparse(str(req.url)).query)
        self.requests.append({"method": req.method, "host": host, "path": req.url.path, "body": body, "query": query, "headers": dict(req.headers),
                              "url": str(req.url), "size": len(req.content or b"")})
        if host not in self.hosts:
            return httpx.Response(404, json={"message": "unknown host"})
        if req.headers.get("api-key") != API_KEY:
            return httpx.Response(401, json={"code": 16, "message": "Invalid API Key"})
        for f in list(self.faults):
            out = f(req, body)
            if isinstance(out, Exception):
                raise out
            if out is not None:
                return out
        route = (req.method, req.url.path)
        dim = self.hosts[host]
        if route == ("POST", "/vectors/upsert"):
            recs = self.ns(host, body.get("namespace", ""))
            for v in body["vectors"]:
                if len(v["values"]) != dim:
                    return httpx.Response(400, json={"code": 3, "message": f"Vector dimension {len(v['values'])} does not match the dimension of the index {dim}"})
                recs[v["id"]] = {"values": v["values"], "metadata": v.get("metadata", {})}
            return httpx.Response(200, json={"upsertedCount": len(body["vectors"])})
        if route == ("POST", "/query"):
            if len(body["vector"]) != dim:
                return httpx.Response(400, json={"code": 3, "message": "dimension mismatch"})
            recs = self.ns(host, body.get("namespace", ""))
            scored = [(_cos(body["vector"], r["values"]), i) for i, r in recs.items() if _match(r["metadata"], body.get("filter") or {})]
            scored.sort(key=lambda x: (-x[0], x[1]))
            return httpx.Response(200, json={"matches": [{"id": i, "score": s} for s, i in scored[: body["topK"]]], "namespace": body.get("namespace", "")})
        if route == ("GET", "/vectors/fetch"):
            ns = dict(query).get("namespace", "")
            ids = [v for k, v in query if k == "ids"]
            if self.always_invisible or self.invisible_fetches > 0:
                self.invisible_fetches = max(0, self.invisible_fetches - 1)
                return httpx.Response(200, json={"vectors": {}, "namespace": ns})
            recs = self.ns(host, ns)
            return httpx.Response(200, json={"vectors": {i: {"id": i, "metadata": recs[i]["metadata"]} for i in ids if i in recs}, "namespace": ns})
        if route == ("GET", "/vectors/list"):
            q = dict(query)
            if (host, q.get("namespace", "")) not in self.data:
                return httpx.Response(404, json={"code": 5, "message": "Namespace not found"})
            ids = sorted(i for i in self.ns(host, q.get("namespace", "")) if i.startswith(q.get("prefix", "")))
            start = int(q.get("paginationToken", "0"))
            limit = int(q.get("limit", "100"))
            page = ids[start : start + limit]
            out: dict = {"vectors": [{"id": i} for i in page], "namespace": q.get("namespace", "")}
            if start + limit < len(ids):
                out["pagination"] = {"next": str(start + limit)}
            return httpx.Response(200, json=out)
        if route == ("POST", "/describe_index_stats"):
            total = sum(len(v) for (h, _n), v in self.data.items() if h == host)
            return httpx.Response(200, json={"namespaces": {n: {"vectorCount": len(v)} for (h, n), v in self.data.items() if h == host},
                                             "dimension": self.reported_dimension.get(host, dim), "indexFullness": 0, "totalVectorCount": total,
                                             **({"metric": self.metric} if self.metric else {})})
        if route == ("POST", "/vectors/delete"):
            ns_name = body.get("namespace", "")
            if body.get("deleteAll"):
                if (host, ns_name) not in self.data:
                    return httpx.Response(404, json={"code": 5, "message": "Namespace not found"})
                del self.data[(host, ns_name)]
                return httpx.Response(200, json={})
            if len(body.get("ids", [])) > 1000:
                return httpx.Response(400, json={"code": 3, "message": "too many ids"})
            recs = self.ns(host, ns_name)
            for i in body.get("ids", []):
                recs.pop(i, None)
            return httpx.Response(200, json={})
        return httpx.Response(404, json={"message": "no such route"})


def _cos(a, b) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na, nb = math.sqrt(sum(x * x for x in a)), math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def _match(meta: dict, flt: dict) -> bool:
    for key, cond in flt.items():
        val = meta.get(key)
        if "$eq" in cond and val != cond["$eq"]:
            return False
        if "$in" in cond and val not in cond["$in"]:
            return False
    return True
