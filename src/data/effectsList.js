import rawEffects from './effects.json' with { type: 'json' }
import rawItems from './items.json' with { type: 'json' }
import chineseEffectNames from './zh-cn/effects.json' with { type: 'json' }
import chineseItemNames from './zh-cn/items.json' with { type: 'json' }
import { getLanguage } from '../lib/languages.js'

// Flatten the {id: {...}} maps from relics.pro into arrays, resolving
// `duplicateOf` references so every entry has a usable category/desc.
function buildEffects(language = 'en') {
  const list = []
  for (const [id, entry] of Object.entries(rawEffects)) {
    let category = entry.category
    let desc = entry.desc
    if (entry.duplicateOf && rawEffects[entry.duplicateOf]) {
      const base = rawEffects[entry.duplicateOf]
      category = category || base.category
      desc = desc || base.desc
    }
    if(entry.unobtainable) continue
    if(entry.type === 'weapon' || entry.type === 'talisman') continue
    if (!entry.name) continue
    list.push({
      id,
      name: language === 'zh-CN' ? chineseEffectNames[id].name : entry.name,
      category: category || 'Other',
      desc: desc || '',
      type: entry.type || 'relic',
      stackable: entry.stackable,
    })
  }
  return list
}

function buildItems(language = 'en') {
  const list = []
  for (const [id, entry] of Object.entries(rawItems)) {
    if (!entry.name) continue
    list.push({
      id,
      name: language === 'zh-CN' ? chineseItemNames[id].name : entry.name,
      color: entry.color || 'White',
      dn: entry.dn || false,
    })
  }
  return list
}

export const EFFECTS = buildEffects()
export const ITEMS = buildItems()

const chineseEffects = buildEffects('zh-CN')
const chineseItems = buildItems('zh-CN')

export function getEffects(language = 'en') {
  getLanguage(language)
  return language === 'zh-CN' ? chineseEffects : EFFECTS
}

export function getItems(language = 'en') {
  getLanguage(language)
  return language === 'zh-CN' ? chineseItems : ITEMS
}
