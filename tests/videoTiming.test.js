import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { detectScanTiming, scanIntervalFromMetrics } from '../src/lib/videoTiming.js'
import { frameSampleTimes } from '../src/lib/videoFrames.js'

const fallback = 1 / 60
const videoBlob = async (name) => new Blob([await readFile(new URL(`./fixtures/${name}`, import.meta.url))])

test('a real 30 fps MP4 selects one sample per source frame', async () => {
  assert.deepEqual(await detectScanTiming(await videoBlob('fps-30.mp4')), {
    intervalSec: 1 / 30, frameOriginSec: 0,
  })
})

test('fractional 59.94 fps is preserved instead of rounded', async () => {
  const timing = await detectScanTiming(await videoBlob('fps-59.94.mp4'))
  assert.ok(Math.abs(timing.intervalSec - 1001 / 60000) < 1e-12)
  assert.equal(timing.frameOriginSec, 0)
})

test('a switch from 30 to 60 fps after the first 256 frames retains 60 Hz', async () => {
  assert.deepEqual(await detectScanTiming(await videoBlob('fps-variable.mp4')), { intervalSec: fallback })
})

test('higher frame rates are capped at 60 and unreliable metrics retain 60', () => {
  const constant = { frameRateIsConstant: true, probedPacketCount: 300 }
  assert.equal(scanIntervalFromMetrics({ ...constant, underlyingFrameRate: 120 }), fallback)
  assert.equal(scanIntervalFromMetrics({ ...constant, underlyingFrameRate: 30000 / 1001 }), 1001 / 30000)
  for (const underlyingFrameRate of [null, undefined, NaN, Infinity, 0, -30]) {
    assert.equal(scanIntervalFromMetrics({ ...constant, underlyingFrameRate }), fallback)
  }
  assert.equal(scanIntervalFromMetrics({ ...constant, underlyingFrameRate: 30, probedPacketCount: 1 }), fallback)
})

test('missing, unsupported and truncated files fall back without failing the scan', async () => {
  assert.deepEqual(await detectScanTiming(null), { intervalSec: fallback })
  assert.deepEqual(await detectScanTiming(new Blob(['not a video'])), { intervalSec: fallback })
  assert.deepEqual(await detectScanTiming((await videoBlob('fps-30.mp4')).slice(0, 32)), { intervalSec: fallback })
})

test('slow file reads time out and release the reader once the pending read settles', async () => {
  let cancelled = false
  let controller
  class SlowBlob extends Blob {
    slice(...args) {
      const part = super.slice(...args)
      part.stream = () => new ReadableStream({
        start(streamController) { controller = streamController },
        cancel() { cancelled = true },
      })
      return part
    }
  }
  const slow = new SlowBlob([await videoBlob('fps-30.mp4')])
  assert.deepEqual(await detectScanTiming(slow, { timeoutMs: 20 }), { intervalSec: fallback })
  controller.enqueue(new Uint8Array([0]))
  await setImmediate()
  assert.equal(cancelled, true)
})

test('known frame grids sample centers and include partially trimmed frames', () => {
  const interval = 1 / 30
  const start = 10.9 * interval
  const end = 15.1 * interval
  const times = [...frameSampleTimes(start, end, interval, 0)]
  assert.deepEqual(times, [start, 11.5 * interval, 12.5 * interval, 13.5 * interval, 14.5 * interval, end])
  assert.deepEqual(times.map(t => Math.floor(t / interval)), [10, 11, 12, 13, 14, 15])
  assert.deepEqual([...frameSampleTimes(start, start, interval, 0)], [start])
  assert.deepEqual([...frameSampleTimes(end, start, interval, 0)], [])
})

test('sampling respects a nonzero first timestamp without accumulating fractional-rate drift', () => {
  const interval = 1001 / 60000
  const origin = 0.25
  const start = origin + 100_000 * interval
  const end = origin + 100_002 * interval
  assert.deepEqual([...frameSampleTimes(start, end, interval, origin)], [
    start, origin + 100_000.5 * interval, origin + 100_001.5 * interval, end,
  ])
})

test('unknown frame grids preserve the existing sampling timestamps', () => {
  assert.deepEqual([...frameSampleTimes(0, 0.5, 0.25)], [0, 0.25, 0.5])
})
