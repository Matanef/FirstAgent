// client/local-llm-ui/src/components/FileReviewPanel.jsx
// Renders file review results: LLM summary text + collapsible file cards with "Show full file"

import { useState } from "react";

const API_URL = "http://localhost:3000";

const FILE_ICONS = {
    js: "\u{1F4DC}", jsx: "\u{1F4DC}", ts: "\u{1F4DC}", tsx: "\u{1F4DC}",
    py: "\u{1F40D}", json: "\u{1F4CB}", csv: "\u{1F4CA}", xml: "\u{1F4CB}",
    md: "\u{1F4DD}", txt: "\u{1F4C4}", pdf: "\u{1F4D5}",
    html: "\u{1F310}", css: "\u{1F3A8}",
    png: "\u{1F5BC}", jpg: "\u{1F5BC}", jpeg: "\u{1F5BC}", gif: "\u{1F5BC}",
};

function getIcon(name) {
    const ext = name.split(".").pop().toLowerCase();
    return FILE_ICONS[ext] || "\u{1F4CE}";
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function FileCard({ file }) {
    const [expanded, setExpanded] = useState(false);
    const [fullContent, setFullContent] = useState(null);
    const [loading, setLoading] = useState(false);

    async function loadFull() {
        if (fullContent !== null) {
            setExpanded(!expanded);
            return;
        }
        setLoading(true);
        try {
            const res = await fetch(`${API_URL}/api/file-content/${encodeURIComponent(file.id)}`);
            const text = await res.text();
            setFullContent(text);
            setExpanded(true);
        } catch {
            setFullContent("[Failed to load file content]");
            setExpanded(true);
        } finally {
            setLoading(false);
        }
    }

    return (
        <div className="file-review-card">
            <div className="file-review-card-header">
                <span className="file-review-icon">{getIcon(file.name)}</span>
                <span className="file-review-name">{file.name}</span>
                <span className="file-review-size">{formatSize(file.size)}</span>
                <button
                    className="file-review-toggle"
                    onClick={loadFull}
                    disabled={loading}
                >
                    {loading ? "Loading..." : expanded ? "Hide file" : "Show full file"}
                </button>
            </div>
            {expanded && fullContent !== null && (
                <div className="file-content-viewer">
                    <pre>{fullContent}</pre>
                </div>
            )}
        </div>
    );
}

export default function FileReviewPanel({ content, data }) {
    const files = data?.files || [];

    return (
        <div className="file-review-panel">
            {/* LLM summary text */}
            <div className="message-text">{content}</div>

            {/* File cards */}
            {files.length > 0 && (
                <div className="file-review-cards">
                    {files.map(f => (
                        <FileCard key={f.id} file={f} />
                    ))}
                </div>
            )}
        </div>
    );
}
