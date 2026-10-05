import { useEffect, useId, useRef, useState } from 'react'
import { getReviewLines } from '../lib/matcher.js'
import {
  getReviewIssues, removeRelicEffect, searchReviewCatalog, selectRelicEffect, selectRelicItem,
} from '../lib/review.js'

const COLORS = ['Red', 'Blue', 'Yellow', 'Green', 'White']

export default function RelicEditor({ relic, language, hasNext, onSave, onClose }) {
  const [draft, setDraft] = useState(relic)
  const [search, setSearch] = useState({ kind: relic.itemName ? 'effect' : 'item', query: '', replace: null })
  const [imageUrl, setImageUrl] = useState(null)
  const dialog = useRef(null)
  const searchInput = useRef(null)
  const headingId = useId()
  const searchId = useId()
  const issues = getReviewIssues(draft)
  const selectedIds = new Set([...draft.buffs, ...draft.nerfs].map((effect) => effect.effectId))
  const choices = searchReviewCatalog(search.query, search.kind, language)
    .filter((entry) => search.kind === 'item' || !selectedIds.has(entry.id) || entry.id === search.replace)

  useEffect(() => {
    const element = dialog.current
    element.showModal()
    return () => element.close()
  }, [])

  useEffect(() => {
    if (!relic.review?.image) return
    const url = URL.createObjectURL(relic.review.image)
    setImageUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [relic.review?.image])

  function find(kind, replace = null, query = '') {
    setSearch({ kind, replace, query })
    searchInput.current?.focus()
  }

  function select(entry) {
    setDraft((current) => search.kind === 'item'
      ? selectRelicItem(current, entry)
      : selectRelicEffect(current, entry, search.replace))
    setSearch({ kind: 'effect', replace: null, query: '' })
  }

  function save(next = false) {
    onSave(next ? { ...draft, reviewed: true, flagged: false } : draft, next)
  }

  return (
    <dialog className="review-dialog" ref={dialog} aria-labelledby={headingId} onCancel={onClose}>
      <div className="review-dialog-header">
        <div>
          <span className="review-eyebrow">RELIC {relic.id}</span>
          <h2 id={headingId}>Review and correct</h2>
        </div>
        <button className="btn btn--ghost" onClick={onClose} aria-label="Close editor">Close</button>
      </div>

      <div className="review-editor-grid">
        <section className="review-source" aria-label="Recognition source">
          <h3>Original capture</h3>
          {imageUrl ? <img className="review-image" src={imageUrl} alt="Cropped relic from the recording" />
            : <p className="review-muted">No capture available for this result.</p>}
          {relic.review && <p className="review-muted">Video time: {relic.review.timeSec.toFixed(2)}s</p>}
          <h3>Recognized text</h3>
          <p className="review-muted">Highlighted text did not match the catalog. Compare it with the capture before adding an effect.</p>
          <ul className="review-ocr-lines">
            {getReviewLines(relic.review).map((line, index) => {
              const note = line.kind === 'note'
              const unmatched = line.kind === 'unmatched' && !note
              return <li key={index} className={unmatched ? 'is-unmatched' : ''}>
                <span>{line.text}</span>
                {unmatched && <span className="review-line-label">Unmatched</span>}
                {note && <span className="review-line-label">Usage note</span>}
              </li>
            })}
          </ul>
          <details className="review-raw-text">
            <summary>Full OCR text</summary>
            <pre>{relic.review?.rawText || 'No OCR text available.'}</pre>
          </details>
        </section>

        <section className="review-fields" aria-label="Edit relic">
          {issues.length > 0 && <ul className="review-issues">{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
          <div className="review-field-header">
            <h3>Relic name</h3>
            <button className="btn btn--ghost btn--small" onClick={() => find('item')}>Find relic</button>
          </div>
          <p className="review-current-name">{draft.itemName || 'Unknown Relic'}</p>
          <div className="review-metadata">
            <label>Color
              <select value={draft.color || ''} onChange={(event) => setDraft({ ...draft, color: event.target.value || null })}>
                <option value="">Unknown</option>
                {COLORS.map((color) => <option key={color}>{color}</option>)}
              </select>
            </label>
            <label className="review-checkbox">
              <input type="checkbox" checked={draft.dn} onChange={(event) => setDraft({ ...draft, dn: event.target.checked })} />
              Deep relic
            </label>
          </div>

          <div className="review-search-panel">
            <label htmlFor={searchId}>{search.kind === 'item' ? 'Search relic names' : search.replace ? 'Search replacement effect' : 'Search effects to add'}</label>
            <input id={searchId} type="search" ref={searchInput} value={search.query}
              onChange={(event) => setSearch({ ...search, query: event.target.value })}
              placeholder="Chinese or English name, or ID" autoComplete="off" />
            {search.replace && <button className="review-text-button" onClick={() => find('effect')}>Cancel replacement</button>}
            {search.query.trim() && <>
              <p className="review-muted" role="status">{choices.length ? `${choices.length} match${choices.length === 1 ? '' : 'es'}${choices.length > 20 ? ' · showing first 20; refine your search' : ''}` : 'No matches. Try a shorter phrase.'}</p>
              <ul className="review-search-results">
                {choices.slice(0, 20).map((entry) => (
                  <li key={entry.id}><button onClick={() => select(entry)}>
                    <span>{entry.name}</span>
                    <small>{search.kind === 'item' ? `${entry.color}${entry.dn ? ' · Deep' : ''}` : entry.category}</small>
                  </button></li>
                ))}
              </ul>
            </>}
          </div>

          {['buffs', 'nerfs'].map((group) => (
            <div className="review-effect-group" key={group}>
              <h3>{group === 'buffs' ? 'Buffs' : 'Debuffs'} <span className="review-muted">{draft[group].length}</span></h3>
              <ul className="review-edit-effects">
                {draft[group].map((effect) => (
                  <li key={effect.effectId}>
                    <span>{effect.name}</span>
                    <div>
                      <button className="review-text-button" aria-label={`Replace ${effect.name}`} onClick={() => find('effect', effect.effectId)}>Replace</button>
                      <button className="review-text-button" aria-label={`Remove ${effect.name}`} onClick={() => setDraft(removeRelicEffect(draft, effect.effectId))}>Remove</button>
                    </div>
                  </li>
                ))}
              </ul>
              {!draft[group].length && <p className="review-muted">None</p>}
            </div>
          ))}
          <button className="btn btn--secondary" onClick={() => find('effect')}>Add effect</button>
          <label className="review-checkbox review-confirm">
            <input type="checkbox" checked={!!draft.reviewed} onChange={(event) => setDraft({ ...draft, reviewed: event.target.checked, flagged: false })} />
            I checked this relic against the capture
          </label>
        </section>
      </div>

      <div className="review-dialog-footer">
        <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn--secondary" onClick={() => save()}>Save changes</button>
        <button className="btn btn--primary" onClick={() => save(true)}>{hasNext ? 'Mark reviewed & next' : 'Save & mark reviewed'}</button>
      </div>
    </dialog>
  )
}
