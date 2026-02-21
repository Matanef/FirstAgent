// client/local-llm-ui/src/App.jsx
// Main application component — slimmed down with extracted components

import { useState, useEffect, useRef } from "react";
import DOMPurify from "dompurify";
import SmartContent from "./components/SmartContent";
import "./App.css";

const API_URL = "http://localhost:3000";

// MAIN APP COMPONENT
function App() {
  const [conversations, setConversations] = useState({});
  const [activeId, setActiveId] = useState(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [metadata, setMetadata] = useState(null);

  // Tone control
  const [toneExpanded, setToneExpanded] = useState(false);
  const [toneValue, setToneValue] = useState(1);

  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversations, activeId]);

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
      const response = await fetch(`${API_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMsg.content,
          conversationId: activeId
        })
      });

      if (!response.ok) {
        throw new Error(`Server error: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let accumulatedText = "";

      // Add placeholder bot message
      const botMsgId = Date.now();
      const botMsg = {
        role: "assistant",
        content: "",
        timestamp: new Date().toISOString(),
        loading: true
      };

      setConversations(c => ({
        ...c,
        [activeId]: [...c[activeId], botMsg]
      }));

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = JSON.parse(line.slice(6));

          if (data.type === "chunk") {
            accumulatedText += data.chunk;
            setConversations(c => {
              const current = [...c[activeId]];
              const last = { ...current[current.length - 1] };
              last.content = accumulatedText;
              current[current.length - 1] = last;
              return { ...c, [activeId]: current };
            });
          } else if (data.type === "done") {
            setConversations(c => {
              const current = [...c[activeId]];
              const last = { ...current[current.length - 1] };
              last.content = data.reply;
              last.confidence = data.confidence;
              last.stateGraph = data.stateGraph;
              last.tool = data.tool;
              last.data = data.data;
              last.loading = false;
              current[current.length - 1] = last;
              return { ...c, [activeId]: current };
            });
            setMetadata(data.metadata);
          } else if (data.type === "error") {
            throw new Error(data.error);
          }
        }
      }
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

            {/* Tone Control */}
            <div className="tone-control-wrapper">
              {toneExpanded ? (
                <div className="tone-button expanded">
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
                      />
                      <div className="tone-labels">
                        <span>Concise</span>
                        <span>Warm</span>
                        <span>Very Warm</span>
                        <span>Pro</span>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <button
                  className="tone-button"
                  onClick={() => setToneExpanded(true)}
                  title="Adjust AI Tone"
                >
                  🎭
                </button>
              )}
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
