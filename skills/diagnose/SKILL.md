---
name: diagnose
description: Use when a Dispatch Envelope command fails or returns nothing useful, because the diagnostic order below finds the failing subsystem and its fix without guesswork.
metadata:
  version: 1.0.0
---

# Diagnose Dispatch Envelope

## When to use this

Something is broken and you do not yet know which subsystem is at fault.

## Steps

1. `dispatch-envelope doctor` — read the failing row and its **fix** line. Do not skip to step 2.
2. `dispatch-envelope tools --json` — confirms which capabilities are registered. A tool missing
   here is a registration failure, not a solver failure.
3. If a solver call fails, run the engine directly. It is a pure function over stdin/stdout, so
   there is nothing to start and nothing to stop:

   ```console
   $ echo '{"op":"dispatch","input":{"site":{"slots":2,"slotMinutes":60,"siteLimitKw":5},"loads":[]}}' | python -m dispatch_envelope
   ```

   Set `PYTHONPATH=services/engine/src` first if the module is not importable.

4. If the web app is stale, `curl -s localhost:3000/api/health` and read `checks`.

## Error codes

| Code                | Meaning                                   | First move                               |
| ------------------- | ----------------------------------------- | ---------------------------------------- |
| `VALIDATION_FAILED` | input did not match the schema            | print the schema, fix the caller         |
| `MISSING_FIELD`     | a required field was absent               | the message names the field              |
| `NON_INTEGER`       | a fractional kW, slot or price            | whole units only — this is deliberate    |
| `TARIFF_LENGTH`     | tariff length does not equal `site.slots` | fix the tariff; it is never padded       |
| `DUPLICATE_LOAD_ID` | two loads share an id                     | ids key the plan, so they must be unique |
| `UPSTREAM_FAILED`   | the Python engine returned an error       | run the op directly, read the code       |
| `TIMEOUT`           | exceeded the configured engine timeout    | raise it or make the instance smaller    |

## If a plan looks wrong

It is verified before it is returned, so a returned plan satisfies every constraint. That means
a wrong-looking plan is usually a wrong **expectation**: check `unplaced` for a dropped optional
load, and `optimal: false` — the plan is cheap and legal, not proven cheapest.

## Verify

`dispatch-envelope doctor` exits 0.
