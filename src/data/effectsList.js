import rawEffects from './effects.json' with { type: 'json' }
import rawItems from './items.json' with { type: 'json' }

// Flatten the {id: {...}} maps from relics.pro into arrays, resolving
// `duplicateOf` references so every entry has a usable category/desc.
function buildEffects() {
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
      name: entry.name,
      category: category || 'Other',
      desc: desc || '',
      type: entry.type || 'relic',
      stackable: entry.stackable,
    })
  }
  return list
}

function buildItems() {
  const list = []
  for (const [id, entry] of Object.entries(rawItems)) {
    if (!entry.name) continue
    list.push({
      id,
      name: entry.name,
      color: entry.color || 'White',
      dn: entry.dn || false,
    })
  }
  return list
}

export const EFFECTS = buildEffects()
export const ITEMS = buildItems()
