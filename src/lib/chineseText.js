import { Converter } from 'opencc-js/t2cn'

// Paddle's Chinese recognizer can emit both scripts. Keep the zh-CN output
// and lookup keys in Simplified Chinese without spending the typo allowance.
export const toSimplifiedChinese = Converter({ from: 't', to: 'cn' })

export function normalizeChineseName(text) {
  return toSimplifiedChinese(text.normalize('NFKC')).toLowerCase()
    .replace(/[−–—]/g, '-')
    .replace(/[^\p{L}\p{N}+-]/gu, '')
    // Restrict 十 -> + to numeric suffixes; ordinary words stay untouched.
    .replace(/十(?=\d+$)/u, '+')
}

export function isChineseUsageNote(text) {
  return normalizeChineseName(text) === '仅限能使用的武器类别'
}
