"""Named operations, and the dispatch table the host routes through.

Four operations. ``propagate_envelope`` and ``prove_infeasible`` are the claims; ``dispatch``
is the product. ``describe`` exists so a caller — a model on the other end of MCP, or the CLI
— can discover the contract instead of guessing at argument names.
"""

from __future__ import annotations

from typing import Any, Final

from .model import DispatchInput, EnvelopeInput
from .protocol import EngineError
from .solver import dispatch_plan, propagate_envelope, prove_infeasible

OPERATIONS: Final[dict[str, Any]] = {
    "propagate_envelope": propagate_envelope,
    "prove_infeasible": prove_infeasible,
    "dispatch": dispatch_plan,
    "describe": lambda _payload: _CATALOG,
}


def analyse(op: str, payload: Any) -> Any:
    handler = OPERATIONS.get(op)
    if handler is None:
        known = ", ".join(sorted(OPERATIONS))
        raise EngineError("UNKNOWN_OP", f"unknown op {op!r}; available: {known}")
    return handler(payload)


_CATALOG: Final[dict[str, Any]] = {
    "domain": "load dispatch under a hard per-slot power cap",
    "units": {"power": "kW (integer)", "time": "slots (integer)", "money": "cents per kWh (integer)"},
    "operations": {
        "propagate_envelope": {
            "required": ["site"],
            "optional": ["loads"],
            "returns": ["slots", "iterations", "feasible", "problems"],
            "summary": "per-slot [min_kw, max_kw] bounds at the constraint fixed point",
        },
        "prove_infeasible": {
            "required": ["site", "loads"],
            "returns": ["infeasible", "minimal", "reason_code", "message", "conflict", "deficit_kw"],
            "summary": "a minimal unsat core, or infeasible=false when the plan is fine",
        },
        "dispatch": {
            "required": ["site", "loads"],
            "optional": ["tariff", "optimise"],
            "returns": ["feasible", "schedule", "per_slot", "total_cost_cents", "peak_kw"],
            "summary": "a verified schedule, or an explicit refusal with the reason",
        },
        "describe": {"required": [], "summary": "this catalog"},
    },
    "rules": [
        "loads may be given in any order; the output order depends only on the set",
        "a load occupies one contiguous run of min_slots slots",
        "mandatory loads must run; optional loads are dropped rather than causing failure",
        "the same input always produces the same output — no clock, no network, no randomness",
    ],
}