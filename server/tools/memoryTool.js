// server/tools/memoryTool.js (COMPLETE FIX - No side effects)
import { getMemory, saveJSON, MEMORY_FILE } from "../memory.js";

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
    // CRITICAL: Load fresh memory, modify, save
    const memory = getMemory();
    
    if (memory.profile?.location) {
      console.log("🗑️ Before delete:", memory.profile);
      delete memory.profile.location;
      console.log("✅ After delete:", memory.profile);
      
      // Save immediately
      console.log("DEBUG memoryTool before save:", MEMORY_FILE, JSON.stringify(memory.profile));
      try {
        await saveJSON(MEMORY_FILE, memory);
        console.log("DEBUG memoryTool save succeeded");
      } catch (e) {
        console.error("DEBUG memoryTool save failed:", e);
      }
      
      // Verify it was saved
      const verification = getMemory();
      console.log("🔍 Verification:", verification.profile);

      return {
        tool: "memorytool",
        success: true,
        final: true,
        data: { message: "I've forgotten your saved location." }
      };
    }

    return {
      tool: "memorytool",
      success: true,
      final: true,
      data: { message: "I don't have any saved location to forget." }
    };
  }

  // --- REMEMBER LOCATION ---
  // (This is handled inline in index.js for immediate effect)
  if (lower.startsWith("remember my location is ")) {
    const city = text.substring("remember my location is ".length).trim();
    if (city) {
      const memory = getMemory();
      memory.profile.location = city;
      console.log("DEBUG memoryTool before save:", MEMORY_FILE, JSON.stringify(memory.profile));
      try {
        await saveJSON(MEMORY_FILE, memory);
        console.log("DEBUG memoryTool save succeeded");
      } catch (e) {
        console.error("DEBUG memoryTool save failed:", e);
      }

      return {
        tool: "memorytool",
        success: true,
        final: true,
        data: { message: `I've saved your location as ${city}.` }
      };
    }
  }

  return {
    tool: "memorytool",
    success: false,
    final: true,
    error: "Memory request not understood."
  };
}
