// client/local-llm-ui/src/components/DepthBar.jsx
// 4-button depth selector for the deepResearch skill.
// Inserts a `[depth:tier]` prefix into the input field; the backend tierDetector
// treats this inline flag as the highest-priority signal after a pending-question resume.

import { useState } from "react";

const TIERS = [
  { key: "article",     label: "Article",     hint: "~1500w · 3 prompts" },
  { key: "indepth",     label: "In-Depth",    hint: "~2200w · 4 prompts" },
  { key: "research",    label: "Research",    hint: "~3500w · 4 prompts (academic)" },
  { key: "thesis",      label: "Thesis",      hint: "~5500w · 8 prompts (full)" },
  // Phase 23D — Thesis-Deep is gated on Thesis being selected first. The
  // supplementary open-questions recursion only makes sense as a layer on
  // top of the full thesis pipeline; rendering it as a peer-level button
  // (its predecessor state) misled users into thinking it was a wholly
  // separate tier. Click "Thesis" first to enable it.
  { key: "thesis-deep", label: "Thesis-Deep", hint: "Thesis + open-questions recursion (~30 min total)", requires: "thesis" }
];

export default function DepthBar({ input, setInput, disabled }) {
  const [active, setActive] = useState(null);

  function isGated(t) {
    // A tier with a `requires` is only clickable when the user has already
    // activated that prerequisite tier (or has already activated this one).
    if (!t.requires) return false;
    if (active === t.key) return false;
    return active !== t.requires;
  }

  function prepend(tier) {
    if (disabled) return;
    const def = TIERS.find(t => t.key === tier);
    if (def && isGated(def)) return;   // ignore clicks on gated tiers
    const flag = `[depth:${tier}] `;
    // Strip any existing flag, then prepend the new one.
    const cleaned = (input || "").replace(/^\s*\[depth:[^\]]+\]\s*/i, "");
    setInput(flag + cleaned);
    setActive(tier);
  }

  return (
    <div
      className="depth-bar"
      style={{
        display: "flex",
        gap: "6px",
        padding: "4px 8px",
        flexWrap: "wrap",
        alignItems: "center",
        fontSize: "0.78rem",
        opacity: disabled ? 0.5 : 1
      }}
    >
      <span style={{ marginRight: "4px", color: "#888" }}>Depth:</span>
      {TIERS.map(t => {
        const gated = isGated(t);
        const baseOpacity = gated ? 0.35 : 1;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => prepend(t.key)}
            disabled={disabled || gated}
            title={gated ? `${t.hint} — click "Thesis" first to enable` : t.hint}
            style={{
              padding: "3px 10px",
              borderRadius: "12px",
              border: "1px solid",
              borderColor: active === t.key ? "#5b8def" : "#444",
              background: active === t.key ? "rgba(91,141,239,0.18)" : "transparent",
              color: active === t.key ? "#9bb8ff" : "#bbb",
              cursor: (disabled || gated) ? "not-allowed" : "pointer",
              opacity: baseOpacity,
              fontSize: "inherit",
              transition: "all 0.15s ease"
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
