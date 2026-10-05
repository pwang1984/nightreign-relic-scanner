import { useEffect, useRef, useState } from 'react'

// Hit tolerance around a corner handle, in CSS px. A fingertip lands far less
// precisely than a cursor and covers the handle it is aiming for, so touch and
// pen get a much larger target than the handle's drawn size.
const MOUSE_HANDLE_HIT = 12
const TOUCH_HANDLE_HIT = 28

// A drag shorter than this in either axis is treated as a stray tap rather than
// a new box, so brushing the video doesn't wipe a box that was already drawn.
const MIN_BOX = 0.02

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v))
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

// Lets the user scrub to a representative frame and drag out a rectangle
// (with corner-resize + move) over the video. The box is stored normalized
// (0..1) against the *displayed* video area, which lines up 1:1 with the
// video's native pixel grid regardless of playback resolution. The same
// scrubber also sets the start/stop points the analysis step will sample
// between, so the user can pick both by eye without leaving this preview.
export default function RegionSelectStep({
  videoUrl,
  initialBox,
  initialStartTime,
  initialEndTime,
  onConfirm,
  onBack,
}) {
  const videoRef = useRef(null)
  const containerRef = useRef(null)
  const dragState = useRef(null)

  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [box, setBox] = useState(initialBox || null)
  const [startTime, setStartTime] = useState(initialStartTime ?? 0)
  const [endTime, setEndTime] = useState(initialEndTime ?? null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onLoaded = () => {
      setDuration(video.duration)
      video.currentTime = Math.min(1, video.duration / 2)
    }
    video.addEventListener('loadedmetadata', onLoaded)
    return () => video.removeEventListener('loadedmetadata', onLoaded)
  }, [])

  function getRelativePos(e) {
    const rect = containerRef.current.getBoundingClientRect()
    return {
      x: clamp((e.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((e.clientY - rect.top) / rect.height, 0, 1),
    }
  }

  // Returns the closest corner within the tolerance, not merely the first one
  // found: on a small box the touch-sized hit zones overlap, and the corner the
  // finger is nearest to is the one it was reaching for.
  function hitTestHandle(pos, tolerance) {
    if (!box) return null
    const rect = containerRef.current.getBoundingClientRect()
    const handles = {
      nw: { x: box.x, y: box.y },
      ne: { x: box.x + box.w, y: box.y },
      sw: { x: box.x, y: box.y + box.h },
      se: { x: box.x + box.w, y: box.y + box.h },
    }
    let best = null
    let bestDist = Infinity
    for (const [name, p] of Object.entries(handles)) {
      const dx = (pos.x - p.x) * rect.width
      const dy = (pos.y - p.y) * rect.height
      if (Math.abs(dx) > tolerance || Math.abs(dy) > tolerance) continue
      const dist = dx * dx + dy * dy
      if (dist < bestDist) {
        bestDist = dist
        best = name
      }
    }
    return best
  }

  function isInsideBox(pos) {
    if (!box) return false
    return pos.x >= box.x && pos.x <= box.x + box.w && pos.y >= box.y && pos.y <= box.y + box.h
  }

  function handlePointerDown(e) {
    // A second finger landing mid-drag (or the start of a pinch) would otherwise
    // yank the box to the new contact point; the first pointer keeps the drag.
    if (dragState.current) return
    // Suppresses the browser's own touch behaviours -- text selection, the
    // long-press callout, and the synthetic mouse events that would re-enter
    // these handlers a second time.
    e.preventDefault()

    const pos = getRelativePos(e)
    const tolerance = e.pointerType === 'mouse' ? MOUSE_HANDLE_HIT : TOUCH_HANDLE_HIT
    const handle = hitTestHandle(pos, tolerance)

    if (handle) {
      dragState.current = { mode: 'resize', handle, start: pos, startBox: box }
    } else if (isInsideBox(pos)) {
      dragState.current = { mode: 'move', start: pos, startBox: box }
    } else {
      // The box isn't replaced until the pointer actually moves, so a tap on the
      // video leaves the current selection alone instead of flashing it away.
      dragState.current = { mode: 'draw', start: pos, prevBox: box }
    }
    dragState.current.pointerId = e.pointerId

    // Capture keeps the drag alive past the edge of the video and guarantees a
    // matching pointerup, which mouseleave-based cancelling never did.
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function handlePointerMove(e) {
    const drag = dragState.current
    if (!drag || e.pointerId !== drag.pointerId) return
    const pos = getRelativePos(e)
    const { mode, start, startBox, handle } = drag

    if (mode === 'draw') {
      const x = Math.min(start.x, pos.x)
      const y = Math.min(start.y, pos.y)
      const w = Math.abs(pos.x - start.x)
      const h = Math.abs(pos.y - start.y)
      setBox({ x, y, w, h })
    } else if (mode === 'move') {
      const dx = pos.x - start.x
      const dy = pos.y - start.y
      const x = clamp(startBox.x + dx, 0, 1 - startBox.w)
      const y = clamp(startBox.y + dy, 0, 1 - startBox.h)
      setBox({ ...startBox, x, y })
    } else if (mode === 'resize') {
      let { x, y, w, h } = startBox
      const x2 = startBox.x + startBox.w
      const y2 = startBox.y + startBox.h
      if (handle.includes('w')) {
        x = clamp(pos.x, 0, x2 - 0.01)
        w = x2 - x
      }
      if (handle.includes('e')) {
        w = clamp(pos.x - startBox.x, 0.01, 1 - startBox.x)
      }
      if (handle.includes('n')) {
        y = clamp(pos.y, 0, y2 - 0.01)
        h = y2 - y
      }
      if (handle.includes('s')) {
        h = clamp(pos.y - startBox.y, 0.01, 1 - startBox.y)
      }
      setBox({ x, y, w, h })
    }
  }

  function handlePointerUp(e) {
    const drag = dragState.current
    if (!drag || e.pointerId !== drag.pointerId) return
    dragState.current = null

    if (drag.mode === 'draw') {
      setBox((current) =>
        current && current.w >= MIN_BOX && current.h >= MIN_BOX ? current : drag.prevBox,
      )
    }
  }

  function setStartHere() {
    const t = currentTime
    // pulling start past the current stop point leaves nothing to sample —
    // open the stop back up rather than allow an inverted range
    if (endTime != null && t >= endTime) setEndTime(null)
    setStartTime(t)
  }

  function setStopHere() {
    const t = currentTime
    if (t <= startTime) setStartTime(0)
    setEndTime(t)
  }

  function resetTrimRange() {
    setStartTime(0)
    setEndTime(null)
  }

  const boxIsValid = box && box.w >= MIN_BOX && box.h >= MIN_BOX
  const trimIsCustom = startTime > 0 || endTime != null

  return (
    <div className="step-panel">
      <h2>2. Draw a box over the area to analyze</h2>
      <p className="step-hint">
        Scrub to a frame where a relic's name and behaviors are visible, then drag across the video
        to draw a box around all of that text. Include the name above the effects to identify the
        relic and its color. Drag inside the box to move it, or drag a corner to resize.
        This same region will be sampled across the whole video. You can also scrub to where your
        relic list starts and ends and set those as the trim points, so only that part of the
        video gets analyzed.
      </p>

      <div
        className="video-stage"
        ref={containerRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <video
          ref={videoRef}
          src={videoUrl}
          className="video-el"
          preload="auto"
          muted
          playsInline
        />
        {box && (
          <div
            className="select-box"
            style={{
              left: `${box.x * 100}%`,
              top: `${box.y * 100}%`,
              width: `${box.w * 100}%`,
              height: `${box.h * 100}%`,
            }}
          >
            <span className="select-handle select-handle--nw" />
            <span className="select-handle select-handle--ne" />
            <span className="select-handle select-handle--sw" />
            <span className="select-handle select-handle--se" />
          </div>
        )}
      </div>

      <input
        type="range"
        className="scrubber"
        min={0}
        max={duration || 0}
        step={0.01}
        value={currentTime}
        onChange={(e) => {
          const t = Number(e.target.value)
          setCurrentTime(t)
          if (videoRef.current) videoRef.current.currentTime = t
        }}
      />

      <div className="trim-controls">
        <div className="trim-readout">
          <span>
            Start: <strong>{formatTime(startTime)}</strong>
          </span>
          <span>
            Stop: <strong>{endTime != null ? formatTime(endTime) : 'end of video'}</strong>
          </span>
        </div>
        <div className="trim-buttons">
          <button type="button" className="btn btn--secondary" onClick={setStartHere}>
            Set start here
          </button>
          <button type="button" className="btn btn--secondary" onClick={setStopHere}>
            Set stop here
          </button>
          {trimIsCustom && (
            <button type="button" className="btn btn--ghost" onClick={resetTrimRange}>
              Reset to full video
            </button>
          )}
        </div>
      </div>

      <div className="step-actions">
        <button className="btn btn--ghost" onClick={onBack}>
          Back
        </button>
        <button
          className="btn btn--primary"
          disabled={!boxIsValid}
          onClick={() => onConfirm({ box, startTime, endTime })}
        >
          Start scanning
        </button>
      </div>
    </div>
  )
}
