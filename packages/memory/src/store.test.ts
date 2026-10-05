import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NotFoundError, ValidationError } from '@dispatchenvelope/core'
import { afterEach, describe, expect, it } from 'vitest'
import { PlanStore } from './store.js'

const dirs: string[] = []

function fixture(): PlanStore {
  const root = mkdtempSync(join(tmpdir(), 'plans-'))
  dirs.push(root)
  return new PlanStore(join(root, 'plans'))
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('PlanStore', () => {
  it('round-trips a plan', () => {
    const store = fixture()
    store.put({ id: 'ev-night', kind: 'plan', payload: { siteLimitKw: 10 }, now: 1 })
    expect(store.read('ev-night').payload).toEqual({ siteLimitKw: 10 })
  })

  it('updates in place and preserves createdAt', () => {
    const store = fixture()
    store.put({ id: 'a', kind: 'plan', payload: { v: 1 }, now: 10 })
    store.put({ id: 'a', kind: 'plan', payload: { v: 2 }, now: 20 })

    expect(store.list()).toHaveLength(1)
    const plan = store.read('a')
    expect(plan.payload).toEqual({ v: 2 })
    expect(plan.createdAt).toBe(10)
    expect(plan.updatedAt).toBe(20)
  })

  it('lists newest first and ties break on id', () => {
    const store = fixture()
    store.put({ id: 'a', kind: 'plan', payload: {}, now: 1 })
    store.put({ id: 'b', kind: 'plan', payload: {}, now: 5 })
    store.put({ id: 'c', kind: 'plan', payload: {}, now: 5 })
    expect(store.list().map((p) => p.id)).toEqual(['b', 'c', 'a'])
  })

  it('filters by kind and honours the limit', () => {
    const store = fixture()
    store.put({ id: 'p1', kind: 'plan', payload: {}, now: 3 })
    store.put({ id: 'p2', kind: 'plan', payload: {}, now: 2 })
    store.put({ id: 't1', kind: 'tariff', payload: {}, now: 1 })

    expect(store.list({ kind: 'tariff' }).map((p) => p.id)).toEqual(['t1'])
    expect(store.list({ limit: 1 }).map((p) => p.id)).toEqual(['p1'])
  })

  it('throws NotFoundError for an unknown plan', () => {
    const store = fixture()
    expect(() => store.read('missing')).toThrowError(NotFoundError)
    expect(store.find('missing')).toBeUndefined()
  })

  it('refuses an id that could escape the directory', () => {
    const store = fixture()
    for (const id of ['../escape', 'a/b', '', '..', 'a\\b']) {
      expect(() => store.read(id)).toThrowError(ValidationError)
    }
  })

  it('reports invalid JSON rather than returning a partial plan', () => {
    const store = fixture()
    writeFileSync(join(store.directory, 'broken.json'), '{not json', 'utf8')
    expect(() => store.read('broken')).toThrowError(ValidationError)
  })

  it('rejects a file that is not a stored plan', () => {
    const store = fixture()
    writeFileSync(join(store.directory, 'wrong.json'), '{"id":"wrong"}', 'utf8')
    expect(() => store.read('wrong')).toThrowError(ValidationError)
  })

  it('names the unreadable files instead of skipping them silently', () => {
    const store = fixture()
    store.put({ id: 'good', kind: 'plan', payload: {}, now: 1 })
    writeFileSync(join(store.directory, 'broken.json'), '{not json', 'utf8')

    expect(() => store.list()).toThrowError(ValidationError)
    try {
      store.list()
    } catch (error) {
      expect((error as ValidationError).details.files).toEqual(['broken.json'])
    }
  })

  it('deletes and reports whether anything was removed', () => {
    const store = fixture()
    store.put({ id: 'a', kind: 'plan', payload: {}, now: 1 })
    expect(store.delete('a')).toBe(true)
    expect(store.delete('a')).toBe(false)
  })

  it('leaves no temp file behind after a write', () => {
    const store = fixture()
    store.put({ id: 'a', kind: 'plan', payload: {}, now: 1 })
    expect(store.list()).toHaveLength(1)
  })
})
