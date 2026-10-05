---
name: product-overview
description: Use when you need to know what Dispatch Envelope can do and which command reaches it, because the surface is wider than one README and guessing a command name wastes a turn.
metadata:
  version: 1.0.0
---

# Dispatch Envelope overview

## When to use this

You are new here and need the map, not the detail.

## The one idea

A site has a power cap and some loads that can move in time. This tool answers two questions
about that: **what is the cheapest plan**, and **if no plan exists, which exact loads are
responsible**. The second question is the one a chatbot cannot answer.

Every capability is a **Tool** in one registry. The CLI, the web app, and the MCP server are
thin transports over that registry — there is no second code path.

## The four commands that matter

| Command                          | Answers                                         |
| -------------------------------- | ----------------------------------------------- |
| `dispatch-envelope solve <file>` | the cheapest verified plan                      |
| `dispatch-envelope prove <file>` | whether a plan exists, and the minimal conflict |
| `dispatch-envelope tools --json` | every capability, with schemas                  |
| `dispatch-envelope doctor`       | whether this install is healthy                 |

Both `solve` and `prove` take a JSON instance file:

```json
{
  "site": { "slots": 12, "slotMinutes": 60, "siteLimitKw": 7, "exportLimitKw": 0 },
  "tariff": { "pricesCents": [28, 26, 24, 30, 18, 9, 8, 9, 14, 22, 31, 33] },
  "loads": [
    { "id": "ev", "powerKw": 3, "earliestSlot": 0, "latestSlot": 10, "minSlots": 4, "mandatory": true }
  ]
}
```

Ready-made instances live in `examples/`.

## Units

Power is whole kW, time is whole slots, money is whole cents per kWh. There is no float
anywhere, so nothing is ever "approximately over the limit".

## Where capability belongs

In order of preference. Adding to the core registry is the **last** option, not the first:

1. Extend an existing tool
2. Add a CLI command plus a skill
3. Add a service-gated tool with a `check_fn`
4. Add a plugin
5. Add an MCP server tool to the catalog
6. Add a new core tool

## Verify

`dispatch-envelope tools --json` lists at least four tools, and `dispatch-envelope doctor` exits 0.
