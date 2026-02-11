import express from "express";
import cors from "cors";
import crypto from "crypto";
import { loadJSON, saveJSON } from "./helpers.js";
import { executeStep } from "./executor.js";
import { calculateConfidence, MAX_TOOL_CALLS } from "./audit.js";
import { plan } from "./planner.js";

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

const MEMORY_FILE = "./memory.json";

app.post("/chat", async (req, res) => {
  try {
    const { message, conversationId } = req.body;
    if (!message) return res.status(400).json({ error: "Missing message" });

    console.log("\n==============================");
    console.log("👤 USER:", message);

    const memory = loadJSON(MEMORY_FILE, { conversations: {} });
    const id = conversationId || crypto.randomUUID();
    memory.conversations[id] ??= [];
    const convo = memory.conversations[id];

    convo.push({ role: "user", content: message });

    const stateGraph = [];
    const toolUsage = {};
    let reply = "";

    const toolType = plan(message);
    const maxSteps = MAX_TOOL_CALLS[toolType] || 3;

    for (let step = 1; step <= maxSteps; step++) {
      const result = await executeStep(message, step, stateGraph, memory, toolUsage, convo);
      reply = result.reply ?? reply;

      const confidence = calculateConfidence(stateGraph);
      if (confidence >= 0.7 || (reply && !["(no search results)", "(tool budget exceeded)"].includes(reply))) break;
    }

    convo.push({ role: "assistant", content: reply });
    saveJSON(MEMORY_FILE, memory);

    console.log("🧾 STATE GRAPH:", JSON.stringify(stateGraph, null, 2));
    console.log("🤖 REPLY:", reply);
    console.log("==============================\n");

    res.json({ reply, conversationId: id, stateGraph, confidence: calculateConfidence(stateGraph) });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Agent failure" });
  }
});

app.listen(PORT, () => {
  console.log(`🤖 Agent running at http://localhost:${PORT}`);
});
