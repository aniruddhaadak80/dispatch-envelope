"""The domain model, its validation, and the typed I/O boundary.

Every quantity is an ``int``. Power is in whole watts-kilowatts and time is in whole slots,
so that "does this fit" is integer arithmetic with no floating-point tolerance to argue about.
A dispatch plan that is off by 0.0000001 kW is not a plan; being off by 1 kW is a tripped
supply.
"""

from __future__ import annotations

from typing import Any, TypedDict

from .protocol import EngineError

# --------------------------------------------------------------------------- site


class Site(TypedDict):
    """The supply the site is allowed to draw, expressed per slot.

    ``slots`` is the length of the planning horizon. ``site_limit_kw`` is the cap on total
    simultaneous demand. ``export_limit_kw`` caps what may be exported — modelled as the
    negative side of the same budget, so a slot's usable headroom is
    ``site_limit_kw + export_limit_kw``.
    """

    slots: int
    slot_minutes: int
    site_limit_kw: int
    export_limit_kw: int


class Load(TypedDict, total=False):
    """One flexible load.

    ``earliest_slot``/``latest_slot`` bound when the load may START. ``min_slots``/
    ``max_slots`` bound how long it occupies. ``mandatory`` loads cannot be dropped to make a
    plan fit — they are the ones that produce an infeasibility proof.
    """

    id: str
    name: str
    power_kw: int
    earliest_slot: int
    latest_slot: int
    min_slots: int
    max_slots: int
    mandatory: bool


class Tariff(TypedDict, total=False):
    """A per-slot price, in whole minor units (cents) per kWh."""

    prices_cents: list[int]
    currency: str


# ------------------------------------------------------------------------ problems


class ValidationProblem(TypedDict):
    """A machine-readable reason the input cannot be solved."""

    code: str
    subject: str
    message: str


class Slot(TypedDict):
    """The propagated state of a single slot."""

    index: int
    min_kw: int
    max_kw: int
    mandatory_kw: int


class EnvelopeOutput(TypedDict):
    """A fixed point: per-slot bounds after all hard constraints have been applied."""

    slots: list[Slot]
    iterations: int
    feasible: bool
    problems: list[ValidationProblem]


class SlotUse(TypedDict):
    index: int
    total_kw: int
    price_cents: int
    cost_cents: int
    load_ids: list[str]


class ScheduleEntry(TypedDict):
    """Where one load was placed, or why it was not."""

    load_id: str
    name: str
    power_kw: int
    slots: list[int]
    mandatory: bool


class ScheduleOutput(TypedDict):
    """A complete plan. ``placed`` is empty when ``feasible`` is false."""

    version: int
    feasible: bool
    total_cost_cents: int
    peak_kw: int
    peak_slot: int
    unused_headroom_kw: int
    schedule: list[ScheduleEntry]
    per_slot: list[SlotUse]


class Conflict(TypedDict):
    """One load in the minimal conflicting subset."""

    load_id: str
    name: str
    power_kw: int
    earliest_slot: int
    latest_slot: int
    min_slots: int
    max_slots: int
    mandatory: bool


class ProofOutput(TypedDict):
    """An infeasibility proof.

    ``conflict`` is MINIMAL: removing any one member makes the remaining set satisfiable.
    ``minimal`` says whether that was actually established, so a caller can tell a proven
    minimal core from a best effort.
    """

    infeasible: bool
    minimal: bool
    reason_code: str
    message: str
    conflict: list[Conflict]
    slot: int
    required_kw: int
    limit_kw: int
    deficit_kw: int
    currency: str
    removable_kw: int


class DispatchInput(TypedDict, total=False):
    site: Site
    loads: list[Load]
    tariff: Tariff
    optimise: str


class EnvelopeInput(TypedDict):
    site: Site
    loads: list[Load]


class ProveInput(TypedDict):
    site: Site
    loads: list[Load]


# ------------------------------------------------------------------------ validation

MAX_SLOTS = 10_000
MAX_LOADS = 2_000
MAX_POWER_KW = 1_000_000


