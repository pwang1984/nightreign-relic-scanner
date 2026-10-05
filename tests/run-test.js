#!/usr/bin/env node
// Runs the app's real matching/grouping pipeline (src/lib/matcher.js,
// src/lib/grouping.js) against a video clip outside the browser, so a test
// fixture like tests/test1.json can be checked without manually clicking
// through the UI. Frame extraction (which the app does via an HTMLVideoElement
// + <canvas>) is done here with ffmpeg instead, since those aren't available
// in Node — everything downstream (OCR + matching + grouping) is the same
// code the browser app runs.
//
// Usage: node tests/run-test.js [tests/test1.json ...]
// With no arguments, runs every tests/*.json fixture.

import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { createWorker } from 'tesseract.js'

import { matchFrameText, normalizeEffectName } from '../src/lib/matcher.js'
import { RelicCollector } from '../src/lib/grouping.js'
import { getEffects } from '../src/data/effectsList.js'
import { getLanguage } from '../src/lib/languages.js'
import { SCAN_INTERVAL_SEC } from '../src/lib/videoFrames.js'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

function parseFraction(value) {
  if (typeof value === 'number') return value
  const str = String(value).trim()
  return str.endsWith('%') ? parseFloat(str) / 100 : parseFloat(str)
}

async function ffprobeDimensions(videoPath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-show_entries', 'format=duration',
    '-of', 'json',
    videoPath,
  ])
  const data = JSON.parse(stdout)
  return {
    width: data.streams[0].width,
    height: data.streams[0].height,
    duration: parseFloat(data.format.duration),
  }
}

async function extractFrames(videoPath, box, { intervalSec, upscale, frameDir }) {
  const { width, height } = await ffprobeDimensions(videoPath)
  const cropX = Math.round(box.left * width)
  const cropY = Math.round(box.top * height)
  const cropW = Math.round(box.width * width)
  const cropH = Math.round(box.height * height)
  const outW = Math.max(2, Math.round(cropW * upscale))
  const outH = Math.max(2, Math.round(cropH * upscale))
  const fps = 1 / intervalSec

  const pattern = path.join(frameDir, 'frame-%06d.png')
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', videoPath,
    '-vf', `fps=${fps},crop=${cropW}:${cropH}:${cropX}:${cropY},scale=${outW}:${outH}`,
    pattern,
  ])

  const files = (await readdir(frameDir)).filter((f) => f.endsWith('.png')).sort()
  return files.map((f, i) => ({ file: path.join(frameDir, f), timeSec: i * intervalSec }))
}

// Times a single async call and adds its duration (ms) onto `bucket[key]`.
async function timed(bucket, key, fn) {
  const start = performance.now()
  const result = await fn()
  bucket[key] = (bucket[key] || 0) + (performance.now() - start)
  return result
}

// Same as `timed`, but for synchronous work (matching/grouping never await).
function timeSync(bucket, key, fn) {
  const start = performance.now()
  const result = fn()
  bucket[key] = (bucket[key] || 0) + (performance.now() - start)
  return result
}

function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1
  let intersection = 0
  for (const x of setA) if (setB.has(x)) intersection += 1
  const union = setA.size + setB.size - intersection
  return union === 0 ? 1 : intersection / union
}

function idsToNameSet(ids, idToName) {
  return new Set((ids || []).map((id) => idToName.get(String(id)) || `<unknown effect id: ${id}>`))
}

// A fixture's relics can be given as a flat array of ids (no buff/nerf/color/dn
// info — treated as all-buffs with no color/dn assertion) or as the newer
// { buffs, nerfs, color, dn } shape. An empty-string color means "not
// asserted" (e.g. the vessel color wasn't clearly visible in that clip),
// same as omitting it entirely.
function toExpectedRelic(relic, idToName) {
  if (Array.isArray(relic)) {
    return { buffs: idsToNameSet(relic, idToName), nerfs: new Set(), color: null, dn: null }
  }
  return {
    buffs: idsToNameSet(relic.buffs, idToName),
    nerfs: idsToNameSet(relic.nerfs, idToName),
    color: relic.color || null,
    dn: relic.dn ?? null,
  }
}

