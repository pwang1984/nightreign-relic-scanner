import assert from 'node:assert/strict'
import test from 'node:test'
import { getEffects, getItems, EFFECTS, ITEMS } from '../src/data/effectsList.js'
import { matchEffectLine, matchItemName, matchFrameText, normalizeEffectName } from '../src/lib/matcher.js'
import { RelicCollector } from '../src/lib/grouping.js'
import { getLanguage } from '../src/lib/languages.js'
import rawEffects from '../src/data/effects.json' with { type: 'json' }
import rawItems from '../src/data/items.json' with { type: 'json' }
import chineseEffectNames from '../src/data/zh-cn/effects.json' with { type: 'json' }
import chineseItemNames from '../src/data/zh-cn/items.json' with { type: 'json' }
import { toSimplifiedChinese } from '../src/lib/chineseText.js'

const ZH = 'zh-CN'

test('Chinese dictionaries contain only names keyed by the original IDs', () => {
  for (const [original, translated] of [[rawEffects, chineseEffectNames], [rawItems, chineseItemNames]]) {
    assert.deepEqual(Object.keys(translated), Object.keys(original))
    for (const [id, entry] of Object.entries(translated)) {
      assert.deepEqual(Object.keys(entry), ['name'], id)
      assert.match(entry.name, /\p{Script=Han}/u, id)
      assert.equal(Object.hasOwn(original[id], 'nameZh'), false)
      assert.equal(Object.hasOwn(original[id], 'aliasesZh'), false)
    }
  }
})

test('language choice selects the OCR model and preserves catalog metadata', () => {
  assert.equal(getLanguage().ocr, 'eng')
  assert.equal(getLanguage(ZH).ocr, 'PP-OCRv5_mobile')
  assert.throws(() => getLanguage('unknown'))
  for (const [english, chinese] of [[EFFECTS, getEffects(ZH)], [ITEMS, getItems(ZH)]]) {
    assert.deepEqual(chinese.map((e) => e.id), english.map((e) => e.id))
    chinese.forEach((entry, i) => {
      assert.match(entry.name, /\p{Script=Han}/u)
      const { name: _enName, ...enMeta } = english[i]
      const { name: _zhName, ...zhMeta } = entry
      assert.deepEqual(zhMeta, enMeta)
    })
  }
})

test('all Chinese catalog names resolve, including duplicate names and short items', () => {
  for (const entry of getEffects(ZH)) {
    assert.equal(matchEffectLine(entry.name, ZH)?.effectName, entry.name, entry.id)
  }
  for (const entry of getItems(ZH)) {
    const result = matchItemName(entry.name, ZH)
    assert.equal(result?.itemName, entry.name, entry.id)
    const english = matchItemName(ITEMS.find((e) => e.id === entry.id).name)
    assert.equal(result.color, english.color, entry.id)
    assert.equal(result.dn, english.dn, entry.id)
  }
})

test('Chinese OCR spaces, brackets, bullet noise and full-width tiers normalize consistently', () => {
  assert.equal(matchEffectLine('● 生 命 力 ＋ ３', ZH)?.effectId, '7000002')
  assert.equal(matchEffectLine('生命 力 十 3', ZH)?.effectId, '7000002')
  assert.equal(matchEffectLine('[ae] 【追 踪 者】技 艺 的 使 用 次 数 ＋ １', ZH)?.effectId, '7033200')
  assert.equal(normalizeEffectName('生命力 ＋ ３'), normalizeEffectName('生 命 力+3'))
  assert.equal(matchItemName('暗 痕', ZH)?.itemId, '10')
})

test('Chinese matching repairs an OCR typo but rejects ambiguous or nonexistent tiers', () => {
  assert.equal(matchEffectLine('提升火属性攻去力+2', ZH)?.effectId, '7001602')
  assert.equal(matchEffectLine('提升物理攻击力+9', ZH), null)
  assert.equal(matchEffectLine('力气+9', ZH), null)
  assert.equal(matchEffectLine('提升冰属性攻击力', ZH), null)
  assert.equal(matchEffectLine('攻击命中时，能恢复血量', ZH), null)
  assert.equal(matchEffectLine('降低血量上限', ZH), null)
  assert.equal(matchEffectLine('随机乱码测试', ZH), null)
  assert.equal(matchEffectLine('※仅限能使用的武器类别', ZH), null)
})

