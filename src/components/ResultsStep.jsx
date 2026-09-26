import { exportRelicsAsCsv, exportRelicsAsJson } from '../lib/exporters.js'

const COLOR_SWATCH = {
  Red: '#e05a5a',
  Blue: '#4f8ff0',
  Yellow: '#e8c94a',
  Green: '#4fbf6b',
  White: '#d8d8d8',
}

export default function ResultsStep({ relics, onStartOver }) {
  return (
    <div className="step-panel">
      <h2>5. Your relics</h2>
      <p className="step-hint">
        {relics.length
          ? `Found ${relics.length} unique relic${relics.length === 1 ? '' : 's'}. Review below, then export.`
          : 'No relics were confidently matched. Try a tighter region or a slower sample interval.'}
      </p>

      {relics.length > 0 && (
        <>
          <div className="step-actions step-actions--top">
            <button className="btn btn--primary" onClick={() => exportRelicsAsJson(relics)}>
              Export JSON
            </button>
            <button className="btn btn--primary" onClick={() => exportRelicsAsCsv(relics)}>
              Export CSV
            </button>
            <button className="btn btn--ghost btn--push-right" onClick={onStartOver}>
              Start over
            </button>
          </div>

          <ul className="relic-list">
            {relics.map((relic) => (
              <li className="relic-card" key={relic.id}>
                <div className="relic-card-header">
                  <span
                    className="relic-swatch"
                    style={{ background: COLOR_SWATCH[relic.color] || '#888' }}
                  />
                  <span className="relic-name">{relic.itemName || 'Unknown Relic'}</span>
                  {relic.occurrences > 1 && (
                    <span className="relic-badge">seen {relic.occurrences}×</span>
                  )}
                </div>
                <ul className="behavior-list">
                  {relic.buffs.map((b, i) => (
                    <li key={i} className="behavior-item">
                      <span className="behavior-name">{b.name}</span>
                      <span className="behavior-category">{b.category}</span>
                    </li>
                  ))}
                </ul>
                {relic.nerfs.length > 0 && (
                  <ul className="behavior-list behavior-list--nerfs">
                    {relic.nerfs.map((b, i) => (
                      <li key={i} className="behavior-item behavior-item--nerf">
                        <span className="behavior-name">{b.name}</span>
                        <span className="behavior-category">{b.category}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {relics.length === 0 && (
        <div className="step-actions">
          <button className="btn btn--ghost btn--push-right" onClick={onStartOver}>
            Start over
          </button>
        </div>
      )}
    </div>
  )
}
