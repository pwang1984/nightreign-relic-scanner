import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'

// Use real Chrome seeks: pure timestamp tests cannot catch the browser
// returning the preceding frame when seeking exactly to a frame boundary.
test('automatic sampling covers every source frame, including partial trim boundaries', { timeout: 60_000 }, async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
  let browser
  t.after(async () => {
    try { await browser?.close() } finally { await server.close() }
  })
  await server.listen()
  const channel = process.env.PLAYWRIGHT_CHANNEL || (existsSync(chromium.executablePath()) ? undefined : 'chrome')
  browser = await chromium.launch({ channel })
  const page = await browser.newPage()
  await page.goto(server.resolvedUrls.local[0])
  const results = await page.evaluate(async () => {
    const { detectScanTiming } = await import('/src/lib/videoTiming.js')
    const { walkVideoFrames } = await import('/src/lib/videoFrames.js')
    const results = []
    for (const name of ['fps-30.mp4', 'fps-59.94.mp4']) {
      const blob = await (await fetch(`/tests/fixtures/${name}`)).blob()
      const timing = await detectScanTiming(blob)
      const video = document.createElement('video')
      const url = URL.createObjectURL(blob)
      video.preload = 'auto'
      video.muted = true
      video.src = url
      document.body.append(video)
      try {
        await new Promise((resolve, reject) => {
          video.onloadedmetadata = resolve
          video.onerror = () => reject(new Error(`Cannot load ${name}`))
        })
        async function collect(trim = {}) {
          const values = []
          const canvas = document.createElement('canvas')
          canvas.width = canvas.height = 16
          const ctx = canvas.getContext('2d', { willReadFrequently: true })
          for await (const frame of walkVideoFrames(video, { x: 0, y: 0, w: 1, h: 1 }, {
            ...timing, ...trim, upscale: 1, unchangedThreshold: 0,
          })) {
            const bitmap = await createImageBitmap(frame.blob)
            ctx.drawImage(bitmap, 0, 0)
            bitmap.close()
            // Each source frame has a distinct gray level.
            values.push(ctx.getImageData(8, 8, 1, 1).data[0])
          }
          return [...new Set(values)]
        }
        const full = await collect()
        const trimmed = await collect({
          startTime: 10.9 * timing.intervalSec, endTime: 15.1 * timing.intervalSec,
        })
        results.push({ name, fps: 1 / timing.intervalSec, full, trimmed })
      } finally {
        video.removeAttribute('src')
        video.load()
        video.remove()
        URL.revokeObjectURL(url)
      }
    }
    return results
  })
  assert.equal(results[0].fps, 30)
  assert.equal(results[0].full.length, 30)
  assert.ok(Math.abs(results[1].fps - 60000 / 1001) < 1e-8)
  assert.equal(results[1].full.length, 60)
  for (const result of results) {
    assert.deepEqual(result.trimmed, result.full.slice(10, 16), `${result.name}: partial trim boundaries`)
  }
})