test('Traditional OCR glyphs become Simplified without weakening typo or tier checks', () => {
  assert.equal(toSimplifiedChinese('強化荊棘的魔法'), '强化荆棘的魔法')
  assert.equal(matchEffectLine('強化荊棘的魔法', ZH)?.effectId, '7043800')
  assert.equal(matchEffectLine('強化荊棘的魔法', ZH)?.confidence, 1)
  assert.equal(matchEffectLine('提升物理攻擊力＋９', ZH), null)
  assert.equal(matchItemName('遼闊的幽靜暗淡情景', ZH)?.itemName, '辽阔的幽静暗淡情景')
  assert.equal(toSimplifiedChinese('出擊時，會持有“魔力壺”\n生命力＋３'), '出击时，会持有“魔力壶”\n生命力＋３')
})

test('overlapping quoted fragments recover exactly one effect and preserve its neighbors', () => {
  const text = '生命力+3\n出击时，会\n会持有\n有“魔力壶\n出击时，武器战技改为“神圣刀刃”'
  const result = matchFrameText(text, ZH)
  assert.deepEqual(result.matchedEffects.map((effect) => effect.effectName), [
    '生命力＋３', '出击时，会持有“魔力壶”', '出击时，武器战技改为“神圣刀刃”',
  ])
  assert.equal(result.review.lines.length, 3)
  assert.equal(result.review.lines[1].text, '出击时，会\n会持有\n有“魔力壶')
  assert.deepEqual(matchFrameText('出击时，不会\n会持有\n有“魔力壶', ZH).matchedEffects, [])
  assert.deepEqual(matchFrameText('出击时，会\n会持有\n有“冰霜壶', ZH).matchedEffects, [])
})

test('missing or misread demerit separators recover only exact buff/debuff pairs', () => {
  for (const separator of ['', ' ', 'i', 'I', 'l', '1', '１', '“']) {
    const result = matchFrameText(`提升物理攻击力+3${separator}闪避后的当下，降低减伤率`, ZH)
    assert.deepEqual(result.matchedEffects.map((effect) => effect.effectId), ['6001400', '6850700'], separator)
    assert.equal(result.review.lines.length, 2)
  }
  for (const text of [
    '提升物理攻击力+9i闪避后的当下，降低减伤率',
    '提升物理攻击力+91闪避后的当下，降低减伤率',
    '提升物理攻击力+31',
    '提升物理攻击力+3i生命力+3',
    '提升物理攻击力+3i闪避后的当下，不降低减伤率',
  ]) {
    assert.deepEqual(matchFrameText(text, ZH).matchedEffects, [], text)
  }
  for (const entry of getEffects(ZH)) {
    assert.equal(matchFrameText(entry.name, ZH).matchedEffects.length, 1, entry.name)
  }
})

test('Chinese icon noise does not consume the repair allowance for an effect typo', () => {
  const text = '辽阔 的 光耀 情景\n辆 强化 控 石 的 魔法\n回 生命 力 + 3\n国 自然 累积 绝招 基 表 十 3'
  const result = matchFrameText(text, ZH)
  assert.equal(result.itemMatch.itemName, '辽阔的光耀情景')
  assert.equal(result.itemMatch.color, 'Yellow')
  assert.deepEqual(result.matchedEffects.map((e) => e.effectId), ['7043200', '7000002', '7000902'])
  assert.equal(result.matchedEffects[0].rawText, '辆 强化 控 石 的 魔法')
  assert.equal(matchEffectLine('不 强化控石的魔法', ZH), null)
  assert.equal(matchEffectLine('辆 强化控石的魔法+9', ZH), null)
  assert.equal(matchEffectLine('国 自然累积绝招量表+9', ZH), null)
})

