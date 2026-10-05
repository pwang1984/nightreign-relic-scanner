# Nightreign Relic Scanner

Turn a video of you scrolling through your Elden Ring: Nightreign relic
inventory into a clean, exportable list of relics.

Everything runs in your browser — frame extraction, OCR and matching all happen
locally, and your video is never uploaded anywhere. OCR runtimes and models
are downloaded on first use. English uses Tesseract.js; Simplified Chinese
uses PaddleOCR's PP-OCRv5 mobile detector and recognizer, preferring WebGPU
acceleration and falling back to four CPU Workers.

## The four steps

### 1. Upload

Choose **Game text language** to match the recording:
**English** (the default) or **简体中文**. This selects both
the OCR model and the names used for matching, results and exports. You can
also change the selection in Prepare, before scanning. The surrounding app
interface and compendium categories/descriptions remain in English.

Drag a video file onto the dropzone, or click to browse. A collapsible section
walks through recording your relic inventory and getting the clip off a
PlayStation or Xbox.

### 2. Prepare

Scrub to a frame where a relic's name and behaviors are visible, then drag a box
around both. Include the title above the effects: its matched name determines
the exported relic name, color and Deep status. The box starts pre-filled at
the behavior panel's usual position, so it usually only needs a nudge. Drag inside
the box to move it, or a corner to resize it — with a mouse, a stylus or a
finger.

Optionally set trim points from the same scrubber, so only the stretch of video
containing your relic list gets scanned.

### 3. Match

Scanning starts automatically and reports live progress. Under the hood:

Before the first frame, the status distinguishes video loading, OCR model
loading (which requires downloads on first use), and reading the first frame.

