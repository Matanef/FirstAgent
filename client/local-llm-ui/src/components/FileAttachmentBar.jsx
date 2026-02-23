// client/local-llm-ui/src/components/FileAttachmentBar.jsx
// Attachment bar: shows attached file chips with progress, removal, drag-and-drop

import { useRef } from "react";

const API_URL = "http://localhost:3000";

const MAX_FILES = 10;
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

const BLOCKED_EXTENSIONS = [".exe", ".bat", ".cmd", ".msi", ".dll", ".so", ".com", ".scr", ".pif"];
const SENSITIVE_PATTERNS = ["password", "secret", "credentials", ".env", "private_key", "id_rsa"];

const FILE_ICONS = {
    js: "\u{1F4DC}", jsx: "\u{1F4DC}", ts: "\u{1F4DC}", tsx: "\u{1F4DC}",
    py: "\u{1F40D}", sh: "\u{1F4DC}", bash: "\u{1F4DC}",
    json: "\u{1F4CB}", csv: "\u{1F4CA}", xml: "\u{1F4CB}", yaml: "\u{1F4CB}", yml: "\u{1F4CB}",
    md: "\u{1F4DD}", txt: "\u{1F4C4}", log: "\u{1F4C4}",
    html: "\u{1F310}", css: "\u{1F3A8}",
    pdf: "\u{1F4D5}", doc: "\u{1F4D8}", docx: "\u{1F4D8}",
    xls: "\u{1F4CA}", xlsx: "\u{1F4CA}",
    png: "\u{1F5BC}", jpg: "\u{1F5BC}", jpeg: "\u{1F5BC}", gif: "\u{1F5BC}", webp: "\u{1F5BC}", svg: "\u{1F5BC}",
    sql: "\u{1F5C4}", toml: "\u{2699}", ini: "\u{2699}", cfg: "\u{2699}", conf: "\u{2699}"
};

function getFileIcon(filename) {
    const ext = filename.split(".").pop().toLowerCase();
    return FILE_ICONS[ext] || "\u{1F4CE}";
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function getExtension(filename) {
    return (filename.lastIndexOf(".") !== -1 ? filename.slice(filename.lastIndexOf(".")).toLowerCase() : "");
}

export default function FileAttachmentBar({ files, setFiles, disabled }) {
    const inputRef = useRef(null);

    function isSensitive(filename) {
        const lower = filename.toLowerCase();
        return SENSITIVE_PATTERNS.some(p => lower.includes(p));
    }

    async function uploadFiles(fileList) {
        const toAdd = Array.from(fileList);

        // Enforce max count
        const currentCount = files.length;
        if (currentCount + toAdd.length > MAX_FILES) {
            alert(`Maximum ${MAX_FILES} files allowed. You have ${currentCount} already attached.`);
            return;
        }

        for (const file of toAdd) {
            const ext = getExtension(file.name);

            // Block executables
            if (BLOCKED_EXTENSIONS.includes(ext)) {
                alert(`Executable files (${ext}) are not allowed.`);
                continue;
            }

            // Size check
            if (file.size > MAX_SIZE) {
                alert(`${file.name} exceeds the 10MB size limit.`);
                continue;
            }

            // Sensitive file warning
            if (isSensitive(file.name)) {
                const proceed = confirm(
                    `"${file.name}" may contain sensitive data. Are you sure you want to upload it?`
                );
                if (!proceed) continue;
            }

            // Add as uploading
            const tempId = crypto.randomUUID();
            const entry = {
                tempId,
                name: file.name,
                size: file.size,
                status: "uploading",
                progress: 0,
                id: null,
                previewUrl: null
            };

            setFiles(prev => [...prev, entry]);

            // Upload via XHR for progress tracking
            const formData = new FormData();
            formData.append("files", file);

            const xhr = new XMLHttpRequest();
            xhr.open("POST", `${API_URL}/upload`);

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                    const pct = Math.round((e.loaded / e.total) * 100);
                    setFiles(prev => prev.map(f =>
                        f.tempId === tempId ? { ...f, progress: pct } : f
                    ));
                }
            };

            xhr.onload = () => {
                if (xhr.status === 200) {
                    try {
                        const result = JSON.parse(xhr.responseText);
                        const uploaded = result.files?.[0];
                        if (uploaded) {
                            setFiles(prev => prev.map(f =>
                                f.tempId === tempId
                                    ? { ...f, status: "uploaded", progress: 100, id: uploaded.id, previewUrl: uploaded.previewUrl }
                                    : f
                            ));
                        }
                    } catch {
                        setFiles(prev => prev.map(f =>
                            f.tempId === tempId ? { ...f, status: "error", progress: 0 } : f
                        ));
                    }
                } else {
                    setFiles(prev => prev.map(f =>
                        f.tempId === tempId ? { ...f, status: "error", progress: 0 } : f
                    ));
                }
            };

            xhr.onerror = () => {
                setFiles(prev => prev.map(f =>
                    f.tempId === tempId ? { ...f, status: "error", progress: 0 } : f
                ));
            };

            xhr.send(formData);
        }
    }

    function removeFile(tempId) {
        setFiles(prev => prev.filter(f => f.tempId !== tempId));
    }

    function handleDragOver(e) {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.classList.add("drag-active");
    }

    function handleDragLeave(e) {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.classList.remove("drag-active");
    }

    function handleDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.classList.remove("drag-active");
        if (e.dataTransfer.files.length > 0) {
            uploadFiles(e.dataTransfer.files);
        }
    }

    function handleBrowse() {
        inputRef.current?.click();
    }

    function handleInputChange(e) {
        if (e.target.files.length > 0) {
            uploadFiles(e.target.files);
            e.target.value = "";
        }
    }

    const hasFiles = files.length > 0;

    return (
        <div
            className={`attachment-drop-zone ${disabled ? "disabled" : ""}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            {hasFiles && (
                <div className="attachment-bar">
                    {files.map(f => (
                        <div
                            key={f.tempId}
                            className={`file-chip ${f.status}`}
                            title={`${f.name} (${formatSize(f.size)})`}
                        >
                            <span className="file-chip-icon">{getFileIcon(f.name)}</span>
                            <span className="file-chip-name">
                                {f.name.length > 20 ? f.name.slice(0, 17) + "..." : f.name}
                            </span>
                            {f.status === "uploading" && (
                                <span className="file-chip-progress">{f.progress}%</span>
                            )}
                            {f.status === "error" && (
                                <span className="file-chip-error" title="Upload failed">!</span>
                            )}
                            <button
                                className="file-chip-remove"
                                onClick={() => removeFile(f.tempId)}
                                title="Remove"
                                disabled={disabled}
                            >
                                &times;
                            </button>
                        </div>
                    ))}
                </div>
            )}

            <input
                ref={inputRef}
                type="file"
                multiple
                onChange={handleInputChange}
                style={{ display: "none" }}
            />

            <button
                className="attach-btn"
                onClick={handleBrowse}
                disabled={disabled || files.length >= MAX_FILES}
                title={files.length >= MAX_FILES ? `Max ${MAX_FILES} files` : "Attach files"}
            >
                {"\u{1F4CE}"}
            </button>
        </div>
    );
}