test('Chinese item titles tolerate a trailing icon without weakening effect tier checks', () => {
  for (const [text, name, color] of [
    ['辽阔 的 水 滴 暗 淡 情 景 ， 9', '辽阔的水滴暗淡情景', 'Blue'],
    ['端正 的 幽静 暗淡 情景 9', '端正的幽静暗淡情景', 'Green'],
    ['辽阔 的 光耀 暗淡 情景 8', '辽阔的光耀暗淡情景', 'Yellow'],
  ]) {
    const item = matchItemName(text, ZH)
    assert.equal(item?.itemName, name)
    assert.equal(item.color, color)
    assert.equal(item.dn, true)
  }
  assert.equal(matchEffectLine('生命力+9', ZH), null)
  assert.equal(matchEffectLine('提升火属性攻击力+2 9', ZH), null)
})

test('two- and three-line Chinese effects merge without consuming the next effect', () => {
  for (const wrapped of [
    '【执行者】提升技艺发动期间的攻击力\n但攻击时会降低减伤率',
    '【执行者】提升技艺发动期间\n的攻击力但攻击时\n会降低减伤率',
  ]) {
    const result = matchFrameText(`${wrapped}\n力气+3`, ZH)
    assert.deepEqual(result.matchedEffects.map((e) => e.effectId), ['7034400', '7000302'])
  }
})

test('Chinese Deep relics retain buff/nerf IDs, color and Deep status through grouping', () => {
  const collector = new RelicCollector({ intervalSec: 1 / 30 })
  for (const [i, title] of ['辽阔的火燃暗淡情景', '辽 阔 的 火 燃 暗 淡 情 景'].entries()) {
    collector.addFrame(matchFrameText(`${title}\n生命力+3\n受到损伤时，会累积中毒量表`, ZH), i / 30)
  }
  const [relic] = collector.finish()
  assert.equal(relic.itemName, '辽阔的火燃暗淡情景')
  assert.equal(relic.color, 'Red')
  assert.equal(relic.dn, true)
  assert.deepEqual(relic.buffs.map((b) => b.effectId), ['7000002'])
  assert.deepEqual(relic.nerfs.map((b) => b.effectId), ['6820000'])
})

test('Chinese Deep relics split inline demerits at a vertical separator', () => {
  for (const separator of ['|', '｜', '「']) {
    const collector = new RelicCollector()
    const text = [
      '辽阔的幽静暗淡情景',
      '受到损伤的当下，能通过攻击恢复部分血量+2',
      '血量没有全满时，降低攻击力',
      '使出致命一击时，能获得卢恩',
      `提升物理攻击力+3 ${separator} 受到损伤时，会累积发狂量表`,
    ].join('\n')
    collector.addFrame(matchFrameText(text, ZH), 0)
    const [relic] = collector.finish()
    assert.equal(relic.itemName, '辽阔的幽静暗淡情景')
    assert.equal(relic.color, 'Green')
    assert.equal(relic.dn, true)
    assert.deepEqual(relic.buffs.map((b) => b.effectId).sort(), ['6001400', '6005601', '7031900'])
    assert.deepEqual(relic.nerfs.map((b) => b.effectId).sort(), ['6820400', '6851200'])
  }
  const quoted = matchFrameText('出击时，会持有「红漩泡状露滴」', ZH)
  assert.deepEqual(quoted.matchedEffects.map((e) => e.effectId), ['6622500'])
  assert.equal(quoted.lineCount, 1)
  assert.equal(matchFrameText('提升物理攻击力+3「生命力+3', ZH).lineCount, 1)
})

test('switching languages keeps lookups and cached results separate', () => {
  assert.equal(matchEffectLine('Strength +3').effectName, 'Strength +3')
  assert.equal(matchEffectLine('力气+3', ZH).effectId, matchEffectLine('Strength +3').effectId)
  assert.equal(matchEffectLine('Strength +3', ZH), null)
  assert.equal(matchEffectLine('力气+3'), null)
  assert.equal(matchEffectLine('力气+3', ZH).rawText, '力气+3')
  assert.equal(matchEffectLine('力 气＋３', ZH).rawText, '力 气＋３')
  assert.equal(matchItemName('Grand Burning Scene').color, 'Red')
  assert.equal(matchItemName('辽阔的火燃情景', ZH).dn, false)
})
