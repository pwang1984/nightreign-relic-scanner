import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'

async function withTimeout(promise) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Browser OCR timed out after 300 seconds')), 300_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// Test adapter with the same recognize/terminate interface as Tesseract.
// Chinese OCR runs in a real browser, including its production Worker.
export async function createBrowserOcrWorker() {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
  let browser
  async function close() {
    try { await browser?.close() } finally { await server.close() }
  }
  try {
    await server.listen()
    const channel = process.env.PLAYWRIGHT_CHANNEL || (existsSync(chromium.executablePath()) ? undefined : 'chrome')
    browser = await chromium.launch({ channel })
    const page = await browser.newPage()
    await page.goto(server.resolvedUrls.local[0])
    await withTimeout(page.evaluate(async () => (await import('/src/lib/ocr.js')).prepareOcr('zh-CN')))
    return {
      async recognize(filename, { upscale = 1, box = { x: 0, y: 0, w: 1, h: 1 } } = {}) {
        const encoded = (await readFile(filename)).toString('base64')
        const text = await withTimeout(page.evaluate(async ({ encoded, upscale, box }) => {
          const [{ recognizeImage }, { cropFrameToCanvas }] = await Promise.all([
            import('/src/lib/ocr.js'), import('/src/lib/videoFrames.js'),
          ])
          const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
          const image = await createImageBitmap(new Blob([bytes]))
          const canvas = cropFrameToCanvas(image, box, upscale)
          image.close()
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
          return recognizeImage(blob, 'zh-CN')
        }, { encoded, upscale, box }))
        return { data: { text } }
      },
      async terminate() {
        try {
          await withTimeout(page.evaluate(async () => (await import('/src/lib/ocr.js')).terminateOcr()))
        } finally {
          await close()
        }
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}