def _as_int(value: Any, field: str, subject: str) -> int:
    """Integers only.

    A float like ``7.5`` is rejected rather than truncated: silently dropping half a kilowatt
    is exactly the class of bug this product exists to prevent.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise EngineError("BAD_SHAPE", f"{subject}.{field} must be a number, got {type(value).__name__}")
    if isinstance(value, float) and not value.is_integer():
        raise EngineError("NON_INTEGER", f"{subject}.{field} must be a whole number, got {value!r}")
    return int(value)


def _as_bool(value: Any, field: str, subject: str) -> bool:
    if not isinstance(value, bool):
        raise EngineError("BAD_SHAPE", f"{subject}.{field} must be a boolean")
    return value


def normalise_load(raw: Any, index: int) -> Load:
    if not isinstance(raw, dict):
        raise EngineError("BAD_SHAPE", f"loads[{index}] must be an object")

    subject = f"loads[{index}]"
    missing = [key for key in ("id", "power_kw", "earliest_slot", "latest_slot", "min_slots", "max_slots") if key not in raw]
    if missing:
        raise EngineError("MISSING_FIELD", f"{subject} is missing {', '.join(missing)}")

    load_id = raw["id"]
    if not isinstance(load_id, str) or not load_id:
        raise EngineError("BAD_SHAPE", f"{subject}.id must be a non-empty string")

    result: Load = {
        "id": load_id,
        "name": raw.get("name") if isinstance(raw.get("name"), str) and raw["name"] else load_id,
        "power_kw": _as_int(raw["power_kw"], "power_kw", subject),
        "earliest_slot": _as_int(raw["earliest_slot"], "earliest_slot", subject),
        "latest_slot": _as_int(raw["latest_slot"], "latest_slot", subject),
        "min_slots": _as_int(raw["min_slots"], "min_slots", subject),
        "max_slots": _as_int(raw["max_slots"], "max_slots", subject),
        "mandatory": _as_bool(raw.get("mandatory", False), "mandatory", subject),
    }
    return result


def normalise_site(raw: Any) -> Site:
    if not isinstance(raw, dict):
        raise EngineError("BAD_SHAPE", "site must be an object")

    missing = [key for key in ("slots", "slot_minutes", "site_limit_kw") if key not in raw]
    if missing:
        raise EngineError("MISSING_FIELD", f"site is missing {', '.join(missing)}")

    site: Site = {
        "slots": _as_int(raw["slots"], "slots", "site"),
        "slot_minutes": _as_int(raw["slot_minutes"], "slot_minutes", "site"),
        "site_limit_kw": _as_int(raw["site_limit_kw"], "site_limit_kw", "site"),
        "export_limit_kw": _as_int(raw.get("export_limit_kw", 0), "export_limit_kw", "site"),
    }

    if site["slots"] <= 0 or site["slots"] > MAX_SLOTS:
        raise EngineError("OUT_OF_RANGE", f"site.slots must be 1..{MAX_SLOTS}, got {site['slots']}")
    if site["slot_minutes"] <= 0:
        raise EngineError("OUT_OF_RANGE", "site.slot_minutes must be positive")
    if site["site_limit_kw"] < 0 or site["export_limit_kw"] < 0:
        raise EngineError("OUT_OF_RANGE", "site limits cannot be negative")
    return site


def normalise_tariff(raw: Any, slots: int) -> Tariff | None:
    """A tariff is optional. When present its length must match the horizon exactly.

    A short tariff is a data error, not something to pad: padding would invent prices and
    silently produce a plan with a made-up cost.
    """
    if raw is None:
        return None
    if not isinstance(raw, dict) or "prices_cents" not in raw:
        raise EngineError("BAD_SHAPE", "tariff must be an object with prices_cents")

    prices = raw["prices_cents"]
    if not isinstance(prices, list):
        raise EngineError("BAD_SHAPE", "tariff.prices_cents must be a list")
    if len(prices) != slots:
        raise EngineError(
            "TARIFF_LENGTH",
            f"tariff.prices_cents has {len(prices)} entries but site.slots is {slots}",
        )

    normalised: list[int] = []
    for index, price in enumerate(prices):
        value = _as_int(price, f"prices_cents[{index}]", "tariff")
        if value < 0:
            raise EngineError("OUT_OF_RANGE", f"tariff.prices_cents[{index}] cannot be negative")
        normalised.append(value)

    tariff: Tariff = {"prices_cents": normalised}
    currency = raw.get("currency")
    if isinstance(currency, str) and currency:
        tariff["currency"] = currency
    return tariff


def normalise_loads(raw: Any) -> list[Load]:
    if not isinstance(raw, list):
        raise EngineError("BAD_SHAPE", "loads must be a list")
    if len(raw) > MAX_LOADS:
        raise EngineError("TOO_MANY_LOADS", f"at most {MAX_LOADS} loads are supported")

    loads = [normalise_load(item, index) for index, item in enumerate(raw)]

    seen: set[str] = set()
    for item in loads:
        if item["id"] in seen:
            raise EngineError("DUPLICATE_LOAD_ID", f"duplicate load id {item['id']!r}")
        seen.add(item["id"])

    # Sort so that the engine's output order depends only on the input set. Two callers who
    # list the same loads in different orders must get byte-identical results.
    return sorted(loads, key=lambda item: str(item["id"]))


def validate_inputs(
    site: Site, loads: list[Load]
) -> tuple[list[ValidationProblem], list[ValidationProblem]]:
    """Split malformed loads into recoverable problems and hard failures.

    A load whose window is inverted, or which cannot fit in its own window even at minimum
    duration, is a ``LOAD_UNSATISFIABLE`` problem rather than an exception: the caller wants to
    see it in a report next to the other loads, not as a stack trace.
    """
    hard: list[ValidationProblem] = []
    soft: list[ValidationProblem] = []

    for item in loads:
        if item["power_kw"] < 0:
            hard.append(
                {
                    "code": "NEGATIVE_POWER",
                    "subject": str(item["id"]),
                    "message": f"load {item['id']!r} has negative power_kw",
                }
            )
            continue
        if item["power_kw"] > MAX_POWER_KW:
            hard.append(
                {
                    "code": "POWER_TOO_LARGE",
                    "subject": str(item["id"]),
                    "message": f"load {item['id']!r} exceeds {MAX_POWER_KW} kW",
                }
            )
            continue

        # The window is the load's own reach, not the horizon. A load that may start in slots
        # 0..1 needs at least 2 slots, and a 3-slot run cannot fit there whatever the horizon
        # length is — conflating the two silently hides a broken window.
        if item["earliest_slot"] < 0 or item["latest_slot"] >= site["slots"]:
            soft.append(
                {
                    "code": "WINDOW_OUT_OF_HORIZON",
                    "subject": str(item["id"]),
                    "message": (
                        f"load {item['id']!r} window [{item['earliest_slot']},"
                        f"{item['latest_slot']}] falls outside a {site['slots']}-slot horizon"
                    ),
                }
            )
            continue

        window = int(item["latest_slot"]) - int(item["earliest_slot"]) + 1
        if item["earliest_slot"] > item["latest_slot"]:
            soft.append(
                {
                    "code": "INVERTED_WINDOW",
                    "subject": str(item["id"]),
                    "message": (
                        f"load {item['id']!r} has earliest_slot {item['earliest_slot']} >"
                        f" latest_slot {item['latest_slot']}"
                    ),
                }
            )
            continue

        if item["min_slots"] < 0 or item["max_slots"] < 1:
            soft.append(
                {
                    "code": "BAD_DURATION",
                    "subject": str(item["id"]),
                    "message": f"load {item['id']!r} has min_slots {item['min_slots']} / max_slots {item['max_slots']}",
                }
            )
            continue

        if item["min_slots"] > item["max_slots"]:
            soft.append(
                {
                    "code": "BAD_DURATION",
                    "subject": str(item["id"]),
                    "message": f"load {item['id']!r} has min_slots > max_slots",
                }
            )
            continue

        if item["min_slots"] > window:
            soft.append(
                {
                    "code": "WINDOW_TOO_SHORT",
                    "subject": str(item["id"]),
                    "message": (
                        f"load {item['id']!r} needs {item['min_slots']} slot(s) but its window"
                        f" holds {window}"
                    ),
                }
            )
            continue

        if item["power_kw"] > site["site_limit_kw"] + site["export_limit_kw"]:
            soft.append(
                {
                    "code": "LOAD_EXCEEDS_SITE_LIMIT",
                    "subject": str(item["id"]),
                    "message": (
                        f"load {item['id']!r} draws {item['power_kw']} kW, above the site limit of"
                        f" {site['site_limit_kw']} kW, so it can never run"
                    ),
                }
            )
    return hard, soft


def load(payload: Any) -> tuple[Site, list[Load], Tariff | None, str]:
    """Validate and normalise a full request payload.

    Returns ``(site, loads, tariff, optimise)``. Raises :class:`EngineError` for structurally
    invalid input; recoverable per-load problems surface later from :func:`validate_inputs`.
    """
    if not isinstance(payload, dict):
        raise EngineError("BAD_SHAPE", "input must be an object")
    # Missing and malformed are different errors: a caller that omitted the site needs to be
    # told so, not handed a type complaint about a field they never sent.
    if payload.get("site") is None:
        raise EngineError("MISSING_FIELD", "input is missing 'site'")
    if payload.get("loads") is None:
        raise EngineError("MISSING_FIELD", "input is missing 'loads'")

    site = normalise_site(payload["site"])
    loads = normalise_loads(payload["loads"])
    tariff = normalise_tariff(payload.get("tariff"), site["slots"])

    optimise = payload.get("optimise", "cost")
    if optimise not in ("cost", "peak", "earliest"):
        raise EngineError("BAD_SHAPE", f"optimise must be cost|peak|earliest, got {optimise!r}")

    return site, loads, tariff, str(optimise)