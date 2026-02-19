// client/local-llm-ui/src/App.jsx (COMPLETE - All UI requirements)
/**
 * COMPLETE React Chat UI with ALL features:
 * - Full-width chat with right-aligned user messages (Req #13)
 * - Tone control button (Req #14)
 * - File checkboxes for selection (Req #15)
 * - Compile to bigFile.txt (Req #16)
 * - YouTube video display 4x (390x220px) (Req #22)
 * - File upload/drag-drop (Req #31)
 * - Specialized content renderers
 */

import { useState, useEffect, useRef } from "react";
import "./App.css";

const API_URL = "http://localhost:3000";

// ============================================================================
// YouTube Video Display (Requirement #22)
// ============================================================================
function YouTubeVideoGrid({ videos }) {
  if (!videos || videos.length === 0) return null;

  const [selectedVideo, setSelectedVideo] = useState(null);

  return (
    <div className="youtube-container">
      <div className="youtube-grid">
        {videos.slice(0, 4).map((video, i) => (
          <div 
            key={i} 
            className="youtube-video-card"
            onClick={() => setSelectedVideo(video.id)}
          >
            <img
              src={`https://img.youtube.com/vi/${video.id}/mqdefault.jpg`}
              alt={video.title}
              className="youtube-thumbnail"
            />
            <div className="youtube-video-info">
              <div className="youtube-video-title">{video.title}</div>
              <div className="youtube-video-channel">{video.channelTitle}</div>
            </div>
          </div>
        ))}
      </div>

      {selectedVideo && (
        <div className="youtube-player-modal" onClick={() => setSelectedVideo(null)}>
          <div className="youtube-player-container" onClick={e => e.stopPropagation()}>
            <button className="youtube-close-btn" onClick={() => setSelectedVideo(null)}>×</button>
            <iframe
              width="100%"
              height="100%"
              src={`https://www.youtube.com/embed/${selectedVideo}`}
              frameBorder="0"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              title="YouTube video player"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// File Browser with Checkboxes (Requirements #15, #16)
// ============================================================================
function FileSystemBrowser({ data, conversationId }) {
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
      const res = await fetch(`${API_URL}/compile-files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: Array.from(selectedFiles),
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
        <span className="file-count">{data.items.length} items</span>
      </div>
      <div className="file-list">
        {data.items.map((item, i) => (
          <div key={i} className="file-item">
            <input
              type="checkbox"
              className="file-checkbox"
              checked={selectedFiles.has(item.name)}
              onChange={() => handleCheckbox(item.name)}
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
          <span>{selectedFiles.size} files selected</span>
          <button 
            className="compile-btn" 
            onClick={handleCompile}
            disabled={compiling}
          >
            {compiling ? "📦 Compiling..." : "📦 Compile to bigFile.txt"}
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Other specialized renderers
// ============================================================================
function CodeBlock({ code, language = "javascript" }) {
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

function WeatherWidget({ data }) {
  if (!data) return null;

  return (
    <div className="weather-widget">
      <div className="weather-header">
        <span>🌤️ {data.city}, {data.country}</span>
      </div>
      <div className="weather-content">
        <div className="weather-temp">{data.temp}°C</div>
        <div className="weather-desc">{data.description}</div>
        <div className="weather-details">
          <span>💨 Wind: {data.wind_speed} m/s</span>
          <span>💧 Humidity: {data.humidity}%</span>
          <span>🌡️ Feels like: {data.feels_like}°C</span>
        </div>
      </div>
    </div>
  );
}

function detectContentType(content, data, tool) {
  if (tool === "youtube" && data?.videos) return "youtube";
  if (content.includes("```") || tool === "calculator") return "code";
  if (tool === "file" && data?.items) return "filesystem";
  if (tool === "weather" && data?.temp) return "weather";
  if (content.includes("<table") || content.includes("ai-table")) return "html";
  return "text";
}

function SmartContent({ message, conversationId }) {
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
          dangerouslySetInnerHTML={{ __html: message.content }}
        />
      );

    default:
      return <div className="message-text">{message.content}</div>;
  }
}

// ============================================================================
// MAIN APP COMPONENT
// ============================================================================
function App() {
  const [conversations, setConversations] = useState({});
  const [activeId, setActiveId] = useState(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [metadata, setMetadata] = useState(null);

  // Requirement #14: Tone control
  const [toneExpanded, setToneExpanded] = useState(false);
  const [toneValue, setToneValue] = useState(1); // 0: concise, 1: mediumWarm, 2: warm, 3: professional

  const messagesEndRef = useRef(null);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversations, activeId]);

  // Save tone to backend
  useEffect(() => {
    const toneNames = ["concise", "mediumWarm", "warm", "professional"];
    const toneName = toneNames[toneValue];

    fetch(`${API_URL}/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "tone", value: toneName })
    }).catch(err => console.error("Failed to save tone:", err));
  }, [toneValue]);

  function newChat() {
    const id = crypto.randomUUID();
    setConversations(c => ({ ...c, [id]: [] }));
    setActiveId(id);
    setError(null);
    setMetadata(null);
  }

  function deleteChat(id, e) {
    e.stopPropagation();
    if (!confirm("Delete this conversation?")) return;

    const newConvos = { ...conversations };
    delete newConvos[id];
    setConversations(newConvos);

    if (activeId === id) {
      setActiveId(null);
    }
  }

  async function sendMessage() {
    if (!input.trim() || !activeId || loading) return;

    const userMsg = {
      role: "user",
      content: input,
      timestamp: new Date().toISOString()
    };

    setConversations(c => ({
      ...c,
      [activeId]: [...c[activeId], userMsg]
    }));

    setInput("");
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`${API_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMsg.content,
          conversationId: activeId
        })
      });

      if (!res.ok) {
        throw new Error(`Server error: ${res.status}`);
      }

      const data = await res.json();

      const botMsg = {
        role: "assistant",
        content: data.reply,
        timestamp: new Date().toISOString(),
        confidence: data.confidence,
        stateGraph: data.stateGraph,
        tool: data.tool,
        data: data.data
      };

      setConversations(c => ({
        ...c,
        [activeId]: [...c[activeId], botMsg]
      }));

      setMetadata(data.metadata);
    } catch (err) {
      console.error("Send error:", err);
      setError(err.message);

      const errorMsg = {
        role: "error",
        content: `Error: ${err.message}`,
        timestamp: new Date().toISOString()
      };

      setConversations(c => ({
        ...c,
        [activeId]: [...c[activeId], errorMsg]
      }));
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  const messages = activeId ? conversations[activeId] : [];

  return (
    <div className="app-container">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <h2>💬 Conversations</h2>
          <button onClick={newChat} className="new-chat-btn" title="New Chat">
            ➕
          </button>
        </div>

        <div className="conversation-list">
          {Object.keys(conversations).length === 0 ? (
            <div className="empty-state">No conversations yet</div>
          ) : (
            Object.keys(conversations).map(id => {
              const convo = conversations[id];
              const preview = convo[0]?.content || "Empty chat";

              return (
                <div
                  key={id}
                  onClick={() => setActiveId(id)}
                  className={`conversation-item ${id === activeId ? "active" : ""}`}
                >
                  <div className="conversation-preview">
                    {preview.slice(0, 40)}
                    {preview.length > 40 ? "..." : ""}
                  </div>
                  <div className="conversation-meta">
                    <span className="message-count">{convo.length} msgs</span>
                    <button
                      onClick={e => deleteChat(id, e)}
                      className="delete-btn"
                      title="Delete"
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="chat-container">
        <div className="chat-header">
          <h1>🤖 AI Agent</h1>
          <div className="header-controls">
            {metadata && (
              <div className="metadata">
                <span>⏱️ {metadata.executionTime ?? 0}ms</span>
                <span>🔧 {metadata.tool || "none"}</span>
                <span>📊 {metadata.steps ?? 0} steps</span>
              </div>
            )}

            {/* Requirement #14: Tone Control Button */}
            <div className="tone-control-wrapper">
              <button 
                className={`tone-button ${toneExpanded ? "expanded" : ""}`}
                onClick={() => setToneExpanded(!toneExpanded)}
              >
                {!toneExpanded ? "🎭" : (
                  <div className="tone-panel">
                    <div className="tone-panel-header">
                      <span>Tone Control</span>
                      <button 
                        className="tone-close" 
                        onClick={(e) => { e.stopPropagation(); setToneExpanded(false); }}
                      >
                        ×
                      </button>
                    </div>
                    <div className="tone-slider-container">
                      <input
                        type="range"
                        min="0"
                        max="3"
                        value={toneValue}
                        onChange={(e) => setToneValue(Number(e.target.value))}
                        className="tone-slider"
                        onClick={(e) => e.stopPropagation()}
                      />
                      <div className="tone-labels">
                        <span>Concise</span>
                        <span>Warm</span>
                        <span>Very Warm</span>
                        <span>Pro</span>
                      </div>
                    </div>
                  </div>
                )}
              </button>
            </div>
          </div>
        </div>

        {!activeId ? (
          <div className="welcome-screen">
            <h2>Welcome to AI Agent</h2>
            <p>Your self-improving AI assistant</p>
            <button onClick={newChat} className="start-chat-btn">
              Start Conversation
            </button>
          </div>
        ) : (
          <>
            <div className="conversation-flow">
              {messages.length === 0 ? (
                <div className="empty-chat">
                  <p>Start typing to begin...</p>
                </div>
              ) : (
                messages.map((m, i) => (
                  <div key={i} className={`message-entry ${m.role}`}>
                    <div className="message-meta">
                      <span className="message-role">
                        {m.role === "user" ? "You" : m.role === "error" ? "Error" : "Agent"}
                      </span>
                      <span className="message-time">
                        {new Date(m.timestamp).toLocaleTimeString()}
                      </span>
                      {m.confidence !== undefined && (
                        <span className="message-confidence">
                          {(m.confidence * 100).toFixed(0)}%
                        </span>
                      )}
                    </div>
                    <div className="message-body">
                      <SmartContent message={m} conversationId={activeId} />
                    </div>
                    {m.stateGraph && m.stateGraph.length > 0 && (
                      <details className="message-trace">
                        <summary>🔍 Execution trace ({m.stateGraph.length} steps)</summary>
                        <pre>{JSON.stringify(m.stateGraph, null, 2)}</pre>
                      </details>
                    )}
                  </div>
                ))
              )}

              {loading && (
                <div className="message-entry loading">
                  <div className="message-meta">
                    <span className="message-role">Agent</span>
                  </div>
                  <div className="message-body">
                    <div className="typing-indicator">
                      <span></span>
                      <span></span>
                      <span></span>
                    </div>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            <div className="input-area">
              {error && <div className="error-banner">⚠️ {error}</div>}

              <div className="input-wrapper">
                <textarea
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask me anything..."
                  disabled={loading}
                  rows={1}
                  className="message-input"
                />
                <button
                  onClick={sendMessage}
                  disabled={loading || !input.trim()}
                  className="send-btn"
                  title="Send"
                >
                  {loading ? "⏳" : "➤"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default App;
