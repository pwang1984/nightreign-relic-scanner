import { useEffect, useRef, useState } from 'react'
import { SCAN_INTERVAL_SEC, walkVideoFrames } from '../lib/videoFrames.js'
import { detectScanTiming } from '../lib/videoTiming.js'
import { prepareOcr, terminateOcr } from '../lib/ocr.js'
import { getLanguage } from '../lib/languages.js'
import { matchFrameText } from '../lib/matcher.js'
import { RelicCollector } from '../lib/grouping.js'

// Follow the video's frame rate, capped at 60 Hz for fast-scrolling captures.
// Unchanged frames reuse the previous OCR result and encoded preview.
const UPSCALE = 2

export default function AnalyzeStep({
  videoUrl,
  videoFile,
  language = 'en',
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
  const [startupStatus, setStartupStatus] = useState('Loading video…')
  const [samplingFps, setSamplingFps] = useState(null)
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
    let maxInflight = 0 // Set by the prepared OCR adapter before extracting frames.
    setRunning(true)
    setStopping(false)
    setError(null)
    setProgress(0)
    setFramesSeen(0)
    setFramesSkipped(0)
    setRelicsFound(0)
    setPreviewImage(null)
    setStartupStatus('Loading video…')
    setSamplingFps(null)
    stopRef.current = false
    pauseRef.current = { paused: false, waiters: [] }
    setPaused(false)

    const video = videoRef.current
    // Keep the existing 50 ms merge window independent of sampling density.
    const collector = new RelicCollector({ intervalSec: SCAN_INTERVAL_SEC })

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
      inflight < maxInflight ? Promise.resolve() : new Promise((resolve) => (slotWaiter = resolve))

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
          frameMatch = matchFrameText(text, language)
          lastText = text
          lastFrameMatch = frameMatch
        }

        setLastText(text.trim() || '(no text detected)')
        setFramesSeen((n) => n + 1)
        if (record.dup) setFramesSkipped((n) => n + 1)
        collector.addFrame(frameMatch, record.timeSec, record.image)
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

      // Download failures must reach the Retry UI instead of silently
      // producing an empty scan for every frame.
      setStartupStatus(getLanguage(language).loadingMessage ?? 'Loading OCR…')
      const [ocr, timing] = await Promise.all([
        prepareOcr(language), detectScanTiming(videoFile),
      ])
      maxInflight = ocr.maxInflight
      setSamplingFps(1 / timing.intervalSec)
      setStartupStatus('Reading first video frame…')

      for await (const frame of walkVideoFrames(video, box, {
        ...timing,
        upscale: UPSCALE,
        startTime,
        endTime: endTime ?? undefined,
        shouldStop: () => stopRef.current,
        waitIfPaused,
      })) {
        if (!frame.duplicateOfPrev) showPreview(frame.blob)

        const record = {
          timeSec: frame.timeSec,
          fraction: frame.fraction,
          dup: frame.duplicateOfPrev,
          text: '',
          done: false,
          image: frame.blob,
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
        ocr.recognize(frame.blob)
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
        OCR, and match each line against the Relics.pro compendium of behaviors.
        {' '}Game text language: {getLanguage(language).label}.
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
            {samplingFps !== null && <span>{Number(samplingFps.toFixed(2))} frames/s sampling</span>}
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
                <span className="frame-preview-placeholder" role="status">{startupStatus}</span>
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
