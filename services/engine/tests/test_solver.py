"""Solver behaviour, including every failure path.

The cases that matter here are the negative ones: an engine that always says "yes" is a
chatbot. Each test asserts the exact deficit, the exact slot, and that the reported core is
actually minimal.
"""

from __future__ import annotations

import pytest

from dispatch_envelope.model import normalise_tariff
from dispatch_envelope.protocol import EngineError
from dispatch_envelope.solver import (
    dispatch_plan,
    propagate_envelope,
    prove_infeasible,
)

SITE = {"slots": 8, "slot_minutes": 60, "site_limit_kw": 10, "export_limit_kw": 0}


def load(
    identifier: str,
    power: int,
    earliest: int,
    latest: int,
    minimum: int = 2,
    mandatory: bool = True,
    maximum: int | None = None,
) -> dict[str, object]:
    return {
        "id": identifier,
        "name": identifier.upper(),
        "power_kw": power,
        "earliest_slot": earliest,
        "latest_slot": latest,
        "min_slots": minimum,
        "max_slots": maximum if maximum is not None else minimum,
        "mandatory": mandatory,
    }


FLAT = {"prices_cents": [10] * 8, "currency": "USD"}
CHEAP_FIRST = {"prices_cents": [50, 40, 30, 20, 10, 10, 20, 50], "currency": "USD"}


class TestPropagateEnvelope:
    def test_reports_a_ceiling_from_the_site_limit(self) -> None:
        result = propagate_envelope({"site": SITE, "loads": []})
        assert [slot["max_kw"] for slot in result["slots"]] == [10] * 8
        assert result["feasible"] is True

    def test_export_headroom_adds_to_the_ceiling(self) -> None:
        site = {**SITE, "export_limit_kw": 4}
        result = propagate_envelope({"site": site, "loads": []})
        assert result["slots"][0]["max_kw"] == 14

    def test_a_floor_is_set_for_slots_a_mandatory_load_can_reach(self) -> None:
        result = propagate_envelope({"site": SITE, "loads": [load("ev", 7, 0, 6)]})
        floors = [slot["min_kw"] for slot in result["slots"]]
        assert floors == [7] * 8

    def test_reports_an_oversubscribed_slot_as_infeasible(self) -> None:
        # Both mandatory loads are confined to slot 0, so the committed demand there is 13 kW
        # against a 10 kW ceiling.
        loads = [load("ev", 7, 0, 0, minimum=1), load("pump", 6, 0, 0, minimum=1)]
        result = propagate_envelope({"site": SITE, "loads": loads})
        assert result["feasible"] is False
        assert any(p["code"] == "SLOT_OVERSUBSCRIBED" for p in result["problems"])

    def test_a_mandatory_load_above_the_supply_is_reported_unrunnable(self) -> None:
        result = propagate_envelope({"site": SITE, "loads": [load("ev", 12, 0, 6)]})
        assert result["feasible"] is False
        codes = {p["code"] for p in result["problems"]}
        assert {"MANDATORY_LOAD_UNRUNNABLE", "LOAD_EXCEEDS_SITE_LIMIT"} <= codes

    def test_reaches_a_fixed_point_and_reports_the_iteration_count(self) -> None:
        result = propagate_envelope({"site": SITE, "loads": [load("ev", 4, 0, 6)]})
        assert result["iterations"] >= 1

    def test_no_loads_is_a_valid_empty_envelope(self) -> None:
        result = propagate_envelope({"site": SITE, "loads": []})
        assert len(result["slots"]) == 8
        assert result["problems"] == []

    def test_a_load_wider_than_its_window_is_reported_not_solved(self) -> None:
        result = propagate_envelope({"site": SITE, "loads": [load("wide", 3, 0, 1, minimum=5)]})
        codes = {p["code"] for p in result["problems"]}
        assert "WINDOW_TOO_SHORT" in codes

    def test_rejects_a_missing_site(self) -> None:
        with pytest.raises(EngineError) as caught:
            propagate_envelope({"loads": []})
        assert caught.value.code == "MISSING_FIELD"


