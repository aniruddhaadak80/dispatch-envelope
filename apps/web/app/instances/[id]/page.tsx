import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { EnvelopeBand } from '@/components/EnvelopeBand'
import { getFixture, listFixtures, type FixtureProof } from '@/lib/fixtures'

export const dynamic = 'force-static'

export function generateStaticParams() {
  return listFixtures().map((id) => ({ id }))
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  return { title: `Instance ${id}` }
}

export default async function InstancePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const fixture = getFixture(id)
  if (fixture === null) notFound()

  const { plan, proof, site, tariff } = fixture
  const ceiling = site.siteLimitKw + site.exportLimitKw

  return (
    <>
      <section className="hero">
        <span className="eyebrow">{fixture.source}</span>
        <h1>{fixture.id}</h1>
        <p>
          {site.slots} slots of {site.slotMinutes} minutes · ceiling {ceiling} kW
          {tariff === null ? ' · no tariff' : ` · ${tariff.currency} time-of-use`}
        </p>
      </section>

      <section aria-labelledby="verdict-heading" className="section">
        <h2 id="verdict-heading" className="panel-title">
          Verdict
        </h2>
        {plan.feasible ? (
          <div className="verdict" data-tone="ok">
            <span className="badge" data-tone="ok">
              feasible
            </span>
            <dl className="metrics">
              <div>
                <dt>cost</dt>
                <dd>
                  {plan.total_cost_cents}
                  <span className="unit">{plan.currency}</span>
                </dd>
              </div>
              <div>
                <dt>peak</dt>
                <dd>
                  {plan.peak_kw}
                  <span className="unit">kW</span>
                </dd>
              </div>
              <div>
                <dt>peak slot</dt>
                <dd>{plan.peak_slot}</dd>
              </div>
              <div>
                <dt>headroom left</dt>
                <dd>
                  {plan.unused_headroom_kw}
                  <span className="unit">kW</span>
                </dd>
              </div>
              <div>
                <dt>search nodes</dt>
                <dd>{plan.search_nodes}</dd>
              </div>
            </dl>
            <p className="panel-note">
              Verified against every constraint after construction.{' '}
              {plan.optimal
                ? 'Proven optimal.'
                : 'Not proven optimal — the plan is cheap and legal, not cheapest.'}
            </p>
          </div>
        ) : (
          <div className="verdict" data-tone="danger">
            <span className="badge" data-tone="danger">
              infeasible
            </span>
            <p className="state" data-kind="error">
              {proof.message}
            </p>
            <ProofDetail proof={proof} />
          </div>
        )}
      </section>

      <section aria-labelledby="band-heading" className="section">
        <h2 id="band-heading" className="panel-title">
          Envelope
        </h2>
        <EnvelopeBand fixture={fixture} />
      </section>

      <section aria-labelledby="schedule-heading" className="section">
        <h2 id="schedule-heading" className="panel-title">
          Schedule
        </h2>
        {plan.schedule.length === 0 ? (
          <p className="state" data-kind="empty">
            No plan exists, so there is nothing to schedule.
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">load</th>
                <th scope="col">kW</th>
                <th scope="col">slots</th>
                <th scope="col">kind</th>
              </tr>
            </thead>
            <tbody>
              {plan.schedule.map((entry) => (
                <tr key={entry.load_id}>
                  <td>{entry.name}</td>
                  <td className="mono">{entry.power_kw}</td>
                  <td className="mono">
                    {entry.slots.length > 0
                      ? `${entry.slots[0]}..${entry.slots[entry.slots.length - 1]}`
                      : '—'}
                  </td>
                  <td>
                    <span className="badge" data-tone={entry.mandatory ? 'warn' : undefined}>
                      {entry.mandatory ? 'mandatory' : 'optional'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {plan.unplaced.length > 0 && (
          <p className="state" data-kind="empty">
            dropped as optional and unplaceable: {plan.unplaced.join(', ')}
          </p>
        )}
      </section>

      <section aria-labelledby="per-slot-heading" className="section">
        <h2 id="per-slot-heading" className="panel-title">
          Per slot
        </h2>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">slot</th>
              <th scope="col">demand</th>
              <th scope="col">price</th>
              <th scope="col">cost</th>
              <th scope="col">carrying</th>
            </tr>
          </thead>
          <tbody>
            {plan.per_slot.map((slot) => (
              <tr key={slot.index} data-over={slot.total_kw > ceiling ? 'true' : 'false'}>
                <td className="mono">{slot.index}</td>
                <td className="mono">
                  {slot.total_kw}
                  <span className="unit">kW</span>
                </td>
                <td className="mono">
                  {slot.price_cents}
                  <span className="unit">c</span>
                </td>
                <td className="mono">
                  {slot.cost_cents}
                  <span className="unit">c</span>
                </td>
                <td className="dim">{slot.load_ids.join(', ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <p className="panel-note">
        <Link href="/">← all instances</Link>
      </p>
    </>
  )
}

function ProofDetail({ proof }: { readonly proof: FixtureProof }) {
  return (
    <div className="proof">
      <h3>The minimal conflicting set</h3>
      <p className="panel-note">
        {proof.minimal
          ? 'Dropping any one of these restores feasibility, so each is genuinely part of the conflict.'
          : 'Minimality was NOT proven — the search budget was exhausted. This is not a proof.'}
      </p>
      {proof.slot >= 0 && (
        <p className="mono-figure">
          slot {proof.slot}: {proof.required_kw} kW required &gt; {proof.limit_kw} kW limit, deficit{' '}
          <strong>{proof.deficit_kw} kW</strong>
        </p>
      )}
      {proof.conflict.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">load</th>
              <th scope="col">kW</th>
              <th scope="col">window</th>
              <th scope="col">min slots</th>
            </tr>
          </thead>
          <tbody>
            {proof.conflict.map((entry) => (
              <tr key={entry.load_id}>
                <td>{entry.name}</td>
                <td className="mono">{entry.power_kw}</td>
                <td className="mono">
                  {entry.earliest_slot}..{entry.latest_slot}
                </td>
                <td className="mono">{entry.min_slots}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="state" data-kind="empty">
          No conflicting subset — the instance is fine.
        </p>
      )}
      {proof.removable_kw > 0 && (
        <p className="panel-note">
          {proof.removable_kw} kW of optional load was excluded from the proof because it is not in conflict.
        </p>
      )}
    </div>
  )
}