async function runTest(testFilePath) {
  const spec = JSON.parse(await readFile(testFilePath, 'utf8'))
  const language = spec.language ?? 'en'
  const idToName = new Map(getEffects(language).map((e) => [String(e.id), normalizeEffectName(e.name)]))
  const testDir = path.dirname(testFilePath)
  const videoPath = path.resolve(testDir, spec.video)

  const box = {
    left: parseFraction(spec.box.left),
    top: parseFraction(spec.box.top),
    width: parseFraction(spec.box.width),
    height: parseFraction(spec.box.height),
  }
  const intervalSec = spec.intervalSec ?? SCAN_INTERVAL_SEC
  const upscale = spec.upscale ?? 2

  const frameDir = await mkdtemp(path.join(tmpdir(), 'nightreign-test-'))
  const timing = {} // ms accumulated per pipeline stage, see `timed()`
  let frames
  try {
    frames = await timed(timing, 'extractFrames', () =>
      extractFrames(videoPath, box, { intervalSec, upscale, frameDir }),
    )

    const worker = await timed(timing, 'workerInit', async () => language === 'zh-CN'
      ? (await import('./browser-ocr.js')).createBrowserOcrWorker()
      : createWorker(getLanguage(language).ocr, undefined, { cachePath: tmpdir() }))
    const collector = new RelicCollector({ intervalSec })
    let framesSkipped = 0
    // Reuse OCR for byte-identical extracted PNGs. The browser's pixel-based
    // comparison also tolerates encoding noise; that path has separate tests.
    let lastHash = null
    let lastText = ''
    let lastFrameMatch = null
    try {
      for (const frame of frames) {
        const hash = await timed(timing, 'hash', async () => createHash('sha1').update(await readFile(frame.file)).digest('hex'))

        let text, frameMatch
        const wasSkipped = hash === lastHash
        if (wasSkipped) {
          text = lastText
          frameMatch = lastFrameMatch
          framesSkipped += 1
        } else {
          const { data } = await timed(timing, 'ocr', () => worker.recognize(frame.file))
          text = data.text
          frameMatch = timeSync(timing, 'match', () => matchFrameText(text, language))
          lastHash = hash
          lastText = text
          lastFrameMatch = frameMatch
        }

        timeSync(timing, 'group', () => collector.addFrame(frameMatch, frame.timeSec))
        if (process.env.DEBUG) {
          const names = frameMatch.matchedEffects.map((e) => e.effectName)
          console.log(`  [frame t=${frame.timeSec.toFixed(3)}] ${frame.file}${wasSkipped ? ' (skipped, unchanged)' : ''}`)
          console.log(`      raw OCR: ${JSON.stringify(text)}`)
          console.log(`      matched: ${names.length ? names.join(' | ') : '(none)'}`)
        }
      }
    } finally {
      await timed(timing, 'workerTerminate', () => worker.terminate())
    }

    const detected = timeSync(timing, 'finish', () => collector.finish())
    const expectedRelics = spec.relics.map((relic) => toExpectedRelic(relic, idToName))

    return { testFilePath, frameCount: frames.length, framesSkipped, detected, expectedRelics, timing }
  } finally {
    if (process.env.DEBUG) {
      console.log(`  (debug) kept extracted frames at: ${frameDir}`)
    } else {
      await rm(frameDir, { recursive: true, force: true })
    }
  }
}

function nameSet(behaviors) {
  return new Set(behaviors.map((b) => normalizeEffectName(b.name)))
}

// Compares an expected attribute (color/dn) against the detected one.
// Returns null when the fixture didn't assert anything for this attribute
// (so it's excluded from pass/fail), true/false otherwise. A detected relic
// with no value for an asserted attribute counts as a mismatch, not "n/a".
function attrMatches(expectedVal, detectedVal, eqFn) {
  if (expectedVal === null || expectedVal === undefined) return null
  if (detectedVal === null || detectedVal === undefined) return false
  return eqFn(expectedVal, detectedVal)
}

