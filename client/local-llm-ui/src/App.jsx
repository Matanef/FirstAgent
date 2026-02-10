/**
 * Simple React chat UI
 * - Multiple conversations
 * - Sidebar ("Your Chats")
 * - One active conversation at a time
 */

import { useState } from "react";

function App() {
  // All conversations stored locally in UI
  const [conversations, setConversations] = useState({});
  const [activeId, setActiveId] = useState(null);
  const [input, setInput] = useState("");

  /**
   * Create a new empty conversation
   */
  function newChat() {
    const id = crypto.randomUUID();
    setConversations(c => ({ ...c, [id]: [] }));
    setActiveId(id);
  }

  /**
   * Send message to agent server
   */
  async function sendMessage() {
    if (!input.trim() || !activeId) return;

    const userMsg = { role: "user", content: input };

    // Update UI immediately
    setConversations(c => ({
      ...c,
      [activeId]: [...c[activeId], userMsg]
    }));

    setInput("");

    const res = await fetch("http://localhost:3000/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: userMsg.content,
        conversationId: activeId
      })
    });

    const data = await res.json();

    const botMsg = { role: "assistant", content: data.reply };

    setConversations(c => ({
      ...c,
      [activeId]: [...c[activeId], botMsg]
    }));
  }

  const messages = activeId ? conversations[activeId] : [];

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      {/* Sidebar */}
      <div style={{ width: 200, borderRight: "1px solid #ccc", padding: 10 }}>
        <h3>Your Chats</h3>
        <button onClick={newChat}>➕ New Chat</button>

        {Object.keys(conversations).map(id => (
          <div
            key={id}
            onClick={() => setActiveId(id)}
            style={{
              cursor: "pointer",
              padding: 5,
              background: id === activeId ? "#eee" : "transparent"
            }}
          >
            Chat {id.slice(0, 4)}
          </div>
        ))}
      </div>

      {/* Chat area */}
      <div style={{ flex: 1, padding: 20 }}>
        <h2>Local Agent</h2>

        <div style={{ border: "1px solid #ccc", padding: 10, minHeight: 300 }}>
          {messages.map((m, i) => (
            <div key={i}>
              <b>{m.role}:</b> {m.content}
            </div>
          ))}
        </div>

        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && sendMessage()}
          style={{ width: "100%", marginTop: 10 }}
          placeholder="Type a message..."
        />

        <button onClick={sendMessage}>Send</button>
      </div>
    </div>
  );
}

export default App;
