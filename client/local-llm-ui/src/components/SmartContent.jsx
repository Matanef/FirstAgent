// client/local-llm-ui/src/components/SmartContent.jsx
import { useRef, useEffect } from "react";
import DOMPurify from "dompurify";

// Allow target="_blank" on links — DOMPurify strips it by default
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

import YouTubeVideoGrid from "./YouTubeVideoGrid";
import FileSystemBrowser from "./FileSystemBrowser";
import CodeBlock from "./CodeBlock";
import WeatherWidget from "./WeatherWidget";
import FileReviewPanel from "./FileReviewPanel";
import DuplicateResultsPanel from "./DuplicateResultsPanel";
import WebBrowserPanel from "./WebBrowserPanel";

/**
 * FolderBrowserPanel — renders folder HTML and attaches event handlers after mount.
 * DOMPurify strips onclick attributes (XSS protection), so we use data-action
 * attributes as hooks and bind listeners via useRef + useEffect.
 */
function FolderBrowserPanel({ html, content }) {
    const containerRef = useRef(null);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        // ── Toggle All button ──
        const toggleBtn = el.querySelector('[data-action="toggle-all"]');
        if (toggleBtn) {
            const handleToggle = () => {
                const cbs = el.querySelectorAll('.file-cb');
                const anyUnchecked = Array.from(cbs).some(cb => !cb.checked);
                cbs.forEach(cb => { cb.checked = anyUnchecked; });
            };
            toggleBtn.addEventListener('click', handleToggle);
            // Cleanup on unmount
            toggleBtn._cleanup = () => toggleBtn.removeEventListener('click', handleToggle);
        }

        // ── Compile button ──
        const compileBtn = el.querySelector('[data-action="compile"]');
        if (compileBtn) {
            const handleCompile = () => {
                const files = Array.from(el.querySelectorAll('.file-cb:checked'))
                    .map(cb => "'" + cb.value + "'");
                if (files.length === 0) return;

                const msg = 'Compile these files: ' + files.join(', ');
                const chatInput = document.querySelector('.message-input');
                if (!chatInput) return;

                // React controls the textarea via state — we need to trigger
                // React's synthetic onChange by using the native value setter
                // and dispatching an input event that React's event system sees.
                const nativeSetter = Object.getOwnPropertyDescriptor(
                    window.HTMLTextAreaElement.prototype, 'value'
                ).set;
                nativeSetter.call(chatInput, msg);
                chatInput.dispatchEvent(new Event('input', { bubbles: true }));
                chatInput.focus();

                // Give React one tick to process the state update, then click send
                setTimeout(() => {
                    const sendBtn = document.querySelector('.send-btn:not(.stop-btn)');
                    if (sendBtn && !sendBtn.disabled) sendBtn.click();
                }, 80);
            };
            compileBtn.addEventListener('click', handleCompile);
            compileBtn._cleanup = () => compileBtn.removeEventListener('click', handleCompile);
        }

        // Cleanup
        return () => {
            if (toggleBtn?._cleanup) toggleBtn._cleanup();
            if (compileBtn?._cleanup) compileBtn._cleanup();
        };
    }, [html]);

    return (
        <div className="folder-access-container">
            <div
                ref={containerRef}
                className="rich-html-content folder-results"
                dangerouslySetInnerHTML={{
                    __html: DOMPurify.sanitize(html, { ADD_ATTR: ['data-action'] })
                }}
            />
            {content && !content.includes("<") && (
                <div className="message-text" style={{ marginTop: "0.5rem", opacity: 0.8, fontSize: '0.9rem' }}>
                    {content}
                </div>
            )}
        </div>
    );
}

function detectContentType(content, data, tool) {
    if (tool === "mcpBridge" && data?.html) return "mcpBridgeHTML"; 
    if (tool === "folderAccess" && data?.html) return "folderAccessHTML";
    if (tool === "folderAccess" && data?.html) return "folderAccessHTML";
    if (tool === "shopping" && data?.html) return "shoppingHTML";
    if (tool === "moltbook" && data?.html) return "moltbookHTML";  // Rich HTML from moltbook data.html
    if (tool === "workflow" && data?.html) return "workflowHTML";  // Workflow with step HTML widgets
    if ((tool === "finance" || tool === "finance-fundamentals" || tool === "financeFundamentals") && data?.html) return "financeHTML";
    if (tool === "selfImprovement" && data?.html) return "html";
    if ((tool === "moltbook" || tool === "webBrowser") && data) return "webBrowser";
    if (tool === "duplicateScanner" && data?.groups) return "duplicateScanner";
    if (tool === "fileReview" && data?.files) return "fileReview";
    if (tool === "youtube" && data?.videos) return "youtube";
    if (content.includes("```") || tool === "calculator") return "code";
    if (tool === "file" && data?.items) return "filesystem";
    if (tool === "weather" && data?.temp) return "weather";
// Tool-specific HTML — must come BEFORE generic html check to avoid being caught by <table>/<div class=> detection
    if ((tool === "githubTrending" || tool === "githubScanner") && data?.html) return "trendingHTML";
    // Compound flow: intermediate step produced an HTML widget (e.g., githubTrending → llm)
    if (data?.html && data?.htmlSource === "githubTrending") return "trendingWithSummary";
    // Generic fallback: ANY tool that returned data.html should render it as HTML
    if (data?.html && typeof data.html === "string" && data.html.length > 20) return "html";
    if (content.includes("<table") || content.includes("ai-table") || content.includes("<div class=") || content.includes("<html>") || content.includes("<body")) return "html";
    return "text";
}

