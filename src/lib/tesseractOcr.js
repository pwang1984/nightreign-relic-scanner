import { createWorker, createScheduler } from 'tesseract.js'

// Keep Tesseract's original scheduler and single-threaded workers. Language
// and worker-count settings live alongside the other language configuration.
export async function createTesseractOcr({ ocr: language, cpuWorkers }) {
  const scheduler = createScheduler()
  try {
    // Warm the language-data cache before starting the remaining workers.
    scheduler.addWorker(await createWorker(language))
    const rest = await Promise.allSettled(
      Array.from({ length: cpuWorkers - 1 }, () => createWorker(language)),
    )
    for (const result of rest) {
      if (result.status === 'fulfilled') scheduler.addWorker(result.value)
    }
    const failed = rest.find((result) => result.status === 'rejected')
    if (failed) throw failed.reason
  } catch (error) {
    await scheduler.terminate()
    throw error
  }

  return {
    maxInflight: cpuWorkers * 2 + 2,
    async recognize(image) {
      const { data } = await scheduler.addJob('recognize', image)
      return data.text
    },
    terminate: () => scheduler.terminate(),
  }
}
