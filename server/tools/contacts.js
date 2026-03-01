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
 */
export function extractContactRef(query) {
    const lower = query.toLowerCase();

    const patterns = [
        /([a-z]+(?:\s+[a-z]+)?)['’]s\s+(?:phone|email|number)/i,
        /(?:to|email|send|call|text|message|contact)\s+(?:my\s+)?([a-z0-9]+(?:\s+[a-z0-9]+)?)/i,
        /(?:for|with)\s+([a-z0-9]+(?:\s+[a-z0-9]+)?)/i
    ];

    for (const pattern of patterns) {
        const match = lower.match(pattern);
        if (match) {
            const ref = match[1].trim();
            const stopwords = ["the", "a", "an", "about", "saying", "that", "with", "from", "it", "this", "my"];
            if (!stopwords.includes(ref) && ref.length > 1) {
                return ref;
            }
        }
    }

    return null;
}

/**
 * Extract phone/email/name from natural language
 */
function extractDetails(query) {
    const emailMatch = query.match(/email(?:\s+is|[:=\s]+)\s*([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
    const phoneMatch = query.match(/phone(?:\s+number)?(?:\s+is|[:=\s]+)\s*([\+\d\s\(\)-]+)/i);
    const nameMatch = query.match(/name(?:\s+is|[:=\s]+)\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);

    return {
        email: emailMatch ? emailMatch[1] : null,
        phone: phoneMatch ? phoneMatch[1].replace(/\s+/g, "") : null,
        name: nameMatch ? nameMatch[1] : null
    };
}

/**
 * Resolve contact by name/alias
 */
export async function resolveContact(contactRef) {
    const memory = await getMemory();
    const contacts = memory.profile?.contacts || {};

    if (Object.keys(contacts).length === 0) return null;

    return fuzzyMatchContact(contactRef, contacts);
}

/**
 * Main contact tool
 */
export async function contacts(query) {
    try {
        const memory = await getMemory();
        const lower = query.toLowerCase();

        if (!memory.profile) memory.profile = {};
        if (!memory.profile.contacts) memory.profile.contacts = {};
        if (!memory.contactState) memory.contactState = {};
        const contacts = memory.profile.contacts;

        // ---------------------------------------
        // HANDLE PENDING ACTIONS
        // ---------------------------------------
        if (memory.contactState.pendingAction) {
            const action = memory.contactState.pendingAction;

            // User chooses option 1: update existing
            if (["1", "update", "yes"].includes(lower.trim())) {
                const contact = contacts[action.contactKey];
                if (action.newPhone) contact.phone = action.newPhone;
                if (action.newEmail) contact.email = action.newEmail;
                if (action.newName) contact.name = action.newName;

                memory.contactState.pendingAction = null;
                await saveJSON(MEMORY_FILE, memory);

                return {
                    tool: "contacts",
                    success: true,
                    final: true,
                    data: {
                        message: `Updated contact "${contact.name}".`,
                        contact
                    }
                };
            }

            // User chooses option 2: add new contact with new name
            if (["2", "add", "new", "add new"].includes(lower.trim())) {
                memory.contactState.pendingAction.awaitingNewName = true;

                await saveJSON(MEMORY_FILE, memory);

                return {
                    tool: "contacts",
                    success: true,
                    final: true,
                    data: {
                        message: `What should I name the new contact?`
                    }
                };
            }

            // User provides the new name
            if (action.awaitingNewName) {
                const newName = query.trim();
                const key = newName.toLowerCase().replace(/\s+/g, "_");

                contacts[key] = {
                    name: newName,
                    email: action.newEmail,
                    phone: action.newPhone,
                    aliases: [],
                    dateAdded: new Date().toISOString()
                };

                memory.contactState.pendingAction = null;
                await saveJSON(MEMORY_FILE, memory);

                return {
                    tool: "contacts",
                    success: true,
                    final: true,
                    data: {
                        message: `Added new contact "${newName}".`,
                        contact: contacts[key]
                    }
                };
            }

            // User chooses option 3: cancel
            if (["3", "cancel", "stop"].includes(lower.trim())) {
                memory.contactState.pendingAction = null;
                await saveJSON(MEMORY_FILE, memory);

                return {
                    tool: "contacts",
                    success: true,
                    final: true,
                    data: { message: "Cancelled." }
                };
            }
        }

        // ---------------------------------------
        // DELETE CONTACT
        // ---------------------------------------
        if (lower.includes("delete contact") || lower.includes("remove contact")) {
            const ref = extractContactRef(query);
            if (!ref) {
                return {
                    tool: "contacts",
                    success: false,
                    final: true,
                    data: { message: "I couldn't identify which contact to delete." }
                };
            }

            const match = fuzzyMatchContact(ref, contacts);
            if (!match) {
                return {
                    tool: "contacts",
                    success: false,
                    final: true,
                    data: { message: `No contact found matching "${ref}".` }
                };
            }

            delete contacts[match.key];
            await saveJSON(MEMORY_FILE, memory);

            return {
                tool: "contacts",
                success: true,
                final: true,
                data: { message: `Deleted contact "${match.contact.name}".` }
            };
        }

        // ---------------------------------------
        // ADD ALIAS
        // ---------------------------------------
        if (lower.includes("alias") || lower.includes("nickname")) {
            const ref = extractContactRef(query);
            if (!ref) {
                return {
                    tool: "contacts",
                    success: false,
                    final: true,
                    data: { message: "I couldn't identify which contact to add an alias to." }
                };
            }

            const match = fuzzyMatchContact(ref, contacts);
            if (!match) {
                return {
                    tool: "contacts",
                    success: false,
                    final: true,
                    data: { message: `No contact found matching "${ref}".` }
                };
            }

            const aliasMatch = query.match(/alias[:\s]+([A-Za-z0-9\s]+)/i);
            if (!aliasMatch) {
                return {
                    tool: "contacts",
                    success: false,
                    final: true,
                    data: { message: "I couldn't find the alias to add." }
                };
            }

            const alias = aliasMatch[1].trim();
            match.contact.aliases.push(alias);

            await saveJSON(MEMORY_FILE, memory);

            return {
                tool: "contacts",
                success: true,
                final: true,
                data: {
                    message: `Added alias "${alias}" to contact "${match.contact.name}".`,
                    contact: match.contact
                }
            };
        }

        // ---------------------------------------
        // ADD OR UPDATE CONTACT (AMBIGUOUS)
        // ---------------------------------------
        if (lower.includes("remember") || lower.includes("add") || lower.includes("save")) {
            const ref = extractContactRef(query);
            const details = extractDetails(query);

            if (!ref && !details.email && !details.phone) {
                return {
                    tool: "contacts",
                    success: false,
                    final: true,
                    data: { message: "I couldn't understand which contact to add or update." }
                };
            }

            const match = ref ? fuzzyMatchContact(ref, contacts) : null;

            // Contact exists → ask user what to do
            if (match) {
                memory.contactState.pendingAction = {
                    type: "update_or_add",
                    contactKey: match.key,
                    newPhone: details.phone,
                    newEmail: details.email,
                    newName: details.name,
                    awaitingNewName: false
                };

                await saveJSON(MEMORY_FILE, memory);

                return {
                    tool: "contacts",
                    success: true,
                    final: true,
                    data: {
                        message:
`I already have a contact named "${match.contact.name}".  
What should I do?

1. Update the existing contact  
2. Add a new contact with a different name  
3. Cancel`
                    }
                };
            }

            // New contact
            const name = details.name || ref || (details.email ? details.email.split("@")[0] : "Unknown");
            const key = name.toLowerCase().replace(/\s+/g, "_");

            contacts[key] = {
                name,
                email: details.email,
                phone: details.phone,
                aliases: [],
                dateAdded: new Date().toISOString()
            };

            await saveJSON(MEMORY_FILE, memory);

            return {
                tool: "contacts",
                success: true,
                final: true,
                data: {
                    message: `Added contact "${name}".`,
                    contact: contacts[key]
                }
            };
        }

        // ---------------------------------------
        // LIST CONTACTS
        // ---------------------------------------
        if (lower.includes("list") || (lower.includes("show") && lower.includes("contact"))) {
            const list = Object.entries(contacts).map(([key, c]) => ({ key, ...c }));

            if (list.length === 0) {
                return {
                    tool: "contacts",
                    success: true,
                    final: true,
                    data: { message: "No contacts saved yet." }
                };
            }

            return {
                tool: "contacts",
                success: true,
                final: true,
                data: {
                    contacts: list,
                    message: `Found ${list.length} contacts:\n${list
                        .map(c => `• ${c.name}: ${c.email || c.phone || "No details"}`)
                        .join("\n")}`
                }
            };
        }

        // ---------------------------------------
        // DEFAULT HELP
        // ---------------------------------------
        return {
            tool: "contacts",
            success: true,
            final: true,
            data: {
                message:
`Contact Management

Commands:
• add Mom as a contact, email: mom@example.com
• mom's phone is 0501234567
• update John's email to john@new.com
• add alias to Mom: Mama
• delete contact John
• list contacts`
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