// Greedily pairs each expected relic with its best-overlapping detected
// relic (matched on buffs+nerfs combined, without reusing a detected relic
// across two expected ones), then scores buffs, nerfs, color, and dn
// separately against that match, and reports whatever detected relics were
// left over as unexpected extras.
function scoreResults(detected, expectedRelics) {
  const detectedSets = detected.map((r) => ({
    buffs: nameSet(r.buffs),
    nerfs: nameSet(r.nerfs),
    color: r.color,
    dn: r.dn,
  }))
  const combined = (s) => new Set([...s.buffs, ...s.nerfs])
  const usedDetected = new Set()

  const matches = expectedRelics.map((expected) => {
    const expectedCombined = combined(expected)
    let best = { idx: -1, score: 0 }
    detectedSets.forEach((d, j) => {
      if (usedDetected.has(j)) return
      const score = jaccard(expectedCombined, combined(d))
      if (score > best.score) best = { idx: j, score }
    })
    if (best.idx >= 0) usedDetected.add(best.idx)
    const hasMatch = best.idx >= 0
    const matchedSet = hasMatch
      ? detectedSets[best.idx]
      : { buffs: new Set(), nerfs: new Set(), color: null, dn: null }
    const buffsScore = jaccard(expected.buffs, matchedSet.buffs)
    const nerfsScore = jaccard(expected.nerfs, matchedSet.nerfs)
    const colorMatch = attrMatches(expected.color, matchedSet.color, (a, b) => a.toLowerCase() === b.toLowerCase())
    const dnMatch = attrMatches(expected.dn, matchedSet.dn, (a, b) => a === b)
    const attrsOk = colorMatch !== false && dnMatch !== false
    const overallScore = hasMatch ? Math.min(buffsScore, nerfsScore) : 0

    return {
      hasMatch,
      expectedBuffs: [...expected.buffs],
      expectedNerfs: [...expected.nerfs],
      matchedBuffs: hasMatch ? [...matchedSet.buffs] : null,
      matchedNerfs: hasMatch ? [...matchedSet.nerfs] : null,
      buffsScore,
      nerfsScore,
      expectedColor: expected.color,
      detectedColor: matchedSet.color,
      colorMatch,
      expectedDn: expected.dn,
      detectedDn: matchedSet.dn,
      dnMatch,
      overallScore,
      passed: overallScore === 1 && attrsOk,
    }
  })

  const extras = detectedSets
    .map((s, j) => ({ j, buffs: [...s.buffs], nerfs: [...s.nerfs], color: s.color, dn: s.dn }))
    .filter(({ j }) => !usedDetected.has(j))

  return { matches, extras }
}

function statusFor(score) {
  return score === 1 ? 'EXACT' : score > 0 ? `PARTIAL ${(score * 100).toFixed(0)}%` : 'MISSING'
}

function attrStatus(match) {
  return match === null ? 'N/A' : match ? 'OK' : 'MISMATCH'
}

function printReport(testFilePath, frameCount, framesSkipped, { matches, extras }) {
  const exact = matches.filter((m) => m.passed).length
  const missing = matches.filter((m) => !m.hasMatch).length
  const partial = matches.length - exact - missing

  const skippedNote = framesSkipped ? `, ${framesSkipped} skipped as duplicates` : ''
  console.log(`\n=== ${path.relative(process.cwd(), testFilePath)} (${frameCount} frames sampled${skippedNote}) ===`)
  console.log(`Expected relics: ${matches.length}  |  Exact: ${exact}  Partial: ${partial}  Missing: ${missing}  |  Unexpected extras: ${extras.length}`)

  matches.forEach((m, i) => {
    const status = m.passed ? 'EXACT' : !m.hasMatch ? 'MISSING' : 'PARTIAL'
    console.log(`  [${i + 1}] ${status}`)
    console.log(`      buffs expected: ${m.expectedBuffs.join(', ') || '(none)'}`)
    console.log(`      buffs detected: ${m.matchedBuffs ? m.matchedBuffs.join(', ') || '(none)' : '(no matching relic)'}  [${statusFor(m.buffsScore)}]`)
    if (m.expectedNerfs.length || (m.matchedNerfs && m.matchedNerfs.length)) {
      console.log(`      nerfs  expected: ${m.expectedNerfs.join(', ') || '(none)'}`)
      console.log(`      nerfs  detected: ${m.matchedNerfs ? m.matchedNerfs.join(', ') || '(none)' : '(no matching relic)'}  [${statusFor(m.nerfsScore)}]`)
    }
    console.log(
      `      color  expected: ${m.expectedColor ?? '(n/a)'}  detected: ${m.detectedColor ?? '(none)'}  [${attrStatus(m.colorMatch)}]`,
    )
    console.log(
      `      dn     expected: ${m.expectedDn ?? '(n/a)'}  detected: ${m.detectedDn ?? '(none)'}  [${attrStatus(m.dnMatch)}]`,
    )
  })

  if (extras.length) {
    console.log('  Unexpected extra detections:')
    extras.forEach((e) => {
      const parts = [e.buffs.join(', ')]
      if (e.nerfs.length) parts.push(`nerfs: ${e.nerfs.join(', ')}`)
      parts.push(`color: ${e.color ?? '(none)'}`, `dn: ${e.dn ?? '(none)'}`)
      console.log(`    - ${parts.join(' | ')}`)
    })
  }

  return { exact, partial, missing, extras: extras.length, total: matches.length }
}

