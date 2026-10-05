import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The product's identity and its shipped-surface manifest, in one typed place.
 *
 * The `SURFACES` list is the honest record of what exists. Desktop and channels are absent
 * because they were deliberately not built, not because they were forgotten — a surface listed
 * here must work, and an unbuilt one listed here would be a lie the health endpoint cannot catch.
 */
export interface Surface {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly status: 'shipped'
}

export const PRODUCT = {
  name: 'Dispatch Envelope',
  slug: 'dispatch-envelope',
  version: '0.1.0',
  tagline:
    'Prove whether a building’s flexible loads fit inside a capped supply — and prove exactly why not.',
} as const

export const SURFACES: readonly Surface[] = [
  {
    id: 'cli',
    title: 'CLI',
    summary:
      'solve, prove, tools, doctor, mcp serve, mcp call. Every capability is reachable without a browser.',
    status: 'shipped',
  },
  {
    id: 'web',
    title: 'Web',
    summary:
      'This app. The envelope band renders the solver’s own output, server-side, with no client-side loading shell.',
    status: 'shipped',
  },
  {
    id: 'mcp-server',
    title: 'MCP server',
    summary:
      'Six tools over stdio, including the solver. Any MCP client can ask this product whether a plan fits.',
    status: 'shipped',
  },
  {
    id: 'mcp-client',
    title: 'MCP client',
    summary: 'A real client used by the end-to-end script that proves the server genuinely speaks MCP.',
    status: 'shipped',
  },
  {
    id: 'skills',
    title: 'Skills catalog',
    summary: 'Markdown skills loaded from disk with frontmatter validation and a version gate.',
    status: 'shipped',
  },
  {
    id: 'plugins',
    title: 'Plugin registry',
    summary:
      'Tariff suppliers. A manifest is data, so loading one cannot execute code, and a clash is reported.',
    status: 'shipped',
  },
  {
    id: 'memory',
    title: 'Flat-file memory',
    summary: 'One JSON document per plan, written atomically. Diffable by hand and visible to `cat`.',
    status: 'shipped',
  },
  {
    id: 'engine',
    title: 'Python engine',
    summary:
      'propagate_envelope, prove_infeasible, dispatch. Pure functions: no clock, no network, no randomness.',
    status: 'shipped',
  },
]

function packageVersion(): string {
  try {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: string }
    return parsed.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export function resolveVersion(): string {
  return packageVersion()
}
