const STEPS = ['Upload', 'Prepare', 'Match', 'Review']

export default function StepIndicator({ activeIndex }) {
  return (
    <ol className="step-indicator">
      {STEPS.map((label, i) => (
        <li
          key={label}
          className={`step-indicator-item ${i === activeIndex ? 'is-active' : ''} ${
            i < activeIndex ? 'is-done' : ''
          }`}
        >
          <span className="step-indicator-dot">{i + 1}</span>
          <span>{label}</span>
        </li>
      ))}
    </ol>
  )
}
