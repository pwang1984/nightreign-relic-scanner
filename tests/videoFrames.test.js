import assert from 'node:assert/strict'
import test from 'node:test'
import { SCAN_INTERVAL_SEC, walkVideoFrames } from '../src/lib/videoFrames.js'

// Model decoded pixels and asynchronous seeking so the walker can be tested
// without depending on a particular browser's video decoder.
function capture(t, values, intervalSec) {
  const stats = { canvases: 0, encodes: 0 }
  class Video extends EventTarget {
    videoWidth = 2
    videoHeight = 2
    duration = (values.length - 1) * intervalSec
    set currentTime(time) {
      this.pixel = values[Math.round(time / intervalSec)]
      queueMicrotask(() => this.dispatchEvent(new Event('seeked')))
    }
  }
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement() {
      stats.canvases++
      let pixel
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => context,
        toBlob(callback) {
          stats.encodes++
          callback(new Blob([String(pixel)]))
        },
      }
      const context = {
        drawImage(video) { pixel = video.pixel },
        putImageData(imageData) { pixel = imageData.data[0] },
        getImageData() {
          const data = new Uint8ClampedArray(canvas.width * canvas.height * 4)
          for (let i = 0; i < data.length; i += 4) {
            data.set(Array.isArray(pixel) ? pixel : [pixel, pixel, pixel, 255], i)
          }
          return { data }
        },
      }
      return canvas
    },
  }
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  })
  return {
    stats,
    frames: walkVideoFrames(new Video(), { x: 0, y: 0, w: 1, h: 1 }, { intervalSec, upscale: 2 }),
  }
}

test('gradual changes trigger OCR relative to the last recognized frame', async (t) => {
  const { frames, stats } = capture(t, [10, 12, 14, 14], 1)
  const output = await Array.fromAsync(frames)
  assert.deepEqual(output.map((f) => f.duplicateOfPrev), [false, true, false, true])
  assert.equal(output[0].blob, output[1].blob)
  assert.equal(output[2].blob, output[3].blob)
  assert.deepEqual(await Promise.all(output.map((f) => f.blob.text())), ['10', '10', '14', '14'])
  assert.equal(stats.encodes, 2)
  assert.equal(stats.canvases, 1)
})

test('sampling includes a change lasting only one 60 Hz frame', async (t) => {
  const { frames } = capture(t, [10, 50, 10], SCAN_INTERVAL_SEC)
  const output = await Array.fromAsync(frames)
  assert.deepEqual(output.map((f) => f.timeSec), [0, 1 / 60, 1 / 30])
  assert.deepEqual(output.map((f) => f.duplicateOfPrev), [false, false, false])
  assert.deepEqual(await Promise.all(output.map((f) => f.blob.text())), ['10', '50', '10'])
})

test('Chinese OCR preserves original pixels for colored demerits and duplicate detection', async (t) => {
  const first = [90, 130, 175, 255]
  const changed = [94, 134, 179, 255]
  const { frames, stats } = capture(t, [first, first, changed, changed], 1)
  const output = await Array.fromAsync(frames)
  assert.deepEqual(output.map((f) => f.duplicateOfPrev), [false, true, false, true])
  assert.deepEqual(await Promise.all(output.map((f) => f.blob.text())), [first, first, changed, changed].map(String))
  assert.equal(stats.encodes, 2)
})
