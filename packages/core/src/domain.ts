/**
 * The domain model, mirrored from the Python engine.
 *
 * These types are the contract, not a copy of it. The engine is the authority; this file is
 * what TypeScript callers, the MCP schemas, and the web app agree on. When the two drift, the
 * fixtures in `evals/` fail — which is the point of having them.
 *
 * Every quantity is an integer: power in kW, time in whole slots, money in whole cents. There
 * is no float anywhere in the domain, because "1.0000001 kW over the limit" is not a state a
 * dispatcher should have to reason about.
 */

/** The supply a site is allowed to draw, per slot. */
export interface Site {
  readonly slots: number
  readonly slotMinutes: number
  readonly siteLimitKw: number
  readonly exportLimitKw?: number
}

/**
 * One flexible load. It occupies a single contiguous run of `minSlots` slots beginning
 * somewhere in `[earliestSlot, latestSlot]`.
 *
 * `mandatory` is the load-bearing distinction: mandatory loads must be served or the plan is
 * refused, and it is their conflict that produces an infeasibility proof. Optional loads are
 * dropped instead, because a plan that serves its required loads is still a useful answer.
 */
export interface Load {
  readonly id: string
  readonly name?: string
  readonly powerKw: number
  readonly earliestSlot: number
  readonly latestSlot: number
  readonly minSlots: number
  readonly maxSlots?: number
  readonly mandatory?: boolean
}

/** A per-slot price in whole cents per kWh. Length must equal `site.slots`. */
export interface Tariff {
  readonly pricesCents: readonly number[]
  readonly currency?: string
}

export type Objective = 'cost' | 'peak' | 'earliest'

/** A machine-readable reason the input cannot be solved. */
export interface ValidationProblem {
  readonly code: string
  readonly subject: string
  readonly message: string
}

export interface Slot {
  readonly index: number
  readonly minKw: number
  readonly maxKw: number
  readonly mandatoryKw: number
}

export interface Envelope {
  readonly slots: readonly Slot[]
  readonly iterations: number
  readonly feasible: boolean
  readonly problems: readonly ValidationProblem[]
}

export interface SlotUse {
  readonly index: number
  readonly totalKw: number
  readonly priceCents: number
  readonly costCents: number
  readonly loadIds: readonly string[]
}

export interface ScheduleEntry {
  readonly loadId: string
  readonly name: string
  readonly powerKw: number
  readonly slots: readonly number[]
  readonly mandatory: boolean
}

export interface Conflict {
  readonly loadId: string
  readonly name: string
  readonly powerKw: number
  readonly earliestSlot: number
  readonly latestSlot: number
  readonly minSlots: number
  readonly maxSlots: number
  readonly mandatory: boolean
}

/**
 * An infeasibility proof.
 *
 * `minimal` is reported rather than assumed. A search that ran out of budget says so instead
 * of claiming a minimality it never established, because a proof you cannot trust is worse
 * than no proof.
 */
export interface Proof {
  readonly infeasible: boolean
  readonly minimal: boolean
  readonly reasonCode: string
  readonly message: string
  readonly conflict: readonly Conflict[]
  readonly slot: number
  readonly requiredKw: number
  readonly limitKw: number
  readonly deficitKw: number
  readonly currency: string
  readonly removableKw: number
}

export interface Schedule {
  readonly version: number
  readonly feasible: boolean
  readonly objective: Objective
  /** False whenever the plan was produced by first-fit rather than proven optimal. */
  readonly optimal: boolean
  readonly currency: string
  readonly totalCostCents: number
  readonly peakKw: number
  readonly peakSlot: number
  readonly unusedHeadroomKw: number
  readonly searchNodes: number
  readonly schedule: readonly ScheduleEntry[]
  readonly perSlot: readonly SlotUse[]
  readonly unplaced: readonly string[]
  readonly violations?: readonly string[]
}

/** A site plus its loads: the minimum an agent must supply to get any answer at all. */
export interface Instance {
  readonly site: Site
  readonly loads: readonly Load[]
  readonly tariff?: Tariff
  readonly optimise?: Objective
}

/** Total demand per slot — the number the envelope band draws. */
export function demandPerSlot(instance: Instance): number[] {
  const usage = new Array<number>(instance.site.slots).fill(0)
  for (const load of instance.loads) {
    const width = load.minSlots
    if (width <= 0) continue
    for (let start = load.earliestSlot; start < instance.site.slots; start++) {
      for (let offset = 0; offset < width; offset++) {
        const index = start + offset
        const slot = usage[index]
        if (slot !== undefined) usage[index] = slot + load.powerKw
      }
    }
  }
  return usage
}

/** Usable power per slot: what may be imported, plus what may be exported. */
export function headroomKw(site: Site): number {
  return site.siteLimitKw + (site.exportLimitKw ?? 0)
}
