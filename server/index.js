import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// --------------------
// Memory (persistent)
// --------------------
const MEMORY_FILE = path.resolve("./memory.json");

function loadMemory() {
  if (!fs.existsSync(MEMORY_FILE)) {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify([]));
  }
  return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8"));
}

function saveMemory(memory) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

// --------------------
// Chat route
// --------------------
app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: "Missing message" });
    }

    const memory = loadMemory();

    // add user message
    memory.push({ role: "user", content: message });

    // build prompt from memory
    const prompt = memory
      .map(m => `${m.role}: ${m.content}`)
      .join("\n");

    const ollamaRes = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "mat-llm",
        prompt,
        stream: false
      })
    });

    const data = await ollamaRes.json();
    const reply = data.response ?? "(no response)";

    // add assistant reply
    memory.push({ role: "assistant", content: reply });

    // persist memory
    saveMemory(memory);

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "LLM server error" });
  }
});

// --------------------
app.listen(PORT, () => {
  console.log(`🤖 Agent server running at http://localhost:${PORT}`);
});
