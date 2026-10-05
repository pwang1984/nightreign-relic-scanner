import { useState } from 'react'
import { exportRelicsAsCsv, exportRelicsAsJson } from '../lib/exporters.js'
import { getReviewIssues, needsReview, reviewStatus } from '../lib/review.js'
import RelicEditor from './RelicEditor.jsx'

const COLOR_SWATCH = {
  Red: '#e05a5a', Blue: '#4f8ff0', Yellow: '#e8c94a', Green: '#4fbf6b', White: '#d8d8d8',
}

export default function ResultsStep({ relics, language = 'en', onChange, onStartOver }) {
  const [filter, setFilter] = useState(relics.some(needsReview) ? 'needs-review' : 'all')
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState(null)
  const flagged = relics.filter(needsReview)
  const reviewed = relics.filter((relic) => relic.reviewed)
  const editing = relics.find((relic) => relic.id === editingId)
  const needle = query.normalize('NFKC').trim().toLowerCase()
  const visible = relics.filter((relic) => {
    if (filter === 'needs-review' && !needsReview(relic)) return false
    if (filter === 'reviewed' && !relic.reviewed) return false
    const text = [relic.itemName || 'Unknown Relic', relic.color, ...relic.buffs.map((b) => b.name), ...relic.nerfs.map((b) => b.name)].join(' ')
    return text.normalize('NFKC').toLowerCase().includes(needle)
  })

  function save(updated, next) {
    const result = relics.map((relic) => relic.id === updated.id ? updated : relic)
    onChange(result)
    if (next) {
      const index = result.findIndex((relic) => relic.id === updated.id)
      const remaining = [...result.slice(index + 1), ...result.slice(0, index)]
      setEditingId(remaining.find(needsReview)?.id ?? null)
    } else {
      setEditingId(null)
    }
  }

  return (
    <div className="step-panel">
      <h2>4. Review your relics</h2>
      <p className="step-hint">
        {relics.length
          ? `${relics.length} relic${relics.length === 1 ? '' : 's'} found. ${flagged.length} ${flagged.length === 1 ? 'needs' : 'need'} review. Check the capture, correct any missing matches, then export.`
          : 'No relics were matched. Try a tighter region that includes the relic name and effects.'}
      </p>

      {relics.length > 0 && <>
        <div className="step-actions step-actions--top review-export-actions">
          <button className="btn btn--primary" onClick={() => exportRelicsAsJson(relics)}>Export JSON</button>
          <button className="btn btn--secondary" onClick={() => exportRelicsAsCsv(relics)}>Export CSV</button>
          <button className="btn btn--ghost btn--push-right" onClick={onStartOver}>Start over</button>
        </div>
        <p className="review-muted">Exports include all results with your saved corrections, regardless of the filter.</p>
        <div className="review-toolbar">
          <div className="review-filters" aria-label="Review filters">
            {[
              ['all', 'All', relics.length],
              ['needs-review', 'Needs review', flagged.length],
              ['reviewed', 'Reviewed', reviewed.length],
            ].map(([value, label, count]) => (
              <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label} <span>{count}</span></button>
            ))}
          </div>
          <input type="search" className="review-filter-search" aria-label="Filter relics" placeholder="Filter by name or effect…"
            value={query} onChange={(event) => setQuery(event.target.value)} />
          <button className="btn btn--secondary btn--small" disabled={!flagged.length} onClick={() => setEditingId(flagged[0].id)}>Review next</button>
        </div>
        <p className="review-muted" role="status">Showing {visible.length} of {relics.length} relics</p>
        {!visible.length && <p className="review-empty">No relics match this filter.</p>}
        <ul className="relic-list">
          {visible.map((relic) => {
            const issues = getReviewIssues(relic)
            const uncertain = needsReview(relic)
            return (
              <li className={`relic-card${uncertain ? ' relic-card--needs-review' : ''}`} key={relic.id}>
                <div className="relic-card-header">
                  <span className="relic-swatch" role="img" aria-label={`Color: ${relic.color || 'Unknown'}`}
                    style={{ background: COLOR_SWATCH[relic.color] || '#888' }} />
                  <span className="relic-name">{relic.itemName || 'Unknown Relic'}</span>
                  <span className={`review-status${uncertain ? ' review-status--warning' : relic.reviewed ? ' review-status--done' : ''}`}>{reviewStatus(relic)}</span>
                </div>
                <div className="review-card-meta">
                  <span>Relic {relic.id} · {relic.buffs.length} buff{relic.buffs.length === 1 ? '' : 's'} · {relic.nerfs.length} debuff{relic.nerfs.length === 1 ? '' : 's'}</span>
                  {relic.occurrences > 1 && <span>seen {relic.occurrences}×</span>}
                </div>
                {uncertain && <ul className="review-issues">{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
                <ul className="behavior-list">
                  {relic.buffs.map((effect) => <li key={effect.effectId} className="behavior-item">
                    <span className="behavior-name">{effect.name}</span><span className="behavior-category">{effect.category}</span>
                  </li>)}
                </ul>
                {relic.nerfs.length > 0 && <ul className="behavior-list behavior-list--nerfs">
                  {relic.nerfs.map((effect) => <li key={effect.effectId} className="behavior-item behavior-item--nerf">
                    <span className="behavior-name">{effect.name}</span><span className="behavior-category">{effect.category}</span>
                  </li>)}
                </ul>}
                <div className="review-card-actions">
                  <button className="btn btn--secondary btn--small" aria-label={`Review relic ${relic.id}`} onClick={() => setEditingId(relic.id)}>{uncertain ? 'Review' : 'Edit'}</button>
                  {!uncertain && <button className="review-text-button" onClick={() => onChange(relics.map((item) => item.id === relic.id ? { ...item, flagged: true, reviewed: false } : item))}>Flag for review</button>}
                </div>
              </li>
            )
          })}
        </ul>
      </>}
      {!relics.length && <button className="btn btn--ghost" onClick={onStartOver}>Start over</button>}
      {editing && <RelicEditor key={editing.id} relic={editing} language={language}
        hasNext={flagged.some((relic) => relic.id !== editing.id)} onSave={save} onClose={() => setEditingId(null)} />}
    </div>
  )
}
