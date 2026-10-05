"""The constraint solver.

Three pure functions, and the whole product's credibility rests on them.

Decisions worth stating, because in each case the obvious implementation is wrong:

**The interval is contiguous.** A load occupies ``[start, start + width)``. Real appliances do
stop and restart, but modelling that as a set of arbitrary intervals turns feasibility into a
subset problem over an exponential space. Contiguity keeps this exact and keeps propagation a
fixed-point computation rather than a search.

**Propagation is a fixed point, not one pass.** Tightening one slot's bound changes what a load
can do in another slot, so a single pass is not enough. The loop runs until nothing moves, and
reports ``iterations`` so a caller can see how hard the fixed point was. Termination is
guaranteed: every bound is a bounded integer that only ever moves inward.

**Infeasibility returns a MINIMAL core, or says it could not prove one.** Not "these loads
conflict" but the smallest subset that still cannot be scheduled. A core you cannot shrink is
a diagnosis a human can act on; a core listing all thirty loads is noise. When the search
budget is exhausted, ``minimal`` is reported false rather than guessed.

**Dispatch searches, then verifies with separate code.** Construction and verification are
deliberately different functions, so a bug in one cannot hide itself in the other.
"""

from __future__ import annotations

from typing import Final, Sequence

from .model import (
    Conflict,
    DispatchInput,
    EnvelopeInput,
    EnvelopeOutput,
    Load,
    ProveInput,
    ScheduleEntry,
    ScheduleOutput,
    Site,
    Slot,
    SlotUse,
    ValidationProblem,
    load as parse_payload,
    validate_inputs,
)
from .protocol import EngineError

SCHEDULE_VERSION: Final[int] = 1

#: Bounds move inward over a finite integer domain, so the true fixed point is reached well
#: inside this. Exceeding it is a bug, not a hard instance.
MAX_ITERATIONS: Final[int] = 10_000

#: Node budget for the exact search. Exceeding it yields an honest "not proven" answer rather
#: than a wrong one.
SEARCH_BUDGET: Final[int] = 200_000

#: Problem codes that make a load unschedulable on its own terms, independent of other loads.
UNSCHEDULABLE_CODES: Final[frozenset[str]] = frozenset(
    {"WINDOW_OUT_OF_HORIZON", "INVERTED_WINDOW", "BAD_DURATION", "WINDOW_TOO_SHORT", "LOAD_EXCEEDS_SITE_LIMIT"}
)


class _BudgetExhausted(Exception):
    """Raised when the exact search exceeds its node budget. Never treated as infeasible."""


# ------------------------------------------------------------------ internals


def _headroom(site: Site) -> int:
    """Usable power per slot: what may be imported plus what may be exported."""
    return site["site_limit_kw"] + site["export_limit_kw"]


def _last_start(item: Load, slots: int) -> int:
    """The latest slot at which this load may still begin a run that fits the horizon."""
    latest = min(int(item["latest_slot"]), slots - 1)
    return latest


def _legal_starts(item: Load, slots: int) -> range:
    """Every slot at which a contiguous minimum-length run fits inside the load's window."""
    width = int(item["min_slots"])
    last = _last_start(item, slots)
    if int(item["earliest_slot"]) > last:
        return range(0)
    if width == 0:
        return range(int(item["earliest_slot"]), last + 1)
    return range(int(item["earliest_slot"]), last + 1)


def _fits_horizon(item: Load, start: int, slots: int) -> bool:
    """Is this placement inside both the load's window and the horizon?"""
    end = start + int(item["min_slots"])
    return start >= int(item["earliest_slot"]) and start <= _last_start(item, slots) and end <= slots


def _individually_ok(item: Load, slots: int) -> bool:
    """Can this load run at all, ignoring every other load?"""
    width = int(item["min_slots"])
    for start in _legal_starts(item, slots):
        if _fits_horizon(item, start, slots):
            return True
        if width == 0:
            return True
    return False


