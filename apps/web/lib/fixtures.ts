/**
 * Reading the engine's own output.
 *
 * The fixtures under `fixtures/` are produced by the real Python engine — see
 * `scripts/gen-fixtures.mjs`. Nothing here computes anything: the web app renders what the
 * solver actually returned, which is why the deployed page can show real results without a
 * second implementation of the solver in TypeScript.
 *
 * The types are snake_case because that is the engine's wire format. Translating them here
 * would mean the deployed UI could silently disagree with the solver.
 */

export interface FixtureSlot {
  readonly index: number
  readonly min_kw: number
  readonly max_kw: number
  readonly mandatory_kw: number
}

export interface FixtureProblem {
  readonly code: string
  readonly subject: string
  readonly message: string
}

export interface FixtureEnvelope {
  readonly slots: readonly FixtureSlot[]
  readonly iterations: number
  readonly feasible: boolean
  readonly problems: readonly FixtureProblem[]
}

export interface FixtureSlotUse {
  readonly index: number
  readonly total_kw: number
  readonly price_cents: number
  readonly cost_cents: number
  readonly load_ids: readonly string[]
}

export interface FixtureEntry {
  readonly load_id: string
  readonly name: string
  readonly power_kw: number
  readonly slots: readonly number[]
  readonly mandatory: boolean
}

export interface FixturePlan {
  readonly version: number
  readonly feasible: boolean
  readonly objective: string
  readonly optimal: boolean
  readonly currency: string
  readonly total_cost_cents: number
  readonly peak_kw: number
  readonly peak_slot: number
  readonly unused_headroom_kw: number
  readonly search_nodes: number
  readonly schedule: readonly FixtureEntry[]
  readonly per_slot: readonly FixtureSlotUse[]
  readonly unplaced: readonly string[]
}

export interface FixtureConflict {
  readonly load_id: string
  readonly name: string
  readonly power_kw: number
  readonly earliest_slot: number
  readonly latest_slot: number
  readonly min_slots: number
  readonly mandatory: boolean
}

export interface FixtureProof {
  readonly infeasible: boolean
  readonly minimal: boolean
  readonly reason_code: string
  readonly message: string
  readonly conflict: readonly FixtureConflict[]
  readonly slot: number
  readonly required_kw: number
  readonly limit_kw: number
  readonly deficit_kw: number
  readonly removable_kw: number
}

export interface FixtureSite {
  readonly slots: number
  readonly slotMinutes: number
  readonly siteLimitKw: number
  readonly exportLimitKw: number
}

export interface Fixture {
  readonly id: string
  readonly source: string
  readonly site: FixtureSite
  readonly tariff: { readonly pricesCents: readonly number[]; readonly currency: string } | null
  readonly loads: readonly { readonly id: string; readonly name?: string; readonly powerKw: number }[]
  readonly envelope: FixtureEnvelope
  readonly plan: FixturePlan
  readonly proof: FixtureProof
}

import conflictFixture from '@/fixtures/overnight-conflict.json'
import tariffFixture from '@/fixtures/overnight-tariff.json'

/**
 * The known fixtures, imported statically.
 *
 * A static import rather than a dynamic read: the set is fixed, so bundling them costs nothing
 * and removes a filesystem read that would behave differently on Vercel than it does locally.
 * `npm run check:fixtures` fails the build if these files ever drift from the engine, so what
 * ships here is what the solver actually produced.
 */
const FIXTURES: Record<string, Fixture> = {
  'overnight-tariff': tariffFixture as Fixture,
  'overnight-conflict': conflictFixture as Fixture,
}

export function listFixtures(): readonly string[] {
  return Object.keys(FIXTURES)
}

export function getFixture(id: string): Fixture | null {
  return FIXTURES[id] ?? null
}
