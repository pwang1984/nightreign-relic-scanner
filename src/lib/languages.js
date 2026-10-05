export const LANGUAGES = {
  en: {
    label: 'English', ocr: 'eng',
    // Preserve the original English worker limit and leave a CPU core free.
    cpuWorkers: Math.max(2, Math.min(4, (globalThis.navigator?.hardwareConcurrency || 4) - 1)),
  },
  'zh-CN': {
    label: '简体中文', ocr: 'PP-OCRv5_mobile',
    cpuWorkers: 4,
    loadingMessage: 'Loading Chinese OCR… The first scan downloads the models.',
  },
}

export function getLanguage(language = 'en') {
  if (!Object.hasOwn(LANGUAGES, language)) throw new Error(`Unsupported language: ${language}`)
  return LANGUAGES[language]
}
