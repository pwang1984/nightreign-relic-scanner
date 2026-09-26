import { normalizeEffectName, signatureFromNames, isDemeritCategory } from './matcher.js'

const DEFAULT_CONTINUATION_THRESHOLD = 0.5 // Jaccard(new frame names, run's stable core) to extend a run
const DEFAULT_MIN_NAME_FREQUENCY = 0.4 // name must appear in >= this fraction of a run's frames to survive
const DEFAULT_MERGE_THRESHOLD = 0.5 // Jaccard between two time-adjacent finished runs to merge as fragments

function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1
  let intersection = 0
  for (const x of setA) if (setB.has(x)) intersection += 1
  const union = setA.size + setB.size - intersection
  return union === 0 ? 1 : intersection / union
}

// Consecutive frames showing the same relic won't always produce identical
// OCR matches (a dropped/garbled line, or a duplicate-name effect resolving
// to a different but equally-valid id — see normalizeEffectName). Rather than
// requiring an exact match to keep extending a run, this watches how similar
// each new frame is to the run's "stable core" (names that have shown up
// often enough so far to be trusted), and only starts a new run once
// similarity drops too low. Every run — even a single frame — is promoted to
// a relic; there's no minimum-repeat-count gate.
export class RelicCollector {
  constructor({
    continuationThreshold = DEFAULT_CONTINUATION_THRESHOLD,
    minNameFrequency = DEFAULT_MIN_NAME_FREQUENCY,
    mergeThreshold = DEFAULT_MERGE_THRESHOLD,
    intervalSec = 0.5,
  } = {}) {
    this.continuationThreshold = continuationThreshold
    this.minNameFrequency = minNameFrequency
    this.mergeThreshold = mergeThreshold
    this.maxMergeGapSec = intervalSec * 3
    this.runs = [] // finished runs, pre-merge: { nameCounts, effectMeta, itemVotes, frameCount, firstSeen, lastSeen }
    this.current = null
  }

  addFrame(frameMatch, timeSec) {
    const { matchedEffects, itemMatch } = frameMatch
    const frameNames = new Set(matchedEffects.map((e) => normalizeEffectName(e.effectName)))

    if (this.current) {
      const similarity = jaccard(frameNames, this._coreNames())
      if (frameNames.size > 0 && similarity >= this.continuationThreshold) {
        this._applyFrame(this.current, matchedEffects, itemMatch, timeSec)
        return
      }
      this._flushCurrent()
    }

    if (matchedEffects.length === 0) return
    this.current = {
      nameCounts: new Map(),
      effectMeta: new Map(),
      itemVotes: [],
      frameCount: 0,
      firstSeen: timeSec,
      lastSeen: timeSec,
    }
    this._applyFrame(this.current, matchedEffects, itemMatch, timeSec)
  }

  _applyFrame(run, matchedEffects, itemMatch, timeSec) {
    run.frameCount += 1
    run.lastSeen = timeSec
    if (itemMatch) run.itemVotes.push(itemMatch)
    for (const effect of matchedEffects) {
      const name = normalizeEffectName(effect.effectName)
      run.nameCounts.set(name, (run.nameCounts.get(name) || 0) + 1)
      const existingMeta = run.effectMeta.get(name)
      if (!existingMeta || effect.confidence > existingMeta.confidence) {
        run.effectMeta.set(name, effect)
      }
    }
  }

  _coreNames() {
    if (!this.current) return new Set()
    const core = new Set()
    for (const [name, count] of this.current.nameCounts) {
      if (count / this.current.frameCount >= this.minNameFrequency) core.add(name)
    }
    return core
  }

  _flushCurrent() {
    if (this.current) {
      this.runs.push(this.current)
    }
    this.current = null
  }

