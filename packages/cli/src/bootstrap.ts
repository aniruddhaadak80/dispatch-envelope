import { join } from 'node:path'
import {
  ToolRegistry,
  ValidationError,
  type Envelope,
  type Instance,
  type Load,
  type Objective,
  type Proof,
  type Schedule,
  type Site,
  type Tool,
  type ToolContext,
} from '@dispatchenvelope/core'
import { buildRegistry, fitTariff } from '@dispatchenvelope/plugins'
import { loadCatalog } from '@dispatchenvelope/skills'

export const ENGINE_MODULE = 'dispatch_envelope'

export type { Envelope, Instance, Load, Objective, Proof, Schedule, Site }

/**
 * Builds the one registry every surface shares.
 *
 * The two catalogue tools describe the product itself; the four engine tools do the work.
 * Every name matches ^[a-z][a-z0-9_]*$ so it is directly exposable over MCP.
 */
export function buildToolRegistry(cwd = process.cwd()): ToolRegistry {
  const registry = new ToolRegistry()

  registry.register(
    {
      name: 'list_skills',
      description:
        'List the skill catalog with each skill name, version and description. Use this to discover what the agent can do before guessing a command.',
      inputSchema: {
        type: 'object',
        properties: {
          includeBodies: { type: 'boolean', description: 'Include each skill body.' },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          issues: { type: 'array', items: { type: 'string' } },
          skills: { type: 'array', items: { type: 'object' } },
        },
        required: ['count', 'issues', 'skills'],
      },
      permissions: ['fs:read'],
      surface: 'core',
      handler: async (input: { includeBodies?: boolean }) => {
        const { skills, issues } = loadCatalog(join(cwd, 'skills'))
        return {
          count: skills.length,
          issues: [...issues],
          skills: skills.map((skill) => ({
            name: skill.name,
            version: skill.version,
            description: skill.description,
            ...(input.includeBodies === true ? { body: skill.body } : {}),
          })),
        }
      },
    } satisfies Tool<{ includeBodies?: boolean }, unknown>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'list_plugins',
      description:
        'List the resolved plugin registry, including plugins that were shadowed, disabled or rejected and why. Use this to explain why an expected capability is missing.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: { type: 'object' },
      permissions: ['fs:read'],
      surface: 'core',
      handler: async () => {
        const result = buildRegistry(join(cwd, 'plugins'))
        return {
          active: result.active.map((p) => ({
            name: p.manifest.name,
            version: p.manifest.version,
            capabilities: p.manifest.capabilities,
            shadowed: p.shadowed,
          })),
          disabled: result.disabled.map((p) => p.manifest.name),
          rejected: result.rejected.map((p) => ({ path: p.path, issues: p.issues })),
        }
      },
    } satisfies Tool<Record<string, never>, unknown>,
    { source: 'core' },
  )

  const runEngine = async <T>(op: string, input: unknown): Promise<T> => {
    const { EngineBridge } = await import('@dispatchenvelope/engine-client')
    const bridge = new EngineBridge({
      module: ENGINE_MODULE,
      cwd: join(cwd, 'services', 'engine', 'src'),
    })
    return (await bridge.call({ op, input })) as T
  }

  /**
   * The three fields every engine call needs. Validated here rather than in the engine so a
   * bad request fails with a message naming the offending field instead of a traceback.
   */
  const requireInstance = (input: unknown): Instance => {
    const value = input as Partial<Instance> | null
    if (value === null || typeof value !== 'object') {
      throw new ValidationError('input must be an object with "site" and "loads"', { field: 'input' })
    }
    if (value.site === undefined) {
      throw new ValidationError('"site" is required', { field: 'site' })
    }
    if (value.loads === undefined) {
      throw new ValidationError('"loads" is required', { field: 'loads' })
    }
    if (!Array.isArray(value.loads)) {
      throw new ValidationError('"loads" must be an array', { field: 'loads' })
    }
    return value as Instance
  }

  const SITE_SCHEMA = {
    type: 'object',
    description: 'The supply cap and the planning horizon, in whole units.',
    properties: {
      slots: { type: 'integer', minimum: 1, description: 'Number of slots in the horizon.' },
      slotMinutes: { type: 'integer', minimum: 1, description: 'Length of one slot.' },
      siteLimitKw: { type: 'integer', minimum: 0, description: 'Cap on simultaneous demand, kW.' },
      exportLimitKw: {
        type: 'integer',
        minimum: 0,
        description: 'Cap on export, kW. Adds to the usable headroom.',
      },
    },
    required: ['slots', 'slotMinutes', 'siteLimitKw'],
    additionalProperties: false,
  }

  const LOADS_SCHEMA = {
    type: 'array',
    description: 'The flexible loads to schedule. Each occupies one contiguous run of slots.',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Unique within the instance.' },
        name: { type: 'string', description: 'Human label. Defaults to the id.' },
        powerKw: { type: 'integer', description: 'Draw while running, in kW.' },
        earliestSlot: { type: 'integer', description: 'Earliest slot the load may start.' },
        latestSlot: { type: 'integer', description: 'Latest slot the load may start.' },
        minSlots: { type: 'integer', description: 'Minimum contiguous slots it must occupy.' },
        maxSlots: { type: 'integer', description: 'Maximum contiguous slots it may occupy.' },
        mandatory: {
          type: 'boolean',
          description: 'True if it must run. A mandatory load that cannot run makes the plan infeasible.',
        },
      },
      required: ['id', 'powerKw', 'earliestSlot', 'latestSlot', 'minSlots'],
      additionalProperties: false,
    },
  }

  const TARIFF_SCHEMA = {
    type: 'object',
    description: 'A per-slot price in whole cents per kWh. Must have exactly site.slots entries.',
    properties: {
      pricesCents: { type: 'array', items: { type: 'integer', minimum: 0 } },
      currency: { type: 'string' },
    },
    required: ['pricesCents'],
    additionalProperties: false,
  }

  const instanceProperties = { site: SITE_SCHEMA, loads: LOADS_SCHEMA, tariff: TARIFF_SCHEMA }

  registry.register(
    {
      name: 'dispatch_plan',
      description:
        'Schedule a site’s flexible loads inside its power cap and return a verified plan with total cost and peak. Use this for the actual answer. Set optimise to "peak" to shave the peak instead of the cost. When no plan exists, feasible is false and unplaced names what could not be served — this tool never invents a plan.',
      inputSchema: {
        type: 'object',
        properties: {
          ...instanceProperties,
          optimise: {
            type: 'string',
            enum: ['cost', 'peak', 'earliest'],
            description: 'Objective. Defaults to cost.',
          },
        },
        required: ['site', 'loads'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          feasible: { type: 'boolean' },
          totalCostCents: { type: 'integer' },
          peakKw: { type: 'integer' },
          schedule: { type: 'array', items: { type: 'object' } },
          perSlot: { type: 'array', items: { type: 'object' } },
          unplaced: { type: 'array', items: { type: 'string' } },
        },
        required: ['feasible', 'totalCostCents', 'peakKw', 'schedule', 'perSlot', 'unplaced'],
      },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input) => {
        const instance = requireInstance(input)
        return fromEngineSchedule(await runEngine('dispatch', toEngineInput(instance)))
      },
    } satisfies Tool<Instance & { optimise?: Objective }, Schedule>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'prove_infeasible',
      description:
        'Prove whether a plan is impossible and, if so, return the MINIMAL set of loads responsible, the slot, and the exact deficit. Use this instead of guessing which appliance conflicts — it removes every load that is not part of the conflict. Check the "minimal" field: false means the search budget was exhausted and this is not a proof.',
      inputSchema: {
        type: 'object',
        properties: instanceProperties,
        required: ['site', 'loads'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          infeasible: { type: 'boolean' },
          minimal: { type: 'boolean' },
          reasonCode: { type: 'string' },
          message: { type: 'string' },
          conflict: { type: 'array', items: { type: 'object' } },
          deficitKw: { type: 'integer' },
        },
        required: ['infeasible', 'minimal', 'reasonCode', 'message', 'conflict', 'deficitKw'],
      },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input) => {
        const instance = requireInstance(input)
        return fromEngineProof(await runEngine('prove_infeasible', toEngineInput(instance)))
      },
    } satisfies Tool<Instance, Proof>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'dispatch_envelope',
      description:
        'Return per-slot [minKw, maxKw] bounds at the constraint fixed point. The max is the most a slot could carry, the min is the demand already committed to it, and mandatoryKw is that committed demand on its own. Use this first to see the shape of the problem, and to draw the band a plan has to stay inside.',
      inputSchema: {
        type: 'object',
        properties: instanceProperties,
        required: ['site', 'loads'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          slots: { type: 'array', items: { type: 'object' } },
          iterations: { type: 'integer' },
          feasible: { type: 'boolean' },
          problems: { type: 'array', items: { type: 'object' } },
        },
        required: ['slots', 'iterations', 'feasible', 'problems'],
      },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input) => {
        const instance = requireInstance(input)
        return fromEngineEnvelope(await runEngine('propagate_envelope', toEngineInput(instance)))
      },
    } satisfies Tool<Instance, Envelope>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'describe_engine',
      description:
        'Return the engine’s operation catalogue: every operation, its arguments, its return fields, and the unit conventions. Call this before guessing an operation name or an argument shape.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: { type: 'object' },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async () => await runEngine<Record<string, unknown>>('describe', null),
    } satisfies Tool<Record<string, never>, Record<string, unknown>>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'list_tariffs',
      description:
        'List the tariffs the loaded plugins can supply, already fitted to a horizon of the requested number of slots. Use this instead of inventing a price series. Refuses a horizon the series does not divide, rather than truncating it.',
      inputSchema: {
        type: 'object',
        properties: {
          slots: { type: 'integer', minimum: 1, description: 'Horizon length to fit the tariff to.' },
        },
        required: ['slots'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          tariffs: { type: 'array', items: { type: 'object' } },
          rejected: { type: 'array', items: { type: 'object' } },
        },
        required: ['tariffs', 'rejected'],
      },
      permissions: ['fs:read'],
      surface: 'core',
      handler: async (input: { slots: number }) => {
        if (!Number.isInteger(input.slots) || input.slots <= 0) {
          throw new ValidationError('"slots" must be a positive integer', { field: 'slots' })
        }

        const resolved = buildRegistry(join(cwd, 'plugins'))
        const tariffs: unknown[] = []
        const rejected: unknown[] = []

        for (const plugin of resolved.active) {
          const series = plugin.manifest.tariff
          if (series === undefined) continue
          try {
            tariffs.push({
              name: plugin.manifest.name,
              capabilities: plugin.manifest.capabilities,
              currency: series.currency,
              slotMinutes: series.slotMinutes,
              slots: input.slots,
              pricesCents: fitTariff(series, input.slots),
            })
          } catch (cause) {
            rejected.push({
              name: plugin.manifest.name,
              reason: cause instanceof Error ? cause.message : String(cause),
            })
          }
        }

        return { tariffs, rejected }
      },
    } satisfies Tool<{ slots: number }, unknown>,
    { source: 'core' },
  )

  return registry
}