- Sampling follows the video frame rate, up to 60 times per second. Local
  packet timestamps are inspected with [Mediabunny](https://mediabunny.dev/guide/reading-media-files#frame-rate-metrics); variable-rate videos,
  unsupported files, or inspection taking over three seconds retain 60 Hz.
  Fractional rates such as 29.97 are preserved. Known frame grids are sampled
  at frame centers to avoid ambiguous browser seeks, with extra samples at
  both trim boundaries. The selected region is cropped
  from each frame and upscaled 2× for OCR. The current sampling rate is shown
  beside scan progress.
- Frames sufficiently similar to the last frame sent to OCR reuse its result
  and preview, avoiding another OCR job and JPEG encoding. Comparing against
  that frame also lets gradual changes accumulate until they trigger OCR.
- English OCR keeps the original pool of 2–4 Tesseract workers. Chinese OCR first
  tries WebGPU in one PaddleOCR Worker; when GPU acceleration is unavailable,
  it uses four CPU Workers with one inference thread each. If GPU inference
  fails mid-scan, the frame is retried on the CPU pool. The model, image scale
  and sampling rate stay the same. Results are emitted in timestamp order
  before grouping, which depends on seeing frames sequentially.
- Both languages use the same scan loop and OCR adapter interface. Language
  strategies handle text matching and classify usage notes before review;
  grouping and review consume the same result structure. The existing 50 ms
  adjacent-run merge window does not change with the detected sampling rate.
- While it runs you get the cropped frame currently being read, the raw OCR text
  coming out of it, counts of frames scanned/skipped and relics found, and the
  progress percentage mirrored into the browser tab title so you can watch from
  another tab.
- **Pause**/**Resume** suspends both extraction and OCR. **Stop & view results**
  ends the scan early and takes you to the results built from what it found so
  far.

If a recording is already black in Prepare, check browser video playback before
changing OCR settings. Some Chrome/GPU combinations have trouble with 10-bit HDR
video. Try an H.264 SDR copy that preserves the original resolution and frame
timestamps; reducing a fast-scrolling recording to 30 fps can discard brief
relic views. Short keyframe intervals also reduce the work needed for seeking.

### 4. Review

Each relic is listed with its item name, a colour swatch, its behaviors grouped
into buffs and nerfs with their compendium categories, and a `seen N×` badge
when the same relic turned up more than once in the video.

The review list flags missing names or colours, low-confidence matches, and
results with more distinct OCR text segments than matched effects. Wrapped
effects count as one segment; recognized titles and repeated lines do not
inflate the count. The weapon restriction note `仅限能使用的武器类别` is kept
as a usage note and does not require review on its own. These flags are prompts to check the capture, not proof
that an effect is missing.

Use **Needs review** to filter suspicious results, or **Review next** to open
the next one. The editor shows the original capture and OCR text alongside
the result. Search by Chinese or English name, or numeric ID, to select a
relic name or add and replace effects; incorrect effects can also be removed.
Selecting a relic name fills its colour and Deep status. **Save changes**
keeps the edit, while **Mark reviewed & next** confirms it and advances to
the next flagged result. Any result can also be flagged manually.

Corrections are kept for the current scan only and are lost on refresh or
starting over. JSON and CSV exports include all relics with their saved
corrections, regardless of the current filter. Captures and review evidence
are not included in exports.

## How matching works

Each OCR'd line is cleaned of the bullet glyphs and leading punctuation
Tesseract tends to invent from the game's icons, then resolved against the
compendium:

- An exact name lookup runs first — roughly 43% of lines already read exactly
  like a compendium entry, and those skip fuzzy matching entirely.
- In English mode, everything else goes to [Fuse.js](https://www.fusejs.io/) fuzzy search
  (threshold 0.45 for effects, 0.4 for item names).
- Lines that fail are retried with leading garbage tokens stripped, since the
  small icon before each effect frequently OCRs as one or two junk characters
  glued to the front of the real text.
- Effects are keyed by display name rather than compendium ID: many entries
  share a name across power tiers that differ only in a description the in-game
  overlay never shows, so the name is the stable unit.
- Effects in the `Impairment` category are treated as nerfs — that category is
  used by every demerit and nothing else, which is how Deep relics' drawbacks
  get separated from their benefits.

Simplified Chinese mode keeps the panel in color so pale blue demerit strokes
are not lost to binarization. PaddleOCR detects text regions before recognizing
them, separating most effect icons from the text. Inline demerits are split at
`|` / `｜`; an OCR misread as `「` is split only when both sides match effects
and the right side is a demerit. Item matching tolerates trailing icon noise
such as `8` or `9`; effect tiers are still checked strictly.
If the separator disappears or becomes `i` / `l` / `1`, a split is recovered only
when both complete names match the catalog exactly, the right side is a
demerit, and there is just one valid pair. Overlapping fragments such as
`出击时，会` / `会持有` / `有“魔力壶”` can likewise be joined when removing
their shared characters produces one exact catalog effect.

The model can emit Traditional glyphs even in Chinese mode. OCR output,
matching and manual searches use [OpenCC](https://github.com/nk2028/opencc-js)
to normalize those glyphs to Simplified Chinese; `強化荊棘的魔法` therefore
matches `强化荆棘的魔法` without relaxing the typo or numeric-tier checks.
It uses a separate name index and cache, and normalizes
full-width punctuation/digits and spaces between characters, including the
OCR confusion `十3` → `+3`. Matching tries exact names first, then full-string
edit distance (at most 18%, capped at three
edits). Numeric tiers must agree; names shorter than six characters require
an exact match, and close competing matches are rejected. Up to three wrapped
lines can be joined. These rules help prevent similar Chinese weapon names
or different power tiers from being merged by substring matching.

Frames are then grouped into relics:

- A run of frames extends while each new frame's matched names stay at least 50%
  similar (Jaccard) to the run's stable core; when similarity drops below that,
  a new relic run begins.
- Names appearing in fewer than 40% of a run's frames are discarded as OCR
  noise.
- Adjacent runs that look like fragments of the same relic are merged, and
  relics with identical effect signatures seen at different points in the video
  collapse into a single entry with an occurrence count.

## Output

**JSON** (`relics-YYYY-MM-DD.json`) follows the shape Relics.pro uses, so it can
be fed back into tooling that speaks that schema. Each relic carries `item`,
`color`, `dn` (whether it's a Deep relic), `buffs`, `nerfs`, the matched effect
IDs, and `occurrences`. `itemId` is always `-1000000`, mirroring Relics.pro's
own "Custom Relic" placeholder — matching only ever recovers an item *name* from
OCR, never a definitive catalog ID. Unidentified names and colors remain
`null`; importers requiring a color string need those entries corrected first.
Chinese names are preserved, and effects are exported as numeric IDs.

**CSV** (`relics-YYYY-MM-DD.csv`) is one row per relic, with `Buff 1..N` and
`Nerf 1..N` columns widened to fit the largest relic in the set.

## Compendium data

- `src/data/effects.json` — 929 effects, each with a name, category, stackable
  flag and description.
- `src/data/items.json` — 849 relic and vessel names with their colour (223 Red,
  212 Blue, 206 Yellow, 208 Green), 252 of them Deep variants.
- `src/data/zh-cn/effects.json` and `src/data/zh-cn/items.json` — Simplified
  Chinese names keyed by the same IDs, containing only `{ "name": "…" }`.
  Chinese mode uses these names with the original catalogs' metadata.

The original English names, IDs and metadata are extracted from the
[Relics.pro compendium](https://relics.pro/compendium)'s own static data bundle,
and remain unchanged. Chinese names are cross-referenced against NRrelics and
the game's Chinese text tables; see [data sources and mapping notes](docs/chinese-data.md).
All dictionaries ship with the app, so matching itself works offline. Chinese
names are maintained directly in the two `zh-cn` dictionaries.

## Development

```bash
npm install
npm run dev      # Vite dev server
npm run lint     # oxlint
npm run build    # production build into dist/
npm test         # matching/export unit tests + real English video regressions
npm run test:unit # fast matching and export checks
npx playwright install chromium # once, for browser OCR tests; installed Chrome also works
npm run test:timing # browser sampling checks at 30 and 59.94 fps, including trimmed clips
npm run test:ocr  # real browser PaddleOCR + Chinese screenshot regressions
npm run test:ocr -- tests/fixtures/zh-CN_0.png # inspect OCR and matches for one Chinese screenshot
```

Open the printed local URL, upload a video, and walk through the steps. To reach
the dev server from a phone or console browser on the same network, use
`npm run dev -- --host`.

`npm test` runs the real matching and grouping code (`src/lib/matcher.js`,
`src/lib/grouping.js`) against the clips in `tests/`, comparing the detected
relics against the expected fixtures and scoring buffs, nerfs, colour and Deep
status. Frame extraction is done with **ffmpeg**, which must be on your `PATH`
along with `ffprobe` — in the browser the app uses an `HTMLVideoElement` and a
`<canvas>` instead, but everything downstream is the same code. Pass specific
fixtures (`node tests/run-test.js tests/test1.json`) or none to run them all.
Video fixtures may set `"language": "zh-CN"` to use the same browser OCR test
adapter; omitted language means English.
The runner exits with a failure status for partial, missing or extra relics.
The Chinese OCR smoke test runs PaddleOCR in a real browser. It checks model
loading, wrapped effects, titles, color, Deep status and all buffs/debuffs in
the synthetic and gameplay screenshots, including inline blue demerits.
These samples are regression checks, not a full gameplay accuracy benchmark.

Pass a cropped Chinese screenshot to `npm run test:ocr -- /path/to/image.png`
to print its OCR text, matched item/color and effects. Include the title and all
effect lines. This uses the scan's browser canvas, 2× scale and JPEG encoding;
`ffmpeg`/`ffprobe` are not needed for screenshot tests. The first run needs
network access to download models. With a filename this is a diagnostic run;
without one it asserts the
fixed regression fixtures. Matching uses `src/data/zh-cn/effects.json`.

## Deployment

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every
push to `main`. The repo needs **Settings → Pages → Source → GitHub Actions**
enabled once; after that the workflow resolves the site's base path via
`actions/configure-pages` and passes it to Vite as `BASE_PATH`, so the build
works from a project subdirectory, a user site or a custom domain without
changes.

## Accuracy notes

- OCR accuracy depends heavily on video resolution and how tightly the selected
  region crops the text. Include the relic title and all behavior lines; leave
  out borders and unrelated UI where possible.
- Scroll slowly when recording. A relic that's on screen for only two or three
  frames gives the grouper very little to work with.
- Matching is fuzzy, so minor OCR errors are tolerated, but badly garbled text
  won't match anything. If a scan comes back empty, the region box is the first
  thing to revisit.
