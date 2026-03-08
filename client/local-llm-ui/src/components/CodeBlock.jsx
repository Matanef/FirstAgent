// D:\local-llm-ui\client\local-llm-ui\src\components\CodeBlock.jsx

import React from 'react';

function getLanguageDisplay(language) {
  return language;
}

function getCopyText(code) {
  return code;
}

export default function CodeBlock({ code, language = "javascript" }) {
  const copyText = getCopyText(code);

  return (
    <div className="code-block-container">
      <div className="code-block-header">
        <span className="language-display">{getLanguageDisplay(language)}</span>
        <button
          className="copy-btn"
          onClick={() => navigator.clipboard.writeText(copyText)}
        >
          📋 Copy
        </button>
      </div>
      <pre className="code-block">
        <code>{code}</code>
      </pre>
    </div>
  );
}