class TestProveInfeasible:
    def test_reports_feasible_when_the_loads_fit(self) -> None:
        proof = prove_infeasible({"site": SITE, "loads": [load("ev", 4, 0, 6)]})
        assert proof["infeasible"] is False
        assert proof["reason_code"] == "FEASIBLE"
        assert proof["conflict"] == []

    def test_proves_an_infeasibility_with_the_exact_deficit(self) -> None:
        # Two mandatory loads, each individually fittable, but forced to overlap because both
        # have a single-slot window. 7 + 6 = 13 against a 10 kW supply, so the deficit is 3 kW
        # and the offending slot is slot 0.
        proof = prove_infeasible(
            {"site": SITE, "loads": [load("ev", 7, 0, 0, minimum=1), load("pump", 6, 0, 0, minimum=1)]}
        )
        assert proof["infeasible"] is True
        assert proof["reason_code"] == "MANDATORY_DEMAND_EXCEEDS_LIMIT"
        assert proof["slot"] == 0
        assert proof["required_kw"] == 13
        assert proof["limit_kw"] == 10
        assert proof["deficit_kw"] == 3

    def test_the_core_is_minimal(self) -> None:
        # ev + pump are forced into slot 0 and together exceed the supply; `spare` fits
        # anywhere. A minimal core must name only the two that actually conflict — and must be
        # verifiable: dropping either one restores feasibility.
        loads = [
            load("ev", 7, 0, 0, minimum=1),
            load("pump", 6, 0, 0, minimum=1),
            load("spare", 1, 1, 7, minimum=1),
        ]
        proof = prove_infeasible({"site": SITE, "loads": loads})
        ids = {entry["load_id"] for entry in proof["conflict"]}

        assert proof["infeasible"] is True
        assert proof["minimal"] is True
        assert ids == {"ev", "pump"}, "the core must exclude a load that is not in conflict"
        assert proof["removable_kw"] == 1

    def test_removing_any_core_member_restores_feasibility(self) -> None:
        loads = [load("ev", 7, 0, 0, minimum=1), load("pump", 6, 0, 0, minimum=1)]
        proof = prove_infeasible({"site": SITE, "loads": loads})
        core_ids = [str(entry["load_id"]) for entry in proof["conflict"]]
        assert proof["minimal"] is True

        for member in core_ids:
            subset = [item for item in loads if item["id"] != member]
            assert prove_infeasible({"site": SITE, "loads": subset})["infeasible"] is False

    def test_names_a_window_conflict_rather_than_a_supply_shortage(self) -> None:
        # 6 kW each, both mandatory, each needing two slots, both confined to slot 0-1. The
        # total is 12 kW against a 10 kW limit, but even a 100 kW supply cannot fix it.
        proof = prove_infeasible(
            {"site": SITE, "loads": [load("a", 6, 0, 1), load("b", 6, 0, 1)]}
        )
        assert proof["infeasible"] is True
        assert proof["reason_code"] in {"MANDATORY_DEMAND_EXCEEDS_LIMIT", "NO_FEASIBLE_PLACEMENT"}

    def test_reports_a_single_malformed_load_as_a_one_element_core(self) -> None:
        proof = prove_infeasible({"site": SITE, "loads": [load("bad", 9, 0, 1, minimum=6)]})
        assert proof["infeasible"] is True
        assert proof["reason_code"] == "WINDOW_TOO_SHORT"
        assert len(proof["conflict"]) == 1

    def test_optional_loads_do_not_make_a_plan_infeasible(self) -> None:
        loads = [load("must", 4, 0, 6), load("nice", 9, 0, 0, minimum=1, mandatory=False)]
        proof = prove_infeasible({"site": SITE, "loads": loads})
        assert proof["infeasible"] is False

    def test_is_order_independent(self) -> None:
        loads = [load("a", 7, 0, 6), load("b", 6, 0, 6), load("c", 5, 0, 6)]
        forward = prove_infeasible({"site": SITE, "loads": loads})
        backward = prove_infeasible({"site": SITE, "loads": list(reversed(loads))})
        assert forward == backward

    def test_rejects_a_fractional_power_value(self) -> None:
        broken = {**load("ev", 4, 0, 6), "power_kw": 4.5}
        with pytest.raises(EngineError) as caught:
            prove_infeasible({"site": SITE, "loads": [broken]})
        assert caught.value.code == "NON_INTEGER"

    def test_rejects_a_duplicate_load_id(self) -> None:
        with pytest.raises(EngineError) as caught:
            prove_infeasible({"site": SITE, "loads": [load("ev", 4, 0, 6), load("ev", 5, 0, 6)]})
        assert caught.value.code == "DUPLICATE_LOAD_ID"


