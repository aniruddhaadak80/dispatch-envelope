import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

/**
 * A tariff a plugin supplies.
 *
 * Prices are whole cents per kWh and the series is **not** padded to the horizon here — the
 * engine refuses a tariff whose length disagrees with `site.slots` rather than inventing prices,
 * because a padded tariff yields a plan whose cost nobody can reproduce. Repeating the series to
 * the horizon is the caller's decision, and it is an explicit one.
 */
export const TariffSchema = z.object({
  currency: z.string().min(3).max(3),
  slotMinutes: z.number().int().positive(),
  pricesCents: z.array(z.number().int().nonnegative()).min(1),
})

export type TariffSeries = z.infer<typeof TariffSchema>

export const PluginManifestSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().min(10),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(100).default(50),
  capabilities: z.array(z.string().min(1)).default([]),
  engines: z.record(z.string(), z.string()).default({}),
  /**
   * Optional. A plugin that supplies prices is how a new supplier is added without touching the
   * solver — the manifest stays data, so loading one cannot execute code.
   */
  tariff: TariffSchema.optional(),
})

/**
 * Repeat a price series to exactly `slots` entries.
 *
 * Truncating a longer series is as dishonest as padding a shorter one, so this only ever
 * repeats, and only when the series divides evenly into the horizon.
 */
export function fitTariff(series: TariffSeries, slots: number): number[] {
  if (slots <= 0) throw new RangeError(`cannot fit a tariff to ${slots} slots`)
  if (slots % series.pricesCents.length !== 0) {
    throw new RangeError(
      `tariff of ${series.pricesCents.length} slots does not divide a horizon of ${slots}; ` +
        'truncating it would invent prices',
    )
  }
  const prices: number[] = []
  while (prices.length < slots) prices.push(...series.pricesCents)
  return prices
}

export type PluginManifest = z.infer<typeof PluginManifestSchema>

export interface LoadedPlugin {
  readonly manifest: PluginManifest
  readonly path: string
  readonly issues: readonly string[]
}

export function loadPlugin(file: string): LoadedPlugin {
  if (!existsSync(file)) {
    return { manifest: null as never, path: file, issues: [`${file}: not found`] }
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (cause) {
    return { manifest: null as never, path: file, issues: [`${file}: invalid JSON — ${String(cause)}`] }
  }
  const parsed = PluginManifestSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${file}: ${i.path.join('.') || '(root)'} — ${i.message}`)
    return { manifest: null as never, path: file, issues }
  }
  return { manifest: parsed.data, path: file, issues: [] }
}

export function loadPlugins(root = 'plugins'): LoadedPlugin[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      const manifestPath = join(root, d.name, 'plugin.json')
      if (!existsSync(manifestPath)) return []
      return [loadPlugin(manifestPath)]
    })
    .sort((a, b) => String(a.path).localeCompare(String(b.path)))
}
