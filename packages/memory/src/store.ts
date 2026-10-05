/**
 * Flat-file persistence.
 *
 * Storage is deliberately flat-file rather than SQLite. A dispatch plan is a document a human
 * reads, edits by hand, diffs in a pull request, and pastes into an issue. One JSON file per
 * plan, written atomically, gives all four for free — and it means the store has no native
 * dependency, so `npm install` never compiles anything and a corrupt file is visible with `cat`
 * instead of hiding behind a binary format.
 *
 * The invariant this module exists to protect: a reader never observes a half-written plan.
 * Writes go to a temp file in the same directory and are then renamed, which is atomic on both
 * POSIX and Windows. A crash mid-write leaves the previous plan intact.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NotFoundError, ValidationError } from '@dispatchenvelope/core'

export interface StoredPlan {
  readonly id: string
  readonly kind: string
  readonly payload: unknown
  readonly createdAt: number
  readonly updatedAt: number
}

export interface PlanQuery {
  readonly kind?: string
  readonly limit?: number
}

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i

/**
 * A plan id becomes a filename, so it is validated rather than escaped. Rejecting is safer
 * than sanitising: `../escape` sanitises to something surprising, and a surprising plan name is
 * a bug report nobody enjoys.
 */
function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id)) {
    throw new ValidationError('plan id must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}', { id })
  }
}

function isStoredPlan(value: unknown): value is StoredPlan {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate['id'] === 'string' &&
    typeof candidate['kind'] === 'string' &&
    'payload' in candidate &&
    typeof candidate['createdAt'] === 'number' &&
    typeof candidate['updatedAt'] === 'number'
  )
}

export class PlanStore {
  readonly #dir: string

  constructor(dir = '.data/plans') {
    this.#dir = dir
    mkdirSync(this.#dir, { recursive: true })
  }

  get directory(): string {
    return this.#dir
  }

  #path(id: string): string {
    assertSafeId(id)
    return join(this.#dir, `${id}.json`)
  }

  put(plan: { id: string; kind: string; payload: unknown; now: number }): StoredPlan {
    const file = this.#path(plan.id)
    const existing = existsSync(file) ? this.read(plan.id) : undefined

    const record: StoredPlan = {
      id: plan.id,
      kind: plan.kind,
      payload: plan.payload,
      // createdAt is preserved across updates. A plan that loses its creation time on every
      // save cannot be ordered against a plan that was never edited.
      createdAt: existing?.createdAt ?? plan.now,
      updatedAt: plan.now,
    }

    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    try {
      renameSync(temp, file)
    } catch (cause) {
      rmSync(temp, { force: true })
      throw cause
    }
    return record
  }

  read(id: string): StoredPlan {
    const file = this.#path(id)
    if (!existsSync(file)) throw new NotFoundError(`no plan with id "${id}"`, { id, dir: this.#dir })

    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch (cause) {
      throw new ValidationError(`plan "${id}" is not valid JSON`, { id, cause: String(cause) })
    }
    if (!isStoredPlan(parsed)) {
      throw new ValidationError(`plan "${id}" does not match the stored shape`, { id })
    }
    return parsed
  }

  find(id: string): StoredPlan | undefined {
    return existsSync(this.#path(id)) ? this.read(id) : undefined
  }

  /** Newest first. A corrupt file is reported, never silently skipped. */
  list(query: PlanQuery = {}): readonly StoredPlan[] {
    const limit = query.limit ?? 50
    const plans: StoredPlan[] = []
    const damaged: string[] = []

    for (const entry of readdirSync(this.#dir)) {
      if (!entry.endsWith('.json')) continue
      const id = entry.slice(0, -'.json'.length)
      try {
        const plan = this.read(id)
        if (query.kind === undefined || plan.kind === query.kind) plans.push(plan)
      } catch {
        damaged.push(entry)
      }
    }

    if (damaged.length > 0) {
      throw new ValidationError('stored plans are unreadable', { files: damaged })
    }

    return plans.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, limit)
  }

  delete(id: string): boolean {
    const file = this.#path(id)
    if (!existsSync(file)) return false
    rmSync(file)
    return true
  }
}
