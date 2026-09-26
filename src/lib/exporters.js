function todayStamp() {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// itemId -1000000 mirrors relics.pro's own "Custom Relic" placeholder id —
// we only ever fuzzy-match an item *name* from OCR, never a definitive
// catalog id, so every exported relic is inherently a custom one in that
// schema.
const CUSTOM_RELIC_ITEM_ID = -1000000

export function exportRelicsAsJson(relics) {
  const payload = relics.map((r) => ({
    id: crypto.randomUUID(),
    itemId: CUSTOM_RELIC_ITEM_ID,
    item: r.itemName,
    color: r.color,
    dn: r.dn,
    buffs: r.buffs.map((b) => b.name),
    nerfs: r.nerfs.map((b) => b.name),
    effects: [...r.buffs, ...r.nerfs].map((b) => Number(b.effectId)),
    occurrences: r.occurrences,
  }))
  download(`relics-${todayStamp()}.json`, JSON.stringify(payload, null, 2), 'application/json')
}

function csvEscape(value) {
  const str = String(value ?? '')
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

export function exportRelicsAsCsv(relics) {
  const maxBuffs = Math.max(1, ...relics.map((r) => r.buffs.length))
  const maxNerfs = Math.max(0, ...relics.map((r) => r.nerfs.length))

  const header = [
    'Item',
    'Color',
    ...Array.from({ length: maxBuffs }, (_, i) => `Buff ${i + 1}`),
    ...Array.from({ length: maxNerfs }, (_, i) => `Nerf ${i + 1}`),
    'Occurrences',
  ]
  const rows = relics.map((r) => [
    r.itemName || '',
    r.color || '',
    ...Array.from({ length: maxBuffs }, (_, i) => r.buffs[i]?.name || ''),
    ...Array.from({ length: maxNerfs }, (_, i) => r.nerfs[i]?.name || ''),
    r.occurrences,
  ])
  const csv = [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n')
  download(`relics-${todayStamp()}.csv`, csv, 'text/csv')
}