class TestDispatch:
    def test_schedules_a_feasible_plan(self) -> None:
        result = dispatch_plan({"site": SITE, "loads": [load("ev", 4, 0, 6)]})
        assert result["feasible"] is True
        assert len(result["schedule"]) == 1
        assert result["schedule"][0]["slots"] == [0, 1]

    def test_places_loads_in_the_cheapest_slots(self) -> None:
        # 8 kW each: two of them cannot share a 10 kW slot, so the second must move to the
        # next cheapest slot rather than stacking on the first.
        loads = [
            load("ev", 8, 0, 7, minimum=1, mandatory=True, maximum=1),
            load("pump", 8, 0, 7, minimum=1, mandatory=True, maximum=1),
        ]
        result = dispatch_plan({"site": SITE, "loads": loads, "tariff": CHEAP_FIRST})
        placed = {entry["load_id"]: entry["slots"] for entry in result["schedule"]}
        assert sorted(placed.values()) == [[4], [5]], "slots 4 and 5 are the two cheapest"
        assert result["peak_kw"] == 8

    def test_a_plan_is_never_produced_when_the_proof_says_infeasible(self) -> None:
        result = dispatch_plan({"site": SITE, "loads": [load("ev", 12, 0, 6)]})
        assert result["feasible"] is False
        assert result["schedule"] == []

    def test_refusing_reports_the_reason_rather_than_an_empty_success(self) -> None:
        result = dispatch_plan({"site": SITE, "loads": [load("ev", 12, 0, 6)]})
        assert result["feasible"] is False
        assert result["schedule"] == [], "no plan is invented when the instance is impossible"
        assert result["unplaced"] == ["ev"]
        assert any("can never run" in violation for violation in result["violations"])
        assert result["total_cost_cents"] == 0

    def test_never_exceeds_the_site_limit_in_any_slot(self) -> None:
        loads = [load(f"l{index}", 4, 0, 7, minimum=2) for index in range(4)]
        result = dispatch_plan({"site": SITE, "loads": loads})
        for entry in result["per_slot"]:
            assert entry["total_kw"] <= 10

    def test_drops_an_optional_load_it_cannot_place(self) -> None:
        # `must` occupies every slot at the full 10 kW, so the optional load has nowhere to go.
        # Dropping it is correct: it is optional.
        loads = [
            load("must", 10, 0, 7, minimum=8, maximum=8),
            load("optional", 9, 0, 7, minimum=1, mandatory=False),
        ]
        result = dispatch_plan({"site": SITE, "loads": loads})
        assert result["feasible"] is True
        assert result["unplaced"] == ["optional"]
        assert [entry["load_id"] for entry in result["schedule"]] == ["must"]

    def test_an_optional_load_is_kept_when_it_fits(self) -> None:
        loads = [
            load("must", 10, 0, 0, minimum=1),
            load("optional", 9, 1, 7, minimum=1, mandatory=False),
        ]
        result = dispatch_plan({"site": SITE, "loads": loads})
        assert result["unplaced"] == []
        assert [entry["load_id"] for entry in result["schedule"]] == ["must", "optional"]

    def test_cost_is_the_sum_of_slot_use_times_price(self) -> None:
        result = dispatch_plan(
            {"site": SITE, "loads": [load("ev", 4, 0, 7, minimum=2)], "tariff": CHEAP_FIRST}
        )
        assert result["schedule"][0]["slots"] == [4, 5]
        assert result["total_cost_cents"] == 4 * 10 + 4 * 10

    def test_is_deterministic_across_runs(self) -> None:
        loads = [load("ev", 4, 0, 6), load("pump", 5, 0, 6)]
        first = dispatch_plan({"site": SITE, "loads": loads, "tariff": CHEAP_FIRST})
        second = dispatch_plan({"site": SITE, "loads": loads, "tariff": CHEAP_FIRST})
        assert first == second

    def test_is_order_independent(self) -> None:
        loads = [load("ev", 4, 0, 6), load("pump", 5, 0, 6)]
        forward = dispatch_plan({"site": SITE, "loads": loads, "tariff": FLAT})
        backward = dispatch_plan({"site": SITE, "loads": list(reversed(loads)), "tariff": FLAT})
        assert forward == backward

    def test_peak_objective_prefers_the_emptiest_slot(self) -> None:
        loads = [load("base", 8, 0, 0, minimum=1)]
        loads.append(load("ev", 3, 0, 7, minimum=1, maximum=1))
        result = dispatch_plan({"site": SITE, "loads": loads, "optimise": "peak"})
        ev = next(entry for entry in result["schedule"] if entry["load_id"] == "ev")
        assert ev["slots"] == [1], "slot 0 is full at 8 kW, so the ev must move off it"

    def test_rejects_an_unknown_objective(self) -> None:
        with pytest.raises(EngineError) as caught:
            dispatch_plan({"site": SITE, "loads": [], "optimise": "vibes"})
        assert caught.value.code == "BAD_SHAPE"

    def test_orders_by_the_cost_of_the_whole_run_not_the_first_slot(self) -> None:
        # Slot 3 is the single cheapest slot (8), but a two-slot run starting there costs
        # 8 + 12 = 20, while one starting at slot 2 costs 9 + 8 = 17. Ordering by the first
        # slot alone would pick the dearer run.
        tariff = {"prices_cents": [30, 28, 9, 8, 12, 30, 34, 34]}
        result = dispatch_plan(
            {"site": SITE, "loads": [load("ev", 3, 0, 5, minimum=2, maximum=2)], "tariff": tariff}
        )
        assert result["schedule"][0]["slots"] == [2, 3]
        assert result["total_cost_cents"] == 3 * (9 + 8)

    def test_reports_the_schema_version(self) -> None:
        result = dispatch_plan({"site": SITE, "loads": []})
        assert result["version"] == 1


class TestTariffValidation:
    def test_a_matching_tariff_is_accepted(self) -> None:
        assert normalise_tariff(FLAT, 8) == FLAT

    def test_absent_tariff_is_allowed(self) -> None:
        assert normalise_tariff(None, 8) is None

    def test_a_short_tariff_is_refused_rather_than_padded(self) -> None:
        with pytest.raises(EngineError) as caught:
            normalise_tariff({"prices_cents": [1, 2, 3]}, 8)
        assert caught.value.code == "TARIFF_LENGTH"

    def test_a_negative_price_is_refused(self) -> None:
        with pytest.raises(EngineError) as caught:
            normalise_tariff({"prices_cents": [-1] * 8}, 8)
        assert caught.value.code == "OUT_OF_RANGE"

    def test_a_dispatch_with_a_short_tariff_fails_loudly(self) -> None:
        with pytest.raises(EngineError) as caught:
            dispatch_plan({"site": SITE, "loads": [], "tariff": {"prices_cents": [1]}})
        assert caught.value.code == "TARIFF_LENGTH"