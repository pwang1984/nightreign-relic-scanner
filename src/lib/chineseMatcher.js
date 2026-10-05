import { getEffects, getItems } from '../data/effectsList.js'
import { normalizeChineseName, isChineseUsageNote } from './chineseText.js'
export { normalizeChineseName } from './chineseText.js'

function buildIndex(entries) {
  const exact = new Map()
  for (const entry of entries) {
    const key = normalizeChineseName(entry.name)
    // Same-name tiers use the same deterministic ID policy as English.
    if (!exact.has(key)) exact.set(key, entry)
  }
  return { exact, candidates: [...exact].map(([key, entry]) => ({ key, entry })) }
}

const effects = buildIndex(getEffects('zh-CN'))
const items = buildIndex(getItems('zh-CN'))
const effectCache = new Map()
const itemCache = new Map()
const splitCache = new Map()

// A missing/misread | can join a buff and a demerit. Recover only one
// unambiguous pair of exact catalog names; never guess away a numeric tier.
export function splitChineseEffectPair(line) {
  if (splitCache.has(line)) return splitCache.get(line)
  const pairs = new Map()
  if (!effects.exact.has(normalizeChineseName(line))) {
    for (let i = 1; i < line.length; i++) {
      const left = effects.exact.get(normalizeChineseName(line.slice(0, i)))
      if (!left || left.category === 'Impairment') continue
      // A thin | can also become 1, including immediately after a tier (+31).
      // Consume it only between two exact names, never in a standalone tier.
      const rightText = line.slice(i).replace(/^\s*[il1１]\s*(?=\p{Script=Han})/iu, '')
      const right = effects.exact.get(normalizeChineseName(rightText))
      if (right?.category === 'Impairment') pairs.set(`${left.id}:${right.id}`, [line.slice(0, i), rightText])
    }
  }
  const result = pairs.size === 1 ? [...pairs.values()][0] : [line]
  splitCache.set(line, result)
  return result
}

// Text boxes can repeat their shared edge: 出击时，会 / 会持有 / 有“魔力壶”.
// Try overlap removal only when it yields a unique, complete catalog entry.
export function matchChineseEffectFragments(lines) {
  const parts = lines.map(normalizeChineseName)
  let variants = new Set([parts[0]])
  for (const part of parts.slice(1)) {
    const next = new Set()
    for (const prefix of variants) {
      next.add(prefix + part)
      for (let overlap = 1; overlap <= Math.min(prefix.length, part.length); overlap++) {
        if (prefix.endsWith(part.slice(0, overlap))) next.add(prefix + part.slice(overlap))
      }
    }
    variants = next
  }
  const exact = [...variants].filter((text) => effects.exact.has(text))
  if (exact.length === 1) return { ...matchChineseEffectLine(exact[0]), rawText: lines.join('\n') }
  return exact.length > 1 ? null : matchChineseEffectLine(lines.join(' '))
}

function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(row[j - 1] + 1, previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    previous = row
  }
  return previous[b.length]
}

function numbers(text) {
  return (text.match(/[+-]?\d+/g) || []).join(',')
}

function lookup(rawLine, index, cache, allowItemSuffixNoise = false) {
  const normalized = normalizeChineseName(rawLine)
  if (cache.has(normalized)) return cache.get(normalized)
  // Only strip non-Chinese icon noise. Dropping arbitrary Chinese characters
  // can turn a real negative effect into a positive one.
  const withoutPrefix = normalized.replace(/^[^\p{Script=Han}]+/u, '')
  const variants = [...new Set([
    normalized,
    withoutPrefix,
    // Item titles have no numeric tiers. Trailing UI noise can read as 8/9;
    // effect lines must retain their numeric suffixes.
    ...(allowItemSuffixNoise ? [withoutPrefix.replace(/[^\p{Script=Han}]+$/u, '')] : []),
  ])]
    .filter((text) => /\p{Script=Han}/u.test(text))
  for (const text of variants) {
    const entry = index.exact.get(text)
    if (entry) {
      const result = { entry, confidence: 1 }
      cache.set(normalized, result)
      return result
    }
  }

  const ranked = new Map()
  for (const text of variants) {
    // Short names (e.g. 力气+3) are too ambiguous to repair by guessing.
    if (text.length < 6) continue
    const maxEdits = Math.min(3, Math.floor(text.length * 0.18))
    for (const { key, entry } of index.candidates) {
      if (Math.abs(key.length - text.length) > maxEdits || numbers(key) !== numbers(text)) continue
      const distance = editDistance(text, key)
      if (distance > maxEdits) continue
      const score = distance / Math.max(key.length, text.length)
      const identity = normalizeChineseName(entry.name)
      const previous = ranked.get(identity)
      if (!previous || score < previous.score) ranked.set(identity, { entry, score })
    }
  }
  const [best, second] = [...ranked.values()].sort((a, b) => a.score - b.score)
  // Refuse close alternatives: Chinese weapon/element names often differ by
  // one character. Full-string distance also avoids Fuse's substring matches
  // that accept half of a wrapped sentence as an unrelated complete effect.
  const result = best && (!second || second.score - best.score > 0.03)
    ? { entry: best.entry, confidence: 1 - best.score }
    : null
  cache.set(normalized, result)
  return result
}

export function matchChineseEffectLine(rawLine) {
  // Square effect icons can OCR as an isolated Han token. Removing these
  // observed glyphs leaves the edit allowance for errors in the effect itself.
  // Require a token boundary and keep other prefixes (including negations).
  const line = rawLine.trim().replace(/^[国回图园辆羡]\s+(?=\p{Script=Han})/u, '')
  const match = lookup(line, effects, effectCache)
  if (!match) return null
  return {
    rawText: rawLine,
    cleanedText: normalizeChineseName(line),
    effectId: match.entry.id,
    effectName: match.entry.name,
    category: match.entry.category,
    desc: match.entry.desc,
    confidence: match.confidence,
  }
}

export function matchChineseItemName(rawLine) {
  const match = lookup(rawLine, items, itemCache, true)
  if (!match) return null
  return {
    rawText: rawLine,
    itemId: match.entry.id,
    itemName: match.entry.name,
    color: match.entry.color,
    dn: match.entry.dn,
    confidence: match.confidence,
  }
}

function splitChineseOcrLine(line) {
  return line.split(/[|｜]/).flatMap((part) => {
    // Paddle can read the thin vertical separator as an opening quote.
    // Only split it when both halves resolve and the right half is a nerf;
    // ordinary quotes inside effect names must stay intact.
    const separator = part.indexOf('「')
    if (separator < 0) return splitChineseEffectPair(part)
    const left = part.slice(0, separator)
    const right = part.slice(separator + 1)
    if (matchChineseEffectLine(left) && matchChineseEffectLine(right)?.category === 'Impairment') {
      return [left, right]
    }
    return splitChineseEffectPair(part)
  })
}

export const chineseMatchingStrategy = {
  splitLines: (text) => text.split('\n').flatMap(splitChineseOcrLine),
  matchEffect: matchChineseEffectLine,
  matchItem: matchChineseItemName,
  matchFragments: matchChineseEffectFragments,
  maxLines: 3,
  preferMerged: (merged, current) => merged.confidence > current.confidence,
  isUsageNote: isChineseUsageNote,
  hasReviewText: (text) => (text.match(/\p{Script=Han}/gu) || []).length >= 2,
}
