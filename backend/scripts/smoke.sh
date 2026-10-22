#!/usr/bin/env bash
# Post-deployment smoke test. READ-ONLY: only GET/HEAD requests, no credentials, no data created — safe against production.
# Usage:  smoke.sh FRONTEND_URL [BACKEND_URL] [RAG_AGENT_URL]
#   or:   FRONTEND_URL=... BACKEND_URL=... RAG_AGENT_URL=... smoke.sh
# BACKEND_URL / RAG_AGENT_URL are internal services: omit them when they are not reachable from where you run this
# (the frontend proxy check below still covers the backend through the public origin).
# Exit code 0 = all checks passed, 1 = at least one check failed.
set -uo pipefail

FRONTEND_URL="${1:-${FRONTEND_URL:-}}"; BACKEND_URL="${2:-${BACKEND_URL:-}}"; RAG_AGENT_URL="${3:-${RAG_AGENT_URL:-}}"
[ -n "$FRONTEND_URL" ] || { echo "usage: smoke.sh FRONTEND_URL [BACKEND_URL] [RAG_AGENT_URL]" >&2; exit 2; }
FRONTEND_URL="${FRONTEND_URL%/}"; BACKEND_URL="${BACKEND_URL%/}"; RAG_AGENT_URL="${RAG_AGENT_URL%/}"
FAILS=0

ok()   { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILS=$((FAILS + 1)); }
code() { local c; c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@" 2>/dev/null)"; echo "${c:-000}"; }
hdrs() { curl -sI --max-time 15 "$1" 2>/dev/null | tr -d '\r'; }
expect_code() { # label expected-regex url
  local got; got="$(code "$3")"
  if [[ "$got" =~ ^($2)$ ]]; then ok "$1 ($got)"; else fail "$1: expected $2, got $got"; fi
}
expect_body() { # label url grep-pattern
  if curl -s --max-time 15 "$2" 2>/dev/null | grep -q "$3"; then ok "$1"; else fail "$1"; fi
}

echo "Frontend $FRONTEND_URL"
expect_code "GET /login" 200 "$FRONTEND_URL/login"
H="$(hdrs "$FRONTEND_URL/login")"
for h in "x-content-type-options: nosniff" "x-frame-options" "strict-transport-security" "content-security-policy" "referrer-policy"; do
  if grep -qi "^$h" <<<"$H"; then ok "header $h"; else fail "missing header $h"; fi
done
if grep -qi '^x-powered-by' <<<"$H"; then fail "x-powered-by is exposed"; else ok "no x-powered-by"; fi
expect_code "unauthenticated /exams is redirected to sign-in" "30[1278]" "$FRONTEND_URL/exams"
expect_code "unauthenticated /admin does not reveal itself" "30[1278]|404" "$FRONTEND_URL/admin"
expect_code "proxy: unauthenticated /api/exams" "401|404" "$FRONTEND_URL/api/exams"
expect_code "proxy: unauthenticated /api/admin/overview" "401|404" "$FRONTEND_URL/api/admin/overview"
expect_code "proxy: unauthenticated /api/groups" "401|404" "$FRONTEND_URL/api/groups"

if [ -n "$BACKEND_URL" ]; then
  echo "Backend $BACKEND_URL"
  expect_body "GET /api/health" "$BACKEND_URL/api/health" '"status":"ok"'
  expect_code "GET /api/ready" 200 "$BACKEND_URL/api/ready"
  expect_body "ready body has no internals" "$BACKEND_URL/api/ready" '"status":"ready"'
  if curl -s --max-time 15 "$BACKEND_URL/api/ready" | grep -qiE 'postgres|password|secret|token|DATABASE_URL'; then fail "/api/ready leaks internals"; else ok "/api/ready leaks nothing"; fi
  expect_code "unauthenticated /api/exams" "401|404" "$BACKEND_URL/api/exams"
  expect_code "unauthenticated /api/admin/overview" "401|404" "$BACKEND_URL/api/admin/overview"
  expect_code "unauthenticated /api/conversations" "401|404" "$BACKEND_URL/api/conversations"
  if hdrs "$BACKEND_URL/api/health" | grep -qi '^x-powered-by'; then fail "backend exposes x-powered-by"; else ok "backend: no x-powered-by"; fi
fi

if [ -n "$RAG_AGENT_URL" ]; then
  echo "rag_agent $RAG_AGENT_URL"
  expect_body "GET /health" "$RAG_AGENT_URL/health" '"status":"ok"'
  expect_code "GET /ready (database reachable)" 200 "$RAG_AGENT_URL/ready"
  expect_code "GET /v1/providers requires the service token" 401 "$RAG_AGENT_URL/v1/providers"
fi

echo
if [ "$FAILS" -eq 0 ]; then echo "smoke: PASS"; exit 0; else echo "smoke: $FAILS check(s) FAILED"; exit 1; fi