function TrendingPanel({ html, content }) {
    const containerRef = useRef(null);
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const filterInput = el.querySelector('#trending-filter');
        if (filterInput) {
            const handleFilter = (e) => {
                const term = e.target.value.toLowerCase();
                const rows = el.querySelectorAll('.trending-row');
                rows.forEach(row => {
                    const text = row.textContent.toLowerCase();
                    row.style.display = text.includes(term) ? "" : "none";
                });
            };
            filterInput.addEventListener('keyup', handleFilter);
            return () => filterInput.removeEventListener('keyup', handleFilter);
        }
    }, [html]);

    return (
        <div ref={containerRef} dangerouslySetInnerHTML={{
            __html: DOMPurify.sanitize(html, {
                ADD_ATTR: ['style', 'target', 'id'],
                ADD_TAGS: ['style']
            })
        }} />
    );
}
function McpBridgePanel({ html, data, content }) {
    const containerRef = useRef(null);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        // 1. ── Handle Copy JSON Button ──
        const copyBtn = el.querySelector('[data-action="copy-json"]');
        if (copyBtn) {
            const handleCopy = () => {
                const rawJson = JSON.stringify(data, null, 2);
                navigator.clipboard.writeText(rawJson);
                const originalText = copyBtn.innerText;
                copyBtn.innerText = "✅ Copied!";
                setTimeout(() => { copyBtn.innerText = originalText; }, 2000);
            };
            copyBtn.addEventListener('click', handleCopy);
            copyBtn._cleanup = () => copyBtn.removeEventListener('click', handleCopy);
        }

        // 2. ── Handle Real-time Search Filter ──
        const filterInput = el.querySelector('#github-filter');
        if (filterInput) {
            const handleFilter = (e) => {
                const term = e.target.value.toLowerCase();
                const rows = el.querySelectorAll('.repo-row');
                
                rows.forEach(row => {
                    const text = row.textContent || row.innerText;
                    row.style.display = text.toLowerCase().includes(term) ? "" : "none";
                });
            };
            filterInput.addEventListener('keyup', handleFilter);
            filterInput._cleanup = () => filterInput.removeEventListener('keyup', handleFilter);
        }
        // 3. ── Handle SQLite Search Filter ──
        const sqliteFilter = el.querySelector('#sqlite-filter');
        if (sqliteFilter) {
            const handleSqliteFilter = (e) => {
                const term = e.target.value.toLowerCase();
                const rows = el.querySelectorAll('.db-row');
                
                rows.forEach(row => {
                    const text = row.textContent || row.innerText;
                    row.style.display = text.toLowerCase().includes(term) ? "" : "none";
                });
            };
            sqliteFilter.addEventListener('keyup', handleSqliteFilter);
            sqliteFilter._cleanup = () => sqliteFilter.removeEventListener('keyup', handleSqliteFilter);
        }

        // Cleanup on unmount
        return () => {
            const cBtn = el.querySelector('[data-action="copy-json"]');
            const fInp = el.querySelector('#github-filter');
            const sFilt = el.querySelector('#sqlite-filter');
            if (sFilt?._cleanup) sFilt._cleanup();
            if (cBtn?._cleanup) cBtn._cleanup();
            if (fInp?._cleanup) fInp._cleanup();
        };
    }, [html, data]);

    return (
        <div className="mcp-bridge-container">
            <div
                ref={containerRef}
                className="rich-html-content mcp-results"
                dangerouslySetInnerHTML={{ 
                    // We can go back to standard sanitization now
                    __html: DOMPurify.sanitize(html) 
                }}
            />
            {content && (
                <div className="message-text" style={{ marginTop: "0.8rem", opacity: 0.9 }}>
                    {content}
                </div>
            )}
        </div>
    );
}

