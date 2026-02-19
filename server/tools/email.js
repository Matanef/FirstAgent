// server/tools/email.js (ENHANCED - Draft confirmation before sending)
import { google } from "googleapis";
import { getAuthorizedClient } from "../utils/googleOAuth.js";

// Parse email details from natural language
function parseEmailRequest(query) {
  const lower = query.toLowerCase();
  
  // Extract recipient
  let to = null;
  const toMatch = lower.match(/to\s+([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
  if (toMatch) {
    to = toMatch[1];
  }
  
  // Extract subject
  let subject = "Message from AI Agent";
  const subjectMatch = lower.match(/subject[:\s]+([^\n]+)/i);
  if (subjectMatch) {
    subject = subjectMatch[1].trim();
  }
  
  // Extract body (everything after "saying" or "message:")
  let body = query;
  const sayingMatch = query.match(/saying[:\s]+(.+)$/is);
  if (sayingMatch) {
    body = sayingMatch[1].trim();
  } else {
    const messageMatch = query.match(/message[:\s]+(.+)$/is);
    if (messageMatch) {
      body = messageMatch[1].trim();
    }
  }
  
  return { to, subject, body };
}

function makeEmailRaw({ to, subject, text }) {
  const message = [
    `To: ${to}`,
    "Content-Type: text/plain; charset=utf-8",
    "MIME-Version: 1.0",
    `Subject: ${subject}`,
    "",
    text
  ].join("\n");

  return Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function email(query) {
  const { to, subject, body } = parseEmailRequest(query);
  
  if (!to) {
    return {
      tool: "email",
      success: false,
      final: true,
      error: "Could not detect recipient email address. Please specify 'to someone@example.com'"
    };
  }

  // Return draft for confirmation
  return {
    tool: "email",
    success: true,
    final: false,
    data: {
      mode: "draft",
      to,
      subject,
      body,
      message: `📧 **Email Draft:**\n\n**To:** ${to}\n**Subject:** ${subject}\n**Message:**\n${body}\n\nSay "send it" to confirm, or "cancel" to discard.`
    }
  };
}

// Separate function to actually send after confirmation
export async function sendConfirmedEmail({ to, subject, body }) {
  try {
    const auth = await getAuthorizedClient();
    const gmail = google.gmail({ version: "v1", auth });

    const raw = makeEmailRaw({ to, subject, text: body });

    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw }
    });

    return {
      tool: "email",
      success: true,
      final: true,
      data: {
        to,
        subject,
        body,
        messageId: res.data.id,
        message: `✅ Email sent successfully to ${to}`
      }
    };
  } catch (err) {
    return {
      tool: "email",
      success: false,
      final: true,
      error: `Email sending failed: ${err.message}`
    };
  }
}
