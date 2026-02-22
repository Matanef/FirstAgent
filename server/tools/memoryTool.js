// server/tools/memoryTool.js
// Memory tool with profile retrieval functionality and structured output

import { getMemory, saveJSON, reloadMemory, MEMORY_FILE, getProfile, setProfileField, addOrUpdateContact, deleteContact, listContacts, withMemoryLock } from "../memory.js";

export async function memorytool(request) {
  const text = (request?.text || request || "").trim();
  const lower = text.toLowerCase();
  const context = request?.context || {};

  // Generic "remember my X is Y" handler (supports email, phone, name, tone, whatsapp)
const genericRememberMatch = text.match(/remember(?: that)? my (name|email|phone|whatsapp|tone|location) (?:is|:)?\s*(.+)$/i);
if (genericRememberMatch) {
  const field = genericRememberMatch[1].toLowerCase();
  const value = genericRememberMatch[2].trim();
  if (field && value) {
    // Map field to profile.self path
    const fieldMap = {
      name: "self.name",
      email: "self.email",
      phone: "self.phone",
      whatsapp: "self.whatsapp",
      tone: "self.tone",
      location: "self.location"
    };
    const path = fieldMap[field] || `self.${field}`;
    await setProfileField(path, value);
    return {
      tool: "memorytool",
      success: true,
      final: true,
      data: { message: `Saved your ${field} as ${value}.`, structured: { identity: { [field]: value } } }
    };
  }
}

  // Helper to build structured summary
  async function buildSummary() {
    const mem = await getMemory();
    const profile = mem.profile || {};
    const self = profile.self || {};
    const contacts = profile.contacts || {};
    const contactEntries = Object.entries(contacts).map(([k, v]) => ({ key: k, name: v.name, email: v.email, phone: v.phone }));
    const structured = {
      identity: {
        name: self.name || profile.name || null,
        aliases: self.aliases || [],
        location: self.location || null,
        email: self.email || null,
        phone: self.phone || null,
        tone: self.tone || null
      },
      contacts: contactEntries,
      durable: mem.durable || []
    };

    let text = "📋 **Here's what I remember about you:**\n\n";
    if (structured.identity.name) text += `• **Name:** ${structured.identity.name}\n`;
    if (structured.identity.location) text += `• **Location:** ${structured.identity.location}\n`;
    if (structured.identity.tone) text += `• **Preferred tone:** ${structured.identity.tone}\n`;
    text += `\n**Contacts saved:** ${contactEntries.length}\n`;
    if (contactEntries.length > 0) {
      text += contactEntries.slice(0, 5).map(c => `• ${c.name}: ${c.email || c.phone || 'No details'}`).join("\n");
      if (contactEntries.length > 5) text += `\n• ... and ${contactEntries.length - 5} more`;
    }
    return { text, structured };
  }

  // --- FORGET LOCATION ---
  if (lower.includes("forget my location") || lower.includes("clear my location") || lower.includes("remove my location") || lower.includes("delete my location") || context.raw === "forget_location") {
    const mem = await getMemory();
    if (mem.profile?.self?.location || mem.profile?.location) {
      await setProfileField("self.location", undefined);
      // also remove top-level profile.location if present
      await withMemoryLock(async () => {
        const m = await getMemory();
        if (m.profile?.location) delete m.profile.location;
        await saveJSON(MEMORY_FILE, m);
      });
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

  // --- REMEMBER LOCATION (pattern) ---
  const rememberLocMatch = text.match(/remember(?: that)? my location is (.+)$/i);
  if (rememberLocMatch) {
    const city = rememberLocMatch[1].trim();
    if (city) {
      await setProfileField("self.location", city);
      return {
        tool: "memorytool",
        success: true,
        final: true,
        data: { message: `I've saved your location as ${city}.`, structured: { identity: { location: city } } }
      };
    }
  }

  // --- ADD CONTACT (simple pattern) ---
  const addContactMatch = text.match(/add\s+([^\n,]+)\s+as a contact(?:,?\s*email:\s*([^\s,]+))?/i);
  if (addContactMatch) {
    const name = addContactMatch[1].trim();
    const email = addContactMatch[2] ? addContactMatch[2].trim() : undefined;
    const key = name.toLowerCase().replace(/\s+/g, "_");
    const contact = { name, email, lastUpdated: new Date().toISOString() };
    const saved = await addOrUpdateContact(key, contact);
    return { tool: "memorytool", success: true, final: true, data: { message: `Saved contact ${name}.`, contact: saved } };
  }

  // --- DELETE CONTACT ---
  const delMatch = text.match(/delete contact\s+([^\n]+)/i) || text.match(/remove contact\s+([^\n]+)/i);
  if (delMatch) {
    const key = delMatch[1].trim().toLowerCase().replace(/\s+/g, "_");
    const ok = await deleteContact(key);
    return { tool: "memorytool", success: ok, final: true, data: { message: ok ? `Deleted contact ${key}.` : `No contact named ${key} found.` } };
  }

  // --- PROFILE RETRIEVAL ---
  if (lower.includes("what do you remember") || lower.includes("show my profile") || lower.includes("what's in my profile") || lower.includes("what do you know about me") || lower.includes("tell me about myself")) {
    const { text: summaryText, structured } = await buildSummary();
    const profile = (await getMemory()).profile || {};
    return { tool: "memorytool", success: true, final: true, data: { profile, message: summaryText, structured } };
  }

  // --- META: what can you remember ---
  if (lower.includes("what can you remember") || lower.includes("what do you store") || lower.includes("what information do you keep")) {
    return {
      tool: "memorytool",
      success: true,
      final: true,
      data: {
        message: `🧠 **Memory Capabilities:**\n\nI can remember:\n• Your name\n• Your location\n• Your email\n• Your preferred communication tone\n• Your contacts (with email/phone)\n\nTo save information, tell me:\n• "remember my name is [name]"\n• "remember my location is [city]"\n• "add [name] as a contact, email: [email]"\n\nTo retrieve information:\n• "what do you remember about me?"\n• "show my profile"\n• "list my contacts"\n\nTo forget information:\n• "forget my location"\n• "delete contact [name]"`
      }
    };
  }

  return { tool: "memorytool", success: false, final: true, error: "Memory request not understood.\n\nTry:\n• 'what do you remember about me?'\n• 'remember my location is Paris'\n• 'forget my location'" };
}