/**
 * Translate the camelCase public contract into the snake_case the engine speaks.
 *
 * Doing this in one place is what stops the two vocabularies drifting: a new field is added
 * here once, and every transport inherits it.
 */
export function toEngineInput(instance: Instance): Record<string, unknown> {
  const site: Record<string, unknown> = {
    slots: instance.site.slots,
    slot_minutes: instance.site.slotMinutes,
    site_limit_kw: instance.site.siteLimitKw,
  }
  if (instance.site.exportLimitKw !== undefined) {
    site['export_limit_kw'] = instance.site.exportLimitKw
  }

  const loads = instance.loads.map((load) => {
    const row: Record<string, unknown> = {
      id: load.id,
      power_kw: load.powerKw,
      earliest_slot: load.earliestSlot,
      latest_slot: load.latestSlot,
      min_slots: load.minSlots,
      max_slots: load.maxSlots ?? load.minSlots,
      mandatory: load.mandatory ?? false,
    }
    if (load.name !== undefined) row['name'] = load.name
    return row
  })

  const payload: Record<string, unknown> = { site, loads }
  if (instance.tariff !== undefined) {
    payload['tariff'] = {
      prices_cents: [...instance.tariff.pricesCents],
      ...(instance.tariff.currency === undefined ? {} : { currency: instance.tariff.currency }),
    }
  }
  if (instance.optimise !== undefined) payload['optimise'] = instance.optimise
  return payload
}

