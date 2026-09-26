import Fuse from 'fuse.js'
import { EFFECTS, ITEMS } from '../data/effectsList.js'

// Searching `desc` too (previously weighted 0.3) roughly doubles Fuse's cost
// per candidate — `desc` is a full sentence, and with `ignoreLocation: true`
// Fuse has to test every alignment within it rather than stopping early. It
// was speculative from the start (the compact in-game overlay only ever
// shows `name`, never the description), and dropping it hasn't cost any
// accuracy against the real-video test fixtures in tests/ — so name-only it
// is, at roughly half the per-search cost.
const effectFuse = new Fuse(EFFECTS, {
  keys: ['name'],
  includeScore: true,
  threshold: 0.45,
  ignoreLocation: true,
  minMatchCharLength: 4,
})

const itemFuse = new Fuse(ITEMS, {
  keys: ['name'],
  includeScore: true,
  threshold: 0.4,
  ignoreLocation: true,
  minMatchCharLength: 3,
})

// OCR noise cleanup: strip bullet glyphs/leading punctuation Tesseract
// tends to invent from icon glyphs, collapse whitespace.
export function cleanOcrLine(line) {
  return line
    .replace(/^[\s\-•*·▪●○◦►▶|]+/, '')
    .replace(/[\s\-•*·▪●○◦►▶|]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Many compendium entries share an identical display name across several
// different effect IDs (different power tiers distinguished only in `desc`,
// which the compact in-game overlay never shows). The name is the actually
// observable, stable unit — IDs are an internal compendium artifact that can
// flip between near-duplicate candidates from trivial OCR noise. Group/dedupe
// on this instead of effectId.
export function normalizeEffectName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

// Matches effectFuse's own search threshold — there's no reason for a second,
// stricter gate here: any candidate Fuse itself is willing to return should
// be accepted. (These used to disagree — 0.4 vs 0.45 — which silently
// discarded some genuinely-good matches for no benefit.)
const MIN_CONFIDENT_SCORE = 0.45 // fuse score: 0 = perfect, 1 = no match

// Fuse's fuzzy search is a Bitap scan over every entry — worth it for garbled
// OCR, wasted on text that already reads exactly like a compendium name
// (measured: ~43% of OCR'd lines do, before even accounting for the
// icon-prefix-stripped variants). These give those lines an O(1) way out.
// Where several entries share a display name, first-one-wins resolves
// consistently instead of relying on Fuse's arbitrary tie-break — and
// grouping already treats same-named entries as interchangeable.
function buildNameIndex(entries) {
  const index = new Map()
  for (const entry of entries) {
    const key = normalizeEffectName(entry.name)
    if (!index.has(key)) index.set(key, entry)
  }
  return index
}

const effectsByName = buildNameIndex(EFFECTS)
const itemsByName = buildNameIndex(ITEMS)

// Every effect line in the game's UI is preceded by a small icon, which
// Tesseract frequently misreads as 1-2 garbage tokens ("[ae]", "(m0", "8",
// "="...) glued onto the front of the real text. That noise is unpredictable
// enough that it's not worth pattern-matching directly — instead, retry the
// fuzzy search with the first one or two whitespace-separated tokens
// stripped, and keep whichever variant (including the untouched original)
// scores best. A real match only ever gets *better* by trying more
// candidates, since the untouched line is always included too.
function candidateLines(line) {
  const tokens = line.split(/\s+/)
  const candidates = [line]
  for (const dropCount of [1, 2]) {
    if (tokens.length <= dropCount) break
    const stripped = tokens.slice(dropCount).join(' ')
    if (stripped.length >= 4 && !candidates.includes(stripped)) candidates.push(stripped)
  }
  return candidates
}

// A slow-scrolling or paused capture samples the same on-screen text over
// many consecutive frames, each re-running these Fuse searches against an
// identical (or near-identical) string. Both functions are pure lookups
// against static compendium data, so memoizing on the cleaned input is
// always safe — no invalidation ever needed — and eliminates that repeat
// work entirely for exact repeats.
const effectLineCache = new Map()
const itemLineCache = new Map()

function withRawText(cached, rawLine) {
  return cached ? { ...cached, rawText: rawLine } : null
}

export function matchEffectLine(rawLine) {
  const line = cleanOcrLine(rawLine)
  if (line.length < 4) return null
  if (effectLineCache.has(line)) return withRawText(effectLineCache.get(line), rawLine)

  const candidates = candidateLines(line)

  // Exact hit on any candidate is the best match possible (score 0) — no
  // amount of fuzzy searching can beat it, so take it and skip Fuse entirely.
  let best = null
  for (const candidate of candidates) {
    const exact = effectsByName.get(normalizeEffectName(candidate))
    if (exact) {
      best = { item: exact, score: 0 }
      break
    }
  }

  // candidateLines() tries the untouched line first. If that's already a
  // near-perfect match, the icon-prefix-stripped variants exist specifically
  // to rescue lines the untouched one *doesn't* already handle well — they
  // can't meaningfully improve on a near-0 score, so skip the extra searches.
  if (!best) {
    for (const candidate of candidates) {
      if (best && best.score < 0.05) break
      const results = effectFuse.search(candidate, { limit: 1 })
      if (!results.length) continue
      const { item, score } = results[0]
      if (!best || score < best.score) best = { item, score }
    }
  }

  const result =
    best && best.score <= MIN_CONFIDENT_SCORE
      ? {
          rawText: rawLine,
          cleanedText: line,
          effectId: best.item.id,
          effectName: best.item.name,
          category: best.item.category,
          desc: best.item.desc,
          confidence: 1 - best.score,
        }
      : null

  effectLineCache.set(line, result)
  return result
}

const MIN_CONFIDENT_ITEM_SCORE = 0.4 // matches itemFuse's own threshold, same reasoning as above

export function matchItemName(rawLine) {
  const line = cleanOcrLine(rawLine)
  if (line.length < 3) return null
  if (itemLineCache.has(line)) return withRawText(itemLineCache.get(line), rawLine)

  // Same exact-first shortcut as matchEffectLine — this one runs on every
  // line of every frame against the larger (849-entry) vessel list, so it's
  // the bigger share of the two.
  const exact = itemsByName.get(normalizeEffectName(line))
  const results = exact ? [{ item: exact, score: 0 }] : itemFuse.search(line, { limit: 1 })
  const { item, score } = results[0] || {}
  const result =
    results.length && score <= MIN_CONFIDENT_ITEM_SCORE
      ? {
          rawText: rawLine,
          itemId: item.id,
          itemName: item.name,
          color: item.color,
          dn: item.dn,
          confidence: 1 - score,
        }
      : null

  itemLineCache.set(line, result)
  return result
}

// Given raw multi-line OCR text from one cropped frame, produce the set of
// matched effect lines (deduped) plus an optional best-guess item/vessel name.
export function matchFrameText(ocrText) {
  const lines = ocrText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  const matchedEffects = []
  const seenNames = new Set()
  let bestItemMatch = null
  let skipNextLine = false

  for (let i = 0; i < lines.length; i++) {
    if (skipNextLine) {
      skipNextLine = false
      continue
    }
    const line = lines[i]

    // A long effect name can get word-wrapped across two lines by the game's
    // UI (e.g. "...restores HP for allies but not for" / "self"), which
    // Tesseract then reports as two separate lines. A truncated first line
    // can still confidently match *something* on its own (its own name, just
    // incomplete) — so it's not enough to only try merging when the single
    // line fails outright; that leaves the orphaned second line to go on and
    // falsely match some unrelated effect by itself. Instead, always try
    // both and keep whichever scores better: a genuine wrap will score at
    // least as well once completed, while two unrelated adjacent lines
    // concatenated together will almost never out-score a real single-line
    // match.
    // ...with one exception: a confidence of 1 means the line already matched
    // a compendium name exactly, and nothing the merge finds can beat that, so
    // skip the second search. That halves the fuzzy searches on clean lines.
    const singleMatch = matchEffectLine(line)
    const mergedMatch =
      i + 1 < lines.length && singleMatch?.confidence !== 1
        ? matchEffectLine(`${line} ${lines[i + 1]}`)
        : null

    let effectMatch = singleMatch
    let consumedNextLine = false
    if (mergedMatch && (!singleMatch || mergedMatch.confidence >= singleMatch.confidence)) {
      effectMatch = mergedMatch
      consumedNextLine = true
    }

    if (effectMatch) {
      const nameKey = normalizeEffectName(effectMatch.effectName)
      if (!seenNames.has(nameKey)) {
        seenNames.add(nameKey)
        matchedEffects.push(effectMatch)
      }
    }

    // Always also try this line (untouched) as a possible item/vessel name,
    // even when it also matched (or merged into) an effect above — the
    // vessel-name line sits directly above the first behavior line, and
    // merging the two can still confidently match a real effect (the vessel
    // name just reads as harmless prefix noise), which would otherwise
    // swallow the line and it'd never get a chance to be recognized as the
    // item name.
    const itemMatch = matchItemName(line)
    if (itemMatch && (!bestItemMatch || itemMatch.confidence > bestItemMatch.confidence)) {
      bestItemMatch = itemMatch
    }

    if (consumedNextLine) skipNextLine = true
  }

  return { matchedEffects, itemMatch: bestItemMatch, lineCount: lines.length }
}

// Deep relics can carry demerits ("nerfs") alongside their normal behaviors
// ("buffs"), shown below them in-game. The compendium doesn't have a
// dedicated buff/nerf flag, but every demerit effect (reduced stats, HP
// drain, impaired damage negation, buildup vulnerabilities...) is exhaustively
// categorized as "Impairment" and no non-demerit effect uses that category,
// so it's a reliable signal to classify on.
const DEMERIT_CATEGORY = 'Impairment'
export function isDemeritCategory(category) {
  return category === DEMERIT_CATEGORY
}

// A relic is uniquely identified by its sorted set of matched effect names
// (not ids — see normalizeEffectName for why).
export function signatureFor(matchedEffects) {
  return signatureFromNames(matchedEffects.map((e) => normalizeEffectName(e.effectName)))
}

export function signatureFromNames(names) {
  return [...names].sort().join('+')
}
