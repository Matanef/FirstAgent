// server/tools/memoryTool.js
// Memory tool: atomic saves, robust deletes, and debug logs.

import { getMemory, saveJSON, reloadMemory, withMemoryLock, MEMORY_FILE } from "../memory.js";

export async function memorytool(request) {
  const text = request?.text || request || "";
  const lower = text.toLowerCase();
  const context = request?.context || {};

  // --- FORGET LOCATION ---
  if (
    lower.includes("forget my location") ||
    lower.includes("forget my saved location") ||
    lower.includes("clear my location") ||
    lower.includes("remove my location") ||
    lower.includes("delete my location") ||
    context.raw === "forget_location"
  ) {
    const memory = await getMemory();
    if (memory.profile?.location) {
      console.log("🗑️ Before delete:", memory.profile);
      delete memory.profile.location;
      console.log("✅ After delete:", memory.profile);
      console.log("DEBUG memoryTool before save:", MEMORY_FILE, JSON.stringify(memory.profile));
      try {
        await saveJSON(MEMORY_FILE, memory);
        console.log("DEBUG memoryTool save succeeded");
      } catch (e) {
        console.error("DEBUG memoryTool save failed:", e);
        return { tool: "memorytool", success: false, final: true, error: "Failed to save memory." };
      }
      const verification = await reloadMemory();
      console.log("🔍 Verification:", verification.profile);
      return { tool: "memorytool", success: true, final: true, data: { message: "I've forgotten your saved location." } };
    }
    return { tool: "memorytool", success: true, final: true, data: { message: "I don't have any saved location to forget." } };
  }

  // --- REMEMBER LOCATION ---
  if (lower.includes("remember my location is ") || lower.includes("remember that my location is ")) {
    const match = text.match(/remember(?: that)? my location is (.+)$/i);
    if (match) {
      const city = match[1].trim();
      if (city) {
        const memory = await getMemory();
        memory.profile.location = city;
        console.log("DEBUG memoryTool before save:", MEMORY_FILE, JSON.stringify(memory.profile));
        try {
          await saveJSON(MEMORY_FILE, memory);
          console.log("DEBUG memoryTool save succeeded");
        } catch (e) {
          console.error("DEBUG memoryTool save failed:", e);
          return { tool: "memorytool", success: false, final: true, error: "Failed to save memory." };
        }
        return { tool: "memorytool", success: true, final: true, data: { message: `I've saved your location as ${city}.` } };
      }
    }
  }

  return { tool: "memorytool", success: false, final: true, error: "Memory request not understood." };
}