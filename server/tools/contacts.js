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
        // Handle both string and object input to prevent toLowerCase crash
        const queryText = typeof query === "string" ? query : (query?.text || query?.input || String(query));
        const lower = queryText.toLowerCase();

        // Ensure contacts exist in profile
        if (!memory.profile) memory.profile = {};
        if (!memory.profile.contacts) {
            memory.profile.contacts = {};
        }

        // ADD CONTACT
        if (lower.includes("add") || lower.includes("save") || (lower.includes("remember") && (lower.includes("contact") || lower.includes("name")))) {
            // Parse labeled format: "add contact, email: john@example.com, phone: +1234567890"
            const labeledEmailMatch = queryText.match(/email[:\s]+([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
            const labeledPhoneMatch = queryText.match(/phone[:\s]+([\+\d\s\(\)-]+)/i);

            // Parse CSV-style format: "Add contact: Name, email@example.com, 0541234567"
            // Also handles: "Add contact: Name, email, phone" without labels
            const csvMatch = queryText.match(/(?:add|save|remember)\s+contact[:\s]+\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s*[,;]\s*([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\s*[,;]\s*([\+\d\s\(\)-]{7,})/i);

            // Parse labeled name format: "add contact name: John Smith"
            const nameMatch = queryText.match(/(?:add|save|remember)\s+(?:contact[:\s]+\s*)?(?:name[:\s]+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i) ||
                queryText.match(/(?:add|save|remember)\s+(?:that\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+(?:to\s+contacts|as\s+a\s+contact)/i);

            // Auto-detect unlabeled email and phone anywhere in input
            const anyEmailMatch = labeledEmailMatch || queryText.match(/\b([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\b/i);
            const anyPhoneMatch = labeledPhoneMatch || queryText.match(/\b((?:\+?\d[\d\s\-\(\)]{6,18}\d))\b/);

            let name, email, phone;

            if (csvMatch) {
                // CSV format: "Add contact: Rafi Efrati, rafi@gmail.com, 0523321756"
                name = csvMatch[1].trim();
                email = csvMatch[2].trim();
                phone = csvMatch[3].replace(/\s+/g, "").trim();
            } else if (nameMatch || anyEmailMatch) {
                name = nameMatch ? nameMatch[1].trim() : (anyEmailMatch ? anyEmailMatch[1].split('@')[0] : "Unknown");
                email = anyEmailMatch ? anyEmailMatch[1] : null;
                phone = anyPhoneMatch ? anyPhoneMatch[1].replace(/\s+/g, "") : null;
            } else {
                // No parseable data
                return {
                    tool: "contacts",
                    success: false,
                    final: true,
                    error: "Could not parse contact details. Try:\n• \"Add contact: John Smith, john@example.com, 0541234567\"\n• \"Add contact name: John, email: john@example.com, phone: 0541234567\""
                };
            }

            const key = name.toLowerCase().replace(/\s+/g, "_");
            memory.profile.contacts[key] = {
                name,
                email: email || null,
                phone: phone || null,
                aliases: [],
                dateAdded: new Date().toISOString()
            };

            await saveJSON(MEMORY_FILE, memory);

            return {
                tool: "contacts",
                success: true,
                final: true,
                data: {
                    text: `✅ Added contact: ${name}\n${email ? `📧 Email: ${email}\n` : ""}${phone ? `📱 Phone: ${phone}\n` : ""}\nYou can now reference "${name}" in messages and emails!`,
                    preformatted: true
                }
            };
        }

        // LIST CONTACTS
        if (lower.includes("list") || lower.includes("all") || (lower.includes("show") && lower.includes("contact"))) {
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
                        text: "📇 No contacts saved yet.\n\nAdd a contact with: 'Add contact: Name, email@example.com, 0541234567'",
                        preformatted: true
                    }
                };
            }

            const formatted = contactList.map(c => {
                const parts = [`• **${c.name}**`];
                if (c.email) parts.push(`📧 ${c.email}`);
                if (c.phone) parts.push(`📱 ${c.phone}`);
                return parts.join(" — ");
            }).join('\n');

            return {
                tool: "contacts",
                success: true,
                final: true,
                data: {
                    text: `📇 **Contacts** (${contactList.length}):\n\n${formatted}`,
                    contacts: contactList,
                    preformatted: true
                }
            };
        }

        // DEFAULT: Show help
        return {
            tool: "contacts",
            success: true,
            final: true,
            data: {
                text: `📇 **Contact Management**\n\n**Commands:**\n• "Add contact: Name, email@example.com, 0541234567"\n• "List all my contacts"\n• "What's John's email?"\n• "Delete contact John"`,
                preformatted: true
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
