import { describe, expect, it } from 'vitest'
import { parseSkill, validateSkill } from './frontmatter.js'

const VALID = `---
name: overnight-triage
description: Decide whether an overnight dispatch is worth escalating.
metadata:
  version: 1.2.0
  license: MIT
---
Escalate when the deficit is structural.
`

describe('parseSkill', () => {
  it('reads the frontmatter and the body', () => {
    const parsed = parseSkill(VALID, 'skills/overnight-triage/SKILL.md')
    expect(parsed.frontmatter.name).toBe('overnight-triage')
    expect(parsed.frontmatter.metadata?.version).toBe('1.2.0')
    expect(parsed.body).toBe('Escalate when the deficit is structural.')
  })

  it('trims the body', () => {
    const parsed = parseSkill(
      `---\nname: a-skill\ndescription: A description long enough.\n---\n\n\nbody\n\n`,
    )
    expect(parsed.body).toBe('body')
  })

  it('refuses a file that does not start with a frontmatter fence', () => {
    expect(() => parseSkill('# just markdown', 'skills/x/SKILL.md')).toThrowError(
      /skills\/x\/SKILL\.md: missing YAML frontmatter/,
    )
  })

  it('refuses an unterminated frontmatter', () => {
    expect(() => parseSkill('---\nname: a-skill\n', 'skills/x/SKILL.md')).toThrowError(
      /skills\/x\/SKILL\.md: unterminated YAML frontmatter/,
    )
  })

  it('refuses frontmatter that is not valid YAML', () => {
    expect(() => parseSkill('---\nname: [unclosed\n---\nbody', 'skills/x/SKILL.md')).toThrowError(
      /skills\/x\/SKILL\.md: frontmatter is not valid YAML/,
    )
  })

  it('refuses frontmatter that is not a mapping', () => {
    expect(() => parseSkill('---\njust a string\n---\nbody', 'skills/x/SKILL.md')).toThrowError(
      /skills\/x\/SKILL\.md: frontmatter must be a mapping/,
    )
  })

  it('refuses empty frontmatter', () => {
    expect(() => parseSkill('---\n---\nbody', 'skills/x/SKILL.md')).toThrowError(
      /skills\/x\/SKILL\.md: frontmatter must be a mapping/,
    )
  })

  it('names the source it was given, and defaults to <inline>', () => {
    expect(() => parseSkill('no frontmatter')).toThrowError(/<inline>: missing YAML frontmatter/)
  })
})

describe('validateSkill', () => {
  const origin = 'skills/x/SKILL.md'

  it('accepts a well-formed skill', () => {
    expect(validateSkill(parseSkill(VALID), origin)).toEqual([])
  })

  it('flags a name that is not kebab-case', () => {
    const issues = validateSkill(parseSkill('---\nname: Not Kebab\ndescription: Long enough.\n---\n'), origin)
    expect(issues).toHaveLength(2)
    expect(issues[0]).toContain('"name" must be kebab-case')
    expect(issues[0]).toContain('"Not Kebab"')
  })

  it('flags a missing name', () => {
    const issues = validateSkill(parseSkill('---\ndescription: Long enough.\n---\n'), origin)
    expect(issues[0]).toContain('"name" must be kebab-case')
  })

  it('flags a description that is missing or too short', () => {
    const missing = validateSkill(parseSkill('---\nname: a-skill\n---\n'), origin)
    expect(missing.some((issue) => issue.includes('"description" must be a non-trivial string'))).toBe(true)

    const short = validateSkill(parseSkill('---\nname: a-skill\ndescription: too short\n---\n'), origin)
    expect(short.some((issue) => issue.includes('"description" must be a non-trivial string'))).toBe(true)
  })

  it('flags a version that is not semver', () => {
    const issues = validateSkill(
      parseSkill('---\nname: a-skill\ndescription: Long enough.\nmetadata:\n  version: 1.2\n---\n'),
      origin,
    )
    expect(issues[0]).toContain('"metadata.version" must be semver')
    // YAML reads `1.2` as a number, and the issue reports the value as JSON.
    expect(issues[0]).toContain('got 1.2')
  })

  it('flags a missing version', () => {
    const issues = validateSkill(parseSkill('---\nname: a-skill\ndescription: Long enough.\n---\n'), origin)
    expect(issues[0]).toContain('"metadata.version" must be semver')
  })

  it('accepts a prerelease version', () => {
    const issues = validateSkill(
      parseSkill('---\nname: a-skill\ndescription: Long enough.\nmetadata:\n  version: 1.2.3-rc.1\n---\n'),
      origin,
    )
    expect(issues).toEqual([])
  })

  it('reports every problem at once', () => {
    const issues = validateSkill(parseSkill('---\nname: "Bad Name"\ndescription: short\n---\n'), origin)
    expect(issues).toHaveLength(3)
  })
})
