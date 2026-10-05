import assert from 'node:assert/strict'
import test from 'node:test'
import { getEffects, getItems } from '../src/data/effectsList.js'
import { matchFrameText } from '../src/lib/matcher.js'
import { RelicCollector } from '../src/lib/grouping.js'
import {
  getReviewIssues, needsReview, reviewStatus, selectRelicItem,
  selectRelicEffect, removeRelicEffect, searchReviewCatalog,
} from '../src/lib/review.js'

const ZH = 'zh-CN'
const title = '辽阔的幽静暗淡情景'
const lines = [
  '受到损伤的当下，能通过攻击恢复部分血量+2',
  '血量没有全满时，降低攻击力',
  '使出致命一击时，能获得卢恩',
  '提升物理攻击力+3',
]
const unread = '受公损伤时会嵌各发外呈表'
const missing = `${title}\n${lines.slice(0, 3).join('\n')}\n${lines[3]} | ${unread}`
const complete = missing.replace(unread, '受到损伤时，会累积发狂量表')
const effect = (id) => getEffects(ZH).find((entry) => entry.id === id)
function collect(text, image = null) {
  const collector = new RelicCollector()
  collector.addFrame(matchFrameText(text, ZH), 2, image)
  return collector.finish()[0]
}

test('a fifth unread effect is flagged and its source survives collection', () => {
  const image = new Blob(['source'])
  const relic = collect(missing, image)
  assert.equal(relic.buffs.length + relic.nerfs.length, 4)
  assert.ok(needsReview(relic))
  assert.deepEqual(getReviewIssues(relic), ['5 OCR text segments, 4 matched effects'])
  assert.equal(relic.review.image, image)
  assert.equal(relic.review.timeSec, 2)
  assert.equal(relic.review.rawText, missing)
  assert.deepEqual(relic.review.lines.filter((line) => line.kind === 'unmatched').map((line) => line.text), [unread])

  const corrected = selectRelicEffect(relic, effect('6820400'))
  assert.equal(corrected.buffs.length, 3)
  assert.equal(corrected.nerfs.length, 2)
  assert.equal(needsReview(corrected), false)
  assert.equal(relic.nerfs.length, 1, 'editing must not mutate the scanned result')
})

test('wrapped effects, titles and repeated text do not create false missing-effect counts', () => {
  const relic = collect(`${title}\n【执行者】提升技艺发动期间\n的攻击力但攻击时\n会降低减伤率\n力气+3\n力气+3`)
  assert.deepEqual(getReviewIssues(relic), [])
  assert.equal(relic.review.lines.filter((line) => line.kind === 'effect').length, 3)
  assert.equal(relic.buffs.length, 2)
})

test('weapon usage notes alone do not require review, but real issues still do', () => {
  for (const note of ['仅限能使用的武器类别', '※仅限能使用的武器类别', '※僅限能使用的武器類別']) {
    const relic = collect(`${title}\n出击时，武器战技改为“神圣刀刃”\n${note}`)
    assert.deepEqual(getReviewIssues(relic), [])
    assert.equal(needsReview(relic), false)
    assert.equal(relic.review.lines.at(-1).kind, 'note')
    assert.equal(relic.review.rawText.endsWith(note), true)
    assert.ok(needsReview({ ...relic, itemName: null }))
    assert.ok(needsReview({ ...relic, flagged: true }))
    assert.ok(needsReview(collect(`${title}\n生命力+3\n${note}\n${unread}`)))
    // Results already in memory before an update also ignore this note.
    const existing = { ...relic, review: { ...relic.review, lines: relic.review.lines.map((line) => ({ ...line, kind: line.kind === 'note' ? 'unmatched' : line.kind })) } }
    assert.equal(needsReview(existing), false)
  }
  assert.ok(needsReview(collect(`${title}\n生命力+3\n仅限能使用的武器类别受到损伤`)))
})

