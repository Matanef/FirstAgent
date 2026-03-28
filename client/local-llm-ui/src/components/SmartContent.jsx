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
    if ((tool === "moltbook" || tool === "webBrowser") && data) return "webBrowser";
    if (tool === "duplicateScanner" && data?.groups) return "duplicateScanner";
    if (tool === "fileReview" && data?.files) return "fileReview";
    if (tool === "youtube" && data?.videos) return "youtube";
    if (content.includes("```") || tool === "calculator") return "code";
    if (tool === "file" && data?.items) return "filesystem";
    if (tool === "weather" && data?.temp) return "weather";
    if (content.includes("<table") || content.includes("ai-table") || content.includes("<div class=")) return "html";
    return "text";
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

        // Cleanup on unmount
        return () => {
            const cBtn = el.querySelector('[data-action="copy-json"]');
            const fInp = el.querySelector('#github-filter');
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

        case "code":
            const codeMatch = (message.content || "").match(/```(\w+)?\n([\s\S]*?)```/);
            if (codeMatch) {
                // Extract text before and after the code block
                const fullContent = message.content || "";
                const codeBlockFull = codeMatch[0];
                const idx = fullContent.indexOf(codeBlockFull);
                const textBefore = fullContent.substring(0, idx).trim();
                const textAfter = fullContent.substring(idx + codeBlockFull.length).trim();
                return (
                    <>
                        {textBefore && <div className="message-text" style={{ marginBottom: "0.5rem" }}>{textBefore}</div>}
                        <CodeBlock code={codeMatch[2]} language={codeMatch[1] || "text"} />
                        {textAfter && <div className="message-text" style={{ marginTop: "0.5rem" }}>{textAfter}</div>}
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

        case "html":
            return (
                <div
                    className="rich-html-content"
                    dangerouslySetInnerHTML={{ 
                        // UPDATE THIS LINE TOO:
                        __html: DOMPurify.sanitize(message.content, { ADD_TAGS: ["script"] }) 
                    }}
                />
            );

        default:
            return <div className="message-text">{message.content}</div>;
    }
}