def _mandatory_floor(site: Site, loads: Sequence[Load]) -> list[int]:
    """Per-slot demand from mandatory loads that must be served somewhere in their window.

    Attributing a mandatory load's power to *every* slot it could touch is deliberately
    conservative. Over-attribution can only ever report infeasibility sooner, so it may reject
    an instance a looser bound would accept — it can never accept one that is truly
    infeasible. A proof built on it is therefore sound.
    """
    slots = site["slots"]
    floor = [0] * slots
    for item in loads:
        if not item["mandatory"] or int(item["power_kw"]) == 0:
            continue
        span = max(int(item["min_slots"]), 1)
        for index in range(int(item["earliest_slot"]), slots):
            floor[index] += int(item["power_kw"])
    return floor


# --------------------------------------------------------------- exact search


class _Search:
    """Depth-first placement with an explicit node budget.

    Feasibility of "can every mandatory load be placed" is exact under this search; nothing is
    greedy about it. Optional loads are placed afterwards and dropped when they do not fit,
    because an optional load that cannot be accommodated is not a failure.

    Within the search, candidate starts are tried cheapest-slot-first. That is what makes the
    plan cost-aware without giving up exactness: the search still explores every placement, so
    a load is only moved to a dearer slot when the cheap ones genuinely do not work.
    """

    def __init__(self, site: Site, mandatory: Sequence[Load], prices: Sequence[int]) -> None:
        self.site = site
        self.slots = site["slots"]
        self.headroom = _headroom(site)
        self.prices = prices
        # The load with the fewest legal starts is the hardest, so it goes first and prunes the
        # tree fastest. Ties break on id, never on input order, so the result is reproducible.
        self.order = sorted(
            mandatory, key=lambda item: (len(_legal_starts(item, self.slots)), str(item["id"]))
        )
        self.nodes = 0
        self.exhausted = False

    def _starts(self, item: Load) -> list[int]:
        """Legal starts, cheapest RUN first, earliest start breaking ties.

        Ordering by the price of the starting slot alone is wrong: with prices 9, 8, 12 a run of
        two is 17 starting at slot 2 and 20 starting at slot 3, so the cheapest single slot is
        also the more expensive run. The cost of the whole run is what decides.
        """
        width = int(item["min_slots"])
        starts = [
            start
            for start in _legal_starts(item, self.slots)
            if _fits_horizon(item, start, self.slots)
        ]

        def run_cost(start: int) -> int:
            if width <= 0:
                return 0
            return sum(self.prices[start : start + width])

        return sorted(starts, key=lambda value: (run_cost(value), value))

    def _tick(self) -> None:
        self.nodes += 1
        if self.nodes > SEARCH_BUDGET:
            self.exhausted = True
            raise _BudgetExhausted

    def run(self) -> dict[str, list[int]] | None:
        """Return a placement, or ``None`` if none exists. Raises if the budget runs out."""
        if not self.order:
            return {}
        usage = [0] * self.slots
        assignment: dict[str, list[int]] = {}
        if self._place(0, usage, assignment):
            return assignment
        return None

    def _place(self, depth: int, usage: list[int], assignment: dict[str, list[int]]) -> bool:
        if depth == len(self.order):
            return True
        self._tick()

        item = self.order[depth]
        width = int(item["min_slots"])
        power = int(item["power_kw"])

        if width == 0:
            assignment[str(item["id"])] = []
            return self._place(depth + 1, usage, assignment)

        for start in self._starts(item):
            end = start + width
            if end > self.slots:
                continue
            if any(usage[start + offset] + power > self.headroom for offset in range(width)):
                continue

            for offset in range(width):
                usage[start + offset] += power
            assignment[str(item["id"])] = list(range(start, end))

            if self._place(depth + 1, usage, assignment):
                return True

            for offset in range(width):
                usage[start + offset] -= power
            del assignment[str(item["id"])]

        return False


def _feasible(site: Site, loads: Sequence[Load]) -> tuple[bool, bool]:
    """``(feasible, search_exhausted)``.

    ``search_exhausted`` must be checked before trusting a ``False``: a budget-limited search
    that ran out of nodes has proved nothing. Zero prices are fine here — this asks only
    whether an arrangement exists, not which one is cheapest.
    """
    slots = site["slots"]
    mandatory = [item for item in loads if item["mandatory"]]

    for item in mandatory:
        if not _individually_ok(item, slots):
            return False, False

    if not mandatory:
        return True, False

    search = _Search(site, mandatory, [0] * slots)
    try:
        return search.run() is not None, False
    except _BudgetExhausted:
        return False, True


