import { describe, expect, it } from 'vitest'
import { describePermissions, isSatisfied, PERMISSION_RANK, rank } from './permissions.js'
import type { Permission } from './types.js'

describe('rank', () => {
  it('orders permissions from least to most privileged', () => {
    expect(rank('fs:read')).toBe(0)
    expect(rank('net:fetch')).toBe(1)
    expect(rank('env:read')).toBe(2)
    expect(rank('fs:write')).toBe(3)
    expect(rank('proc:spawn')).toBe(4)
    expect(rank('secrets:read')).toBe(5)
  })

  it('lists them in that same order', () => {
    expect([...PERMISSION_RANK].sort((a, b) => rank(a) - rank(b))).toEqual([...PERMISSION_RANK])
  })

  it('refuses to rank a permission it does not know', () => {
    // The ceiling is a maximum over ranks, so an unknown permission must not
    // get a small one: that would widen the ceiling instead of narrowing it.
    expect(rank('fs:delete' as Permission)).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe('isSatisfied', () => {
  it('accepts a tool that asks for nothing', () => {
    expect(isSatisfied([], ['fs:read'])).toBe(true)
    expect(isSatisfied([], [])).toBe(true)
  })

  it('refuses a permission above the granted ceiling', () => {
    expect(isSatisfied(['fs:write'], ['fs:read'])).toBe(false)
    expect(isSatisfied(['secrets:read'], ['net:fetch'])).toBe(false)
    expect(isSatisfied(['env:read'], ['fs:read'])).toBe(false)
  })

  it('reads the grant as a ceiling rather than a set', () => {
    // Granting secrets:read implies everything ranked below it.
    expect(isSatisfied(['fs:read'], ['secrets:read'])).toBe(true)
    expect(isSatisfied(['fs:read', 'proc:spawn'], ['secrets:read'])).toBe(true)
  })

  it('sits at the baseline when nothing is granted', () => {
    // The registry's default is an empty grant, so this is the product's
    // default posture: the lowest rank is inside the ceiling, everything
    // above it is refused.
    expect(isSatisfied(['fs:read'], [])).toBe(true)
    expect(isSatisfied(['net:fetch'], [])).toBe(false)
    expect(isSatisfied(['fs:write'], [])).toBe(false)
    expect(isSatisfied(['secrets:read'], [])).toBe(false)
  })

  it('refuses an unknown permission outright', () => {
    expect(isSatisfied(['fs:delete' as Permission], ['secrets:read'])).toBe(false)
  })
})

describe('describePermissions', () => {
  it('names the empty set', () => {
    expect(describePermissions([])).toBe('none')
  })

  it('lists permissions in escalation order', () => {
    expect(describePermissions(['secrets:read', 'fs:read', 'proc:spawn'])).toBe(
      'fs:read, proc:spawn, secrets:read',
    )
  })

  it('does not reorder the array it was given', () => {
    const permissions: Permission[] = ['secrets:read', 'fs:read']
    describePermissions(permissions)
    expect(permissions).toEqual(['secrets:read', 'fs:read'])
  })
})
