import React from "react";
import CodeField from "./CodeField";

export default function ReviewPanel({ review }) {
  if (!review) return null;

  return (
    <div className="review-panel">
      <div className="review-header">
        <h3>📋 Code Review: {review.path}</h3>
      </div>

      <div className="review-summary">
        <h4>Summary</h4>
        <p>{review.summary}</p>
      </div>

      {review.snippets && review.snippets.length > 0 && (
        <div className="review-snippets">
          <h4>Important Code Sections</h4>
          {review.snippets.map((snippet, i) => (
            <div key={i} className="snippet-item">
              <p className="snippet-reason">
                <strong>Lines {snippet.lineStart}-{snippet.lineEnd}:</strong> {snippet.reason}
              </p>
              <CodeField
                code={snippet.code}
                language="javascript"
                filename={`snippet-${i + 1}.js`}
              />
            </div>
          ))}
        </div>
      )}

      {review.suggestions && review.suggestions.length > 0 && (
        <div className="review-suggestions">
          <h4>💡 Suggestions for Improvement</h4>
          <ul>
            {review.suggestions.map((suggestion, i) => (
              <li key={i}>{suggestion}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}