import type { Fixture } from '@/lib/fixtures'

/**
 * THE SIGNATURE ELEMENT.
 *
 * A horizontal slot timeline drawn as a band rather than a chart. For every slot:
 *
 *   - the full column height is the site ceiling (the most that slot could carry),
 *   - the darker segment at the bottom is the demand already committed to it,
 *   - the amber overlay is what the dispatched plan actually draws.
 *
 * The point is that feasibility is a *shape*. A column whose amber reaches the ceiling is a
 * tripped supply, and you see it before reading a single number. A broken slot is torn open and
 * labelled with its deficit in monospace, because an exception you cannot point at is not a
 * diagnosis.
 *
 * Everything is a div with a percentage height: no chart library, no canvas, no client
 * JavaScript. It renders identically on the server and in a screenshot.
 */
export function EnvelopeBand({ fixture }: { readonly fixture: Fixture }) {
  const { site, envelope, plan } = fixture
  const ceiling = Math.max(site.siteLimitKw + site.exportLimitKw, 1)
  const scale = (kw: number): string => `${Math.min(Math.max(kw / ceiling, 0), 1) * 100}%`

  return (
    <div className="band-wrap">
      <div
        className="band"
        role="img"
        aria-label={`Envelope band: ${site.slots} slots, ceiling ${ceiling} kilowatts, peak ${
          plan.peak_kw
        } kilowatts, ${plan.feasible ? 'feasible' : 'infeasible'}.`}
      >
        {envelope.slots.map((slot) => {
          const used = plan.per_slot.find((entry) => entry.index === slot.index)
          const drawn = used?.total_kw ?? 0
          const broken = plan.feasible === false && slot.mandatory_kw > slot.max_kw

          return (
            <div className="band-col" key={slot.index} data-broken={broken ? 'true' : 'false'}>
              <div className="band-stack">
                <div className="band-headroom" style={{ height: scale(slot.max_kw) }}>
                  <span className="band-headroom-ink">{slot.max_kw}</span>
                </div>
                <div className="band-floor" style={{ height: scale(slot.mandatory_kw) }} />
                <div
                  className="band-load"
                  style={{ height: scale(drawn), bottom: `${scale(slot.mandatory_kw)}` }}
                />
              </div>
              <span className="band-label">{slot.index}</span>
              {broken && (
                <span className="band-deficit">
                  {slot.mandatory_kw}
                  <span aria-hidden="true">▲</span>
                  {slot.max_kw}
                </span>
              )}
            </div>
          )
        })}
      </div>

      <ul className="band-legend">
        <li>
          <span className="swatch" data-tone="headroom" /> ceiling — most the slot could carry
        </li>
        <li>
          <span className="swatch" data-tone="floor" /> committed — mandatory demand
        </li>
        <li>
          <span className="swatch" data-tone="load" /> dispatched — what the plan draws
        </li>
      </ul>
    </div>
  )
}
