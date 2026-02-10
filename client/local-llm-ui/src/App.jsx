import { useState } from "react";

function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");

  async function sendMessage() {
    if (!input.trim()) return;

    const userMessage = { role: "user", content: input };
    setMessages((m) => [...m, userMessage]);
    setInput("");
    const PORT = 3000
    const res = await fetch(`http://localhost:${PORT}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: input })
    });

    const data = await res.json();

    setMessages((m) => [
      ...m,
      { role: "assistant", content: data.reply }
    ]);
  }

  return (
    <div style={{ padding: 20, maxWidth: 700, margin: "auto" }}>
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
        onChange={(e) => setInput(e.target.value)}
        style={{ width: "100%", marginTop: 10 }}
        onKeyDown={(e) => e.key === "Enter" && sendMessage()}
      />
      <button onClick={sendMessage}>Send</button>
    </div>
  );
}

export default App;
