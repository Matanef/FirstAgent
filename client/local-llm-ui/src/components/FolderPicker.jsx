// client/local-llm-ui/src/components/FolderPicker.jsx
// Browse button + dropdown to select a folder from any drive
// Passes selected path to the agent input field

import { useState, useRef, useEffect } from "react";
import { API_URL, apiFetch } from "../api";

export default function FolderPicker({ onSelectFolder, disabled }) {
  const [isOpen, setIsOpen] = useState(false);
  const [currentPath, setCurrentPath] = useState("");
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]);
  const panelRef = useRef(null);

  // Close on outside click
  useEffect(() => {
    function handleClick(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    }
    if (isOpen) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [isOpen]);

  async function browse(dirPath = "") {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`${API_URL}/api/browse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: dirPath })
      });
      const data = await res.json();
      if (data.success) {
        setItems(data.items || []);
        setCurrentPath(data.path || dirPath);
      } else {
        setError(data.error || "Could not browse directory");
      }
    } catch (err) {
      setError("Failed to connect to server");
    }
    setLoading(false);
  }

  function handleOpen() {
    if (isOpen) {
      setIsOpen(false);
      return;
    }
    setIsOpen(true);
    browse(""); // List drives / root
  }

  function handleNavigate(itemPath) {
    setHistory(h => [...h, currentPath]);
    browse(itemPath);
  }

  function handleBack() {
    const prev = history[history.length - 1];
    setHistory(h => h.slice(0, -1));
    browse(prev || "");
  }

  function handleSelect() {
    if (currentPath) {
      onSelectFolder(currentPath);
      setIsOpen(false);
    }
  }

  return (
    <div className="folder-picker" ref={panelRef}>
      <button
        className="folder-picker-btn"
        onClick={handleOpen}
        disabled={disabled}
        title="Browse folders"
      >
        📂
      </button>

      {isOpen && (
        <div className="folder-picker-panel">
          <div className="folder-picker-header">
            <button
              className="folder-picker-back"
              onClick={handleBack}
              disabled={history.length === 0 && !currentPath}
              title="Go back"
            >
              ⬅
            </button>
            <span className="folder-picker-path" title={currentPath || "Root"}>
              {currentPath || "Select a drive/folder"}
            </span>
            <button
              className="folder-picker-select"
              onClick={handleSelect}
              disabled={!currentPath}
              title="Use this folder"
            >
              ✓ Select
            </button>
          </div>

          <div className="folder-picker-list">
            {loading && <div className="folder-picker-loading">Loading...</div>}
            {error && <div className="folder-picker-error">{error}</div>}
            {!loading && !error && items.length === 0 && (
              <div className="folder-picker-empty">No items</div>
            )}
            {items.map((item, i) => (
              <div
                key={i}
                className={`folder-picker-item ${item.type}`}
                onClick={() => item.type === "directory" || item.type === "drive"
                  ? handleNavigate(item.path)
                  : null}
              >
                <span className="folder-picker-icon">
                  {item.type === "drive" ? "💿" : item.type === "directory" ? "📁" : "📄"}
                </span>
                <span className="folder-picker-name">{item.name}</span>
                {item.size && <span className="folder-picker-size">{item.size}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