  // Call once frame walking is done. Returns deduped unique relics sorted by
  // first time seen.
  finish() {
    this._flushCurrent()

    const finalized = this.runs.map((run) => this._finalizeRun(run))
    finalized.sort((a, b) => a.firstSeen - b.firstSeen)
    const merged = this._mergeAdjacentFragments(finalized)

    const bySignature = new Map()
    for (const run of merged) {
      const existing = bySignature.get(run.signature)
      if (!existing) {
        bySignature.set(run.signature, { ...run, occurrences: 1 })
      } else {
        existing.occurrences += 1
        existing.itemVotes.push(...run.itemVotes)
        existing.lastSeen = run.lastSeen
      }
    }

    const relics = [...bySignature.values()].map((r, idx) => {
      const allBehaviors = r.names.map((name) => {
        const meta = r.effectMeta.get(name)
        return {
          name: meta.effectName,
          effectId: meta.effectId,
          category: meta.category,
          desc: meta.desc,
          confidence: Number(meta.confidence.toFixed(2)),
        }
      })
      return {
        id: idx + 1,
        itemName: pickBestVote(r.itemVotes, (v) => v.itemName),
        color: pickBestVote(r.itemVotes, (v) => v.color),
        // Deep relics (the only ones that can carry demerits) are flagged on
        // the compendium's own vessel/item data, not the effects — same
        // weighted-vote approach as itemName/color above.
        dn: pickBestVote(r.itemVotes, (v) => v.dn) ?? false,
        // Deep relics can carry demerits ("nerfs") shown below their normal
        // behaviors ("buffs") — split on the compendium's own category data
        // rather than guessing from line position.
        buffs: allBehaviors.filter((b) => !isDemeritCategory(b.category)),
        nerfs: allBehaviors.filter((b) => isDemeritCategory(b.category)),
        occurrences: r.occurrences,
        firstSeen: r.firstSeen,
        lastSeen: r.lastSeen,
      }
    })

    relics.sort((a, b) => a.firstSeen - b.firstSeen)
    return relics
  }

  // Frequency-filters a run's accumulated name counts down to its "core"
  // (names seen often enough to trust), which becomes its final behavior list.
  _finalizeRun(run) {
    const names = [...run.nameCounts.entries()]
      .filter(([, count]) => count / run.frameCount >= this.minNameFrequency)
      .map(([name]) => name)
      .sort()
    return {
      names,
      signature: signatureFromNames(names),
      effectMeta: run.effectMeta,
      itemVotes: run.itemVotes,
      frameCount: run.frameCount,
      firstSeen: run.firstSeen,
      lastSeen: run.lastSeen,
    }
  }

  // Two runs that are close together in time and share most of their
  // behaviors are probably the same relic's viewing period, split by a
  // noisy gap (e.g. a couple of blank/garbled frames). Name-overlap alone
  // isn't safe to merge on globally — common effect names legitimately
  // recur across unrelated relics throughout a video — so this only
  // considers runs that are also time-adjacent.
  _mergeAdjacentFragments(finalizedRuns) {
    const merged = []
    for (const run of finalizedRuns) {
      const prev = merged[merged.length - 1]
      if (
        prev &&
        run.firstSeen - prev.lastSeen <= this.maxMergeGapSec &&
        jaccard(new Set(prev.names), new Set(run.names)) >= this.mergeThreshold
      ) {
        this._mergeInto(prev, run)
      } else {
        merged.push(run)
      }
    }
    return merged
  }

  _mergeInto(target, source) {
    for (const [name, meta] of source.effectMeta) {
      const existing = target.effectMeta.get(name)
      if (!existing || meta.confidence > existing.confidence) {
        target.effectMeta.set(name, meta)
      }
    }
    const nameSet = new Set([...target.names, ...source.names])
    target.names = [...nameSet].sort()
    target.signature = signatureFromNames(target.names)
    target.itemVotes.push(...source.itemVotes)
    target.frameCount += source.frameCount
    target.lastSeen = source.lastSeen
  }
}

// Weighted majority vote across a run's item-name matches: whichever value
// (name / color / dn flag, via keyFn) accumulated the most matcher confidence
// wins. Used for itemName, color, and dn — all three come from the same
// matched-item votes and should usually agree, but this keeps them
// independently robust to a stray bad match.
function pickBestVote(votes, keyFn) {
  if (!votes.length) return null
  const counts = new Map()
  for (const v of votes) {
    const key = keyFn(v)
    if (key === undefined || key === null) continue
    counts.set(key, (counts.get(key) || 0) + v.confidence)
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
  return sorted.length ? sorted[0][0] : null
}