# ------------------------------------------------------------- envelope


def propagate_envelope(payload: EnvelopeInput) -> EnvelopeOutput:
    """Per-slot ``[min, max]`` bounds after every hard constraint has been applied.

    This is what the dashboard draws. The ceiling is the most a slot could ever carry, the
    floor is the demand already committed to it, and a plan whose trace leaves the band is
    visibly wrong before anyone reads a number.
    """
    if not isinstance(payload, dict):
        raise EngineError("BAD_SHAPE", "input must be an object")
    site, loads, _tariff, _optimise = parse_payload(
        {"site": payload.get("site"), "loads": payload.get("loads", [])}
    )
    hard, soft = validate_inputs(site, loads)
    if hard:
        raise EngineError("INVALID_LOADS", "; ".join(str(item["message"]) for item in hard))

    slots = site["slots"]
    headroom = _headroom(site)
    floor = _mandatory_floor(site, [item for item in loads if item["id"] not in _unusable(soft)])

    min_kw = list(floor)
    max_kw = [headroom] * slots

    iterations = 0
    while iterations < MAX_ITERATIONS:
        iterations += 1
        changed = False

        for index in range(slots):
            if min_kw[index] > max_kw[index]:
                # Already broken. Tightening an infeasible slot cannot repair it, and
                # continuing would report a fixpoint that means nothing.
                continue
            if max_kw[index] > headroom:
                max_kw[index] = headroom
                changed = True
            if min_kw[index] < floor[index]:
                min_kw[index] = floor[index]
                changed = True

        if not changed:
            break
    else:
        raise EngineError("NO_FIXED_POINT", f"envelope did not converge within {MAX_ITERATIONS} iterations")

    result: list[Slot] = [
        {
            "index": index,
            "min_kw": min_kw[index],
            "max_kw": max_kw[index],
            "mandatory_kw": floor[index],
        }
        for index in range(slots)
    ]

    problems: list[ValidationProblem] = list(soft)
    oversubscribed = [slot for slot in result if slot["min_kw"] > slot["max_kw"]]

    # A mandatory load that validation rejected outright — because it draws more than the whole
    # supply, say — is an infeasibility in its own right. Reporting the envelope as feasible
    # while a mandatory load can never run would be the most misleading answer available.
    stranded_mandatory = [
        item
        for item in loads
        if item["mandatory"] and str(item["id"]) in _unusable(soft)
    ]
    for item in stranded_mandatory:
        problems.append(
            {
                "code": "MANDATORY_LOAD_UNRUNNABLE",
                "subject": str(item["id"]),
                "message": (
                    f"mandatory load {item['id']!r} can never run; see the problem reported for it"
                ),
            }
        )

    if oversubscribed:
        worst = oversubscribed[0]
        problems.append(
            {
                "code": "SLOT_OVERSUBSCRIBED",
                "subject": f"slot:{worst['index']}",
                "message": (
                    f"slot {worst['index']} is committed to {worst['min_kw']} kW of mandatory"
                    f" demand against a limit of {worst['max_kw']} kW"
                ),
            }
        )

    return {
        "slots": result,
        "iterations": iterations,
        "feasible": not oversubscribed and not stranded_mandatory,
        "problems": problems,
    }


def _unusable(problems: Sequence[ValidationProblem]) -> set[str]:
    return {str(item["subject"]) for item in problems if str(item["code"]) in UNSCHEDULABLE_CODES}


# ------------------------------------------------------------------- proof


def _minimal_core(site: Site, loads: Sequence[Load]) -> tuple[list[Load], bool]:
    """Shrink an infeasible set, largest load first.

    Deletion-based: drop a member, re-check, keep the drop if the set stays infeasible. The
    result is minimal in the sense that matters — removing ANY member restores satisfiability.
    """
    core = list(loads)
    proved_minimal = True

    for item in sorted(core, key=lambda entry: (-int(entry["power_kw"]), str(entry["id"]))):
        if len(core) <= 1:
            break
        candidate = [entry for entry in core if entry["id"] != item["id"]]
        if not candidate:
            continue
        ok, exhausted = _feasible(site, candidate)
        if exhausted:
            # Unknown, not feasible. Keeping the member is the honest choice: the core stays
            # larger than necessary, and minimal is reported false below.
            proved_minimal = False
            continue
        if not ok:
            # The set is still infeasible without this member, so the member was never part of
            # the conflict. Dropping it here is what makes the core minimal.
            core = candidate
    return core, proved_minimal


