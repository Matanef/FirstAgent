// server/tools/memoryTool.js
// COMPLETE FIX: Memory tool with profile retrieval functionality

import { getMemory, saveJSON, reloadMemory, MEMORY_FILE } from "../memory.js";

export async function memorytool(request) {
  const text = request?.text || request || "";
  const lower = text.toLowerCase();
  const context = request?.context || {};

  // --- FORGET LOCATION ---
  if (
    lower.includes("forget my location") ||
    lower.includes("clear my location") ||
    lower.includes("remove my location") ||
    lower.includes("delete my location") ||
    context.raw === "forget_location"
  ) {
    const memory = await getMemory();
    if (memory.profile?.location) {
      delete memory.profile.location;
      await saveJSON(MEMORY_FILE, memory);
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
  if (lower.includes("remember my location is ") || lower.includes("remember that my location is ")) {
    const match = text.match(/remember(?: that)? my location is (.+)$/i);
    if (match) {
      const city = match[1].trim();
      if (city) {
        const memory = await getMemory();
        memory.profile.location = city;
        await saveJSON(MEMORY_FILE, memory);
        return {
          tool: "memorytool",
          success: true,
          final: true,
          data: { message: `I've saved your location as ${city}.` }
        };
      }
    }
  }

  // --- GENERIC REMEMBER: "remember my [field] is [value]" ---
  const genericRememberMatch = text.match(/remember(?:\s+that)?\s+my\s+([\w][\w\s]*?)\s+is\s+(.+)$/i);
  if (genericRememberMatch) {
    const field = genericRememberMatch[1].trim().toLowerCase();
    const value = genericRememberMatch[2].trim();

    if (value) {
      // Map common field variations to standard profile keys
      const fieldMap = {
        'email': 'email', 'email address': 'email', 'e-mail': 'email',
        'name': 'name', 'first name': 'name', 'full name': 'name',
        'location': 'location', 'city': 'location', 'town': 'location',
        'tone': 'tone', 'preferred tone': 'tone', 'communication style': 'tone',
        'phone': 'phone', 'phone number': 'phone',
        'birthday': 'birthday', 'birth date': 'birthday',
        'job': 'job', 'occupation': 'job', 'role': 'job',
        'company': 'company', 'workplace': 'company',
        'language': 'language', 'timezone': 'timezone',
        'favorite color': 'favoriteColor', 'favourite colour': 'favoriteColor'
      };

      const profileKey = fieldMap[field] || field.replace(/\s+/g, '_');

      const memory = await getMemory();
      memory.profile = memory.profile || {};
      memory.profile[profileKey] = value;
      await saveJSON(MEMORY_FILE, memory);

      return {
        tool: "memorytool",
        success: true,
        final: true,
        data: { message: `I've saved your ${field} as "${value}".` }
      };
    }
  }

  // FIX #5: PROFILE RETRIEVAL - "what do you remember about me?"
  if (
    lower.includes("what do you remember") ||
    lower.includes("what do you know about me") ||
    lower.includes("tell me about myself") ||
    lower.includes("what is my information") ||
    lower.includes("show my profile") ||
    lower.includes("my profile") ||
    lower.includes("what's in my profile")
  ) {
    const memory = await getMemory();
    const profile = memory.profile || {};

    if (Object.keys(profile).length === 0) {
      return {
        tool: "memorytool",
        success: true,
        final: true,
        data: {
          profile: {},
          message: "I don't have any information saved about you yet.\n\nYou can tell me things like:\n• 'remember my name is John'\n• 'remember my location is London'"
        }
      };
    }

    // Build profile summary
    let summary = "📋 **Here's what I remember about you:**\n\n";
    if (profile.name) summary += `• **Name:** ${profile.name}\n`;
    if (profile.location) summary += `• **Location:** ${profile.location}\n`;
    if (profile.email) summary += `• **Email:** ${profile.email}\n`;
    if (profile.tone) summary += `• **Preferred tone:** ${profile.tone}\n`;

    // Include contacts if any
    if (profile.contacts && Object.keys(profile.contacts).length > 0) {
      summary += `\n**Contacts saved:** ${Object.keys(profile.contacts).length}\n`;
      const contactList = Object.entries(profile.contacts)
        .slice(0, 5)
        .map(([key, c]) => `• ${c.name}: ${c.email || c.phone || 'No details'}`)
        .join('\n');
      summary += contactList;
      if (Object.keys(profile.contacts).length > 5) {
        summary += `\n• ... and ${Object.keys(profile.contacts).length - 5} more`;
      }
    }

    return {
      tool: "memorytool",
      success: true,
      final: true,
      data: {
        profile,
        message: summary
      }
    };
  }

  // FIX #5: META QUESTIONS - "what can you remember?"
  if (
    lower.includes("what can you remember") ||
    lower.includes("what do you store") ||
    lower.includes("what information do you keep")
  ) {
    return {
      tool: "memorytool",
      success: true,
      final: true,
      data: {
        message: `🧠 **Memory Capabilities:**

I can remember:
• Your name
• Your location
• Your email
• Your preferred communication tone
• Your contacts (with email/phone)

**To save information, just tell me:**
• "remember my name is [name]"
• "remember my location is [city]"
• "add [name] as a contact, email: [email]"

**To retrieve information:**
• "what do you remember about me?"
• "show my profile"
• "list my contacts"

**To forget information:**
• "forget my location"
• "delete contact [name]"`
      }
    };
  }

  return {
    tool: "memorytool",
    success: false,
    final: true,
    error: "Memory request not understood.\n\nTry:\n• 'what do you remember about me?'\n• 'remember my location is Paris'\n• 'forget my location'"
  };
}
