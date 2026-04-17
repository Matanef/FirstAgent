// D:\local-llm-ui\client\local-llm-ui\src\components\CodeBlock.jsx
// Syntax-highlighted code block with copy button and line numbers.
// Uses react-syntax-highlighter (Prism engine) with the VS Dark theme — same
// highlighter/stack as CodeField.jsx so chat code blocks and standalone code
// widgets look identical.

import React, { useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";

// Map common extension/alias inputs to Prism language IDs.
// The codeRag tool always tags blocks as "javascript" regardless of actual file type,
// so we also probe the extension when a filename-like hint arrives later.
const LANG_ALIASES = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  py: "python",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  "": "text",
};

function normalizeLanguage(lang) {
  if (!lang) return "text";
  const key = String(lang).toLowerCase().trim();
  return LANG_ALIASES[key] || key;
}

export default function CodeBlock({ code, language = "javascript" }) {
  const [copied, setCopied] = useState(false);
  const normalized = normalizeLanguage(language);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard permission denied — no-op.
    }
  };

  return (
    <div className="code-block-container">
      <div className="code-block-header">
        <span className="language-display">{normalized}</span>
        <button className="copy-btn" onClick={handleCopy}>
          {copied ? "✅ Copied" : "📋 Copy"}
        </button>
      </div>
      <SyntaxHighlighter
        language={normalized}
        style={vscDarkPlus}
        showLineNumbers={true}
        wrapLongLines={false}
        customStyle={{
          margin: 0,
          borderRadius: "0 0 6px 6px",
          fontSize: "0.85rem",
          lineHeight: "1.45",
        }}
        codeTagProps={{
          style: { fontFamily: "Consolas, 'Courier New', monospace" },
        }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}