const TIMING_LABELS = {
  extractFrames: 'Frame extraction (ffmpeg)',
  workerInit: 'OCR worker startup',
  hash: 'Dedup hash (skip check)',
  ocr: 'OCR (recognize)',
  match: 'Matching (Fuse fuzzy search)',
  group: 'Grouping (RelicCollector)',
  finish: 'Finalize (collector.finish)',
  workerTerminate: 'OCR worker shutdown',
}

// 'ocr'/'match' only ever run on frames that weren't skipped as duplicates,
// so their per-frame average is only meaningful against that smaller count;
// 'group'/'hash' run on every sampled frame regardless.
const PER_PROCESSED_FRAME = new Set(['ocr', 'match'])
const PER_SAMPLED_FRAME = new Set(['group', 'hash'])

function printTiming(label, frameCount, framesSkipped, timing) {
  const total = Object.values(timing).reduce((sum, ms) => sum + ms, 0)
  const processedFrames = Math.max(1, frameCount - framesSkipped)
  const skippedNote = framesSkipped ? `, ${framesSkipped} skipped` : ''
  console.log(`\n--- Timing: ${label} (${frameCount} frames${skippedNote}) ---`)
  for (const [key, label] of Object.entries(TIMING_LABELS)) {
    const ms = timing[key] || 0
    const pct = total > 0 ? ((ms / total) * 100).toFixed(1) : '0.0'
    let perFrame = ''
    if (PER_PROCESSED_FRAME.has(key)) perFrame = ` (${(ms / processedFrames).toFixed(1)}ms/processed frame)`
    else if (PER_SAMPLED_FRAME.has(key)) perFrame = ` (${(ms / frameCount).toFixed(1)}ms/frame)`
    console.log(`  ${label.padEnd(28)} ${ms.toFixed(0).padStart(7)}ms  ${pct.padStart(5)}%${perFrame}`)
  }
  console.log(`  ${'Total'.padEnd(28)} ${total.toFixed(0).padStart(7)}ms`)
  return timing
}

async function main() {
  const profile = Boolean(process.env.PROFILE)
  const testsDir = __dirname
  let targets = process.argv.slice(2)
  if (targets.length === 0) {
    targets = (await readdir(testsDir))
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(testsDir, f))
  } else {
    targets = targets.map((t) => path.resolve(t))
  }

  const totals = { exact: 0, partial: 0, missing: 0, extras: 0, total: 0 }
  const timingTotals = {}
  let totalFrames = 0
  let totalFramesSkipped = 0
  for (const target of targets) {
    const { testFilePath, frameCount, framesSkipped, detected, expectedRelics, timing } = await runTest(target)
    const scored = scoreResults(detected, expectedRelics)
    const summary = printReport(testFilePath, frameCount, framesSkipped, scored)
    for (const key of Object.keys(totals)) totals[key] += summary[key]

    if (profile) {
      printTiming(path.relative(process.cwd(), testFilePath), frameCount, framesSkipped, timing)
      for (const key of Object.keys(timing)) timingTotals[key] = (timingTotals[key] || 0) + timing[key]
      totalFrames += frameCount
      totalFramesSkipped += framesSkipped
    }
  }

  if (targets.length > 1) {
    console.log(`\n=== Overall: ${totals.exact}/${totals.total} exact, ${totals.partial} partial, ${totals.missing} missing, ${totals.extras} unexpected extras ===`)
    if (profile) printTiming('all fixtures combined', totalFrames, totalFramesSkipped, timingTotals)
  }
  if (totals.partial || totals.missing || totals.extras) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
