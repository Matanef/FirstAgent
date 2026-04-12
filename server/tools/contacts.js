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

        // ADD CONTACT (but NOT alias/nickname commands — those are handled separately below)
        if ((lower.includes("add") || lower.includes("save") || (lower.includes("remember") && (lower.includes("contact") || lower.includes("name")))) &&
            !/\b(alias|nickname|aka)\b/i.test(lower)) {
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

        // DELETE CONTACT
        if (/\b(delete|remove)\b/i.test(lower) && /\bcontact\b/i.test(lower)) {
            // Extract the contact name from "delete contact John Smith" or "remove contact alias to Rafael"
            const deleteMatch = queryText.match(/(?:delete|remove)\s+(?:the\s+)?contact\s+(.+)/i);
            if (!deleteMatch) {
                return {
                    tool: "contacts", success: false, final: true,
                    error: "Please specify which contact to delete. Example: \"Delete contact John Smith\""
                };
            }
            const target = deleteMatch[1].trim();
            const match = fuzzyMatchContact(target, memory.profile.contacts);
            if (!match) {
                return {
                    tool: "contacts", success: false, final: true,
                    error: `Contact "${target}" not found. Use "list all my contacts" to see available contacts.`
                };
            }
            const deletedName = match.contact.name || match.key;
            delete memory.profile.contacts[match.key];
            await saveJSON(MEMORY_FILE, memory);
            return {
                tool: "contacts", success: true, final: true,
                data: { text: `🗑️ Deleted contact: **${deletedName}**`, preformatted: true }
            };
        }

        // ADD/REMOVE ALIAS
        if (/\b(alias|nickname|also\s+known\s+as|aka)\b/i.test(lower)) {
            const isRemove = /\b(delete|remove)\b/i.test(lower);
            const aliasMatch = queryText.match(
                /(?:add|set|create|delete|remove)\s+(?:an?\s+)?(?:alias|nickname|aka)\s+["']?([^"',]+?)["']?\s+(?:to|for|from|of)\s+(.+)/i
            ) || queryText.match(
                /(?:alias)\s+(.+?)\s+(?:as|:)\s+["']?([^"']+)["']?/i
            );

            if (!aliasMatch) {
                return {
                    tool: "contacts", success: false, final: true,
                    error: "Could not parse alias command. Try:\n• \"Add alias Rafi to Rafael Efrati\"\n• \"Remove alias Rafi from Rafael Efrati\""
                };
            }

            const aliasName = aliasMatch[1].trim();
            const contactName = aliasMatch[2].trim();
            const match = fuzzyMatchContact(contactName, memory.profile.contacts);
            if (!match) {
                return {
                    tool: "contacts", success: false, final: true,
                    error: `Contact "${contactName}" not found. Use "list all my contacts" to see available contacts.`
                };
            }

            if (!match.contact.aliases) match.contact.aliases = [];

            if (isRemove) {
                const idx = match.contact.aliases.findIndex(a => a.toLowerCase() === aliasName.toLowerCase());
                if (idx === -1) {
                    return {
                        tool: "contacts", success: false, final: true,
                        error: `Alias "${aliasName}" not found on contact ${match.contact.name || match.key}.`
                    };
                }
                match.contact.aliases.splice(idx, 1);
                await saveJSON(MEMORY_FILE, memory);
                return {
                    tool: "contacts", success: true, final: true,
                    data: { text: `🗑️ Removed alias "${aliasName}" from **${match.contact.name || match.key}**`, preformatted: true }
                };
            } else {
                if (!match.contact.aliases.includes(aliasName)) {
                    match.contact.aliases.push(aliasName);
                }
                await saveJSON(MEMORY_FILE, memory);
                return {
                    tool: "contacts", success: true, final: true,
                    data: { text: `✅ Added alias "${aliasName}" to **${match.contact.name || match.key}**\nAliases: ${match.contact.aliases.join(", ")}`, preformatted: true }
                };
            }
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

        // LOOKUP CONTACT (query about a specific person)
        if (/\b(what(?:'?s| is)|get|show|find|look\s*up)\b/i.test(lower) && /\b(email|phone|number|contact|info)\b/i.test(lower)) {
            // "What's John's email?" / "Get Rafael's phone number"
            const lookupMatch = queryText.match(/(?:what(?:'?s|\s+is)|get|show|find)\s+(\w+(?:\s+\w+)?)'?s?\s+(?:email|phone|number|contact|info)/i)
                || queryText.match(/(?:email|phone|number|info)\s+(?:for|of)\s+(\w+(?:\s+\w+)?)/i);

            if (lookupMatch) {
                const target = lookupMatch[1].trim();
                const match = fuzzyMatchContact(target, memory.profile.contacts);
                if (match) {
                    const c = match.contact;
                    const parts = [`📇 **${c.name || match.key}**`];
                    if (c.email) parts.push(`📧 Email: ${c.email}`);
                    if (c.phone) parts.push(`📱 Phone: ${c.phone}`);
                    if (c.aliases?.length) parts.push(`🏷️ Aliases: ${c.aliases.join(", ")}`);
                    return {
                        tool: "contacts", success: true, final: true,
                        data: { text: parts.join("\n"), preformatted: true }
                    };
                }
                return {
                    tool: "contacts", success: false, final: true,
                    error: `Contact "${target}" not found.`
                };
            }
        }

        // UPDATE CONTACT (change email/phone)
        if (/\b(update|change|set|edit)\b/i.test(lower) && /\bcontact\b/i.test(lower)) {
            const updateMatch = queryText.match(
                /(?:update|change|set|edit)\s+(?:contact\s+)?(.+?)(?:'s)?\s+(?:email|phone|number)\s+(?:to\s+)?(.+)/i
            );
            if (updateMatch) {
                const target = updateMatch[1].trim();
                const newValue = updateMatch[2].trim();
                const match = fuzzyMatchContact(target, memory.profile.contacts);
                if (!match) {
                    return {
                        tool: "contacts", success: false, final: true,
                        error: `Contact "${target}" not found.`
                    };
                }
                const isEmail = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(newValue);
                if (isEmail) {
                    match.contact.email = newValue;
                } else {
                    match.contact.phone = newValue.replace(/\s+/g, "");
                }
                await saveJSON(MEMORY_FILE, memory);
                return {
                    tool: "contacts", success: true, final: true,
                    data: { text: `✅ Updated **${match.contact.name || match.key}** — ${isEmail ? "📧 " + newValue : "📱 " + newValue}`, preformatted: true }
                };
            }
        }

        // DEFAULT: Show help
        return {
            tool: "contacts",
            success: true,
            final: true,
            data: {
                text: `📇 **Contact Management**\n\n**Commands:**\n• "Add contact: Name, email@example.com, 0541234567"\n• "List all my contacts"\n• "What's John's email?"\n• "Delete contact John"\n• "Add alias Rafi to Rafael Efrati"\n• "Remove alias Rafi from Rafael Efrati"\n• "Update contact John's email to john@new.com"`,
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
