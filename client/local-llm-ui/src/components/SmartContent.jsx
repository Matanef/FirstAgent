// client/local-llm-ui/src/components/SmartContent.jsx
import DOMPurify from "dompurify";
import YouTubeVideoGrid from "./YouTubeVideoGrid";
import FileSystemBrowser from "./FileSystemBrowser";
import CodeBlock from "./CodeBlock";
import WeatherWidget from "./WeatherWidget";

function detectContentType(content, data, tool) {
    if (tool === "youtube" && data?.videos) return "youtube";
    if (content.includes("```") || tool === "calculator") return "code";
    if (tool === "file" && data?.items) return "filesystem";
    if (tool === "weather" && data?.temp) return "weather";
    if (content.includes("<table") || content.includes("ai-table")) return "html";
    return "text";
}

export default function SmartContent({ message, conversationId }) {
    const contentType = detectContentType(
        message.content || "",
        message.data,
        message.tool
    );

    switch (contentType) {
        case "youtube":
            return <YouTubeVideoGrid videos={message.data.videos} />;

        case "code":
            const codeMatch = (message.content || "").match(/```(\w+)?\n([\s\S]*?)```/);
            if (codeMatch) {
                return <CodeBlock code={codeMatch[2]} language={codeMatch[1] || "text"} />;
            }
            if (message.tool === "calculator" && message.data?.expression) {
                return (
                    <div className="calc-result">
                        <div className="calc-expression">{message.data.expression}</div>
                        <div className="calc-answer">= {message.data.result}</div>
                    </div>
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
                    {message.content && !message.content.toLowerCase().includes("weather") && (
                        <div className="message-note">{message.content}</div>
                    )}
                </>
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
