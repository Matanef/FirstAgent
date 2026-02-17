// server/tools/memoryTool.js
import { getMemory, saveJSON, MEMORY_FILE } from "../memory.js";

export async function memorytool(request) {
  const text = request?.text || request || "";
  const lower = text.toLowerCase();
  const context = request?.context || {};
  const memory = getMemory();

  // --- FORGET LOCATION ---
  if (
    lower.includes("forget my location") ||
    lower.includes("forget my saved location") ||
    lower.includes("clear my location") ||
    lower.includes("remove my location") ||
    context.raw === "forget_location"
  ) {
    if (memory.profile?.location) {
      console.log("Before delete:", memory.profile);
      delete memory.profile.location;
      console.log("After delete:", memory.profile);
      saveJSON(MEMORY_FILE, memory);
      console.log("Saved memory:", getMemory().profile);


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
  if (lower.startsWith("remember my location is ")) {
    const city = text.substring("remember my location is ".length).trim();
    if (city) {
      memory.profile.location = city;
      saveJSON(MEMORY_FILE, memory);

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