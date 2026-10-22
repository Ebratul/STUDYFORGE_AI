"""`.env.example` must document exactly the settings `app/config.py` reads (keeps deployment docs from drifting)."""

from __future__ import annotations

import re
from pathlib import Path

from app.config import Settings

EXAMPLE = Path(__file__).resolve().parent.parent / ".env.example"


def _documented() -> set[str]:
    return set(re.findall(r"^\s*#?\s*([A-Z][A-Z0-9_]+)=", EXAMPLE.read_text(), flags=re.M))


def test_every_setting_is_documented() -> None:
    settings = {name.upper() for name in Settings.model_fields}
    assert len(settings) > 20
    assert sorted(settings - _documented()) == []


def test_example_documents_no_unknown_settings() -> None:
    settings = {name.upper() for name in Settings.model_fields}
    assert sorted(_documented() - settings) == []


def test_example_has_placeholders_only() -> None:
    text = EXAMPLE.read_text()
    assert not re.search(r"sk-[A-Za-z0-9]{20,}", text)
    assert "BEGIN PRIVATE KEY" not in text
