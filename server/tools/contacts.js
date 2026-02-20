// server/tools/contacts.js
// Contact Recognition & Management - Natural language contact resolution

import { getMemory, saveJSON, MEMORY_FILE } from "../memory.js";

/**
 * Fuzzy match contact names/aliases
 */
function fuzzyMatchContact(query, contacts) {
    const lower = query.toLowerCase();

    // Exact matches first
    for (const [key, contact] of Object.entries(contacts)) {
        if (lower === key.toLowerCase()) return { key, contact };
        if (contact.name && lower === contact.name.toLowerCase()) return { key, contact };
        if (contact.aliases) {
            for (const alias of contact.aliases) {
                if (lower === alias.toLowerCase()) return { key, contact };
            }
        }
    }

    // Partial matches
    for (const [key, contact] of Object.entries(contacts)) {
        if (lower.includes(key.toLowerCase())) return { key, contact };
        if (contact.name && lower.includes(contact.name.toLowerCase())) return { key, contact };
        if (contact.aliases) {
            for (const alias of contact.aliases) {
                if (lower.includes(alias.toLowerCase())) return { key, contact };
            }
        }
    }

    return null;
}

/**
 * Extract contact reference from natural language
 * Examples: "send email to mom", "call john", "text my boss"
 */
export function extractContactRef(query) {
    const lower = query.toLowerCase();

    // Patterns: "to X", "contact X", "call X", "text X", "email X", "send X an email"
    const patterns = [
        /(?:to|email|send|call|text|message|contact)\s+(?:my\s+)?([a-z0-9]+(?:\s+[a-z0-9]+)?)(?:\s+an\s+email|\s+a\s+message|\s+contact|\s+as\s+a\s+contact)?/i,
        /(?:for|with)\s+([a-z0-9]+(?:\s+[a-z0-9]+)?)\b/i
    ];

    for (const pattern of patterns) {
        const match = lower.match(pattern);
        if (match) {
            const ref = match[1].trim();
            // Filter out common words and short junk
            const stopwords = ["the", "a", "an", "about", "saying", "that", "with", "from", "it", "this", "my"];
            if (!stopwords.includes(ref) && ref.length > 1) {
                return ref;
            }
        }
    }

    return null;
}

/**
 * Resolve contact by name/alias to email/phone
 */
export async function resolveContact(contactRef) {
    const memory = await getMemory();
    const contacts = memory.profile?.contacts || {};

    if (Object.keys(contacts).length === 0) {
        return null;
    }

    return fuzzyMatchContact(contactRef, contacts);
}

export async function contacts(query) {
    try {
        const memory = await getMemory();
        const lower = query.toLowerCase();

        // Ensure contacts exist in profile
        if (!memory.profile) memory.profile = {};
        if (!memory.profile.contacts) {
            memory.profile.contacts = {};
        }

        // ADD CONTACT
        if (lower.includes("add") || lower.includes("save") || lower.includes("remember") && (lower.includes("contact") || lower.includes("name"))) {
            // Parse: "add john smith as a contact, email: john@example.com, phone: +1234567890"
            const nameMatch = query.match(/(?:add|save|remember)\s+(?:contact\s+)?(?:name[:\s]+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i) ||
                query.match(/(?:add|save|remember)\s+(?:that\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:to\s+contacts|as\s+a\s+contact)/i);

            const emailMatch = query.match(/email[:\s]+([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
            const phoneMatch = query.match(/phone[:\s]+([\+\d\s\(\)-]+)/i);

            if (nameMatch || emailMatch) {
                let name = nameMatch ? nameMatch[1].trim() : (emailMatch ? emailMatch[1].split('@')[0] : "Unknown");
                const key = name.toLowerCase().replace(/\s+/g, "_");

                memory.profile.contacts[key] = {
                    name: name,
                    email: emailMatch ? emailMatch[1] : null,
                    phone: phoneMatch ? phoneMatch[1].replace(/\s+/g, "") : null,
                    aliases: [],
                    dateAdded: new Date().toISOString()
                };

                await saveJSON(MEMORY_FILE, memory);

                return {
                    tool: "contacts",
                    success: true,
                    final: true,
                    data: {
                        action: "added",
                        contact: memory.profile.contacts[key],
                        message: `✅ Added contact: ${name}\n${emailMatch ? `📧 Email: ${emailMatch[1]}\n` : ""}${phoneMatch ? `📱 Phone: ${phoneMatch[1]}\n` : ""}\n\nYou can now reference "${name}" in messages and emails!`
                    }
                };
            }
        }

        // LIST CONTACTS
        if (lower.includes("list") || (lower.includes("show") && lower.includes("contact"))) {
            const contactList = Object.entries(memory.profile.contacts).map(([key, c]) => ({
                key,
                ...c
            }));

            if (contactList.length === 0) {
                return {
                    tool: "contacts",
                    success: true,
                    final: true,
                    data: {
                        message: "📇 No contacts saved yet.\n\nAdd a contact with: 'add Mom as a contact, email: mom@example.com'"
                    }
                };
            }

            return {
                tool: "contacts",
                success: true,
                final: true,
                data: {
                    contacts: contactList,
                    message: `Found ${contactList.length} contacts:\n${contactList.map(c => `• ${c.name}: ${c.email || c.phone || 'No details'}`).join('\n')}`
                }
            };
        }

        // DEFAULT: Show help
        return {
            tool: "contacts",
            success: true,
            final: true,
            data: {
                message: `📇 Contact Management\n\n**Commands:**\n• "add Mom as a contact, email: mom@example.com"\n• "list contacts"\n• "what's john's email?"\n• "delete contact john"`
            }
        };

    } catch (err) {
        console.error("Contacts error:", err);
        return {
            tool: "contacts",
            success: false,
            final: true,
            error: `Contact operation failed: ${err.message}`
        };
    }
}