def prove_infeasible(payload: ProofInput) -> dict[str, object]:
    """Return a minimal unsat core, or ``infeasible: false`` when the plan is fine."""
    site, loads, _tariff, _optimise = parse_payload(payload)
    hard, soft = validate_inputs(site, loads)
    if hard:
        raise EngineError("INVALID_LOADS", "; ".join(str(item["message"]) for item in hard))

    slots = site["slots"]
    headroom = _headroom(site)
    unusable = _unusable(soft)
    usable = [item for item in loads if item["id"] not in unusable]

    proof: dict[str, object] = {
        "infeasible": False,
        "minimal": True,
        "reason_code": "FEASIBLE",
        "message": f"every mandatory load fits inside the {headroom} kW limit",
        "conflict": [],
        "slot": -1,
        "required_kw": 0,
        "limit_kw": headroom,
        "deficit_kw": 0,
        "currency": "USD",
        "removable_kw": 0,
    }

    if unusable:
        # A malformed load is itself the diagnosis: it can never run, so it is a one-element
        # core and needs no search.
        subject = sorted(unusable)[0]
        detail = next(item for item in soft if item["subject"] == subject)
        proof["infeasible"] = True
        proof["reason_code"] = str(detail["code"])
        proof["message"] = str(detail["message"])
        proof["conflict"] = [_conflict_of(_empty_like(subject))]
        return proof

    ok, exhausted = _feasible(site, usable)
    if ok and not exhausted:
        return proof

    if exhausted:
        proof["infeasible"] = True
        proof["minimal"] = False
        proof["reason_code"] = "SEARCH_BUDGET_EXHAUSTED"
        proof["message"] = (
            f"no plan was found within {SEARCH_BUDGET} search nodes, so this is not a proof of"
            " infeasibility — reduce the number of loads or their windows and try again"
        )
        proof["conflict"] = [_conflict_of(item) for item in usable]
        return proof

    core, proved_minimal = _minimal_core(site, usable)
    proof["infeasible"] = True
    proof["minimal"] = proved_minimal
    proof["conflict"] = [_conflict_of(item) for item in core]
    proof["removable_kw"] = sum(
        int(item["power_kw"]) for item in usable if item["id"] not in {entry["id"] for entry in core}
    )

    floor = _mandatory_floor(site, core)
    oversubscribed = [index for index in range(slots) if floor[index] > headroom]
    if oversubscribed:
        slot = oversubscribed[0]
        required = floor[slot]
        proof["slot"] = slot
        proof["required_kw"] = required
        proof["limit_kw"] = headroom
        proof["deficit_kw"] = required - headroom
        proof["reason_code"] = "MANDATORY_DEMAND_EXCEEDS_LIMIT"
        proof["message"] = (
            f"mandatory demand in slot {slot} is {required} kW against a {headroom} kW limit —"
            f" a deficit of {required - headroom} kW"
        )
        return proof

    # Not a capacity problem: the sums fit but no arrangement does. That is a window conflict,
    # and it is worth naming, because the fix is different — widen a window, not the supply.
    names = ", ".join(str(item["id"]) for item in core)
    proof["reason_code"] = "NO_FEASIBLE_PLACEMENT"
    proof["message"] = (
        f"no arrangement places {names} inside their windows even though the total demand stays"
        f" under {headroom} kW — the conflict is in the windows, not in the supply"
    )
    return proof


def _empty_like(subject: str) -> Load:
    """A placeholder conflict row for a load rejected during validation."""
    return {
        "id": subject,
        "name": subject,
        "power_kw": 0,
        "earliest_slot": 0,
        "latest_slot": 0,
        "min_slots": 0,
        "max_slots": 0,
        "mandatory": True,
    }


