import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Command } from 'commander'
import type { Instance, Proof, Schedule, Site } from '@dispatchenvelope/core'
import { buildToolRegistry, createContext } from './bootstrap.js'
import { doctor, renderReport } from './doctor.js'

const VERSION = '0.1.0'

function errorCode(cause: unknown): string {
  return (cause as { code?: string }).code ?? 'INTERNAL'
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function storeDir(): string {
  return resolve(process.env.PRODUCT_DATA_DIR ?? '.data', 'plans')
}

function readInstance(file: string): Instance {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(resolve(file), 'utf8'))
  } catch (cause) {
    process.stderr.write(`cannot read instance at ${file}: ${errorMessage(cause)}\n`)
    process.exit(2)
  }
  return parsed as Instance
}

/**
 * A plan is a table, because a plan is something you read against a clock. Money is printed in
 * whole cents because the engine works in whole cents and a rounded-up pound sign would imply
 * a precision the arithmetic never had.
 */
function renderPlan(plan: Schedule, site: Site): string {
  if (!plan.feasible) {
    return [
      'NO PLAN — the instance is infeasible.',
      'Run `dispatch-envelope prove <file>` for the minimal conflicting set.',
      '',
      `unplaced: ${plan.unplaced.join(', ') || '(none)'}`,
      ...(plan.violations ?? []).map((violation) => `  - ${violation}`),
    ].join('\n')
  }

  const width = site.slots
  const lines: string[] = []
  lines.push(`plan: feasible, objective ${plan.objective}, ${plan.searchNodes} search nodes`)
  lines.push(`cost: ${plan.totalCostCents}c  peak: ${plan.peakKw} kW in slot ${plan.peakSlot}`)
  lines.push('')
  lines.push('  load        kW  slots')
  for (const entry of plan.schedule) {
    const slots = entry.slots.length > 0 ? `${entry.slots[0]}..${entry.slots[entry.slots.length - 1]}` : '-'
    const flag = entry.mandatory ? '' : ' (optional)'
    lines.push(`  ${entry.name.padEnd(11)} ${String(entry.powerKw).padStart(2)}  ${slots}${flag}`)
  }
  lines.push('')
  lines.push('  slot  price  kW   headroom')
  for (const slot of plan.perSlot) {
    const bar = '#'.repeat(slot.totalKw).padEnd(site.siteLimitKw, '.')
    lines.push(
      `  ${String(slot.index).padStart(4)}  ${String(slot.priceCents).padStart(5)}  ${String(slot.totalKw).padStart(2)}  ${bar}`,
    )
  }
  if (width === 0) lines.push('  (no slots)')
  return lines.join('\n')
}

function renderProof(proof: Proof): string {
  if (!proof.infeasible) {
    return `FEASIBLE — ${proof.message}`
  }
  const lines = [`INFEASIBLE — ${proof.message}`, '']
  lines.push(`  reason:     ${proof.reasonCode}`)
  lines.push(`  minimal:    ${proof.minimal ? 'yes' : 'no (search budget exhausted — not a proof)'}`)
  if (proof.slot >= 0) {
    lines.push(
      `  slot:       ${proof.slot}  required ${proof.requiredKw} kW > limit ${proof.limitKw} kW` +
        `  (deficit ${proof.deficitKw} kW)`,
    )
  }
  if (proof.conflict.length > 0) {
    lines.push('')
    lines.push('  minimal conflicting set:')
    for (const entry of proof.conflict) {
      lines.push(
        `    ${entry.loadId.padEnd(12)} ${String(entry.powerKw).padStart(2)} kW  window ` +
          `${entry.earliestSlot}..${entry.latestSlot}  min ${entry.minSlots}`,
      )
    }
  }
  if (proof.removableKw > 0) {
    lines.push('')
    lines.push(`  optional loads excluded from the proof: ${proof.removableKw} kW`)
  }
  return lines.join('\n')
}

