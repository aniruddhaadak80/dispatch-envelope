from __future__ import annotations

import io
import json

import pytest

from dispatch_envelope.__main__ import handle
from dispatch_envelope.analysis import OPERATIONS, analyse
from dispatch_envelope.protocol import EngineError, dispatch, read_request, write_response

SITE = {"slots": 4, "slot_minutes": 60, "site_limit_kw": 10, "export_limit_kw": 0}
LOAD = {
    "id": "ev",
    "power_kw": 4,
    "earliest_slot": 0,
    "latest_slot": 3,
    "min_slots": 1,
    "max_slots": 1,
    "mandatory": True,
}


class TestReadRequest:
    def test_parses_a_valid_request(self) -> None:
        op, payload = read_request(io.StringIO('{"op":"dispatch","input":{"site":{},"loads":[]}}'))
        assert op == "dispatch"
        assert payload["loads"] == []

    @pytest.mark.parametrize(
        ("raw", "code"),
        [
            ("", "EMPTY_INPUT"),
            ("{not json", "BAD_JSON"),
            ("[1,2,3]", "BAD_SHAPE"),
            ('{"input":1}', "MISSING_OP"),
            ('{"op":"","input":1}', "MISSING_OP"),
        ],
    )
    def test_rejects_malformed_input_with_a_stable_code(self, raw: str, code: str) -> None:
        with pytest.raises(EngineError) as caught:
            read_request(io.StringIO(raw))
        assert caught.value.code == code

    def test_rejects_a_body_over_the_size_limit(self) -> None:
        with pytest.raises(EngineError) as caught:
            read_request(io.StringIO("x" * (8 * 1024 * 1024 + 2)))
        assert caught.value.code == "INPUT_TOO_LARGE"


class TestWriteResponse:
    def test_writes_exactly_one_line_of_json(self) -> None:
        buffer = io.StringIO()
        write_response({"ok": True, "value": {"a": 1}, "durationMs": 2}, stream=buffer)
        lines = buffer.getvalue().strip().split("\n")
        assert len(lines) == 1
        assert json.loads(lines[0]) == {"ok": True, "value": {"a": 1}, "durationMs": 2}

    def test_writes_an_error_response_without_raising(self) -> None:
        buffer = io.StringIO()
        write_response({"ok": False, "error": {"code": "X", "message": "y"}, "durationMs": 0}, stream=buffer)
        assert json.loads(buffer.getvalue())["ok"] is False


class TestDispatchRouting:
    def test_routes_to_a_handler(self) -> None:
        assert dispatch({"echo": lambda payload: payload}, "echo", 7) == 7

    def test_unknown_op_names_the_available_ones(self) -> None:
        with pytest.raises(EngineError) as caught:
            dispatch({}, "nope", None)
        assert caught.value.code == "UNKNOWN_OP"
        assert "available" in caught.value.message


class TestOperations:
    def test_every_advertised_operation_is_callable(self) -> None:
        for name, handler in OPERATIONS.items():
            assert callable(handler), f"{name} is advertised but not callable"

    def test_describe_documents_every_other_operation(self) -> None:
        catalog = analyse("describe", None)
        for name in OPERATIONS:
            if name == "describe":
                continue
            assert name in catalog["operations"]

    def test_analyse_routes_to_each_operation(self) -> None:
        assert analyse("dispatch", {"site": SITE, "loads": []})["feasible"] is True
        assert analyse("propagate_envelope", {"site": SITE, "loads": []})["feasible"] is True
        assert analyse("prove_infeasible", {"site": SITE, "loads": [LOAD]})["infeasible"] is False


class TestHandle:
    def test_handle_routes_to_the_real_operations(self) -> None:
        assert handle("dispatch", {"site": SITE, "loads": [LOAD]})["feasible"] is True

    def test_unknown_operation_is_an_error_not_a_crash(self) -> None:
        with pytest.raises(EngineError) as caught:
            handle("nope", None)
        assert caught.value.code == "UNKNOWN_OP"

    def test_a_failing_handler_propagates_its_code(self) -> None:
        with pytest.raises(EngineError) as caught:
            handle("dispatch", {"site": "not-an-object", "loads": []})
        assert caught.value.code == "BAD_SHAPE"

    def test_an_infeasible_instance_is_a_successful_call_with_a_refusal(self) -> None:
        heavy = {**LOAD, "power_kw": 40}
        result = handle("prove_infeasible", {"site": SITE, "loads": [heavy]})
        assert result["infeasible"] is True