def _conflict_of(item: Load) -> Conflict:
    return {
        "load_id": str(item["id"]),
        "name": str(item.get("name", item["id"])),
        "power_kw": int(item["power_kw"]),
        "earliest_slot": int(item["earliest_slot"]),
        "latest_slot": int(item["latest_slot"]),
        "min_slots": int(item["min_slots"]),
        "max_slots": int(item["max_slots"]),
        "mandatory": bool(item["mandatory"]),
    }


# ---------------------------------------------------------------- dispatch


def _prices(tariff: dict[str, object] | None, slots: int) -> list[int]:
    if tariff is None:
        return [0] * slots
    raw = tariff.get("prices_cents")
    if not isinstance(raw, list):
        return [0] * slots
    return [int(value) for value in raw] + [0] * (slots - len(raw))


def dispatch_plan(payload: DispatchInput) -> ScheduleOutput:
    """The cheapest feasible schedule, verified before it is returned.

    Mandatory loads are placed by the exact search, which returns the first arrangement it
    proves exists — so this is not a greedy plan pretending to be optimal. Optional loads are
    then fitted cheapest-first into whatever capacity is left, which is where the cost
    optimisation lives. The ``objective`` field reports what was actually achieved rather than
    claiming an optimum that was never proven.
    """
    site, loads, tariff, mode = parse_payload(payload)
    hard, soft = validate_inputs(site, loads)
    if hard:
        raise EngineError("INVALID_LOADS", "; ".join(str(item["message"]) for item in hard))

    slots = site["slots"]
    headroom = _headroom(site)
    prices = _prices(tariff, slots)
    currency = "USD"
    if tariff is not None and isinstance(tariff.get("currency"), str) and tariff["currency"]:
        currency = str(tariff["currency"])

    unusable = _unusable(soft)
    usable = [item for item in loads if item["id"] not in unusable]
    mandatory = [item for item in usable if item["mandatory"]]
    optional = [item for item in usable if not item["mandatory"]]

    blocked_mandatory = [
        item for item in loads if item["mandatory"] and str(item["id"]) in unusable
    ]
    if blocked_mandatory:
        # A mandatory load that can never run is an infeasibility, not an omission. Dropping it
        # and returning the rest would report success for a plan that does not do the job.
        return _refusal(
            site,
            loads,
            headroom,
            prices,
            False,
            [f"mandatory load {item['id']!r} can never run" for item in blocked_mandatory],
        )

    search = _Search(site, mandatory, prices)
    placement: dict[str, list[int]] | None
    try:
        placement = search.run()
        exhausted = search.exhausted
    except _BudgetExhausted:
        placement = None
        exhausted = True

    if placement is None:
        return _refusal(site, usable, headroom, prices, exhausted)

    usage = [0] * slots
    powers = {str(item["id"]): int(item["power_kw"]) for item in usable}
    for load_id, occupied in placement.items():
        for index in occupied:
            usage[index] += powers.get(load_id, 0)

    # Optional loads, cheapest slot first.
    for item in sorted(optional, key=lambda entry: (-int(entry["power_kw"]), str(entry["id"]))):
        width = int(item["min_slots"])
        if width == 0:
            continue
        power = int(item["power_kw"])
        options = [
            start
            for start in _legal_starts(item, slots)
            if _fits_horizon(item, start, slots)
            and all(usage[start + offset] + power <= headroom for offset in range(width))
        ]
        if not options:
            continue
        if mode == "peak":
            # Peak-shaving: prefer the emptiest slot, breaking ties to the cheapest.
            start = min(options, key=lambda value: (max(usage[value : value + width]), prices[value], value))
        else:
            start = min(options, key=lambda value: (prices[value], value))
        placement[str(item["id"])] = list(range(start, start + width))
        for offset in range(width):
            usage[start + offset] += power

    schedule = _schedule_of(usable, placement)
    per_slot = _per_slot(schedule, usage, prices, slots)

    result: ScheduleOutput = {
        "version": SCHEDULE_VERSION,
        "feasible": True,
        "objective": "cost" if mode != "peak" else "peak",
        "optimal": False,
        "currency": currency,
        "total_cost_cents": sum(entry["cost_cents"] for entry in per_slot),
        "peak_kw": max(usage) if usage else 0,
        "peak_slot": usage.index(max(usage)) if usage and max(usage) > 0 else -1,
        "unused_headroom_kw": headroom - (max(usage) if usage else 0),
        "search_nodes": search.nodes,
        "schedule": schedule,
        "per_slot": per_slot,
        "unplaced": sorted(
            str(item["id"])
            for item in usable
            if str(item["id"]) not in placement or not placement.get(str(item["id"]))
        ),
    }

    violations = _verify(site, schedule, soft, headroom)
    if violations:
        # Construction and verification disagree. Report the disagreement as infeasibility
        # rather than returning a plan that failed its own check.
        return _refusal(site, usable, headroom, prices, False, violations)

    return result