// --------------------------------------------------------------- return path

/**
 * The inverse of {@link toEngineInput}. The engine is snake_case because Python is; the public
 * contract is camelCase because TypeScript is. Converting in both directions, in exactly one
 * place each, is what keeps the two vocabularies from bleeding into each other.
 */

type Row = Record<string, unknown>

const num = (row: Row, key: string): number => {
  const value = row[key]
  return typeof value === 'number' ? value : 0
}

const flag = (row: Row, key: string): boolean => row[key] === true

const ints = (value: unknown): number[] =>
  Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : []

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const objects = (value: unknown): Row[] =>
  Array.isArray(value) ? value.filter((item): item is Row => typeof item === 'object' && item !== null) : []

export function fromEngineSchedule(value: unknown): Schedule {
  const row = (value ?? {}) as Row
  return {
    version: num(row, 'version'),
    feasible: flag(row, 'feasible'),
    objective: (row['objective'] as Objective) ?? 'cost',
    optimal: flag(row, 'optimal'),
    currency: typeof row['currency'] === 'string' ? row['currency'] : 'USD',
    totalCostCents: num(row, 'total_cost_cents'),
    peakKw: num(row, 'peak_kw'),
    peakSlot: num(row, 'peak_slot'),
    unusedHeadroomKw: num(row, 'unused_headroom_kw'),
    searchNodes: num(row, 'search_nodes'),
    schedule: objects(row['schedule']).map((entry) => ({
      loadId: String(entry['load_id']),
      name: String(entry['name']),
      powerKw: num(entry, 'power_kw'),
      slots: ints(entry['slots']),
      mandatory: flag(entry, 'mandatory'),
    })),
    perSlot: objects(row['per_slot']).map((entry) => ({
      index: num(entry, 'index'),
      totalKw: num(entry, 'total_kw'),
      priceCents: num(entry, 'price_cents'),
      costCents: num(entry, 'cost_cents'),
      loadIds: strings(entry['load_ids']),
    })),
    unplaced: strings(row['unplaced']),
    violations: strings(row['violations']),
  }
}

