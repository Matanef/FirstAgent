// server/utils/emailVerification.js
// Search Gmail inbox for verification emails and extract/click verification links

import { google } from "googleapis";
import { getAuthorizedClient } from "./googleOAuth.js";
import * as cheerio from "cheerio";
import { createHttpClient } from "./httpClient.js";

/**
 * Search Gmail for a verification email from a given domain.
 *
 * @param {string} fromDomain - e.g. "moltbook.com"
 * @param {object} options
 * @param {number} options.maxAge - Max age in hours (default 1)
 * @param {number} options.maxWait - Max wait time in ms (default 120000 = 2min)
 * @param {number} options.pollInterval - Poll interval in ms (default 10000 = 10s)
 * @returns {{ found: boolean, subject?: string, link?: string, messageId?: string, error?: string }}
 */
export async function findVerificationEmail(fromDomain, options = {}) {
  const {
    maxAge = 1,
    maxWait = 120000,
    pollInterval = 10000
  } = options;

  let auth;
  try {
    auth = await getAuthorizedClient();
  } catch (err) {
    return {
      found: false,
      error: `Gmail OAuth not available: ${err.message}. Please set up Gmail OAuth with 'gmail.readonly' scope.`
    };
  }

  const gmail = google.gmail({ version: "v1", auth });
  const query = `from:*@${fromDomain} newer_than:${maxAge}h (subject:verify OR subject:confirm OR subject:activate OR subject:welcome OR subject:registration)`;

  console.log(`[emailVerification] Searching Gmail: ${query}`);

  const startTime = Date.now();
  let attempts = 0;

  while (Date.now() - startTime < maxWait) {
    attempts++;
    console.log(`[emailVerification] Poll attempt ${attempts}...`);

    try {
      const listRes = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: 5
      });

      const messages = listRes.data.messages || [];

      if (messages.length > 0) {
        // Get the most recent matching message
        const msgRes = await gmail.users.messages.get({
          userId: "me",
          id: messages[0].id,
          format: "full"
        });

        const msg = msgRes.data;
        const subject = msg.payload.headers?.find(h => h.name.toLowerCase() === "subject")?.value || "";
        const from = msg.payload.headers?.find(h => h.name.toLowerCase() === "from")?.value || "";

        // Extract body (HTML or plain text)
        let body = "";
        if (msg.payload.parts) {
          for (const part of msg.payload.parts) {
            if (part.mimeType === "text/html" && part.body?.data) {
              body = Buffer.from(part.body.data, "base64").toString("utf8");
              break;
            }
            if (part.mimeType === "text/plain" && part.body?.data && !body) {
              body = Buffer.from(part.body.data, "base64").toString("utf8");
            }
          }
        } else if (msg.payload.body?.data) {
          body = Buffer.from(msg.payload.body.data, "base64").toString("utf8");
        }

        // Extract verification link
        const link = extractVerificationLink(body, fromDomain);

        console.log(`[emailVerification] Found email from ${from}: "${subject}"`);
        if (link) {
          console.log(`[emailVerification] Verification link: ${link}`);
        }

        return {
          found: true,
          subject,
          from,
          link,
          messageId: messages[0].id,
          body: body.slice(0, 1000) // First 1KB for context
        };
      }
    } catch (err) {
      console.warn(`[emailVerification] Gmail API error:`, err.message);
    }

    // Wait before next poll
    if (Date.now() - startTime + pollInterval < maxWait) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    } else {
      break;
    }
  }

  return {
    found: false,
    error: `No verification email from ${fromDomain} found after ${Math.round((Date.now() - startTime) / 1000)}s of polling.`
  };
}

/**
 * Extract a verification link from email HTML/text body.
 */
function extractVerificationLink(body, fromDomain) {
  if (!body) return null;

  // Try HTML parsing first
  try {
    const $ = cheerio.load(body);

    // Look for links with verification-related text
    const verifyPatterns = [
      /verify/i, /confirm/i, /activate/i, /complete.*registration/i, /click.*here/i
    ];

    let verifyLink = null;

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") || "";
      const text = $(el).text().trim();

      // Prioritize links that contain verify/confirm in URL or text
      for (const pattern of verifyPatterns) {
        if (pattern.test(href) || pattern.test(text)) {
          verifyLink = href;
          return false; // break
        }
      }
    });

    if (verifyLink) return verifyLink;
  } catch { /* fall through to regex */ }

  // Fallback: regex for URLs with verification-like paths
  const urlRegex = /https?:\/\/[^\s"'<>]+(?:verify|confirm|activate|token|registration)[^\s"'<>]*/gi;
  const matches = body.match(urlRegex);
  if (matches && matches.length > 0) return matches[0];

  // Last resort: any URL from the expected domain
  const domainRegex = new RegExp(`https?://[^\\s"'<>]*${fromDomain.replace(".", "\\.")}[^\\s"'<>]*`, "gi");
  const domainMatches = body.match(domainRegex);
  if (domainMatches && domainMatches.length > 0) return domainMatches[0];

  return null;
}

/**
 * Click a verification link using a named session's cookies.
 *
 * @param {string} link - The verification URL
 * @param {string} sessionName - Session to use (e.g. "moltbook")
 * @returns {{ success: boolean, statusCode?: number, pageTitle?: string, error?: string }}
 */
export async function clickVerificationLink(link, sessionName = "default") {
  const client = createHttpClient(sessionName, { rateLimit: 500 });

  console.log(`[emailVerification] Clicking verification link: ${link}`);

  const response = await client.get(link);

  if (response.ok) {
    const html = typeof response.data === "string" ? response.data : "";
    const $ = cheerio.load(html);
    const title = $("title").text().trim();

    return {
      success: true,
      statusCode: response.status,
      pageTitle: title,
      url: response.url || link
    };
  }

  return {
    success: false,
    statusCode: response.status,
    error: `Verification link returned HTTP ${response.status}`,
    url: response.url || link
  };
}