test('a more complete frame resolves earlier uncertainty without losing its capture', () => {
  const collector = new RelicCollector()
  const first = new Blob(['unread'])
  const second = new Blob(['complete'])
  collector.addFrame(matchFrameText(missing, ZH), 0, first)
  collector.addFrame(matchFrameText(complete, ZH), 0.1, second)
  const [relic] = collector.finish()
  assert.equal(needsReview(relic), false)
  assert.equal(relic.review.image, second)
  assert.equal(relic.review.rawText, complete)
})

test('frequency filtering marks a recognized effect dropped from the final relic', () => {
  const collector = new RelicCollector()
  collector.addFrame(matchFrameText(complete, ZH), 0)
  for (let i = 1; i <= 3; i++) collector.addFrame(matchFrameText(`${title}\n${lines.join('\n')}`, ZH), i / 10)
  const [relic] = collector.finish()
  assert.equal(relic.buffs.length + relic.nerfs.length, 4)
  assert.ok(getReviewIssues(relic).includes('5 OCR text segments, 4 matched effects'))
})

test('deduplication retains evidence of an unmatched line from a later occurrence', () => {
  const collector = new RelicCollector()
  collector.addFrame(matchFrameText(`${title}\n${lines.join('\n')}`, ZH), 0)
  collector.addFrame(matchFrameText('', ZH), 1)
  collector.addFrame(matchFrameText(missing, ZH), 10)
  const [relic] = collector.finish()
  assert.equal(relic.occurrences, 2)
  assert.equal(relic.review.rawText, missing)
  assert.ok(needsReview(relic))
})

test('selecting a missing name also repairs its color and Deep status', () => {
  const relic = collect('生命力+3')
  assert.ok(getReviewIssues(relic).includes('Relic name not recognized'))
  assert.ok(getReviewIssues(relic).includes('Relic color not recognized'))
  const corrected = selectRelicItem(relic, getItems(ZH).find((item) => item.name === title))
  assert.equal(corrected.itemName, title)
  assert.equal(corrected.color, 'Green')
  assert.equal(corrected.dn, true)
  assert.equal(needsReview(corrected), false)
})

test('manual effect replacement changes the correct buff/debuff group and rejects duplicates', () => {
  const relic = collect(`${title}\n生命力+3\n力气+3`)
  const corrected = selectRelicEffect(relic, effect('6820400'), '7000002')
  assert.deepEqual(corrected.buffs.map((entry) => entry.effectId), ['7000302'])
  assert.deepEqual(corrected.nerfs.map((entry) => entry.effectId), ['6820400'])
  assert.equal(selectRelicEffect(corrected, effect('6820400')), corrected)
  assert.deepEqual(removeRelicEffect(corrected, '6820400').nerfs, [])
})

test('manual review acknowledgement and flags are independent of the original evidence', () => {
  const relic = collect(missing)
  assert.equal(reviewStatus(relic), 'Needs review')
  assert.equal(reviewStatus({ ...relic, reviewed: true }), 'Reviewed')
  assert.equal(needsReview({ ...relic, reviewed: true }), false)
  const good = collect(complete)
  assert.equal(reviewStatus(good), 'No issues detected')
  assert.ok(needsReview({ ...good, flagged: true }))
  const lowConfidence = { ...good, buffs: good.buffs.map((entry) => ({ ...entry, confidence: 0.8 })) }
  assert.ok(getReviewIssues(lowConfidence).some((issue) => issue.includes('low-confidence')))
})

test('manual catalog search accepts localized names, English names, tiers and IDs', () => {
  for (const query of ['生命力 +3', 'Vigor +3', '7000002']) {
    assert.ok(searchReviewCatalog(query, 'effect', ZH).some((entry) => entry.id === '7000002'), query)
  }
  assert.ok(searchReviewCatalog('幽静 暗淡', 'item', ZH).some((entry) => entry.name === title))
  assert.ok(searchReviewCatalog('強化荊棘', 'effect', ZH).some((entry) => entry.id === '7043800'))
  assert.deepEqual(searchReviewCatalog('', 'effect', ZH), [])
})
