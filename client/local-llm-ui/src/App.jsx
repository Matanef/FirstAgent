/**
 * Enhanced React Chat UI
 * Features:
 * - Multiple conversations with preview
 * - Loading states
 * - Error handling
 * - Confidence indicators
 * - Tool usage display
 * - Markdown support
 */

import { useState, useEffect, useRef } from "react";
import "./App.css";

const API_URL = "http://localhost:3000";

function App() {
  const [conversations, setConversations] = useState({});
  const [activeId, setActiveId] = useState(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [metadata, setMetadata] = useState(null);

  const messagesEndRef = useRef(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversations, activeId]);

  // Create new conversation
  function newChat() {
    const id = crypto.randomUUID();
    setConversations(c => ({ ...c, [id]: [] }));
    setActiveId(id);
    setError(null);
    setMetadata(null);
  }

  // Delete conversation
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

  // Send message
  async function sendMessage() {
    if (!input.trim() || !activeId || loading) return;

    const userMsg = {
      role: "user",
      content: input,
      timestamp: new Date().toISOString()
    };

    // Update UI immediately
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
        stateGraph: data.stateGraph
      };

      setConversations(c => ({
        ...c,
        [activeId]: [...c[activeId], botMsg]
      }));

      setMetadata(data.metadata);

    } catch (err) {
      console.error("Send error:", err);
      setError(err.message);

      // Add error message to chat
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

  // Handle Enter key
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
          <h2>💬 Chats</h2>
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
                  className={`conversation-item ${id === activeId ? 'active' : ''}`}
                >
                  <div className="conversation-preview">
                    {preview.slice(0, 40)}
                    {preview.length > 40 ? "..." : ""}
                  </div>
                  <div className="conversation-meta">
                    <span className="message-count">{convo.length} msgs</span>
                    <button
                      onClick={(e) => deleteChat(id, e)}
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

      {/* Chat area */}
      <div className="chat-container">
        <div className="chat-header">
          <h1>🤖 AI Agent</h1>
          {metadata && (
            <div className="metadata">
              <span title="Execution time">
                ⏱️ {metadata.executionTime ?? 0}ms
              </span>
                    
              <span title="Tools used">
                🔧 {Array.isArray(metadata.toolsUsed) && metadata.toolsUsed.length > 0
                  ? metadata.toolsUsed.join(", ")
                  : "none"}
              </span>
                
              <span title="Steps taken">
                📊 {metadata.steps ?? 0} steps
              </span>
            </div>
          )}
        </div>

        {!activeId ? (
          <div className="welcome-screen">
            <h2>Welcome to AI Agent</h2>
            <p>Start a new conversation to begin</p>
            <button onClick={newChat} className="start-chat-btn">
              Start New Chat
            </button>
            <div className="capabilities">
              <h3>I can help with:</h3>
              <ul>
                <li>📈 <strong>Stock market data</strong> - Top stocks by sector (e.g., "top 10 bioengineering stocks")</li>
                <li>🔍 <strong>Web search</strong> - Find information on any topic</li>
                <li>🧮 <strong>Calculations</strong> - Solve math expressions</li>
                <li>💬 <strong>General chat</strong> - Answer questions and have conversations</li>
              </ul>
            </div>
          </div>
        ) : (
          <>
            <div className="messages-container">
              {messages.length === 0 ? (
                <div className="empty-chat">
                  <p>Send a message to start the conversation</p>
                </div>
              ) : (
                messages.map((m, i) => (
                  <div key={i} className={`message message-${m.role}`}>
                    <div className="message-header">
                      <span className="role-badge">
                        {m.role === "user" ? "👤" : m.role === "error" ? "⚠️" : "🤖"}
                        {m.role}
                      </span>
                      {m.confidence !== undefined && (
                        <span className="confidence" title="Response confidence">
                          {(m.confidence * 100).toFixed(0)}% confident
                        </span>
                      )}
                    </div>
                    <div className="message-content">
                      {m.content}
                    </div>
                    {m.stateGraph && m.stateGraph.length > 0 && (
                      <details className="state-graph">
                        <summary>🔍 View execution trace ({m.stateGraph.length} steps)</summary>
                        <pre>{JSON.stringify(m.stateGraph, null, 2)}</pre>
                      </details>
                    )}
                  </div>
                ))
              )}

            {loading && (
              <div className="message message-assistant message-loading">
                <div className="message-header">
                  <span className="role-badge">🤖 assistant</span>
                </div>
                <div className="message-content">
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

            <div className="input-container">
              {error && (
                <div className="error-banner">
                  ⚠️ {error}
                </div>
              )}

              <div className="input-wrapper">
                <textarea
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type your message... (Enter to send, Shift+Enter for new line)"
                  disabled={loading}
                  rows={1}
                  className="message-input"
                />
                <button
                  onClick={sendMessage}
                  disabled={loading || !input.trim()}
                  className="send-btn"
                  title="Send message"
                >
                  {loading ? "⏳" : "📤"}
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
