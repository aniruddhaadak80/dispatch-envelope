"""The deterministic engine for Dispatch Envelope.

The domain is load dispatch under a hard power cap. A building has a site supply limit and a
set of flexible loads — an EV charger, a water heater, a pool pump — each with a power draw, a
window of slots in which it may run, and a minimum number of contiguous slots it must occupy.

The three functions in :mod:`solver` are the parts of this product that must never be a model
call. They are arithmetic and set reasoning over integers, and their correctness is checkable:

  * :func:`propagate_envelope` reaches a fixed point by repeatedly tightening per-slot bounds.
  * :func:`prove_infeasible` returns a MINIMAL conflicting subset, not just "it failed".
  * :func:`dispatch` returns the cheapest feasible assignment.

Nothing here reads a clock, the network, the filesystem, or a random number generator. Same
input, same output, always.
"""

from .protocol import EngineError, dispatch
from .model import Site, Tariff, ValidationProblem, load, normalise_site
from .solver import SCHEDULE_VERSION, dispatch_plan, propagate_envelope, prove_infeasible

__all__ = [
    "EngineError",
    "dispatch",
    "Site",
    "Tariff",
    "ValidationProblem",
    "load",
    "normalise_site",
    "SCHEDULE_VERSION",
    "dispatch_plan",
    "propagate_envelope",
    "prove_infeasible",
]
__version__ = "0.1.0"