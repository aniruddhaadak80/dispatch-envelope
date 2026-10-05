#!/usr/bin/env node
// End-to-end proof that the MCP surface really speaks MCP.
//
// A stubbed server proves nothing. This launches the real server as a child process, speaks the
// real protocol to it over stdio, and asserts on values that only a working solver can produce:
// a per-slot envelope, a verified schedule, and a minimal unsat core.
//
//   node scripts/e2e-mcp.mjs
//
// Exits non-zero on the first failed assertion.

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'bin.js')

let failures = 0

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

if (!existsSync(CLI)) {
  console.error(`${CLI} not found. Run "npm run build" first.`)
  process.exit(1)
}

const { McpClient } = await import(pathToFileURL(join(ROOT, 'packages', 'mcp', 'dist', 'client.js')).href)

console.log(`e2e: MCP over stdio against ${CLI}`)

const client = new McpClient()
await client.connect({ id: 'self', command: process.execPath, args: [CLI, 'mcp', 'serve'], enabled: true })

try {
  // --- initialize happened inside connect(); prove the protocol is live -----------
  const tools = await client.listTools()
  const names = tools.map((tool) => tool.name).sort()
  console.log(`\n  tools/list -> ${names.length} tool(s)`)
  for (const name of names) console.log(`    ${name}`)

  check('exposes at least four tools', tools.length >= 4, `got ${tools.length}`)
  check(
    'exposes the four product tools',
    ['dispatch_plan', 'dispatch_envelope', 'prove_infeasible', 'describe_engine'].every((name) =>
      names.includes(name),
    ),
    names.join(', '),
  )
  check(
    'every tool declares a JSON schema',
    tools.every((tool) => tool.inputSchema?.type === 'object'),
  )

  // --- a real call that hits the Python engine ----------------------------------
  console.log('\n  tools/call dispatch_envelope')
  const envelope = await client.callTool('dispatch_envelope', {
    site: { slots: 4, slotMinutes: 60, siteLimitKw: 10 },
    loads: [{ id: 'ev', powerKw: 7, earliestSlot: 0, latestSlot: 0, minSlots: 1, mandatory: true }],
  })
  check('envelope returns one slot per horizon slot', envelope?.slots?.length === 4)
  check('envelope ceiling is the site limit', envelope?.slots?.[0]?.maxKw === 10)
  check('envelope floor is the committed demand', envelope?.slots?.[0]?.minKw === 7)
  check('7 kW inside a 10 kW cap is feasible', envelope?.feasible === true)

  console.log('\n  tools/call dispatch_envelope (oversubscribed)')
  const tight = await client.callTool('dispatch_envelope', {
    site: { slots: 2, slotMinutes: 60, siteLimitKw: 5 },
    loads: [{ id: 'ev', powerKw: 7, earliestSlot: 0, latestSlot: 0, minSlots: 1, mandatory: true }],
  })
  check('a mandatory load above the cap is reported unrunnable', tight?.feasible === false)

  console.log('\n  tools/call dispatch_plan')
  const plan = await client.callTool('dispatch_plan', {
    site: { slots: 6, slotMinutes: 60, siteLimitKw: 7 },
    tariff: { pricesCents: [30, 28, 9, 8, 12, 30], currency: 'GBP' },
    loads: [
      { id: 'ev', powerKw: 3, earliestSlot: 0, latestSlot: 5, minSlots: 2, mandatory: true },
      { id: 'wash', powerKw: 2, earliestSlot: 0, latestSlot: 5, minSlots: 2, mandatory: false },
    ],
  })
  check('plan is feasible', plan?.feasible === true)
  check('plan schedules both loads', plan?.schedule?.length === 2)
  check(
    'plan respects the site cap in every slot',
    (plan?.perSlot ?? []).every((slot) => slot.totalKw <= 7),
  )
  check('plan reports a peak at or below the cap', plan?.peakKw <= 7, `peak ${plan?.peakKw}`)
  check(
    'the mandatory load took the cheapest slots',
    plan?.schedule?.find((entry) => entry.loadId === 'ev')?.slots?.join() === '2,3',
    JSON.stringify(plan?.schedule?.find((entry) => entry.loadId === 'ev')?.slots),
  )

  console.log('\n  tools/call prove_infeasible')
  const proof = await client.callTool('prove_infeasible', {
    site: { slots: 4, slotMinutes: 60, siteLimitKw: 10 },
    loads: [
      { id: 'heat-pump', powerKw: 7, earliestSlot: 0, latestSlot: 0, minSlots: 1, mandatory: true },
      { id: 'water-tanks', powerKw: 6, earliestSlot: 0, latestSlot: 0, minSlots: 1, mandatory: true },
      { id: 'freezer', powerKw: 2, earliestSlot: 1, latestSlot: 3, minSlots: 1, mandatory: false },
    ],
  })
  check('proof reports infeasible', proof?.infeasible === true)
  check('proof claims minimality', proof?.minimal === true)
  check('proof gives the exact deficit', proof?.deficitKw === 3, `got ${proof?.deficitKw}`)
  check('proof names the offending slot', proof?.slot === 0)
  check(
    'the core excludes the optional load',
    (proof?.conflict ?? []).length === 2 && !proof.conflict.some((entry) => entry.loadId === 'freezer'),
    JSON.stringify(proof?.conflict?.map((entry) => entry.loadId)),
  )

  console.log('\n  tools/call describe_engine')
  const catalog = await client.callTool('describe_engine', {})
  check('catalog lists the dispatch operation', 'dispatch' in (catalog?.operations ?? {}))

  console.log('\n  tools/call list_skills')
  const skills = await client.callTool('list_skills', {})
  check('skill catalog loads from disk', typeof skills?.count === 'number' && skills.count > 0)
} finally {
  await client.close()
}

console.log('')
if (failures > 0) {
  console.error(`e2e-mcp FAILED — ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('e2e-mcp PASSED — the MCP surface really works')
