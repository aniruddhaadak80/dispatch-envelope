import type { Metadata } from 'next'
import { SURFACES } from '@/lib/product'

export const metadata: Metadata = { title: 'Surfaces' }

const TONE = { shipped: 'ok', planned: 'warn' } as const

export default function SurfacesPage() {
  return (
    <>
      <section className="hero">
        <span className="eyebrow">Capability</span>
        <h1>Surfaces</h1>
        <p>
          Every capability in this product is a Tool in one registry, reachable identically from each surface
          below.
        </p>
      </section>

      {SURFACES.length === 0 ? (
        <p className="state" data-kind="empty">
          No surfaces registered.
        </p>
      ) : (
        <div className="grid">
          {SURFACES.map((surface) => (
            <article className="card" key={surface.id}>
              <span className="badge" data-tone={TONE[surface.status]}>
                {surface.status}
              </span>
              <h2>{surface.title}</h2>
              <p>{surface.summary}</p>
              <code style={{ color: 'var(--fg-subtle)' }}>{surface.id}</code>
            </article>
          ))}
        </div>
      )}
    </>
  )
}
