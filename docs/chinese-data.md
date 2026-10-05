# Simplified Chinese names

The original `src/data/effects.json` and `src/data/items.json` remain unchanged.
Chinese names live in `src/data/zh-cn/effects.json` and
`src/data/zh-cn/items.json`. Each entry contains only a name:

```json
{
  "7000002": { "name": "生命力＋３" }
}
```

The selected language chooses the name by the original ID. Categories
(especially `Impairment`), descriptions, item colors and Deep flags always
come from the original catalogs. Edit the Chinese dictionaries directly;
there is no data download or import step.

## Sources

- [NRrelics affix catalog](https://github.com/limbic07/NRrelics/blob/a318132a3638b1202581d42bc45e0f2861655ac1/data/affix_catalog.json),
  revision `a318132a3638b1202581d42bc45e0f2861655ac1`. Contains Chinese
  normal, Deep positive and Deep negative effect names keyed by effect ID.
  547 of this scanner's 570 eligible relic-effect entries occur directly in
  this catalog. Used to cross-check effect IDs and names.
- [Elden-Ring-Nightreign-Save-Editor game text tables](https://github.com/alfizari/Elden-Ring-Nightreign-Save-Editor/tree/0d2ad1494c372098e689c23159656df70ff2d76d/src/Resources/Text),
  revision `0d2ad1494c372098e689c23159656df70ff2d76d`. Uses `en_US` and `zh_CN`
  `AttachEffectName` and `AntiqueName` FMG XML tables, including `_dlc01`.
  These were used to check game spelling and item names missing from NRrelics.

These links record the names' provenance. No software library, application
code or OCR model from either repository is included.

## Mapping rules

1. Use the Chinese game text with the same ID. Where a compendium effect ID
   differs from its text ID (including duplicate effects), resolve the exact
   English name in the paired English/Chinese text tables.
2. Remove layout whitespace and the `※仅限能使用的武器类别` footnote. Keep
   character labels, punctuation and numeric tiers in display names; the
   matcher normalizes formatting separately.
3. Effect `6001400` is `Physical Attack Up +3` in this project's original
   compendium and NRrelics, while the newer text dump labels that ID `+4`.
   Use NRrelics' `提升物理攻击力＋３` to preserve the original tier mapping.
4. Item IDs `1`–`6` are the generic `Antique` placeholders with null game text.
   Their Chinese label is the generic `遗物`.

All 929 stored effects and 849 items have Chinese names. The original filters
still exclude unobtainable, weapon and talisman effects from OCR matching,
leaving 570 eligible effects. Identical display names continue to resolve to
the first catalog entry, just as they do in English; OCR cannot distinguish
IDs whose displayed names are identical.

## Verification

Unit tests cover the dictionary shape and ID coverage, eligible Chinese names, retained metadata,
OCR whitespace/full-width symbols, numeric tiers, ambiguous matches, line
wrapping, buff/nerf classification and exported IDs/UTF-8 CSV. The existing
English video fixtures remain the regression baseline.

`tests/fixtures/zh-CN.png` is a synthetic five-line text panel rendered using
Noto Sans CJK SC Regular at 32 px on a dark background. `npm run test:ocr`
loads the real `chi_sim` pool and matches its output, including the `＋` → `十`
OCR error observed with this fixture.

`tests/fixtures/zh-CN-gameplay.png` is a 1518×464 panel crop from the local
`chrome-check-4k-sdr-original-fps.mp4` recording at 1.5 seconds (crop origin
2138,1530). Without preprocessing, OCR drops its title. The smoke test scales
it 2× and applies the browser's luminance threshold (140/255) to produce dark
text on white, then checks the name, Red color, Deep flag, buffs and blue
demerit text.

`tests/fixtures/zh-CN-title-fallback.jpg` is the browser's preprocessed 2× crop
from the same recording at 5.3 seconds. Block layout omits this title; the
sparse-layout retry recovers `辽阔的幽静暗淡情景`. The smoke test checks its Green
color and retains the original three effects. Matcher tests also cover
trailing title-icon noise read as `8` or `9`, without relaxing effect tiers.
These are regression samples; they do not measure accuracy across all capture
resolutions, brightness settings or font sizes.

`tests/fixtures/zh-CN_0.png` is the 838×258 screenshot of `辽阔的光耀情景`
with `强化挖石的魔法`, `生命力＋３` and `自然累积绝招量表＋３`. OCR reads an
effect icon as a separate `辆`/`国` token and also misreads a character in the
effect, exceeding the old edit allowance. Matching now removes a small set of
observed icon tokens at the start of effect lines before matching. Other
prefixes and numeric tiers are retained. The smoke test asserts the Yellow
color, all three effect IDs and normal (non-Deep) status.

Run `npm run test:ocr -- tests/fixtures/zh-CN_0.png` to inspect this screenshot's
preprocessed OCR text and matching results directly.
