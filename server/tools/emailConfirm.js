// server/tools/emailConfirm.js
// Confirmation tool for email drafts: send or cancel

import { getDraft, clearDraft } from "../utils/emailDrafts.js";
import { sendConfirmedEmail } from "./email.js";

export async function email_confirm(request) {
  try {
    const ctx = request?.context || {};
    const action = ctx.action || (typeof request === "string" ? request : "");
    const sessionId = ctx.sessionId || "default";

    if (action === "cancel") {
      const ok = await clearDraft(sessionId);
      return {
        tool: "email_confirm",
        success: ok,
        final: true,
        data: { message: ok ? "Email draft canceled." : "No draft to cancel." }
      };
    }

    if (action === "send_confirmed") {
      const draft = await getDraft(sessionId);
      if (!draft) {
        return { tool: "email_confirm", success: false, final: true, error: "No draft to send." };
      }

      const res = await sendConfirmedEmail({ draft, sessionId });
      if (res.success) {
        return { tool: "email_confirm", success: true, final: true, data: { message: "Email sent.", result: res } };
      } else {
        return { tool: "email_confirm", success: false, final: true, error: res.error || "Send failed." };
      }
    }

    return { tool: "email_confirm", success: false, final: true, error: "Unknown action" };
  } catch (err) {
    return { tool: "email_confirm", success: false, final: true, error: err?.message || String(err) };
  }
}