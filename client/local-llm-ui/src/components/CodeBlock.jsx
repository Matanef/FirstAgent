// client/local-llm-ui/src/components/CodeBlock.jsx

export default function CodeBlock({ code, language = "javascript" }) {
    return (
        <div className="code-block-container">
            <div className="code-block-header">
                <span className="code-language">{language}</span>
                <button
                    className="code-copy-btn"
                    onClick={() => navigator.clipboard.writeText(code)}
                >
                    📋 Copy
                </button>
            </div>
            <pre className="code-block">
                <code>{code}</code>
            </pre>
        </div>
    );
}
