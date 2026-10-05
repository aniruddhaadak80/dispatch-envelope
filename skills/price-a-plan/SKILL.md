---
name: price-a-plan
description: Use when you need the cheapest schedule for a site under a time-of-use tariff, because moving flexible loads into cheap slots is worth real money and the plan is verified before it is returned.
metadata:
  version: 1.0.0
---

# Price a dispatch plan

## When to use this

You have a tariff and flexible loads, and you want to know what the cheapest legal arrangement
costs.

## Steps

1. Build the instance. `tariff.pricesCents` **must** have exactly `site.slots` entries — a short
   tariff is refused rather than padded, because padding invents prices and produces a plan with a
   made-up cost.
2. `dispatch-envelope solve <file>`
3. Read `cost` for the total and the per-slot table for the shape of the day. Each row prints
   demand as a bar against the cap, so an oversubscribed plan is visible without arithmetic.

Add `"optimise": "peak"` to shave the peak instead of the cost — it spreads loads into the
emptiest slots. This matters when the supply is constrained by a transformer rather than by price.

## What the numbers mean

| Field                | Meaning                                                                          |
| -------------------- | -------------------------------------------------------------------------------- |
| `total_cost_cents`   | sum over slots of `demand x price`                                               |
| `peak_kw`            | the busiest slot — this is what trips a supply                                   |
| `unused_headroom_kw` | `site_limit_kw + export_limit_kw - peak_kw`                                      |
| `unplaced`           | optional loads that were dropped because nothing would fit                       |
| `optimal`            | false. First-fit, not proven optimal — the plan is verified, not minimal in cost |

`optimal: false` is reported deliberately. The plan is **verified** against every constraint by
code independent of the code that built it, but its cost is not claimed to be the theoretical
minimum. A tool that quietly implied optimality would be lying about what it checked.

## Mandatory versus optional

`mandatory: true` means the load must run; a plan that cannot serve it is refused outright.
`mandatory: false` (the default) means the load is dropped instead. Mark a load optional only when
serving it late or not at all is genuinely acceptable — it changes the answer from a proof to a
silent omission.

## Verify

`dispatch-envelope solve examples/overnight-tariff.json` exits 0 and prints `plan: feasible`.
