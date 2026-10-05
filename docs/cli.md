# CLI reference

```bash
dispatch-envelope <command> [options]
```

From a fresh clone the binary is not on `PATH` yet, so use the repo-local path:

```bash
node packages/cli/dist/bin.js <command> [options]
```

## Exit codes

| Code | Meaning                                                 |
| ---- | ------------------------------------------------------- |
| `0`  | success                                                 |
| `1`  | runtime failure, **or a legitimate negative answer**    |
| `2`  | usage error (unknown command, unreadable instance file) |

`solve` and `prove` exit `1` when the instance is infeasible. That is not a crash — it is the
answer. Scripts must read stdout, not treat a non-zero exit as an error to be swallowed.

## Commands

| Command                  | Purpose                                          |
| ------------------------ | ------------------------------------------------ |
| `solve <file>`           | schedule a site; print the plan, or refuse       |
| `prove <file>`           | prove feasibility and print the minimal conflict |
| `doctor`                 | probe every subsystem, print status + fix hint   |
| `tools`                  | list registered tools with schemas               |
| `version`                | version and runtime information as JSON          |
| `mcp serve`              | run the MCP server over stdio                    |
| `mcp call <tool> <json>` | invoke one tool directly, without MCP            |

### `solve`

```bash
dispatch-envelope solve examples/overnight-tariff.json
dispatch-envelope solve examples/overnight-tariff.json --json
dispatch-envelope solve examples/overnight-tariff.json --save my-plan
```

| Option   | Effect                                              |
| -------- | --------------------------------------------------- |
| `--json` | one JSON document on stdout instead of the table    |
| `--save` | write the plan to the flat-file store under that id |

The per-slot table prints demand as a bar against the site cap, so an oversubscribed plan is
visible without doing arithmetic.

### `prove`

```bash
dispatch-envelope prove examples/overnight-conflict.json
```

Prints the reason code, whether minimality was **proven**, the offending slot with the exact
deficit, and the minimal conflicting set. `minimal: no` means the search budget was exhausted
and the output is explicitly not a proof.

## Instance files

Both commands take one JSON document:

```json
{
  "site": { "slots": 12, "slotMinutes": 60, "siteLimitKw": 7, "exportLimitKw": 0 },
  "tariff": { "pricesCents": [28, 26, 24, 30, 18, 9, 8, 9, 14, 22, 31, 33], "currency": "GBP" },
  "optimise": "cost",
  "loads": [
    {
      "id": "ev",
      "name": "EV charge",
      "powerKw": 3,
      "earliestSlot": 0,
      "latestSlot": 10,
      "minSlots": 4,
      "maxSlots": 6,
      "mandatory": true
    }
  ]
}
```

| Field                | Rule                                                             |
| -------------------- | ---------------------------------------------------------------- |
| `site.slots`         | horizon length, `>= 1`                                           |
| `site.siteLimitKw`   | cap on simultaneous demand                                       |
| `site.exportLimitKw` | optional; adds to the usable headroom                            |
| `tariff.pricesCents` | **must** have exactly `site.slots` entries — never padded        |
| `load.minSlots`      | minimum contiguous slots the load occupies                       |
| `load.mandatory`     | `true` means it must run; a plan that cannot serve it is refused |
| `load.maxSlots`      | defaults to `minSlots`                                           |

Units are whole numbers throughout. A fractional kW, slot or price is rejected as
`NON_INTEGER` rather than truncated.

Ready-made instances live in `examples/`.

## Machine-readable output

`solve`, `prove`, `tools` and `doctor` accept `--json`, which writes a single JSON document to
stdout and nothing else. Diagnostics always go to stderr, so `--json` output is always safe to
pipe into a parser.

```bash
dispatch-envelope tools --json | jq '.[] | select(.surface == "core")'
```

## The `doctor` contract

`doctor` never throws. A failing subsystem becomes a row with a status, a detail, and a **fix**
hint. The exit code is `1` if any required check failed, `0` otherwise. This is what lets it run
in CI as a smoke test without taking the build down on a missing optional credential.
