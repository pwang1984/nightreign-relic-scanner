import assert from 'node:assert/strict'
import test from 'node:test'
import { exportRelicsAsCsv, exportRelicsAsJson } from '../src/lib/exporters.js'
import { matchFrameText } from '../src/lib/matcher.js'
import { RelicCollector } from '../src/lib/grouping.js'
import { getEffects, getItems } from '../src/data/effectsList.js'
import { selectRelicEffect, selectRelicItem } from '../src/lib/review.js'

function captureDownload(t) {
  let blob
  t.mock.method(URL, 'createObjectURL', (value) => { blob = value; return 'blob:test' })
  t.mock.method(URL, 'revokeObjectURL', () => {})
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: () => ({ click() {}, remove() {} }),
    body: { appendChild() {} },
  }
  t.after(() => { globalThis.document = previousDocument })
  return () => blob
}

test('exports keep Chinese names, numeric effect IDs and Excel-readable UTF-8', async (t) => {
  const downloadedBlob = captureDownload(t)
  const collector = new RelicCollector()
  collector.addFrame(matchFrameText('辽阔的火燃暗淡情景\n生命力+3\n受到损伤时，会累积中毒量表', 'zh-CN'), 0)
  const relics = collector.finish()
  exportRelicsAsJson(relics)
  const [json] = JSON.parse(await downloadedBlob().text())
  assert.equal(json.itemId, -1000000)
  assert.equal(json.item, '辽阔的火燃暗淡情景')
  assert.equal(json.color, 'Red')
  assert.equal(json.dn, true)
  assert.deepEqual(json.effects, [7000002, 6820000])
  assert.deepEqual(json.buffs, ['生命力＋３'])
  assert.deepEqual(json.nerfs, ['受到损伤时，会累积中毒量表'])
  exportRelicsAsCsv(relics)
  assert.deepEqual([...new Uint8Array(await downloadedBlob().arrayBuffer()).slice(0, 3)], [0xef, 0xbb, 0xbf])
  assert.match(await downloadedBlob().text(), /生命力＋３/)
})

for (const [language, text] of [['en', 'Vigor +3'], ['zh-CN', '生命力+3']]) {
  test(`JSON preserves unknown metadata when the ${language} item name is missing`, async (t) => {
    const downloadedBlob = captureDownload(t)
    const collector = new RelicCollector()
    collector.addFrame(matchFrameText(text, language), 0)
    const relics = collector.finish()
    assert.equal(relics.length, 1)
    assert.equal(relics[0].color, null)

    exportRelicsAsJson(relics)
    const payload = JSON.parse(await downloadedBlob().text())
    assert.equal(payload.length, 1)
    for (const relic of payload) {
      assert.equal(typeof relic.id, 'string')
      assert.equal(typeof relic.itemId, 'number')
      assert.equal(relic.item, null)
      assert.equal(relic.color, null)
      assert.ok(Array.isArray(relic.effects))
      assert.ok(relic.effects.every((id) => typeof id === 'number'))
    }
    assert.deepEqual(payload[0].effects, [7000002])
    assert.equal(relics[0].color, null)
  })
}

test('JSON and CSV retain the Chinese name and color recovered from title icon noise', async (t) => {
  const downloadedBlob = captureDownload(t)
  const collector = new RelicCollector()
  collector.addFrame(matchFrameText('辽阔 的 水 滴 暗 淡 情 景 ， 9\n生命力+3', 'zh-CN'), 0)
  const relics = collector.finish()
  exportRelicsAsJson(relics)
  const [json] = JSON.parse(await downloadedBlob().text())
  assert.equal(json.item, '辽阔的水滴暗淡情景')
  assert.equal(json.color, 'Blue')
  assert.equal(json.dn, true)
  exportRelicsAsCsv(relics)
  assert.match(await downloadedBlob().text(), /辽阔的水滴暗淡情景,Blue,生命力＋３/)
})

test('exports use manual corrections while leaving review evidence out of the payload', async (t) => {
  const downloadedBlob = captureDownload(t)
  const collector = new RelicCollector()
  collector.addFrame(matchFrameText('生命力+3', 'zh-CN'), 0, new Blob(['capture']))
  const [original] = collector.finish()
  const item = getItems('zh-CN').find((entry) => entry.name === '辽阔的幽静暗淡情景')
  const effect = getEffects('zh-CN').find((entry) => entry.id === '6820400')
  const corrected = { ...selectRelicEffect(selectRelicItem(original, item), effect), reviewed: true }
  exportRelicsAsJson([corrected])
  const [json] = JSON.parse(await downloadedBlob().text())
  assert.equal(json.item, item.name)
  assert.equal(json.color, 'Green')
  assert.equal(json.dn, true)
  assert.deepEqual(json.effects, [7000002, 6820400])
  assert.deepEqual(json.nerfs, ['受到损伤时，会累积发狂量表'])
  assert.equal(Object.hasOwn(json, 'review'), false)
  exportRelicsAsCsv([corrected])
  assert.match(await downloadedBlob().text(), /受到损伤时，会累积发狂量表/)
})