/** Exit codes are part of the contract: 0 ok, 1 runtime failure, 2 usage error. */
export function buildProgram(): Command {
  const program = new Command()

  program
    .name('dispatch-envelope')
    .description(
      "Dispatch Envelope — prove whether a building's flexible loads fit inside a capped supply, and prove exactly why not.",
    )
    .version(VERSION, '-v, --version', 'print the version')
    .exitOverride((error) => {
      process.exitCode = error.exitCode === 0 ? 0 : 2
      throw error
    })

  program
    .command('doctor')
    .description('diagnose every subsystem and print an actionable report')
    .option('--json', 'machine-readable output')
    .action(async () => {
      const report = await doctor()
      process.stdout.write(
        process.argv.includes('--json')
          ? `${JSON.stringify(report, null, 2)}\n`
          : `${renderReport(report)}\n`,
      )
      if (!report.ok) process.exitCode = 1
    })

  program
    .command('tools')
    .description('list the registered tools — the authoritative capability list')
    .option('--json', 'machine-readable output')
    .action(() => {
      const registry = buildToolRegistry()
      const tools = registry.list().map((tool) => ({
        name: tool.name,
        description: tool.description,
        surface: registry.surfaceOf(tool.name),
        source: registry.sourceOf(tool.name),
        permissions: tool.permissions,
        inputSchema: tool.inputSchema,
      }))
      if (process.argv.includes('--json')) {
        process.stdout.write(`${JSON.stringify(tools, null, 2)}\n`)
        return
      }
      const width = Math.max(...tools.map((t) => t.name.length), 4)
      for (const tool of tools) {
        process.stdout.write(`  ${tool.name.padEnd(width)}  [${tool.surface}]  ${tool.description}\n`)
      }
    })

  const mcp = program.command('mcp').description('Model Context Protocol commands')

  mcp
    .command('serve')
    .description('run the MCP server over stdio')
    .action(async () => {
      const { serveStdio } = await import('@dispatchenvelope/mcp')
      const registry = buildToolRegistry()
      // stdout belongs to the protocol from here on; diagnostics must go to stderr.
      await serveStdio(registry, createContext('mcp'))
    })

  mcp
    .command('call')
    .description('invoke one tool directly, without MCP')
    .argument('<tool>', 'tool name')
    .argument('<input>', 'JSON input document')
    .action(async (tool: string, raw: string) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (cause) {
        process.stderr.write(`error: input is not valid JSON — ${String(cause)}\n`)
        process.exitCode = 2
        return
      }
      const registry = buildToolRegistry()
      try {
        const value = await registry.invoke(tool, parsed, createContext('cli'), [
          'fs:read',
          'net:fetch',
          'proc:spawn',
        ])
        process.stdout.write(`${JSON.stringify(value ?? null, null, 2)}\n`)
      } catch (cause) {
        const code = (cause as { code?: string }).code ?? 'INTERNAL'
        process.stderr.write(`${code}: ${cause instanceof Error ? cause.message : String(cause)}\n`)
        process.exitCode = 1
      }
    })

  program
    .command('solve')
    .description('schedule a site from a JSON instance file and print the plan')
    .argument('<file>', 'path to a JSON instance: { site, loads, tariff?, optimise? }')
    .option('--json', 'machine-readable output')
    .option('--save <id>', 'write the plan to the flat-file store under this id')
    .action(async (file: string, options: { json?: boolean; save?: string }) => {
      const instance = readInstance(file)
      const registry = buildToolRegistry()
      const granted = ['fs:read', 'fs:write', 'proc:spawn'] as const

      try {
        const plan = (await registry.invoke('dispatch_plan', instance, createContext('cli'), [
          ...granted,
        ])) as Schedule

        if (options.save !== undefined) {
          const { PlanStore } = await import('@dispatchenvelope/memory')
          const store = new PlanStore(storeDir())
          store.put({ id: options.save, kind: 'plan', payload: plan, now: Date.now() })
        }

        process.stdout.write(
          options.json === true
            ? `${JSON.stringify(plan, null, 2)}\n`
            : `${renderPlan(plan, instance.site)}\n`,
        )
        if (!plan.feasible) process.exitCode = 1
      } catch (cause) {
        process.stderr.write(`${errorCode(cause)}: ${errorMessage(cause)}\n`)
        process.exitCode = 1
      }
    })

  program
    .command('prove')
    .description('prove whether an instance is impossible, and name the minimal conflict')
    .argument('<file>', 'path to a JSON instance')
    .option('--json', 'machine-readable output')
    .action(async (file: string, options: { json?: boolean }) => {
      const instance = readInstance(file)
      const registry = buildToolRegistry()
      try {
        const proof = (await registry.invoke('prove_infeasible', instance, createContext('cli'), [
          'fs:read',
          'proc:spawn',
        ])) as Proof
        process.stdout.write(
          options.json === true ? `${JSON.stringify(proof, null, 2)}\n` : `${renderProof(proof)}\n`,
        )
        if (proof.infeasible) process.exitCode = 1
      } catch (cause) {
        process.stderr.write(`${errorCode(cause)}: ${errorMessage(cause)}\n`)
        process.exitCode = 1
      }
    })

  program
    .command('version')
    .description('print version and runtime information as JSON')
    .action(() => {
      process.stdout.write(
        `${JSON.stringify(
          {
            name: 'dispatch-envelope',
            version: VERSION,
            node: process.versions.node,
            platform: process.platform,
            tools: buildToolRegistry().size,
          },
          null,
          2,
        )}\n`,
      )
    })

  return program
}
