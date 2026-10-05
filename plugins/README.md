# Plugins

A plugin adds **data**, not behaviour. The manifest is the whole contract, and the loader never
executes a plugin — it reads JSON. A malformed plugin is rejected with a reason, never run.

## What a plugin is for here

Tariffs are the one part of this product that genuinely varies per site and per supplier, and
they vary as _data_. So a new supplier is a new plugin, and the solver never changes.

## Contract

```json
{
  "name": "octopus-agile",
  "version": "1.0.0",
  "description": "Agile-style half-hourly import pricing.",
  "enabled": true,
  "priority": 70,
  "capabilities": ["tariff.agile"],
  "engines": { "@dispatchenvelope/core": "0.1.0" },
  "tariff": {
    "currency": "GBP",
    "slotMinutes": 30,
    "pricesCents": [2240, 1980, 1610]
  }
}
```

| Field          | Rule                                                           |
| -------------- | -------------------------------------------------------------- |
| `name`         | kebab-case, unique across the directory                        |
| `version`      | semver                                                         |
| `description`  | at least 10 characters                                         |
| `priority`     | 0–100; the highest priority wins a contested capability        |
| `capabilities` | claimed names; a clash is reported, never silently dropped     |
| `engines`      | exact version requirements — a mismatch **rejects** the plugin |
| `tariff`       | optional; whole cents per kWh, never fractions                 |

## Using a plugin's tariff

```console
$ dispatch-envelope tools --json      # lists every plugin and its capabilities
$ dispatch-envelope mcp call list_tariffs '{"slots":14}'
```

`list_tariffs` returns each active plugin's tariff already fitted to the requested horizon. It
**repeats** the series to reach the horizon and refuses when the length does not divide it evenly,
because truncating a series is as much an invention as padding one.

## Conflict resolution

Two plugins claiming the same capability is resolved by `priority`, highest first. The loser is
reported under `shadowed` — a shadowed plugin is never silently ignored, because "why did my
tariff change?" needs an answer.

## The two shipped plugins

| Plugin          | Capability     | Shape                                       |
| --------------- | -------------- | ------------------------------------------- |
| `octopus-agile` | `tariff.agile` | 14 half-hourly prices, a representative day |
| `flat-9`        | `tariff.flat`  | a single flat price, repeated               |

## Adding one

1. `mkdir -p plugins/<name>` and write `plugin.json`.
2. Run `dispatch-envelope doctor` — the `plugins` row reports rejections with reasons.
3. `dispatch-envelope mcp call list_plugins '{}'` confirms it resolved, and shows what it shadowed.
4. Add a test if it encodes anything non-obvious. A tariff is data, so it needs no test of its own.
