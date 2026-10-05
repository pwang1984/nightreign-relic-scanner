import { useEffect, useState } from 'react'
import UploadStep from './components/UploadStep.jsx'
import RegionSelectStep from './components/RegionSelectStep.jsx'
import AnalyzeStep from './components/AnalyzeStep.jsx'
import ResultsStep from './components/ResultsStep.jsx'
import StepIndicator from './components/StepIndicator.jsx'
import { LANGUAGES } from './lib/languages.js'
import './App.css'

const STEP = { UPLOAD: 0, REGION: 1, ANALYZE: 2, RESULTS: 3 }

// Where the relic behavior panel sits in most players' capture setups —
// pre-fills the region box so it's ready to confirm (or nudge) rather than
// drawn from scratch every time.
const DEFAULT_BOX = { x: 0.556675, y: 0.708158, w: 0.395466, h: 0.214945 }

export default function App() {
  const [step, setStep] = useState(STEP.UPLOAD)
  const [videoFile, setVideoFile] = useState(null)
  const [box, setBox] = useState(DEFAULT_BOX)
  const [startTime, setStartTime] = useState(0)
  const [endTime, setEndTime] = useState(null) // null = until the end of the video
  const [relics, setRelics] = useState([])
  const [videoUrl, setVideoUrl] = useState(null)
  const [language, setLanguage] = useState('en')

  // Recreate the object URL whenever the file itself changes, and revoke
  // only the URL this effect run created (not tied to a memoized value) so
  // React StrictMode's dev-mode double-invoke of effects can't revoke a URL
  // that's still in use.
  useEffect(() => {
    if (!videoFile) {
      setVideoUrl(null)
      return
    }
    const url = URL.createObjectURL(videoFile)
    setVideoUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [videoFile])

  function startOver() {
    setVideoFile(null)
    setBox(DEFAULT_BOX)
    setStartTime(0)
    setEndTime(null)
    setRelics([])
    setStep(STEP.UPLOAD)
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Nightreign Relic Scanner</h1>
        <p>Turn gameplay footage of your relic inventory into a clean, exportable list.</p>
      </header>

      <StepIndicator activeIndex={step} />

      <main className="app-main">
        {(step === STEP.UPLOAD || step === STEP.REGION) && (
          <div className="language-picker">
            <label htmlFor="game-language">Game text language</label>
            <select id="game-language" value={language} onChange={(event) => setLanguage(event.target.value)}>
              {Object.entries(LANGUAGES).map(([value, { label }]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
        )}
        {step === STEP.UPLOAD && (
          <UploadStep
            onVideoSelected={(file) => {
              setVideoFile(file)
              setStep(STEP.REGION)
            }}
          />
        )}

        {step === STEP.REGION && (
          <RegionSelectStep
            videoUrl={videoUrl}
            initialBox={box}
            initialStartTime={startTime}
            initialEndTime={endTime}
            onBack={() => setStep(STEP.UPLOAD)}
            onConfirm={({ box: chosenBox, startTime: chosenStart, endTime: chosenEnd }) => {
              setBox(chosenBox)
              setStartTime(chosenStart)
              setEndTime(chosenEnd)
              setStep(STEP.ANALYZE)
            }}
          />
        )}

        {step === STEP.ANALYZE && (
          <AnalyzeStep
            videoUrl={videoUrl}
            videoFile={videoFile}
            language={language}
            box={box}
            startTime={startTime}
            endTime={endTime}
            onBack={() => setStep(STEP.REGION)}
            onComplete={(foundRelics) => {
              setRelics(foundRelics)
              setStep(STEP.RESULTS)
            }}
          />
        )}

        {step === STEP.RESULTS && (
          <ResultsStep relics={relics} language={language} onChange={setRelics} onStartOver={startOver} />
        )}
      </main>
    </div>
  )
}
