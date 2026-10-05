// Loaded only for Chinese scans. Paddle's text detector separates the effect
// icons from the lettering and preserves the pale blue demerit text.
import { toSimplifiedChinese } from './chineseText.js'
import { getLanguage } from './languages.js'

export const CHINESE_CPU_WORKERS = getLanguage('zh-CN').cpuWorkers

// The factory also lets queue/fallback tests exercise real scheduling without
// downloading models or requiring a GPU.
export async function createChineseOcrEngine(createOcr) {
  const createWorker = (backend) => createOcr({
    lang: 'ch',
    ocrVersion: 'PP-OCRv5',
    textDetectionModelName: 'PP-OCRv5_mobile_det',
    textRecognitionModelName: 'PP-OCRv5_mobile_rec',
    worker: true,
    ortOptions: { backend, numThreads: 1 },
  })

  const dispose = (pool) => Promise.allSettled(pool.map(({ ocr }) => ocr.dispose()))
  const slot = (ocr) => ({ ocr, busy: false })
  async function createCpuPool(first) {
    // Warm the download cache before loading the remaining model instances.
    const pool = [slot(first ?? await createWorker('wasm'))]
    const rest = await Promise.allSettled(
      Array.from({ length: CHINESE_CPU_WORKERS - 1 }, () => createWorker('wasm')),
    )
    for (const result of rest) {
      if (result.status === 'fulfilled') pool.push(slot(result.value))
    }
    const failed = rest.find((result) => result.status === 'rejected')
    if (failed) {
      await dispose(pool)
      throw failed.reason
    }
    return pool
  }

  let first
  try {
    // Paddle tries WebGPU first, falling back to WASM for unsupported models
    // or browsers. Inspect the actual providers before choosing a pool size.
    first = await createWorker('auto')
  } catch (error) {
    console.warn('Chinese GPU OCR initialization failed; retrying on CPU.', error)
  }
  const summary = first?.getInitializationSummary()
  let usingGpu = summary?.detProvider === 'webgpu' || summary?.recProvider === 'webgpu'
  let workers = usingGpu ? [slot(first)] : await createCpuPool(first)
  const queue = []
  let closed = false
  let failure = null
  let idleWaiter = null
  let termination = null

  function dispatch() {
    for (const worker of workers) {
      if (worker.busy || !queue.length) continue
      worker.busy = true
      run(worker, queue.shift())
    }
    if (!queue.length && workers.every((worker) => !worker.busy)) idleWaiter?.()
  }

  async function run(worker, job) {
    try {
      const [page] = await worker.ocr.predict(job.image)
      job.resolve(page.items.map((item) => toSimplifiedChinese(item.text)).join('\n'))
    } catch (error) {
      if (usingGpu) {
        usingGpu = false
        console.warn('Chinese GPU OCR failed; retrying the frame on CPU.', error)
        // Only one GPU job can be active. Keep the other frames queued while
        // replacing its models, then retry this frame without losing its place.
        await dispose(workers)
        try {
          workers = await createCpuPool()
          queue.unshift(job)
        } catch (cpuError) {
          failure = cpuError
          workers = []
          job.reject(cpuError)
          for (const queued of queue.splice(0)) queued.reject(cpuError)
        }
      } else {
        job.reject(error)
      }
    } finally {
      worker.busy = false
      dispatch()
    }
  }

  return {
    // Reserve capacity for all CPU workers even if a scan starts on GPU.
    maxInflight: CHINESE_CPU_WORKERS * 2,
    recognize(image) {
      if (closed || failure) return Promise.reject(failure ?? new Error('Chinese OCR has been terminated.'))
      return new Promise((resolve, reject) => {
        queue.push({ image, resolve, reject })
        dispatch()
      })
    },
    terminate() {
      closed = true
      termination ??= (async () => {
        await new Promise((resolve) => {
          idleWaiter = resolve
          dispatch()
        })
        await dispose(workers)
      })()
      return termination
    },
  }
}

export async function createChineseOcr() {
  const { PaddleOCR } = await import('@paddleocr/paddleocr-js')
  return createChineseOcrEngine((options) => PaddleOCR.create(options))
}