export default function SmartContent({ message, conversationId }) {
    const contentType = detectContentType(
        message.content || "",
        message.data,
        message.tool
    );

    switch (contentType) {
        case "mcpBridgeHTML":
            return <McpBridgePanel html={message.data.html} data={message.data} content={message.content} />;
        case "folderAccessHTML":
            return <FolderBrowserPanel html={message.data.html} content={message.content} />;
        case "webBrowser":
            return <WebBrowserPanel content={message.content} data={message.data} />;

        case "duplicateScanner":
            return <DuplicateResultsPanel content={message.content} data={message.data} />;

        case "fileReview":
            return <FileReviewPanel content={message.content} data={message.data} />;

        case "youtube":
            return (
                <>
                    <YouTubeVideoGrid videos={message.data.videos} />
                    {message.content && (
                        <div className="message-note">{message.content}</div>
                    )}
                </>
            );

        case "code": {
            // Parse ALL fenced code blocks, not just the first. The previous implementation
            // matched a single block then dumped the remainder as plain text, which caused
            // subsequent ```blocks``` to render as literal backticks in chat output.
            const fullContent = message.content || "";
            const blockRe = /```(\w+)?\n?([\s\S]*?)```/g;
            const parts = [];
            let lastIndex = 0;
            let m;
            while ((m = blockRe.exec(fullContent)) !== null) {
                if (m.index > lastIndex) {
                    const txt = fullContent.substring(lastIndex, m.index).trim();
                    if (txt) parts.push({ kind: "text", value: txt });
                }
                parts.push({ kind: "code", language: m[1] || "text", code: m[2] });
                lastIndex = m.index + m[0].length;
            }
            if (lastIndex < fullContent.length) {
                const tail = fullContent.substring(lastIndex).trim();
                if (tail) parts.push({ kind: "text", value: tail });
            }
            if (parts.length > 0) {
                return (
                    <>
                        {parts.map((p, i) => p.kind === "code"
                            ? <CodeBlock key={i} code={p.code} language={p.language} />
                            : <div key={i} className="message-text" style={{ margin: "0.5rem 0", whiteSpace: "pre-wrap" }}>{p.value}</div>
                        )}
                    </>
                );
            }
            if (message.tool === "calculator" && message.data?.expression) {
                return (
                    <>
                        <div className="calc-result">
                            <div className="calc-expression">{message.data.expression}</div>
                            <div className="calc-answer">= {message.data.result}</div>
                        </div>
                        {message.content && !message.content.includes("```") && (
                            <div className="message-note">{message.content}</div>
                        )}
                    </>
                );
            }
            return <div className="message-text">{message.content}</div>;
        }

        case "filesystem":
            return (
                <>
                    <FileSystemBrowser data={message.data} conversationId={conversationId} />
                    {message.content && !message.content.includes("<") && (
                        <div className="message-note">{message.content}</div>
                    )}
                </>
            );

        case "weather":
            return (
                <>
                    <WeatherWidget data={message.data} />
                    {message.content && (
                        <div className="message-note">{message.content}</div>
                    )}
                </>
            );

        case "moltbookHTML":
            return (
                <div
                    className="rich-html-content"
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(message.data.html) }}
                />
            );

        case "workflowHTML":
            return (
                <div className="workflow-container">
                    <div
                        className="rich-html-content workflow-results"
                        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(message.data.html) }}
                    />
                    {message.content && (
                        <details className="workflow-summary">
                            <summary>View text summary</summary>
                            <div className="message-text">{message.content}</div>
                        </details>
                    )}
                </div>
            );

        case "shoppingHTML":
            return (
                <div className="shopping-container">
                    <div
                        className="rich-html-content shopping-results"
                        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(message.data.html) }}
                    />
                </div>
            );

        case "financeHTML":
            return (
                <div className="finance-container">
                    <div
                        className="rich-html-content finance-results"
                        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(message.data.html) }}
                    />
                    {message.content && (
                        <div className="message-text" style={{ marginTop: "0.5rem" }}>{message.content}</div>
                    )}
                </div>
            );

        case "trendingHTML":
            return <TrendingPanel html={message.data.html} content={message.content} />;

        case "trendingWithSummary":
            return (
                <>
                    <TrendingPanel html={message.data.html} content="" />
                    {message.content && (
                        <div className="message-text" style={{ marginTop: "0.75rem" }}>{message.content}</div>
                    )}
                </>
            );

        case "html": {
            const widgetHtml = message.data?.html || message.html;
            // If there's a separate LLM intro text AND a widget, render both
            const introText = widgetHtml && message.content && !message.content.includes("<html") && !message.content.includes("<div")
                ? message.content.trim()
                : null;
            return (
                <>
                    {introText && <div className="message-text" style={{ marginBottom: "12px" }}>{introText}</div>}
                    <div
                        className="rich-html-content"
                        dangerouslySetInnerHTML={{
                            __html: DOMPurify.sanitize(widgetHtml || message.content, { ADD_TAGS: ["script"] })
                        }}
                    />
                </>
            );
        }

        default:
            return <div className="message-text">{message.content}</div>;
    }
}
