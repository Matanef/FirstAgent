import React from "react";
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vsDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

export default function CodeField({ code, language = "javascript", filename = "code.txt" }) {
  const download = async () => {
    try {
      // Try File System Access API
      if (window.showSaveFilePicker) {
        const opts = {
          suggestedName: filename,
          types: [{
            description: 'Code file',
            accept: { 'text/plain': [`.${filename.split('.').pop()}`] }
          }]
        };
        const handle = await window.showSaveFilePicker(opts);
        const writable = await handle.createWritable();
        await writable.write(code);
        await writable.close();
        return;
      }
    } catch (e) {
      console.warn("FS API failed, using fallback");
    }

    // Fallback: Blob download
    const blob = new Blob([code], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="code-field">
      <div className="code-toolbar">
        <span className="code-filename">{filename}</span>
        <button onClick={download} className="code-download-btn">
          📥 Download
        </button>
      </div>
      <SyntaxHighlighter 
        language={language} 
        style={vsDark}
        showLineNumbers={true}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}