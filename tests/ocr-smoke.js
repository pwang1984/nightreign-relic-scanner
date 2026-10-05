// Run the actual browser OCR and canvas pipeline on a cropped screenshot.
// Install Chromium once with `npx playwright install chromium`.
import assert from 'node:assert/strict'
import { resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBrowserOcrWorker } from './browser-ocr.js'
import { matchFrameText } from '../src/lib/matcher.js'
import { RelicCollector } from '../src/lib/grouping.js'
import { getReviewIssues } from '../src/lib/review.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const inputImage = process.argv[2] ? resolve(process.argv[2]) : null
console.log('Loading Chinese OCR in the browser (first run downloads the models)…')
const worker = await createBrowserOcrWorker()
try {
  async function recognizeScreenshot(filename, box) {
    const { data: { text } } = await worker.recognize(filename, { upscale: 2, box })
    const match = matchFrameText(text, 'zh-CN')
    const collector = new RelicCollector()
    collector.addFrame(match, 0)
    return { text, match, relics: collector.finish() }
  }
  if (inputImage) {
    const result = await recognizeScreenshot(inputImage)
    console.log('OCR text:\n' + result.text)
    console.log(JSON.stringify(result, null, 2))
  } else {
    const fixtures = [
      ['zh-CN.png', '辽阔的火燃暗淡情景', 'Red', true, ['7000002', '7034400'], ['6820000']],
      ['zh-CN-gameplay.png', '辽阔的火燃暗淡情景', 'Red', true, ['6002700', '7005600', '7100100'], ['6820100']],
      ['zh-CN-title-fallback.jpg', '辽阔的幽静暗淡情景', 'Green', true, ['6003400', '6500300', '7001002'], []],
      ['zh-CN_0.png', '辽阔的光耀情景', 'Yellow', false, ['7000002', '7000902', '7043200'], []],
      ['zh-CN_1.png', '辽阔的幽静暗淡情景', 'Green', true, ['6003400', '6500300', '7001002'], []],
      ['zh-CN_2.png', '辽阔的幽静暗淡情景', 'Green', true, ['6001400', '6005601', '7031900'], ['6820400', '6851200']],
      ['zh-CN_3.png', '辽阔的火燃暗淡情景', 'Red', true, ['6003500', '6500300', '7080300'], []],
      ['zh-CN_4.png', '辽阔的幽静暗淡情景', 'Green', true, ['6001400', '7003200', '7030700'], ['6851400']],
      ['zh-CN_5.png', '辽阔的光耀暗淡情景', 'Yellow', true, ['6622500', '6646100', '7043600'], []],
      ['zh-CN_6.png', '辽阔的幽静暗淡情景', 'Green', true, ['6610700', '6611302', '7100100'], ['6830200']],
      // User reports include the Review UI. Crop only its original capture.
      ['zh-CN-quotes-review.png', '辽阔的幽静情景', 'Green', false, ['7034600', '7121200', '7123300'], [], { x: 42 / 540, y: 65 / 813, w: 478 / 540, h: 147 / 813 }],
      ['zh-CN-separator-review.png', '辽阔的幽静暗淡情景', 'Green', true, ['6001400', '6003100', '6633100'], ['6850700'], { x: 42 / 540, y: 121 / 813, w: 478 / 540, h: 147 / 813 }],
    ]
    // Submit together to exercise the production queue and concurrent CPU
    // Workers. The engine bounds inference concurrency, just as in a scan.
    const started = performance.now()
    await Promise.all(fixtures.map(async ([file, name, color, dn, buffs, nerfs, box]) => {
      const result = await recognizeScreenshot(resolve(root, 'tests/fixtures', file), box)
      const [relic] = result.relics
      const context = `${file}\n${result.text}`
      assert.equal(result.relics.length, 1, context)
      assert.equal(relic.itemName, name, context)
      assert.equal(relic.color, color, context)
      assert.equal(relic.dn, dn, context)
      assert.deepEqual(relic.buffs.map((b) => b.effectId).sort(), buffs, context)
      assert.deepEqual(relic.nerfs.map((b) => b.effectId).sort(), nerfs, context)
      if (file === 'zh-CN-quotes-review.png') {
        assert.ok(!getReviewIssues(relic).some((issue) => issue.includes('OCR text segments')), context)
      }
      console.log(`${basename(file)}: title, color, ${buffs.length} buffs, ${nerfs.length} nerfs — passed`)
    }))
    console.log(`${fixtures.length} screenshots recognized in ${((performance.now() - started) / 1000).toFixed(2)}s (model loading excluded)`)
  }
} finally {
  await worker.terminate()
}
