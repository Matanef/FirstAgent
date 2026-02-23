// client/local-llm-ui/src/components/DuplicateResultsPanel.jsx
// Renders duplicate scan results in a scrollable 700x500 panel inside chat messages

const API_URL = "http://localhost:3000";

const EXECUTABLE_EXTENSIONS = new Set([
    ".exe", ".bat", ".cmd", ".sh", ".bash", ".py", ".pl", ".rb",
    ".msi", ".dll", ".so", ".patch", ".com", ".scr", ".pif",
    ".ps1", ".vbs", ".wsf"
]);

const FILE_ICONS = {
    js: "\u{1F4DC}", jsx: "\u{1F4DC}", ts: "\u{1F4DC}", tsx: "\u{1F4DC}",
    py: "\u{1F40D}", json: "\u{1F4CB}", csv: "\u{1F4CA}", xml: "\u{1F4CB}",
    md: "\u{1F4DD}", txt: "\u{1F4C4}", pdf: "\u{1F4D5}",
    html: "\u{1F310}", css: "\u{1F3A8}",
    png: "\u{1F5BC}", jpg: "\u{1F5BC}", jpeg: "\u{1F5BC}",
    exe: "\u{26A0}", bat: "\u{26A0}", cmd: "\u{26A0}", msi: "\u{26A0}", dll: "\u{26A0}",
};

function getIcon(name) {
    const ext = name.split(".").pop().toLowerCase();
    return FILE_ICONS[ext] || "\u{1F4CE}";
}

function formatSize(bytes) {
    if (!bytes && bytes !== 0) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function formatDate(isoStr) {
    if (!isoStr) return "";
    try {
        return new Date(isoStr).toLocaleDateString(undefined, {
            month: "short", day: "numeric", year: "numeric"
        });
    } catch {
        return "";
    }
}

function getExtension(name) {
    const dot = name.lastIndexOf(".");
    return dot !== -1 ? name.slice(dot).toLowerCase() : "";
}

function getFolderPath(filePath) {
    // Get parent directory
    const sep = filePath.includes("\\") ? "\\" : "/";
    const parts = filePath.split(sep);
    return parts.slice(0, -1).join(sep);
}

function matchTypeLabel(matchType) {
    switch (matchType) {
        case "exact": return "Exact Match (SHA256)";
        case "metadata": return "Metadata Match (name + size)";
        case "fuzzy_name": return "Similar Name";
        default: return matchType;
    }
}

function matchTypeBadgeClass(matchType) {
    switch (matchType) {
        case "exact": return "badge-exact";
        case "metadata": return "badge-metadata";
        case "fuzzy_name": return "badge-fuzzy";
        default: return "";
    }
}

function FileRow({ file }) {
    const ext = getExtension(file.name);
    const isExec = file.isExecutable || EXECUTABLE_EXTENSIONS.has(ext);
    const folder = getFolderPath(file.path);

    function openFile(e) {
        e.preventDefault();
        if (isExec) return;
        window.open(`${API_URL}/api/open-file?path=${encodeURIComponent(file.path)}`, "_blank");
    }

    function openFolder(e) {
        e.preventDefault();
        window.open(`${API_URL}/api/open-folder?path=${encodeURIComponent(folder)}`, "_blank");
    }

    return (
        <div className={`duplicate-file-row ${isExec ? "executable" : ""}`}>
            <span className="dup-file-icon">{getIcon(file.name)}</span>

            {isExec ? (
                <span className="dup-file-name disabled" title="Executable files cannot be opened">
                    {file.name} {"\u{26A0}"}
                </span>
            ) : (
                <a href="#" className="dup-file-name" onClick={openFile} title={file.path}>
                    {file.name}
                </a>
            )}

            <a href="#" className="dup-folder-link" onClick={openFolder} title={folder}>
                {"\u{1F4C1}"}
            </a>

            <span className="dup-file-size">{formatSize(file.size)}</span>
            <span className="dup-file-date">{formatDate(file.mtime)}</span>
        </div>
    );
}

export default function DuplicateResultsPanel({ content, data }) {
    const groups = data?.groups || [];
    const stats = data?.stats || {};

    if (groups.length === 0) {
        return (
            <div className="duplicate-panel empty">
                <div className="message-text">{content}</div>
                <div className="dup-no-results">No duplicates found.</div>
            </div>
        );
    }

    return (
        <div className="duplicate-panel-wrapper">
            <div className="message-text">{content}</div>

            <div className="duplicate-panel">
                <div className="dup-stats">
                    {"\u{1F4CA}"} {stats.groups} group(s), {stats.totalDuplicates} files &mdash;
                    scanned {stats.scanned} entries in {stats.elapsed}ms
                    {stats.timedOut && <span className="dup-timeout"> (timed out)</span>}
                </div>

                {groups.map((group, gi) => (
                    <div className="duplicate-group" key={gi}>
                        <div className="dup-group-header">
                            <span className="dup-group-title">
                                Group {gi + 1} &mdash; {group.files.length} files
                            </span>
                            <span className={`dup-match-badge ${matchTypeBadgeClass(group.matchType)}`}>
                                {matchTypeLabel(group.matchType)}
                            </span>
                        </div>

                        <div className="dup-group-files">
                            {group.files.map((file, fi) => (
                                <FileRow key={fi} file={file} />
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
