---
name: prove-a-conflict
description: Use when a dispatch plan will not fit and you need to know exactly which loads are responsible, because the useful answer is the minimal conflicting set with the exact deficit, not a guess about which appliance is at fault.
metadata:
  version: 1.0.0
---

# Prove why a dispatch is impossible

## When to use this

`solve` refused, or you suspect the site cannot serve its mandatory loads. Do not guess which
appliance conflicts — run the proof.

## Steps

1. Write the instance to a JSON file (see `product-overview` for the shape).
2. `dispatch-envelope prove <file>`
3. Read the output in this order:
   - `minimal: yes` — the core is proven minimal. Dropping **any one** listed load restores
     feasibility, so each one is genuinely part of the conflict.
   - `minimal: no` — the search budget was exhausted. This is **not a proof**. Reduce the number
     of loads or widen their windows and run it again.
   - `reason: MANDATORY_DEMAND_EXCEEDS_LIMIT` — a capacity problem. `slot`, `required` and
     `deficit` tell you how much supply is missing or which window to change.
   - `reason: NO_FEASIBLE_PLACEMENT` — a **window** problem, not a supply problem. The total fits;
     no arrangement does. Widening a window fixes it, and a bigger cap does not.

## Example

```console
$ dispatch-envelope prove examples/overnight-conflict.json
INFEASIBLE — mandatory demand in slot 0 is 13 kW against a 10 kW limit — a deficit of 3 kW

  reason:     MANDATORY_DEMAND_EXCEEDS_LIMIT
  minimal:    yes
  slot:       0  required 13 kW > limit 10 kW  (deficit 3 kW)

  minimal conflicting set:
    heat-pump     7 kW  window 0..0  min 1
    water-tanks   6 kW  window 0..0  min 1

  optional loads excluded from the proof: 2 kW
```

The optional `freezer-defrost` load is **absent from the core**. That is the point: it is not in
conflict, and a proof that listed it would be useless.

## Reporting to a human

Lead with the deficit and the fix, not the method. "These two loads both have to run at once
and together they need 13 kW from a 10 kW supply — move the tank heating to slot 1, or drop it
to optional" is the answer. The search internals are supporting detail.

## Verify

`dispatch-envelope prove examples/overnight-conflict.json` exits 1 and prints `minimal: yes`.
