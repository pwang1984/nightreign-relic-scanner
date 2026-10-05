// Drives a <video> element through the timeline, cropping a normalized
// region box to an off-screen canvas at each sampled timestamp so it can be
// handed to an OCR engine. Uses seek+'seeked' rather than requestVideoFrameCallback
// so it works consistently across browsers and frame rates.

export const SCAN_INTERVAL_SEC = 1 / 60

function seekTo(video, time) {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked)
      resolve()
    }
    video.addEventListener('seeked', onSeeked)
    video.currentTime = time
  })
}

// box: { x, y, w, h } normalized 0..1 against native video dimensions.
// upscale: multiplier applied to the cropped region before OCR (helps
// Tesseract on small in-game text).
export function cropFrameToCanvas(video, box, upscale = 2, canvas = document.createElement('canvas')) {
  const sourceWidth = video.videoWidth ?? video.width
  const sourceHeight = video.videoHeight ?? video.height
  const sx = Math.round(box.x * sourceWidth)
  const sy = Math.round(box.y * sourceHeight)
  const sw = Math.round(box.w * sourceWidth)
  const sh = Math.round(box.h * sourceHeight)

  const width = Math.max(1, Math.round(sw * upscale))
  const height = Math.max(1, Math.round(sh * upscale))
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  return canvas
}

// Mean absolute per-channel difference between two same-sized RGBA buffers
// (e.g. from canvas ImageData.data), sampling every `stride`th pixel to keep
// this cheap — it only needs to be "good enough" to tell a truly static
// frame from a changed one, not pixel-perfect. Returns Infinity if the
// buffers aren't comparable (different size, or nothing to compare yet).
export function frameDiffScore(a, b, stride = 8) {
  if (!a || !b || a.length !== b.length) return Infinity
  let sum = 0
  let samples = 0
  for (let i = 0; i < a.length; i += 4 * stride) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
    samples += 1
  }
  return samples === 0 ? Infinity : sum / (samples * 3)
}

// Below this mean per-channel pixel difference (0-255 scale), a frame is
// treated as unchanged from the last OCR frame so its OCR can be skipped. Even
// a visually static capture has some encoding noise frame-to-frame — this is
// tuned to absorb that without missing genuine content changes (exact pixel
// equality turned out to almost never happen once real compressed video is
// involved).
export const FRAME_UNCHANGED_THRESHOLD = 3

function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.85) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

export function* frameSampleTimes(start, end, intervalSec, frameOriginSec) {
  if (start > end) return
  if (!Number.isFinite(frameOriginSec)) {
    for (let t = start; t <= end; t += intervalSec) yield t
    return
  }
  // Chrome can return the preceding frame when seeking exactly to a frame
  // boundary. Use the known frame grid's centers, plus both trim boundaries
  // so a partially included first/last frame is still captured.
  yield start
  let index = Math.floor((start - frameOriginSec) / intervalSec - 0.5) + 1
  for (let t = frameOriginSec + (index + 0.5) * intervalSec; t < end;
    t = frameOriginSec + (++index + 0.5) * intervalSec) {
    if (t > start) yield t
  }
  if (end > start) yield end
}

// Walks the video from `startTime` to `endTime` (defaulting to the full
// video) in `intervalSec` steps, yielding one descriptor per sampled frame.
// Respects a `shouldStop` callback so the UI can cancel mid-run, and an
// optional `waitIfPaused` callback (returning a promise that resolves once
// resumed) so the UI can pause between frames without losing progress.
//
// This is a generator rather than a callback loop so the consumer can run OCR
// concurrently while extraction continues: seeking is inherently serial (one
// <video>, one playhead) but OCR isn't, and pulling from a generator gives
// backpressure for free — extraction only advances when the consumer asks for
// the next frame.
//
// The duplicate check lives here because it's pure main-thread pixel work
// with no OCR dependency, so `duplicateOfPrev` is already known by the time a
// frame is handed over and duplicates never need to occupy a worker.
export async function* walkVideoFrames(
  video,
  box,
  {
    intervalSec,
    upscale,
    shouldStop,
    waitIfPaused,
    startTime = 0,
    endTime,
    frameOriginSec,
    unchangedThreshold = FRAME_UNCHANGED_THRESHOLD,
  },
) {
  const rangeStart = Math.max(0, startTime)
  const rangeEnd = Math.min(endTime ?? video.duration, video.duration)
  const rangeLength = Math.max(rangeEnd - rangeStart, 0.0001)

  let index = 0
  const canvas = document.createElement('canvas')
  let lastOcrPixels = null
  let lastBlob = null
  for (const t of frameSampleTimes(rangeStart, rangeEnd, intervalSec, frameOriginSec)) {
    if (shouldStop && shouldStop()) break
    if (waitIfPaused) await waitIfPaused()
    if (shouldStop && shouldStop()) break

    await seekTo(video, t)
    cropFrameToCanvas(video, box, upscale, canvas)
    const context = canvas.getContext('2d')
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height)
    const pixels = imageData.data
    // Compare against the frame whose OCR will be reused. Comparing only
    // neighboring frames can skip a gradual change indefinitely, especially
    // with denser sampling.
    const duplicateOfPrev = frameDiffScore(pixels, lastOcrPixels) < unchangedThreshold

    // Hand over a Blob rather than the canvas: it's what tesseract.js wants
    // anyway (saving an encode on the main thread at dispatch time), it
    // doubles as the preview thumbnail, and it drops queued-frame memory from
    // megabytes of RGBA to tens of kilobytes while frames wait for a worker.
    // Duplicates reuse both the OCR result and its preview; avoid encoding
    // another multi-megapixel JPEG when no worker will consume it.
    if (!duplicateOfPrev) {
      // Keep the original colors, including pale blue demerits. Paddle's
      // detector handles contrast; thresholding here can erase their strokes.
      lastOcrPixels = pixels
      lastBlob = await canvasToBlob(canvas)
    }

    yield {
      index: index++,
      timeSec: t,
      fraction: Math.min(1, (t - rangeStart) / rangeLength),
      blob: lastBlob,
      duplicateOfPrev,
    }
  }
}
