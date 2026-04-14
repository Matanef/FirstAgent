// client/local-llm-ui/src/App.jsx
// Main application component — slimmed down with extracted components

import { useState, useEffect, useRef } from "react";
import DOMPurify from "dompurify";
import SmartContent from "./components/SmartContent";
import TrainOfThought from "./components/TrainOfThought";
import FileAttachmentBar from "./components/FileAttachmentBar";
import DuplicateScannerPopup from "./components/DuplicateScannerPopup";
import FolderPicker from "./components/FolderPicker";
import DepthBar from "./components/DepthBar";
import { API_URL, apiFetch } from "./api";
import "./App.css";

// MAIN APP COMPONENT
function App() {
  const [conversations, setConversations] = useState({});
  const [activeId, setActiveId] = useState(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [metadata, setMetadata] = useState(null);
  const [attachedFiles, setAttachedFiles] = useState([]);
  const [showDuplicateScanner, setShowDuplicateScanner] = useState(false);

  // --- NEW: Terminal-style Input History ---
  const [messageHistory, setMessageHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [tempDraft, setTempDraft] = useState("");
  const MAX_HISTORY = 30;
  // ----------------------------------------
  // Tone control
  const [toneExpanded, setToneExpanded] = useState(false);
  const [toneValue, setToneValue] = useState(1);

  const messagesEndRef = useRef(null);
  const abortControllerRef = useRef(null);
  

useEffect(() => {
    const currentChat = conversations[activeId];
    if (!currentChat || currentChat.length === 0) return;

    const lastMsg = currentChat[currentChat.length - 1];

    if (lastMsg.role === "user" || lastMsg.loading) {
      // 1. Keep scrolling to the bottom while the user sends or the agent is streaming
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    } else if (lastMsg.role === "assistant" && !lastMsg.loading) {
      // 2. When the agent finishes, snap the view back to the TOP of its message
      // so you don't have to scroll up past the "Reinforced" text or long widgets.
      const msgElements = document.querySelectorAll('.message-entry');
      const lastMsgElement = msgElements[msgElements.length - 1];
      if (lastMsgElement) {
        lastMsgElement.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
  }, [conversations, activeId]);

  useEffect(() => {
    const toneNames = ["concise", "mediumWarm", "warm", "professional"];
    const toneName = toneNames[toneValue];

    apiFetch(`${API_URL}/profile`, {
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
  if (attachedFiles.some(f => f.status === "uploading")) return;

  const cleanInput = input.trim(); // Get the clean text to save

  // --- NEW: Save to history ---
  const isNewMessage = messageHistory.length === 0 || messageHistory[messageHistory.length - 1] !== cleanInput;
  
  // Calculate what the new history length will be
  const nextHistoryLength = isNewMessage 
    ? Math.min(messageHistory.length + 1, MAX_HISTORY) 
    : messageHistory.length;

  setMessageHistory(prev => {
    const newHistory = [...prev];
    if (isNewMessage) newHistory.push(cleanInput);
    if (newHistory.length > MAX_HISTORY) newHistory.shift();
    return newHistory;
  });
  
  // Reset pointers
  setHistoryIndex(nextHistoryLength);
  setTempDraft("");
  // ----------------------------

    const fileIds = attachedFiles
      .filter(f => f.status === "uploaded" && f.id)
      .map(f => f.id);

    const userMsg = {
      role: "user",
      content: input,
      timestamp: new Date().toISOString(),
      fileIds: fileIds.length > 0 ? fileIds : undefined
    };

    setConversations(c => ({
      ...c,
      [activeId]: [...c[activeId], userMsg]
    }));

    setInput("");
    setAttachedFiles([]);
    setLoading(true);
    setError(null);

    try {
      const payload = {
        message: userMsg.content,
        conversationId: activeId
      };
      if (fileIds.length > 0) payload.fileIds = fileIds;

      // Create AbortController for cancel support
      abortControllerRef.current = new AbortController();

      const response = await apiFetch(`${API_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: abortControllerRef.current.signal
      });

      if (!response.ok) {
        throw new Error(`Server error: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let accumulatedText = "";
      
      // Removed the duplicate 'let buffer = "";' here since you use sseBuffer below

      // Add placeholder bot message (for streamed content)
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

      let sseBuffer = "";
      let streamFinished = false; // <-- ADDED: Flag to break the outer loop
      let accumulatedThoughts = []; // Train of Thought reasoning chain

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split("\n");
        // Keep the last partial line in the buffer (might be incomplete)
        sseBuffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          console.log("RECEIVED FROM SERVER:", line);
          let data;
          try {
            data = JSON.parse(line.slice(6));
          } catch (parseErr) {
            console.warn("SSE JSON parse error (skipping chunk):", parseErr.message);
            continue;
          }

          if (data.type === "thought") {
            // Train of Thought: accumulate reasoning events in real-time
            accumulatedThoughts.push({
              phase: data.phase,
              content: data.content,
              data: data.data,
              timestamp: data.timestamp
            });
            setConversations(c => {
              const current = [...c[activeId]];
              const last = { ...current[current.length - 1] };
              last.thoughts = [...accumulatedThoughts];
              current[current.length - 1] = last;
              return { ...c, [activeId]: current };
            });
          } else if (data.type === "chunk") {
            // Note: I added a fallback to data.text just in case your backend uses that
            accumulatedText += data.chunk || data.text || "";
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

              // If nothing was streamed, fall back to the final reply
              if (!accumulatedText && typeof data.reply === "string") {
                last.content = data.reply;
              }
              
              last.loading = false;
              last.confidence = data.confidence;
              last.stateGraph = data.stateGraph;
              last.thoughts = data.thoughtChain || accumulatedThoughts;
              last.tool = data.tool;
              last.data = data.data;
              if (data.html) last.html = data.html;
              current[current.length - 1] = last;
              return { ...c, [activeId]: current };
            });
            
            setMetadata(data.metadata);
            streamFinished = true; // <-- ADDED: Tell the while loop it's time to stop
            break; // This only breaks the 'for' loop
            
          } else if (data.type === "error") {
            throw new Error(data.error);
          }
        }

        // <-- ADDED: Safely break the while loop so the 3 dots disappear
        if (streamFinished) {
          break; 
        }
      }
    } catch (err) {
      // Don't show error for user-initiated abort
      if (err.name === "AbortError") {
        console.log("Request cancelled by user.");
        // Update the last bot message to show it was cancelled
        setConversations(c => {
          const current = [...(c[activeId] || [])];
          const lastIdx = current.length - 1;
          if (lastIdx >= 0 && current[lastIdx].role === "assistant") {
            current[lastIdx] = {
              ...current[lastIdx],
              content: current[lastIdx].content || "(Request cancelled)",
              loading: false
            };
          }
          return { ...c, [activeId]: current };
        });
      } else {
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
      }
    } finally {
      abortControllerRef.current = null;
      setLoading(false);

      // ADDED: Failsafe to ensure the dots disappear even if the server crashes
      setConversations(c => {
        const current = [...(c[activeId] || [])];
        if (current.length > 0) {
          const lastIdx = current.length - 1;
          // If the message is STILL marked as loading after the stream closes, fix it!
          if (current[lastIdx].loading) {
            current[lastIdx] = {
              ...current[lastIdx],
              loading: false,
              content: current[lastIdx].content || "⚠️ Connection to server lost before completion."
            };
            return { ...c, [activeId]: current };
          }
        }
        return c;
      });
    }
  }

  function cancelRequest() {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  }

function handleKeyDown(e) {
    // Original Enter to Send logic
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
      return; // Exit early
    }

    // --- NEW: Terminal-style Input History Logic ---
    const target = e.target;
    const isAtStart = target.selectionStart === 0;
    const isAtEnd = target.selectionEnd === target.value.length;

    if (e.key === "ArrowUp" && isAtStart) {
      e.preventDefault();
      if (messageHistory.length === 0) return;

      // If just entering history, save current draft
      if (historyIndex === messageHistory.length) {
        setTempDraft(input);
      }

      // Move up in history
      if (historyIndex > 0) {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setInput(messageHistory[newIndex]);
      }
    } 
    else if (e.key === "ArrowDown" && isAtEnd) {
      e.preventDefault();
      
      // Move down in history
      if (historyIndex < messageHistory.length - 1) {
        const newIndex = historyIndex + 1;
        setHistoryIndex(newIndex);
        setInput(messageHistory[newIndex]);
      } 
      // Reach the bottom: restore draft
      else if (historyIndex === messageHistory.length - 1) {
        setHistoryIndex(messageHistory.length);
        setInput(tempDraft);
      }
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
                    {m.role === "assistant" && m.thoughts && m.thoughts.length > 0 && (
                      <TrainOfThought
                        thoughts={m.thoughts}
                        isStreaming={m.loading === true}
                      />
                    )}
                    <div className="message-body">
                      <SmartContent message={m} conversationId={activeId} />
                    </div>
                    {m.stateGraph && m.stateGraph.length > 1 && (
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

              {showDuplicateScanner && (
                <DuplicateScannerPopup
                  onClose={() => setShowDuplicateScanner(false)}
                  onResults={(result) => {
                    if (result.data && activeId) {
                      const scanMsg = {
                        role: "assistant",
                        content: result.data?.text || "Scan complete.",
                        timestamp: new Date().toISOString(),
                        tool: "duplicateScanner",
                        data: result.data,
                        loading: false
                      };
                      setConversations(c => ({
                        ...c,
                        [activeId]: [...(c[activeId] || []), scanMsg]
                      }));
                    }
                  }}
                />
              )}

              <FileAttachmentBar
                files={attachedFiles}
                setFiles={setAttachedFiles}
                disabled={loading}
              />

              <DepthBar input={input} setInput={setInput} disabled={loading} />

              <div className="input-wrapper">
                <FolderPicker
                  onSelectFolder={(folderPath) => {
                    setInput(prev => prev ? `${prev} ${folderPath}` : folderPath);
                  }}
                  disabled={loading}
                />
                <button
                  className="scanner-trigger-btn"
                  onClick={() => setShowDuplicateScanner(!showDuplicateScanner)}
                  title="Scan for duplicate files"
                  disabled={loading}
                >
                  {"\u{1F50D}"}
                </button>
                <textarea
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask me anything..."
                  disabled={loading}
                  rows={1}
                  className="message-input"
                />
                {loading ? (
                  <button
                    onClick={cancelRequest}
                    className="send-btn stop-btn"
                    title="Stop"
                  >
                    ■
                  </button>
                ) : (
                  <button
                    onClick={sendMessage}
                    disabled={!input.trim() || attachedFiles.some(f => f.status === "uploading")}
                    className="send-btn"
                    title="Send"
                  >
                    ➤
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default App;