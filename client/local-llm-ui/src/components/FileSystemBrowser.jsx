// client/local-llm-ui/src/components/FileSystemBrowser.jsx
import { useState } from "react";

const API_URL = "http://localhost:3000";

export default function FileSystemBrowser({ data, conversationId }) {
    const [selectedFiles, setSelectedFiles] = useState(new Set());
    const [compiling, setCompiling] = useState(false);

    if (!data || !data.items) return null;

    const handleCheckbox = (filename) => {
        const newSelected = new Set(selectedFiles);
        if (newSelected.has(filename)) {
            newSelected.delete(filename);
        } else {
            newSelected.add(filename);
        }
        setSelectedFiles(newSelected);
    };

    const handleCompile = async () => {
        if (selectedFiles.size === 0) return;

        setCompiling(true);
        try {
            // Build full relative paths by prepending the browsed directory
            const dirPath = data.path || "";
            const fullPaths = Array.from(selectedFiles).map(name =>
                dirPath && dirPath !== "root" && dirPath !== "."
                    ? `${dirPath}/${name}`
                    : name
            );

            const res = await fetch(`${API_URL}/compile-files`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    files: fullPaths,
                    conversationId
                })
            });

            const result = await res.json();
            if (result.success) {
                alert(`✅ Compiled ${result.filesCompiled} files to bigFile.txt`);
                setSelectedFiles(new Set());
            } else {
                alert(`❌ Compilation failed: ${result.error}`);
            }
        } catch (err) {
            alert(`❌ Compilation error: ${err.message}`);
        } finally {
            setCompiling(false);
        }
    };

    return (
        <div className="file-browser">
            <div className="file-browser-header">
                <span>📂 {data.path || "Directory"}</span>
                <div className="header-right">
                    <span className="file-count">{data.items.length} items</span>
                    {selectedFiles.size > 0 && (
                        <span className="selected-count">{selectedFiles.size} selected</span>
                    )}
                </div>
            </div>

            <div className="file-list">
                {data.items.map((item, i) => (
                    <div key={i} className="file-item">
                        <input
                            type="checkbox"
                            className="file-checkbox"
                            checked={selectedFiles.has(item.name)}
                            onChange={(e) => {
                                e.stopPropagation();
                                handleCheckbox(item.name);
                            }}
                            onClick={(e) => e.stopPropagation()}
                            disabled={item.type === 'folder'}
                        />
                        <span className="file-icon">{item.icon || (item.type === 'folder' ? '📁' : '📄')}</span>
                        <span className="file-name">{item.name}</span>
                        <span className="file-type">{item.type}</span>
                        {item.sizeFormatted && <span className="file-size">{item.sizeFormatted}</span>}
                    </div>
                ))}
            </div>

            {selectedFiles.size > 0 && (
                <div className="file-actions">
                    <span className="file-actions-text">
                        {selectedFiles.size} file{selectedFiles.size > 1 ? 's' : ''} selected
                    </span>
                    <button
                        className="compile-btn"
                        onClick={handleCompile}
                        disabled={compiling}
                    >
                        {compiling ? "📦 Compiling..." : "📦 Compile Selected"}
                    </button>
                </div>
            )}
        </div>
    );
}
