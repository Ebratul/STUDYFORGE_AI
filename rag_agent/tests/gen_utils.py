"""Helpers for the generation tests: request payloads, a long pasted-text fixture, and a runner returning (event, data) pairs."""

from __future__ import annotations

import uuid
from typing import Any

from app.generation.schemas import CqGenBody, McqGenBody
from app.graphs.runner import make_gen_context, run_generation
from app.providers.mock import VALID_KEY
from app.providers.registry import ProviderRegistry
from tests.conftest import CANARY_KEY, make_settings

SENTENCES = [
    "Photosynthesis converts light energy into chemical energy stored in glucose within the chloroplasts of green plants.",
    "The mitochondrion is the organelle where most cellular respiration takes place and ATP is generated for the cell.",
    "Enzymes are biological catalysts that lower the activation energy required for metabolic reactions to proceed.",
    "DNA replication is semi-conservative because each new double helix keeps one original strand and one newly built strand.",
    "Osmosis describes the movement of water across a selectively permeable membrane from dilute to concentrated solutions.",
    "Natural selection favours heritable traits that improve survival and reproduction within a changing environment.",
    "The nitrogen cycle moves nitrogen between the atmosphere, soil, plants and microorganisms through fixation and decay.",
    "Red blood cells carry oxygen around the body bound to haemoglobin which gives blood its characteristic colour.",
    "Neurons transmit electrical impulses along axons and release neurotransmitters across tiny gaps called synapses.",
    "Ribosomes translate messenger RNA into chains of amino acids that fold into functional proteins inside the cytoplasm.",
    "Ecosystems depend on producers, consumers and decomposers that transfer energy through successive trophic levels.",
    "Vaccination trains the immune system by exposing it to harmless antigens so that memory cells can respond quickly later.",
    "The cell membrane is a phospholipid bilayer studded with proteins that regulate which substances enter and leave.",
    "Meiosis halves the chromosome number and shuffles alleles which produces genetically diverse gametes for reproduction.",
    "Antibiotics kill or inhibit bacteria but they have no effect on viruses which replicate inside host cells.",
    "The human heart has four chambers that keep oxygenated and deoxygenated blood separate while pumping continuously.",
    "Hormones are chemical messengers secreted by glands into the bloodstream to coordinate growth and metabolism.",
    "Biodiversity measures the variety of species genes and habitats which supports resilient and productive ecosystems.",
    "Fermentation lets yeast release energy without oxygen and produces ethanol and carbon dioxide as byproducts.",
    "Homeostasis keeps internal conditions such as temperature and blood glucose within narrow limits using feedback loops.",
]
PASTE = "\n\n".join(" ".join(SENTENCES[i : i + 4]) for i in range(0, len(SENTENCES), 4))


def payload(kind: str = "MCQ", *, grounding: str = "SOURCE_ONLY", topic: str | None = None, pasted: str | None = "default", docs=(),
            user: str = "alice", provider: str = "mock", key: str = VALID_KEY, model: str = "mock-chat", emb: bool = False,
            limits: dict | None = None, avoid=(), cross_check: bool = True, context_tokens: int | None = None, **spec: Any) -> dict:
    if pasted == "default":
        pasted = PASTE if grounding != "GENERAL" and not docs else None
    if kind == "MCQ":
        s = {"count": 4, "difficulty": "MIXED", "language": "en", "option_count": 4, "include_explanations": True, "include_short_notes": True,
             "marks": 1, "negative_marks": 0, "subject": None}
    else:
        s = {"count": 2, "mode": "WITH_ANSWERS", "structure": "stimulus_4part", "total_marks": 10, "stimulus": "required",
             "difficulty": "MIXED", "language": "en", "subject": None}
    s.update(spec)
    return {
        "request_id": uuid.uuid4().hex, "user_id": user,
        "chat": {"provider": provider, "api_key": key, "model": model, "params": {"temperature": 0.2, "top_p": None, "max_output_tokens": 2000}},
        "embedding": {"provider": "mock", "api_key": VALID_KEY, "model": "mock-embed"} if emb else None,
        "context_tokens": context_tokens, "grounding": grounding,
        "sources": {"topic": topic, "pasted_text": pasted, "document_ids": list(docs)},
        "spec": s, "avoid": list(avoid), "cross_check": cross_check, "limits": limits or {},
    }


async def run_gen(pool, p: dict, kind: str = "MCQ", *, extra=(), settings=None, limits_update: dict | None = None):
    settings = settings or make_settings()
    reg = ProviderRegistry(settings)
    for prov in extra:
        reg.register_for_tests(prov)
    body = (McqGenBody if kind == "MCQ" else CqGenBody).model_validate(p)
    if limits_update:  # bypass field bounds (e.g. sub-second timeouts) in tests
        body.limits = body.limits.model_copy(update=limits_update)
    ctx = make_gen_context(settings, reg, pool, body, kind)
    events = [ev async for ev in run_generation(ctx)]
    return events, reg


def names(events) -> list[str]:
    return [e for e, _ in events]


def result(events) -> dict:
    assert events[-1][0] == "result", events[-1]
    return events[-1][1]


def error(events) -> dict:
    assert events[-1][0] == "error", events[-1]
    return events[-1][1]


__all__ = ["CANARY_KEY", "PASTE", "error", "names", "payload", "result", "run_gen"]