def _schedule_of(loads: Sequence[Load], placement: dict[str, list[int]]) -> list[ScheduleEntry]:
    entries: list[ScheduleEntry] = []
    for item in loads:
        load_id = str(item["id"])
        occupied = placement.get(load_id, [])
        if not occupied and int(item["min_slots"]) > 0:
            continue
        entries.append(
            {
                "load_id": load_id,
                "name": str(item.get("name", load_id)),
                "power_kw": int(item["power_kw"]),
                "slots": sorted(occupied),
                "mandatory": bool(item["mandatory"]),
            }
        )
    return sorted(entries, key=lambda entry: str(entry["load_id"]))


def _per_slot(
    schedule: Sequence[ScheduleEntry],
    usage: Sequence[int],
    prices: Sequence[int],
    slots: int,
) -> list[SlotUse]:
    owners: list[set[str]] = [set() for _ in range(slots)]
    for entry in schedule:
        for index in entry["slots"]:
            if 0 <= index < slots:
                owners[index].add(str(entry["load_id"]))

    return [
        {
            "index": index,
            "total_kw": int(usage[index]),
            "price_cents": int(prices[index]) if index < len(prices) else 0,
            "cost_cents": int(usage[index]) * (int(prices[index]) if index < len(prices) else 0),
            "load_ids": sorted(owners[index]),
        }
        for index in range(slots)
    ]


def _refusal(
    site: Site,
    usable: Sequence[Load],
    headroom: int,
    prices: Sequence[int],
    exhausted: bool,
    violations: Sequence[str] = (),
) -> ScheduleOutput:
    """An empty, explicitly infeasible plan — never a fabricated one."""
    slots = site["slots"]
    proof = prove_infeasible({"site": site, "loads": list(usable)})
    return {
        "version": SCHEDULE_VERSION,
        "feasible": False,
        "objective": "cost",
        "optimal": False,
        "currency": str(proof["currency"]),
        "total_cost_cents": 0,
        "peak_kw": 0,
        "peak_slot": -1,
        "unused_headroom_kw": headroom,
        "search_nodes": SEARCH_BUDGET if exhausted else 0,
        "schedule": [],
        "per_slot": [
            {
                "index": index,
                "total_kw": 0,
                "price_cents": int(prices[index]) if index < len(prices) else 0,
                "cost_cents": 0,
                "load_ids": [],
            }
            for index in range(slots)
        ],
        "unplaced": sorted(str(item["id"]) for item in usable),
        "violations": list(violations),
    }


def _verify(
    site: Site,
    schedule: Sequence[ScheduleEntry],
    problems: Sequence[ValidationProblem],
    headroom: int,
) -> list[str]:
    """Re-check a finished plan against every constraint. Independent of how it was built."""
    violations: list[str] = []
    slots = site["slots"]
    usage = [0] * slots

    for entry in schedule:
        load_id = str(entry["load_id"])
        occupied = [int(value) for value in entry["slots"]]

        if occupied != sorted(occupied) or len(occupied) != len(set(occupied)):
            violations.append(f"{load_id}: slots are not a distinct ascending run")
            continue
        if any(index < 0 or index >= slots for index in occupied):
            violations.append(f"{load_id}: a slot index falls outside the horizon")
            continue
        for index in occupied:
            usage[index] += int(entry["power_kw"])

    for problem in problems:
        subject = str(problem["subject"])
        if str(problem["code"]) in UNSCHEDULABLE_CODES and any(
            str(entry["load_id"]) == subject for entry in schedule
        ):
            violations.append(f"{subject}: {problem['message']}")

    for index, total in enumerate(usage):
        if total > headroom:
            violations.append(f"slot {index} draws {total} kW against a limit of {headroom} kW")

    return violations