// server/tools/email.js
// Gmail API email sender using OAuth2 and local token storage

import { google } from "googleapis";
import { getAuthorizedClient } from "../utils/googleOAuth.js";

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
  // For now, treat the whole query as the email body and use a dummy recipient.
  // You can later parse "send an email to X saying Y".
  const to = "example@example.com";
  const subject = "Email from your local AI agent";
  const text = query;

  try {
    const auth = await getAuthorizedClient();
    const gmail = google.gmail({ version: "v1", auth });

    const raw = makeEmailRaw({ to, subject, text });

    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw
      }
    });

    return {
      tool: "email",
      success: true,
      final: true,
      data: {
        to,
        subject,
        text,
        messageId: res.data.id,
        note:
          "Email sent via Gmail API. You can improve parsing to extract recipient and subject from the user message."
      }
    };
  } catch (err) {
    return {
      tool: "email",
      success: false,
      final: true,
      error: `Email tool failed: ${err.message}`
    };
  }
}