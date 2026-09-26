# Nightreign Relic Scanner

Turn a video of you scrolling through your Elden Ring: Nightreign relic
inventory into a clean, exportable list of relics.

Everything runs in your browser — frame extraction, OCR and matching all happen
locally, and your video is never uploaded anywhere. (Tesseract.js does fetch its
WASM core and ~2 MB English language model from a CDN the first time you scan;
both are cached by the browser afterwards.)

## The four steps

### 1. Upload

Drag a video file onto the dropzone, or click to browse. A collapsible section
walks through recording your relic inventory and getting the clip off a
PlayStation or Xbox.

### 2. Prepare

Scrub to a frame where a relic's behaviors are visible, then drag a box around
just that text. The box starts pre-filled at the position the behavior panel
occupies in most capture setups, so it usually only needs a nudge. Drag inside
the box to move it, or a corner to resize it — with a mouse, a stylus or a
finger.

Optionally set trim points from the same scrubber, so only the stretch of video
containing your relic list gets scanned.

### 3. Match

Scanning starts automatically and reports live progress. Under the hood:

- The video is sampled ~30 times per second of footage; the selected region is
  cropped from each frame and upscaled 2× to give Tesseract more to work with.
- Frames identical to the one before them are detected and skipped before they
  ever reach OCR, which is what makes fine-grained sampling affordable — during
  a slow scroll most frames are duplicates.
- OCR runs across a pool of 2–4 Tesseract workers (one per core, minus one for
  the main thread). Results come back out of order and are buffered back into
  timestamp order before grouping, which depends on seeing frames sequentially.
- While it runs you get the cropped frame currently being read, the raw OCR text
  coming out of it, counts of frames scanned/skipped and relics found, and the
  progress percentage mirrored into the browser tab title so you can watch from
  another tab.
- **Pause**/**Resume** suspends both extraction and OCR. **Stop & view results**
  ends the scan early and takes you to the results built from what it found so
  far.

### 4. Review

Each relic is listed with its item name, a colour swatch, its behaviors grouped
into buffs and nerfs with their compendium categories, and a `seen N×` badge
when the same relic turned up more than once in the video. From here you can
export, or start over.

## How matching works

Each OCR'd line is cleaned of the bullet glyphs and leading punctuation
Tesseract tends to invent from the game's icons, then resolved against the
compendium:

- An exact name lookup runs first — roughly 43% of lines already read exactly
  like a compendium entry, and those skip fuzzy matching entirely.
- Everything else goes to [Fuse.js](https://www.fusejs.io/) fuzzy search
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
OCR, never a definitive catalog ID.

**CSV** (`relics-YYYY-MM-DD.csv`) is one row per relic, with `Buff 1..N` and
`Nerf 1..N` columns widened to fit the largest relic in the set.

## Compendium data

- `src/data/effects.json` — 929 effects, each with a name, category, stackable
  flag and description.
- `src/data/items.json` — 849 relic and vessel names with their colour (223 Red,
  212 Blue, 206 Yellow, 208 Green), 252 of them Deep variants.

Both are extracted from the
[Relics.pro compendium](https://relics.pro/compendium)'s own static data bundle,
so matching works entirely offline.

## Development

```bash
npm install
npm run dev      # Vite dev server
npm run lint     # oxlint
npm run build    # production build into dist/
npm test         # pipeline regression tests
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

## Deployment

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every
push to `main`. The repo needs **Settings → Pages → Source → GitHub Actions**
enabled once; after that the workflow resolves the site's base path via
`actions/configure-pages` and passes it to Vite as `BASE_PATH`, so the build
works from a project subdirectory, a user site or a custom domain without
changes.

## Accuracy notes

- OCR accuracy depends heavily on video resolution and how tightly the selected
  region crops the text. A tight box containing only the behavior lines — no
  icons, borders or surrounding UI — works best.
- Scroll slowly when recording. A relic that's on screen for only two or three
  frames gives the grouper very little to work with.
- Matching is fuzzy, so minor OCR errors are tolerated, but badly garbled text
  won't match anything. If a scan comes back empty, the region box is the first
  thing to revisit.
