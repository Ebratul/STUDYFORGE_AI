# syntax=docker/dockerfile:1
# StudyForge rag_agent (FastAPI + LangGraph). Build context: ./rag_agent
#   docker build -t studyforge-rag-agent:ci rag_agent
# Internal service: never expose it publicly; only the backend calls it (bearer RAG_AGENT_TOKEN).
# Configuration is injected at RUNTIME (see .env.example). APP_ENV=production disables the mock provider.

ARG PYTHON_VERSION=3.13

FROM python:${PYTHON_VERSION}-slim-bookworm AS build
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev --no-install-project
COPY app ./app

FROM python:${PYTHON_VERSION}-slim-bookworm AS runtime
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 APP_ENV=production HOST=0.0.0.0 PORT=8100
RUN groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid app --no-create-home app
WORKDIR /app
COPY --from=build --chown=app:app /app /app
USER app
EXPOSE 8100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import os,urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('PORT','8100'), timeout=4).status == 200 else 1)"
CMD ["python", "-m", "app"]
