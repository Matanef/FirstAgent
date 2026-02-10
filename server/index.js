import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

app.post("/chat", async (req, res) => {
  const { message } = req.body;

  const response = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "mat-llm",
      prompt: message,
      stream: false
    })
  });

  const data = await response.json();
  res.json({ reply: data.response });
});


app.post("/chat", async (req, res) => {
  const userMessage = req.body.message;

  const ollamaRes = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "mat-llm",
      prompt: userMessage,
      stream: false
    })
  });

  const data = await ollamaRes.json();
  res.json({ reply: data.response });
});

let memory = [];

app.post("/chat", async (req, res) => {
  const userMessage = req.body.message;

  memory.push({ role: "user", content: userMessage });

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

  memory.push({ role: "assistant", content: data.response });

  res.json({ reply: data.response });
});

const PORT = 3000
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

