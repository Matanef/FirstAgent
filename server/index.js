import express from "express";
import cors from "cors";
import crypto from "crypto";

import { loadJSON, saveJSON } from "./memory.js";
import { executeStep } from "./executor.js";
import { calculateConfidence } from "./audit.js";
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
    let reply = null;

    const toolType = plan(message);
    const maxSteps = 2;

    for (let step = 1; step <= maxSteps; step++) {
      const result = await executeStep(
        message,
        step,
        stateGraph,
        toolUsage,
        convo
      );

      if (result.reply) {
        reply = result.reply;
        break;
      }
    }

    if (!reply) reply = "(unable to generate response)";

    const confidence = calculateConfidence(stateGraph);

    convo.push({ role: "assistant", content: reply });
    saveJSON(MEMORY_FILE, memory);

    console.log("🧾 STATE GRAPH:", JSON.stringify(stateGraph, null, 2));
    console.log("🤖 REPLY:", reply);
    console.log("==============================\n");

    res.json({ reply, stateGraph, confidence, conversationId: id });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Agent failure" });
  }
});

app.listen(PORT, () => {
  console.log(`🤖 Agent running at http://localhost:${PORT}`);
});
