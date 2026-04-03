// server/skills/pikudTracker.js
import { sendWhatsAppMessage } from "../tools/whatsapp.js";

let activeInterval = null;
let seenAlertIds = []; // Memory array to prevent duplicate WhatsApp messages

export async function pikudTracker(request) {
    const text = typeof request === "string" ? request : (request?.text || request?.input || "");
    const lower = text.toLowerCase();

    // ── 1. HANDLE STOP REQUEST ──
    if (lower.includes("stop") || lower.includes("cancel")) {
        if (activeInterval) {
            clearInterval(activeInterval);
            activeInterval = null;
            seenAlertIds = [];
            return { 
                success: true, 
                final: true, 
                data: { text: "🛑 Pikud HaOref tracker stopped successfully." } 
            };
        }
        return { 
            success: true, 
            final: true, 
            data: { text: "No active Pikud HaOref tracker is currently running." } 
        };
    }

    // ── 2. HANDLE START REQUEST ──
    if (activeInterval) {
        return { 
            success: true, 
            final: true, 
            data: { text: "⚠️ The Pikud HaOref tracker is already running in the background!" } 
        };
    }

    // Extract the target WhatsApp number
    const phoneMatch = text.match(/(?:\+?\d[\d\s\-\(\)]{6,18}\d)/);
    const phone = phoneMatch ? phoneMatch[0].replace(/[\s\-\(\)]/g, "") : null;

    if (!phone) {
        return { 
            success: false, 
            final: true, 
            error: "Please provide a WhatsApp number. Example: 'call pikudTracker to send alerts to 0587426393'" 
        };
    }

    // ── CONFIGURATION ──
    // Add any cities here in HEBREW exactly as Pikud HaOref spells them.
    const TARGET_CITIES = [
        "גבעתיים", 
        "תל אביב - מרכז",
        "תל אביב - דרום",
        "תל אביב - מזרח",
        "רמת גן"
    ]; 
    
    const CHECK_INTERVAL_MS = 3000; // Poll every 3 seconds!

    console.log(`🚨 [pikudTracker] Monitoring Pikud HaOref for: ${TARGET_CITIES.join(", ")}. Sending alerts to ${phone}.`);

    // ── 3. THE BACKGROUND LOOP ──
    activeInterval = setInterval(async () => {
        try {
            // The official unofficial Pikud HaOref live alerts endpoint
            const response = await fetch("https://www.oref.org.il/WarningMessages/alert/alerts.json", {
                headers: {
                    // Pikud HaOref blocks requests without these specific headers
                    "X-Requested-With": "XMLHttpRequest",
                    "Referer": "https://www.oref.org.il/",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
                }
            });

            const rawText = await response.text();

            // If the response is empty, there are no active sirens anywhere in the country.
            if (!rawText || rawText.trim() === "") {
                return; // Silently do nothing and check again in 3 seconds
            }

            // Parse the active alert JSON
            const alertData = JSON.parse(rawText);
            
            // alertData looks like this: { id: "123", cat: "1", title: "ירי רקטות וטילים", data: ["גבעתיים", "אשדוד"] }
            if (alertData && alertData.data && alertData.id) {
                
                // Have we already alerted you about this exact event ID?
                if (seenAlertIds.includes(alertData.id)) {
                    return; 
                }

                // Check if any of the cities currently experiencing an alarm match your target list
                const affectedTargetCities = alertData.data.filter(city => TARGET_CITIES.includes(city));

                if (affectedTargetCities.length > 0) {
                    console.log(`🚨 [pikudTracker] ALARM IN TARGET CITIES: ${affectedTargetCities.join(", ")}!`);
                    
                    const message = `🚨 *צבע אדום* 🚨\n\n*אזור:* ${affectedTargetCities.join(", ")}\n*סוג:* ${alertData.title}\n*הנחיות:* ${alertData.desc}`;
                    
                    await sendWhatsAppMessage(phone, message);
                    
                    // Memorize this event ID so we don't spam you for the next 2 minutes while the alarm is still active on the server
                    seenAlertIds.push(alertData.id);
                    
                    // Keep memory clean
                    if (seenAlertIds.length > 50) seenAlertIds.shift();
                }
            }
        } catch (err) {
            // Ignore JSON parsing errors from Pikud HaOref's messy backend, but log real network errors
            if (!err.message.includes("Unexpected token")) {
                console.error("❌ [pikudTracker] Polling error:", err.message);
            }
        }
    }, CHECK_INTERVAL_MS);

    return {
        success: true,
        final: true,
        data: { 
            text: `🛡️ Pikud HaOref live tracker engaged! Monitoring ${TARGET_CITIES.length} areas every 3 seconds. Alerts will be sent to WhatsApp number ${phone}. \n\nTo turn it off, tell me "call pikudTracker and stop".` 
        }
    };
}