export function fromEngineEnvelope(value: unknown): Envelope {
  const row = (value ?? {}) as Row
  return {
    slots: objects(row['slots']).map((entry) => ({
      index: num(entry, 'index'),
      minKw: num(entry, 'min_kw'),
      maxKw: num(entry, 'max_kw'),
      mandatoryKw: num(entry, 'mandatory_kw'),
    })),
    iterations: num(row, 'iterations'),
    feasible: flag(row, 'feasible'),
    problems: objects(row['problems']).map((entry) => ({
      code: String(entry['code']),
      subject: String(entry['subject']),
      message: String(entry['message']),
    })),
  }
}

export function fromEngineProof(value: unknown): Proof {
  const row = (value ?? {}) as Row
  return {
    infeasible: flag(row, 'infeasible'),
    minimal: flag(row, 'minimal'),
    reasonCode: String(row['reason_code'] ?? 'UNKNOWN'),
    message: String(row['message'] ?? ''),
    conflict: objects(row['conflict']).map((entry) => ({
      loadId: String(entry['load_id']),
      name: String(entry['name']),
      powerKw: num(entry, 'power_kw'),
      earliestSlot: num(entry, 'earliest_slot'),
      latestSlot: num(entry, 'latest_slot'),
      minSlots: num(entry, 'min_slots'),
      maxSlots: num(entry, 'max_slots'),
      mandatory: flag(entry, 'mandatory'),
    })),
    slot: num(row, 'slot'),
    requiredKw: num(row, 'required_kw'),
    limitKw: num(row, 'limit_kw'),
    deficitKw: num(row, 'deficit_kw'),
    currency: typeof row['currency'] === 'string' ? row['currency'] : 'USD',
    removableKw: num(row, 'removable_kw'),
  }
}

/** A minimal, dependency-free logger for the tool context. */
export function createContext(requestId = 'cli'): ToolContext {
  return {
    requestId,
    now: () => Date.now(),
    log: (level, message, fields) => {
      process.stderr.write(`${JSON.stringify({ level, message, requestId, ...fields })}\n`)
    },
    dataDir: process.env.PRODUCT_DATA_DIR ?? '.data',
  }
}
