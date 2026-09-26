import { useCallback, useState } from 'react'

export default function UploadStep({ onVideoSelected }) {
  const [dragActive, setDragActive] = useState(false)
  const [error, setError] = useState(null)

  const handleFile = useCallback(
    (file) => {
      if (!file) return
      if (!file.type.startsWith('video/')) {
        setError('That file does not look like a video. Please choose a video file.')
        return
      }
      setError(null)
      onVideoSelected(file)
    },
    [onVideoSelected],
  )

  return (
    <div className="step-panel">
      <h2>1. Upload a video</h2>
      <p className="step-hint">
        Upload gameplay footage of you scrolling through your relic inventory. In the next step
        you'll draw a box around the part of the screen that shows each relic's behaviors.
      </p>
      <p className="step-hint">
        Your video never leaves your device — everything from reading the footage to matching
        behaviors happens right here in your browser, so nothing is ever uploaded to a server.
      </p>
      {/* Collapsed by default: most returning users already have a clip and
          shouldn't have to scroll past a wall of console instructions. */}
      <details className="help-details">
        <summary className="help-summary">
          How do I record my relics on PlayStation or Xbox?
        </summary>
        <div className="help-body">
          <p>
            Any screen recording works — you just need footage that scrolls through your relic
            inventory with each relic's behaviors visible on screen.
          </p>

          <h3>PlayStation 5</h3>
          <ol>
            <li>Open your relic inventory in-game.</li>
            <li>
              Press the <strong>Create</strong> button (left of the touchpad) and choose{' '}
              <strong>Start New Recording</strong>.
            </li>
            <li>
              Scroll through your relics at full speed without stopping.
            </li>
            <li>
              Press <strong>Create</strong> again and choose <strong>Stop Recording</strong>.
            </li>
            <li>
              Open <strong>Media Gallery</strong> (Game Library → Media Gallery) and select your
              clip.
            </li>
            <li>
              To get it onto this device: plug in a USB drive and choose{' '}
              <strong>Copy to USB drive</strong>, or share the clip to the PlayStation App on your
              phone.
            </li>
          </ol>

          <h3>PlayStation 4</h3>
          <ol>
            <li>
              Press <strong>Share</strong>, then <strong>Save Video Clip</strong> to save what just
              happened — or double-tap <strong>Share</strong> to start recording forward, and press
              it again to stop.
            </li>
            <li>
              Find the clip in <strong>Capture Gallery</strong> and copy it to a USB drive.
            </li>
          </ol>

          <h3>Xbox Series X|S</h3>
          <ol>
            <li>Open your relic inventory in-game.</li>
            <li>
              Press the <strong>Xbox</strong> button, choose <strong>Capture &amp; share</strong>,
              then <strong>Start recording</strong>.
            </li>
            <li>Scroll through your relics at full speed without stopping.</li>
            <li>
              Press the <strong>Xbox</strong> button again and choose{' '}
              <strong>Stop recording</strong>.
            </li>
            <li>
              Recordings to internal storage are capped at a few minutes. Plug in an external USB
              drive first if your relic list is long.
            </li>
            <li>
              Open <strong>Capture &amp; share → Recent captures</strong>, pick your clip, and
              upload it to the Xbox network — then download it from the Xbox app on your phone or
              from xbox.com. You can also copy it straight to a USB drive.
            </li>
          </ol>

          <h3>Tips for a clean scan</h3>
          <ul>
            <li>Scroll through your relics at full speed without stopping. As long as the relic's text is in screen for a full frame it should be captured correctly.</li>
            <li>Keep the behaviors text fully on screen and unobstructed by menus or popups.</li>
            <li>1080p is more than enough; higher resolutions just make a bigger file.</li>
            <li>Mute notifications so nothing covers the text mid-scroll.</li>
          </ul>
        </div>
      </details>

      <label
        className={`dropzone ${dragActive ? 'dropzone--active' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragActive(true)
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragActive(false)
          handleFile(e.dataTransfer.files?.[0])
        }}
      >
        <input
          type="file"
          accept="video/*"
          onChange={(e) => handleFile(e.target.files?.[0])}
          hidden
        />
        <span className="dropzone-icon">🎬</span>
        <span>Drag & drop a video, or click to browse</span>
      </label>
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}
