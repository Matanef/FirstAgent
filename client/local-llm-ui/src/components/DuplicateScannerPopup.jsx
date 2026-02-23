// client/local-llm-ui/src/components/DuplicateScannerPopup.jsx
// Popup UI for configuring and triggering duplicate file scans

import { useState } from "react";

const API_URL = "http://localhost:3000";

const FILE_TYPES = [
    { value: "", label: "All types" },
    { value: ".txt", label: ".txt — Text" },
    { value: ".js", label: ".js — JavaScript" },
    { value: ".jsx", label: ".jsx — React JSX" },
    { value: ".ts", label: ".ts — TypeScript" },
    { value: ".tsx", label: ".tsx — React TSX" },
    { value: ".json", label: ".json — JSON" },
    { value: ".css", label: ".css — CSS" },
    { value: ".md", label: ".md — Markdown" },
    { value: ".py", label: ".py — Python" },
    { value: ".html", label: ".html — HTML" },
    { value: ".xml", label: ".xml — XML" },
    { value: ".csv", label: ".csv — CSV" },
    { value: ".pdf", label: ".pdf — PDF" },
    { value: ".png", label: ".png — PNG Image" },
    { value: ".jpg", label: ".jpg — JPEG Image" },
];

export default function DuplicateScannerPopup({ onClose, onResults }) {
    const [name, setName] = useState("");
    const [scanPath, setScanPath] = useState("");
    const [fileType, setFileType] = useState("");
    const [scanning, setScanning] = useState(false);
    const [progress, setProgress] = useState(0);
    const [phase, setPhase] = useState("");
    const [scanId, setScanId] = useState(null);

    const hasFilter = name.trim() || scanPath.trim() || fileType;

    async function startScan() {
        if (!hasFilter) return;
        setScanning(true);
        setProgress(0);
        setPhase("Initializing...");

        try {
            const body = {};
            if (scanPath.trim()) body.path = scanPath.trim();
            if (name.trim()) body.name = name.trim();
            if (fileType) body.type = fileType;

            const response = await fetch(`${API_URL}/api/scan-duplicates`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split("\n");

                for (const line of lines) {
                    if (!line.startsWith("data: ")) continue;
                    try {
                        const data = JSON.parse(line.slice(6));

                        if (data.type === "start") {
                            setScanId(data.scanId);
                            setPhase("Scanning files...");
                        } else if (data.type === "progress") {
                            setPhase(data.phase || "Scanning...");
                            if (data.scanned && data.total) {
                                setProgress(Math.round((data.scanned / data.total) * 100));
                            } else {
                                setProgress(prev => Math.min(prev + 5, 90));
                            }
                        } else if (data.type === "done") {
                            setProgress(100);
                            setPhase("Complete");
                            if (onResults) onResults(data);
                            setTimeout(() => onClose(), 500);
                        } else if (data.type === "error") {
                            setPhase(`Error: ${data.error}`);
                        }
                    } catch { /* skip unparseable lines */ }
                }
            }
        } catch (err) {
            setPhase(`Error: ${err.message}`);
        } finally {
            setScanning(false);
        }
    }

    async function cancelScan() {
        if (scanId) {
            try {
                await fetch(`${API_URL}/api/scan-duplicates/cancel`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ scanId })
                });
            } catch { /* ignore */ }
        }
        setScanning(false);
        setPhase("Cancelled");
    }

    return (
        <div className="duplicate-scanner-popup">
            <div className="scanner-popup-header">
                <span className="scanner-popup-title">{"\u{1F50D}"} Duplicate File Scanner</span>
                <button className="scanner-popup-close" onClick={onClose}>&times;</button>
            </div>

            <div className="scanner-popup-body">
                <div className="scanner-field">
                    <label>File Name <span className="optional">(optional)</span></label>
                    <input
                        type="text"
                        value={name}
                        onChange={e => setName(e.target.value)}
                        placeholder="e.g. config"
                        disabled={scanning}
                    />
                </div>

                <div className="scanner-field">
                    <label>Scan Path <span className="optional">(optional)</span></label>
                    <input
                        type="text"
                        value={scanPath}
                        onChange={e => setScanPath(e.target.value)}
                        placeholder="e.g. client/local-llm-ui/src"
                        disabled={scanning}
                    />
                </div>

                <div className="scanner-field">
                    <label>File Type <span className="optional">(optional)</span></label>
                    <select
                        value={fileType}
                        onChange={e => setFileType(e.target.value)}
                        disabled={scanning}
                    >
                        {FILE_TYPES.map(t => (
                            <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                    </select>
                </div>

                {!scanning ? (
                    <button
                        className="scanner-scan-btn"
                        onClick={startScan}
                        disabled={!hasFilter}
                    >
                        {"\u{1F50E}"} Scan for Duplicates
                    </button>
                ) : (
                    <div className="scanner-progress-area">
                        <div className="scan-progress-bar">
                            <div
                                className="scan-progress-fill"
                                style={{ width: `${progress}%` }}
                            />
                        </div>
                        <div className="scan-progress-info">
                            <span className="scan-phase">{phase}</span>
                            <span className="scan-pct">{progress}%</span>
                        </div>
                        <button className="scanner-cancel-btn" onClick={cancelScan}>
                            Cancel
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
