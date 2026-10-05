import Link from 'next/link'
import { PRODUCT, SURFACES } from '@/lib/product'
import { getFixture, listFixtures } from '@/lib/fixtures'
import { EnvelopeBand } from '@/components/EnvelopeBand'

export default function HomePage() {
  const ids = listFixtures()
  const shipped = SURFACES.filter((surface) => surface.status === 'shipped')
  const featured = ids.length === 0 ? null : getFixture(ids[0] as string)

  return (
    <>
      <section className="hero">
        <span className="eyebrow">v{PRODUCT.version} · deterministic engine</span>
        <h1>Does it fit?</h1>
        <p>{PRODUCT.tagline}</p>
      </section>

      {/*
        Master/detail split: the instance list on the left, the envelope on the right. A
        dispatcher reads down a list of sites and across a day, so the layout is exactly that.
      */}
      <section className="split" aria-labelledby="instances-heading">
        <div className="split-master">
          <h2 id="instances-heading" className="panel-title">
            Instances
          </h2>
          {ids.length === 0 ? (
            <p className="state" data-kind="empty">
              No instances have been generated yet.
            </p>
          ) : (
            <ul className="instance-list">
              {ids.map((id) => (
                <li key={id}>
                  <Link href={`/instances/${id}`} className="instance">
                    <span className="instance-name">{id}</span>
                    <span className="instance-meta">
                      {id === 'overnight-conflict' ? 'infeasible' : 'feasible'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="split-detail">
          <h2 className="panel-title">The envelope band</h2>
          <p className="panel-note">
            Each column is one slot. The ceiling is the most that slot could carry; the floor is what is
            already committed to it. A plan that leaves the band is wrong before anyone reads a number.
          </p>
          {featured === null ? (
            <p className="state" data-kind="empty">
              Nothing to draw — generate the fixtures with <code>npm run gen:fixtures</code>.
            </p>
          ) : (
            <>
              <p className="panel-note">
                <strong>{featured.id}</strong> — {featured.site.slots} slots, ceiling{' '}
                {featured.site.siteLimitKw + featured.site.exportLimitKw} kW, peak {featured.plan.peak_kw} kW.{' '}
                <Link href={`/instances/${featured.id}`}>open →</Link>
              </p>
              <EnvelopeBand fixture={featured} />
            </>
          )}
        </div>
      </section>

      <section aria-labelledby="surfaces-heading" className="section">
        <h2 id="surfaces-heading" className="panel-title">
          What ships
        </h2>
        <div className="grid">
          {shipped.map((surface) => (
            <article className="card" key={surface.id}>
              <span className="badge" data-tone="ok">
                {surface.status}
              </span>
              <h3>{surface.title}</h3>
              <p>{surface.summary}</p>
              <code className="mono-dim">{surface.id}</code>
            </article>
          ))}
        </div>
      </section>
    </>
  )
}
