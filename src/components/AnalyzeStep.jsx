import { useEffect, useRef, useState } from 'react'
import { walkVideoFrames } from '../lib/videoFrames.js'
import { recognizeImage, terminateOcr, POOL_SIZE } from '../lib/ocr.js'
import { matchFrameText } from '../lib/matcher.js'
import { RelicCollector } from '../lib/grouping.js'

// Sampling this finely used to be a real cost/accuracy tradeoff, but with
// per-frame duplicate detection an unchanged frame costs almost nothing to
// skip, so there's no longer a reason to make this — or the upscale factor —
// a decision the user has to make before every scan.
const INTERVAL_SEC = 1 / 30
const UPSCALE = 2

// How many frames may be extracted ahead of the OCR pool. Deep enough that no
// worker ever sits idle waiting on a slow seek, shallow enough that stopping
// mid-run drains in about a second.
const MAX_INFLIGHT = POOL_SIZE * 2 + 2

export default function AnalyzeStep({
  videoUrl,
  box,
  startTime: initialStartTime,
  endTime: initialEndTime,
  onComplete,
  onBack,
}) {
  const videoRef = useRef(null)
  const stopRef = useRef(false)
  const pauseRef = useRef({ paused: false, waiters: [] })
  const hasStartedRef = useRef(false)
  const previewUrlRef = useRef(null)
  // Set by the active run so resuming (or stopping) can restart the ordered
  // emit, which pauses along with extraction.
  const drainRef = useRef(null)

  // The trim range is set in step 2 — nothing left to configure here.
  const startTime = initialStartTime ?? 0
  const endTime = initialEndTime ?? null

  const [running, setRunning] = useState(false)
  const [paused, setPaused] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [progress, setProgress] = useState(0)
  const [framesSeen, setFramesSeen] = useState(0)
  const [framesSkipped, setFramesSkipped] = useState(0)
  const [relicsFound, setRelicsFound] = useState(0)
  const [lastText, setLastText] = useState('')
  const [previewImage, setPreviewImage] = useState(null)
  const [error, setError] = useState(null)

  useEffect(
    () => () => {
      terminateOcr()
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    },
    [],
  )

  // Surface progress in the tab title so it's visible even when this tab
  // isn't focused, and always restore whatever the title was before.
  const originalTitleRef = useRef(typeof document !== 'undefined' ? document.title : '')
  useEffect(() => {
    if (running) {
      document.title = `${Math.round(progress * 100)}% – ${originalTitleRef.current}`
    } else {
      document.title = originalTitleRef.current
    }
    return () => {
      document.title = originalTitleRef.current
    }
  }, [running, progress])

  function waitIfPaused() {
    if (!pauseRef.current.paused) return Promise.resolve()
    return new Promise((resolve) => pauseRef.current.waiters.push(resolve))
  }

  function togglePause() {
    const next = !pauseRef.current.paused
    pauseRef.current.paused = next
    setPaused(next)
    if (!next) {
      const waiters = pauseRef.current.waiters
      pauseRef.current.waiters = []
      waiters.forEach((resolve) => resolve())
      drainRef.current?.()
    }
  }

  async function start() {
    setRunning(true)
    setStopping(false)
    setError(null)
    setProgress(0)
    setFramesSeen(0)
    setFramesSkipped(0)
    setRelicsFound(0)
    setPreviewImage(null)
    stopRef.current = false
    pauseRef.current = { paused: false, waiters: [] }
    setPaused(false)

    const video = videoRef.current
    const collector = new RelicCollector({ intervalSec: INTERVAL_SEC })

    // OCR runs on a pool of workers, so results come back out of order — but
    // RelicCollector builds relics from *consecutive* frames, so it must be
    // fed in strict timestamp order. Frames land in `pending` keyed by index
    // and are emitted only once every earlier frame has completed.
    const pending = new Map()
    let nextEmit = 0
    let extracted = 0
    let extractionDone = false
    let inflight = 0
    let slotWaiter = null
    let drainWaiter = null
    let lastText = ''
    let lastFrameMatch = null

    const releaseSlot = () => {
      inflight -= 1
      const waiter = slotWaiter
      slotWaiter = null
      waiter?.()
    }
    const awaitSlot = () =>
      inflight < MAX_INFLIGHT ? Promise.resolve() : new Promise((resolve) => (slotWaiter = resolve))

    const fullyDrained = () => extractionDone && nextEmit >= extracted

    // Emits every frame that's now contiguous with what's already been
    // emitted. A duplicate frame inherits the text of the last frame actually
    // OCR'd — because `lastText` is only reassigned on non-duplicates and
    // this runs strictly in order, a long run of near-identical frames all
    // resolve to the same ancestor, matching the previous behavior.
    //
    // Pausing gates this too, not just extraction: extraction now runs ahead
    // of OCR, so on a short clip it can finish entirely before the user hits
    // Pause, and gating only extraction would let the run quietly complete
    // while the UI still said "Paused".
    function drain() {
      if (pauseRef.current.paused) return
      while (pending.get(nextEmit)?.done) {
        const record = pending.get(nextEmit)
        pending.delete(nextEmit)
        nextEmit += 1

        let text, frameMatch
        if (record.dup && lastFrameMatch) {
          text = lastText
          frameMatch = lastFrameMatch
        } else {
          text = record.text
          frameMatch = matchFrameText(text)
          lastText = text
          lastFrameMatch = frameMatch
        }

        setLastText(text.trim() || '(no text detected)')
        setFramesSeen((n) => n + 1)
        if (record.dup) setFramesSkipped((n) => n + 1)
        collector.addFrame(frameMatch, record.timeSec)
        setRelicsFound(collector.runs.length)
        setProgress(record.fraction)
      }
      if (drainWaiter && fullyDrained()) {
        const waiter = drainWaiter
        drainWaiter = null
        waiter()
      }
    }
    drainRef.current = drain

    let previewUrl = null
    const showPreview = (blob) => {
      const url = URL.createObjectURL(blob)
      if (previewUrl) URL.revokeObjectURL(previewUrl)
      previewUrl = url
      previewUrlRef.current = url
      setPreviewImage(url)
    }

    try {
      await new Promise((resolve, reject) => {
        if (video.readyState >= 1) return resolve()
        video.addEventListener('loadedmetadata', resolve, { once: true })
        video.addEventListener('error', reject, { once: true })
      })

      for await (const frame of walkVideoFrames(video, box, {
        intervalSec: INTERVAL_SEC,
        upscale: UPSCALE,
        startTime,
        endTime: endTime ?? undefined,
        shouldStop: () => stopRef.current,
        waitIfPaused,
      })) {
        showPreview(frame.blob)

        const record = {
          timeSec: frame.timeSec,
          fraction: frame.fraction,
          dup: frame.duplicateOfPrev,
          text: '',
          done: false,
        }
        pending.set(frame.index, record)
        extracted = frame.index + 1

        // Duplicates never reach a worker — mark them ready immediately and
        // let `drain()` resolve their text in order.
        if (record.dup) {
          record.done = true
          drain()
          continue
        }

        await awaitSlot()
        inflight += 1
        recognizeImage(frame.blob)
          .then((text) => {
            record.text = text
          })
          .catch((err) => {
            // A failed job must still be marked done, or the reorder buffer
            // stalls forever on it and the run never finishes.
            console.error('OCR failed for frame', frame.index, err)
            record.text = ''
          })
          .finally(() => {
            record.done = true
            releaseSlot()
            drain()
          })
      }

      extractionDone = true
      drain()
      if (!fullyDrained()) await new Promise((resolve) => (drainWaiter = resolve))

      drainRef.current = null
      const relics = collector.finish()
      onComplete(relics)
    } catch (err) {
      console.error(err)
      drainRef.current = null
      setError(err.message || String(err))
      setRunning(false)
      setStopping(false)
      terminateOcr()
    }
  }

  // Nothing left for the user to configure before scanning — kick off
  // automatically as soon as this step mounts. Guarded by a ref (rather than
  // relying on the effect only firing once) since React's dev-mode
  // StrictMode double-invokes effects on mount, which would otherwise start
  // two concurrent scans.
  useEffect(() => {
    if (hasStartedRef.current) return
    hasStartedRef.current = true
    start()
  }, [])

  // Stops sampling after whichever frame is currently in flight and moves
  // straight on to the results built from what's been found so far — this
  // stays in the "running" view (rather than snapping back to the settings
  // screen) until that in-flight work actually finishes and `onComplete`
  // hands off to the results step.
  function stopAndFinish() {
    if (stopRef.current) return
    stopRef.current = true
    // wake up the loop if it's currently paused so it can observe the stop
    // and unwind instead of hanging forever waiting to be resumed
    forceResume()
    setPaused(false)
    setStopping(true)
  }

  function forceResume() {
    if (!pauseRef.current.paused) return
    pauseRef.current.paused = false
    const waiters = pauseRef.current.waiters
    pauseRef.current.waiters = []
    waiters.forEach((resolve) => resolve())
    drainRef.current?.()
  }

  return (
    <div className="step-panel">
      <h2>3–4. Scan the video with OCR and match behaviors</h2>
      <p className="step-hint">
        We'll automatically step through the video, crop your selected region, run it through
        Tesseract OCR, and fuzzy-match each line against the Relics.pro compendium of behaviors.
      </p>

      <video ref={videoRef} src={videoUrl} className="hidden-video" preload="auto" muted playsInline />

      {running && (
        <div className="progress-panel">
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{ width: `${progress * 100}%` }} />
          </div>
          <div className="progress-stats">
            <span>{Math.round(progress * 100)}% complete</span>
            <span>{framesSeen} frames scanned</span>
            {framesSkipped > 0 && <span>{framesSkipped} skipped (unchanged)</span>}
            <span>{relicsFound} relics found</span>
            {paused && <span className="paused-badge">Paused</span>}
            {stopping && <span className="stopping-badge">Stopping…</span>}
          </div>
          <div className="frame-inspector">
            <div className="frame-preview">
              {previewImage ? (
                <img src={previewImage} alt="Region currently being scanned" />
              ) : (
                <span className="frame-preview-placeholder">Waiting for first frame…</span>
              )}
            </div>
            <pre className="ocr-preview">{lastText}</pre>
          </div>
        </div>
      )}

      {error && <p className="error-text">Something went wrong: {error}</p>}

      <div className="step-actions">
        <button className="btn btn--ghost" onClick={onBack} disabled={running}>
          Back
        </button>
        {running && (
          <div className="step-actions-group">
            <button className="btn btn--secondary" onClick={togglePause} disabled={stopping}>
              {paused ? 'Resume' : 'Pause'}
            </button>
            <button className="btn btn--danger" onClick={stopAndFinish} disabled={stopping}>
              {stopping ? 'Stopping…' : 'Stop & view results'}
            </button>
          </div>
        )}
        {!running && error && (
          <button className="btn btn--primary" onClick={start}>
            Retry
          </button>
        )}
      </div>
    </div>
  )
}
