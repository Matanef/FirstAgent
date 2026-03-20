// client/local-llm-ui/src/components/SmartContent.jsx
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

function detectContentType(content, data, tool) {
    if (tool === "moltbook" && data?.html) return "moltbookHTML";  // Rich HTML from moltbook data.html
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

export default function SmartContent({ message, conversationId }) {
    const contentType = detectContentType(
        message.content || "",
        message.data,
        message.tool
    );

    switch (contentType) {
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

        case "html":
            return (
                <div
                    className="rich-html-content"
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(message.content) }}
                />
            );

        default:
            return <div className="message-text">{message.content}</div>;
    }
}
