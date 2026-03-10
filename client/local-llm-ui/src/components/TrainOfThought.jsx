// client/local-llm-ui/src/components/TrainOfThought.jsx
// Renders the agent's internal reasoning chain as a vertical timeline.
// Phases: THOUGHT → PLAN → EXECUTION → OBSERVATION → ANSWER

import { useState } from "react";

const PHASE_CONFIG = {
  THOUGHT:     { icon: "\uD83E\uDDE0", label: "Thought",     color: "#a78bfa" },
  PLAN:        { icon: "\uD83D\uDCCB", label: "Plan",        color: "#60a5fa" },
  EXECUTION:   { icon: "\u2699\uFE0F", label: "Action",      color: "#fbbf24" },
  OBSERVATION: { icon: "\uD83D\uDD0D", label: "Observation", color: "#34d399" },
  ANSWER:      { icon: "\u2728",       label: "Answer",      color: "#f472b6" },
};

export default function TrainOfThought({ thoughts, isStreaming }) {
  const [expanded, setExpanded] = useState(true);

  if (!thoughts || thoughts.length === 0) return null;

  return (
    <div className="tot-container">
      <button
        className="tot-toggle"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="tot-toggle-icon">{expanded ? "\u25BC" : "\u25B6"}</span>
        <span className="tot-toggle-label">Train of Thought</span>
        <span className="tot-step-count">{thoughts.length} steps</span>
        {isStreaming && <span className="tot-streaming-dot" />}
      </button>

      {expanded && (
        <div className="tot-chain">
          {thoughts.map((t, i) => {
            const config = PHASE_CONFIG[t.phase] || PHASE_CONFIG.THOUGHT;
            const isLatest = i === thoughts.length - 1 && isStreaming;

            return (
              <div
                key={i}
                className={`tot-step${isLatest ? " tot-step-active" : ""}`}
                style={{ "--phase-color": config.color }}
              >
                <div className="tot-step-connector">
                  <div className="tot-step-dot" />
                  {i < thoughts.length - 1 && <div className="tot-step-line" />}
                </div>
                <div className="tot-step-content">
                  <div className="tot-step-header">
                    <span className="tot-step-icon">{config.icon}</span>
                    <span className="tot-step-label">{config.label}</span>
                  </div>
                  <div className="tot-step-text">{t.content}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
