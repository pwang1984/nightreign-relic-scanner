import { getEffects, getItems } from '../data/effectsList.js'
import { isDemeritCategory, normalizeEffectName, getReviewLines } from './matcher.js'

export function getReviewIssues(relic) {
  const issues = []
  if (relic.flagged) issues.push('Flagged for review')
  if (!relic.itemName) issues.push('Relic name not recognized')
  if (!relic.color) issues.push('Relic color not recognized')
  const effects = [...relic.buffs, ...relic.nerfs]
  const lines = getReviewLines(relic.review)
  // Wrapped effects are already one segment; titles and repeated OCR lines
  // must not inflate the number of expected effects.
  const segments = new Set(lines.filter((line) => line.kind !== 'item' && line.kind !== 'note')
    .map((line) => normalizeEffectName(line.effectName || line.text)))
  if (segments.size > effects.length) {
    issues.push(`${segments.size} OCR text segments, ${effects.length} matched effects`)
  }
  const uncertain = effects.filter((effect) => effect.confidence < 0.85)
  if (uncertain.length) issues.push(`${uncertain.length} low-confidence match${uncertain.length === 1 ? '' : 'es'}`)
  return issues
}

export function needsReview(relic) {
  return !relic.reviewed && getReviewIssues(relic).length > 0
}

export function reviewStatus(relic) {
  return relic.reviewed ? 'Reviewed' : needsReview(relic) ? 'Needs review' : 'No issues detected'
}

export function selectRelicItem(relic, item) {
  return { ...relic, itemName: item.name, color: item.color, dn: item.dn }
}

export function removeRelicEffect(relic, effectId) {
  return {
    ...relic,
    buffs: relic.buffs.filter((effect) => effect.effectId !== effectId),
    nerfs: relic.nerfs.filter((effect) => effect.effectId !== effectId),
  }
}

export function selectRelicEffect(relic, entry, replacedId = null) {
  const remaining = removeRelicEffect(relic, replacedId)
  if ([...remaining.buffs, ...remaining.nerfs].some((effect) => effect.effectId === entry.id)) return relic
  const group = isDemeritCategory(entry.category) ? 'nerfs' : 'buffs'
  return {
    ...remaining,
    [group]: [...remaining[group], {
      effectId: entry.id, name: entry.name, category: entry.category,
      desc: entry.desc, confidence: 1,
    }],
  }
}

export function searchReviewCatalog(query, kind, language = 'en') {
  const tokens = query.trim().split(/\s+/).filter(Boolean).map(normalizeEffectName)
  if (!tokens.length) return []
  const entries = kind === 'item' ? getItems(language) : getEffects(language)
  const english = new Map((kind === 'item' ? getItems() : getEffects()).map((entry) => [entry.id, entry.name]))
  const seen = new Set()
  return entries.filter((entry) => {
    const text = normalizeEffectName(`${entry.name} ${english.get(entry.id)} ${entry.id}`)
    if (!tokens.every((token) => text.includes(token))) return false
    const key = normalizeEffectName(entry.name)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
