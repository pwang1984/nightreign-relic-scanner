import { createWorker, createScheduler } from 'tesseract.js'

// Tesseract is CPU-bound and single-threaded per worker, so OCR throughput
// scales close to linearly with worker count (measured on real frames: 401ms
// per frame with one worker, 114ms with four). Leave a core for the main
// thread — it still has to seek, draw, diff frames, match text and render.
// Each worker is an independent WASM heap, and tesseract.js's own docs
// recommend a small fixed pool rather than a worker per job.
export const POOL_SIZE = Math.max(
  2,
  Math.min(4, (globalThis.navigator?.hardwareConcurrency || 4) - 1),
)

let schedulerPromise = null

async function buildScheduler() {
  const scheduler = createScheduler()
  // Warm one worker to completion before spawning the rest: each worker
  // fetches and caches the ~2MB language data independently, with no dedup
  // between them, so starting them all cold at once means N simultaneous
  // downloads of the same file and N redundant cache writes.
  const first = await createWorker('eng')
  scheduler.addWorker(first)

  const rest = await Promise.all(
    Array.from({ length: POOL_SIZE - 1 }, () => createWorker('eng')),
  )
  for (const worker of rest) scheduler.addWorker(worker)

  return scheduler
}

function getScheduler() {
  if (!schedulerPromise) schedulerPromise = buildScheduler()
  return schedulerPromise
}

// Accepts anything tesseract.js treats as an image — we hand it a Blob, which
// avoids the internal canvas->blob conversion it would otherwise do on the
// calling (main) thread.
export async function recognizeImage(image) {
  const scheduler = await getScheduler()
  const { data } = await scheduler.addJob('recognize', image)
  return data.text
}

export async function terminateOcr() {
  if (!schedulerPromise) return
  const pending = schedulerPromise
  schedulerPromise = null
  const scheduler = await pending
  await scheduler.terminate()
}
