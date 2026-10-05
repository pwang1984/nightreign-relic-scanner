import { getLanguage } from './languages.js'

const engines = new Map()

async function createEngine(language) {
  if (language === 'zh-CN') {
    const { createChineseOcr } = await import('./chineseOcr.js')
    return createChineseOcr()
  }
  const { createTesseractOcr } = await import('./tesseractOcr.js')
  return createTesseractOcr(getLanguage(language))
}

// Both adapters expose { recognize(image), terminate(), maxInflight }.
// Engine choice and lifecycle stay here; the scan loop only handles frames.
export function prepareOcr(language = 'en') {
  getLanguage(language)
  if (!engines.has(language)) {
    const pending = createEngine(language).catch((error) => {
      if (engines.get(language) === pending) engines.delete(language)
      throw error
    })
    engines.set(language, pending)
  }
  return engines.get(language)
}

export async function recognizeImage(image, language = 'en') {
  return (await prepareOcr(language)).recognize(image)
}

export async function terminateOcr() {
  const pending = [...engines.values()]
  engines.clear()
  await Promise.allSettled(pending.map(async (promise) => {
    const engine = await promise
    await engine.terminate()
  }))
}
