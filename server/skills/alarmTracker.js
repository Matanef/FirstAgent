// server/skills/alarmTracker.js
import { TOOLS } from "../tools/index.js";
import { sendWhatsAppMessage } from "../tools/whatsapp.js";

// Keep track of the active background interval so we can stop it later
let activeInterval = null;
let seenTweets = []; // Array to remember the last 50 alerts
let isFirstRun = true;

export async function alarmTracker(request) {
    const text = typeof request === "string" ? request : (request?.text || request?.input || "");
    const lower = text.toLowerCase();

    // ── 1. HANDLE STOP REQUEST ──
    if (lower.includes("stop") || lower.includes("cancel")) {
        if (activeInterval) {
            clearInterval(activeInterval);
            activeInterval = null;
            lastSeenText = null;
            return { 
                success: true, 
                final: true, 
                data: { text: "🛑 Alarm tracker stopped successfully." } 
            };
        }
        return { 
            success: true, 
            final: true, 
            data: { text: "No active alarm tracker is currently running." } 
        };
    }

    // ── 2. HANDLE START REQUEST ──
    // Prevent multiple trackers running at once
    if (activeInterval) {
        return { 
            success: true, 
            final: true, 
            data: { text: "⚠️ The alarm tracker is already running in the background!" } 
        };
    }

    // Extract the target WhatsApp number from your prompt
    const phoneMatch = text.match(/(?:\+?\d[\d\s\-\(\)]{6,18}\d)/);
    const phone = phoneMatch ? phoneMatch[0].replace(/[\s\-\(\)]/g, "") : null;

    if (!phone) {
        return { 
            success: false, 
            final: true, 
            error: "Please provide a WhatsApp number. Example: 'call alarmTracker to start sending alerts to 0587426393'" 
        };
    }

    // Define the target Twitter account (Change this to whatever account you want!)
    const TARGET_ACCOUNT = "ILRedAlert"; // or PikudHaoref1, etc.
    const CHECK_INTERVAL_MS = 60 * 1000; // Check every 60 seconds

    console.log(`🚨 [alarmTracker] Starting background monitor for @${TARGET_ACCOUNT}. Sending alerts to ${phone}.`);

// ── 3. THE BACKGROUND LOOP ──
    activeInterval = setInterval(async () => {
        try {
            // Call your existing X core tool to fetch the latest tweets
            const xResult = await TOOLS.x({
                text: `search X for from:${TARGET_ACCOUNT} latest`,
                context: { action: "search" }
            });

            const rawOutput = xResult.data?.text || xResult.output || "";

// ── EXTRACTION & CLEANUP ──
            const tweetRegex = /<div class="x-tweet-text"[^>]*>([\s\S]*?)<\/div>/gi;
            let match;
            const fetchedTweets = [];

            // 1. Try to extract HTML tweets first
            while ((match = tweetRegex.exec(rawOutput)) !== null) {
                const cleanText = match[1].replace(/<[^>]+>/g, "").replace(/\s{2,}/g, " ").trim();
                if (cleanText && !cleanText.toLowerCase().includes("error")) {
                    fetchedTweets.push(cleanText);
                }
            }

            // 2. FALLBACK: If HTML parsing found zero tweets, handle the raw text
            if (fetchedTweets.length === 0) {
                console.log(`⚠️ [alarmTracker] Zero HTML tweets found! Raw output snippet:`, rawOutput.substring(0, 150).replace(/\n/g, " "));
                
                // Strip all tags just in case, and clean it up
                const fallbackText = rawOutput.replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim();
                
                // If it's a real message (not an error or empty), push it as one giant block
                if (fallbackText.length > 10 && !fallbackText.toLowerCase().includes("error") && !fallbackText.toLowerCase().includes("no results")) {
                    fetchedTweets.push(fallbackText);
                }
            }

            if (isFirstRun && fetchedTweets.length > 0) {
                // On the very first run, just memorize everything currently on the page so we don't spam you
                seenTweets = [...fetchedTweets];
                isFirstRun = false;
                console.log(`🚨 [alarmTracker] Baseline established. Memorized ${fetchedTweets.length} recent alerts.`);
            } 
            else if (!isFirstRun && fetchedTweets.length > 0) {
                const newAlerts = [];
                
                // Read from bottom-to-top (oldest to newest) so WhatsApp gets them in chronological order
                for (const twt of fetchedTweets.reverse()) {
                    // If this tweet is NOT in our memory list, it's a new alert!
                    if (!seenTweets.includes(twt)) {
                        newAlerts.push(twt);
                        seenTweets.push(twt); // Add it to memory so we don't send it again
                    }
                }

                // Prevent our memory array from growing infinitely and crashing the server
                if (seenTweets.length > 50) {
                    seenTweets = seenTweets.slice(-50); // Keep only the newest 50
                }

                // Send a WhatsApp message for EVERY new alert found
                for (const alert of newAlerts) {
                    console.log(`🚨 [alarmTracker] NEW ALERT DETECTED! Sending to WhatsApp...`);
                    await sendWhatsAppMessage(phone, `🚨 *New Alert (@${TARGET_ACCOUNT})*\n\n${alert}`);
                    
                    // Wait 1 second between messages so WhatsApp doesn't block us for spamming
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        } catch (err) {
            console.error("❌ [alarmTracker] Background check failed:", err.message);
        }
    }, CHECK_INTERVAL_MS);

    return {
        success: true,
        final: true,
        data: { 
            text: `✅ Alarm tracker engaged! Monitoring @${TARGET_ACCOUNT} every 60 seconds. New alerts will be sent to WhatsApp number ${phone}. \n\nTo turn it off, just tell me "call alarmTracker and stop".` 
        }
    };
}