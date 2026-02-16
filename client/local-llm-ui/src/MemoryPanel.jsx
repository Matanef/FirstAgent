import { useEffect, useState } from "react";
import "./MemoryPanel.css";

export default function MemoryPanel() {
  const [open, setOpen] = useState(false);
  const [memory, setMemory] = useState(null);
  const [loading, setLoading] = useState(false);

  async function loadMemory() {
    setLoading(true);
    try {
      const res = await fetch("http://localhost:3000/debug/memory");
      const data = await res.json();
      setMemory(data.memory);
    } catch (err) {
      console.error("Failed to load memory:", err);
    }
    setLoading(false);
  }

  async function resetMemory() {
    if (!window.confirm("Reset ALL memory? This cannot be undone.")) return;

    try {
      await fetch("http://localhost:3000/debug/memory/reset", {
        method: "POST"
      });
      await loadMemory();
    } catch (err) {
      console.error("Failed to reset memory:", err);
    }
  }

  useEffect(() => {
    if (open) loadMemory();
  }, [open]);

  return (
    <div className={`memory-panel ${open ? "open" : ""}`}>
      <button className="toggle-btn" onClick={() => setOpen(!open)}>
        {open ? "Close Memory" : "Open Memory"}
      </button>

      {open && (
        <div className="memory-content">
          <h2>🧠 Agent Memory</h2>

          {loading && <p>Loading...</p>}

          {!loading && memory && (
            <>
              <section>
                <h3>Profile</h3>
                <pre>{JSON.stringify(memory.profile, null, 2)}</pre>
              </section>

              <section>
                <h3>Conversations</h3>
                {Object.entries(memory.conversations).length === 0 && (
                  <p>No conversations stored.</p>
                )}

                {Object.entries(memory.conversations).map(([id, msgs]) => (
                  <div key={id} className="conversation-block">
                    <strong>ID:</strong> {id}
                    <br />
                    <strong>Messages:</strong> {msgs.length}
                    <br />
                    <strong>Preview:</strong>{" "}
                    {msgs[0]?.content.slice(0, 60) || "(empty)"}
                    <details>
                      <summary>View Messages</summary>
                      <pre>{JSON.stringify(msgs, null, 2)}</pre>
                    </details>
                  </div>
                ))}
              </section>

              <button className="reset-btn" onClick={resetMemory}>
                Reset Memory
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}