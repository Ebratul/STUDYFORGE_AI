"""Optional LangSmith tracing. OFF by default. Content is hidden unless LANGSMITH_INCLUDE_CONTENT=true; keys are never traced.

Live LangSmith could not be exercised in development (no account/key): only this configuration logic is unit-tested.
"""

from __future__ import annotations

import os
from collections.abc import Callable, MutableMapping
from typing import Any

from app.config import Settings
from app.redact import scrub_obj


def tracing_env(settings: Settings) -> dict[str, str]:
    """The environment variables that implement the policy (pure function; unit-tested)."""
    if not (settings.langsmith_tracing and settings.langsmith_api_key.get_secret_value()):
        # force OFF even if the ambient environment tried to enable it
        return {"LANGSMITH_TRACING": "false", "LANGCHAIN_TRACING_V2": "false", "LANGSMITH_TRACING_V2": "false"}
    hide = "false" if settings.langsmith_include_content else "true"
    return {
        "LANGSMITH_TRACING": "false",  # we attach an explicit tracer (below); avoids double tracing by ambient auto-detection
        "LANGCHAIN_TRACING_V2": "false",
        "LANGSMITH_PROJECT": settings.langsmith_project,
        "LANGSMITH_HIDE_INPUTS": hide,
        "LANGSMITH_HIDE_OUTPUTS": hide,
        "LANGCHAIN_HIDE_INPUTS": hide,
        "LANGCHAIN_HIDE_OUTPUTS": hide,
    }


def apply_tracing_env(settings: Settings, environ: MutableMapping[str, str] | None = None) -> dict[str, str]:
    env = os.environ if environ is None else environ
    vals = tracing_env(settings)
    env.update(vals)
    return vals


def tracing_enabled(settings: Settings) -> bool:
    return bool(settings.langsmith_tracing and settings.langsmith_api_key.get_secret_value())


def _scrub_hook(payload: Any) -> Any:
    return scrub_obj(payload)


def _hide_all(_payload: Any) -> dict:
    return {}


def make_hooks(settings: Settings) -> tuple[Callable[[Any], Any], Callable[[Any], Any]]:
    """(hide_inputs, hide_outputs) for the LangSmith client: drop everything unless content tracing was explicitly enabled,
    and even then scrub key-looking values and secret-named fields."""
    if settings.langsmith_include_content:
        return _scrub_hook, _scrub_hook
    return _hide_all, _hide_all


def build_callbacks(settings: Settings) -> list[Any]:
    """[] when tracing is off (no LangSmith import, no network). Otherwise one LangChainTracer with a scrubbing client."""
    if not tracing_enabled(settings):
        return []
    from langchain_core.tracers.langchain import LangChainTracer
    from langsmith import Client

    hide_in, hide_out = make_hooks(settings)
    client = Client(api_key=settings.langsmith_api_key.get_secret_value(), hide_inputs=hide_in, hide_outputs=hide_out)
    return [LangChainTracer(client=client, project_name=settings.langsmith_project)]
