/**
 * The public facade. It re-exports the stable surface and nothing else — if a consumer can
 * reach an internal module from here, a boundary has been broken.
 *
 * Channels and providers were removed rather than re-exported empty: a package that exists only
 * to be exported is a claim that something is supported when nothing implements it. The
 * deliberate omissions are recorded in AGENTS.md.
 */
export * from '@dispatchenvelope/core'
export * from '@dispatchenvelope/skills'
export * from '@dispatchenvelope/plugins'
export * from '@dispatchenvelope/memory'
