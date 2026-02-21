// server/utils/uiUtils.js
/**
 * Convert markdown tables to HTML with specific wrapper classes
 */
export function convertMarkdownTablesToHTML(text) {
    if (!text) return "";
    const tableRegex = /\|(.+)\|\n\|[-:\s|]+\|\n((?:\|.+\|\n?)+)/g;

    return text.replace(tableRegex, (match, headers, rows) => {
        const headerCells = headers.split('|').map(h => h.trim()).filter(Boolean);
        const rowData = rows.trim().split('\n').map(row =>
            row.split('|').map(cell => cell.trim()).filter(Boolean)
        );

        let html = '<div class="ai-table-wrapper"><table class="ai-table">';
        html += '<thead><tr>';
        headerCells.forEach(h => html += `<th>${h}</th>`);
        html += '</tr></thead><tbody>';

        rowData.forEach(row => {
            html += '<tr>';
            row.forEach(cell => html += `<td>${cell}</td>`);
            html += '</tr>';
        });

        html += '</tbody></table></div>';
        return html;
    });
}

/**
 * Check if the user is asking for a table format
 */
export function wantsTableFormat(userQuestion) {
    const lower = (userQuestion || "").toLowerCase();
    return (
        lower.includes("show in a table") ||
        lower.includes("show it in a table") ||
        lower.includes("display in a table") ||
        lower.includes("table format") ||
        lower.includes("as a table") ||
        lower.includes("in table form") ||
        lower.includes("tabular") ||
        lower.includes("make a table") ||
        lower.includes("create a table")
    );
}

/**
 * Normalize common city aliases (e.g. for weather)
 */
export function normalizeCityAliases(message) {
    if (!message || typeof message !== "object") return message;

    if (message.context?.city) {
        const c = message.context.city.toLowerCase();

        const aliases = {
            givataim: "Givatayim",
            "giv'atayim": "Givatayim",
            givatayim: "Givatayim"
        };

        if (aliases[c]) {
            message.context.city = aliases[c];
        }
    }

    return message;
}

/**
 * Helper to get text content from a message object/string
 */
export function getMessageText(message) {
    return typeof message === "string" ? message : message?.text;
}
