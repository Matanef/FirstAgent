// server/tools/emailConfirm.js
// Confirmation tool for email drafts: send or cancel

import { getDraft, clearDraft } from "../utils/emailDrafts.js";
import { sendConfirmedEmail } from "./email.js";

export async function email_confirm(request) {
  try {
    const ctx       = request?.context || {};
    const action    = ctx.action || (typeof request === "string" ? request : "");
    const sessionId = ctx.sessionId || "default";

    // ── CANCEL ───────────────────────────────────────────────
    if (action === "cancel") {
      const ok = await clearDraft(sessionId);
      return {
        tool: "email_confirm",
        success: ok,
        final: true,
        data: { message: ok ? "Email draft canceled." : "No draft to cancel." }
      };
    }

    // ── SEND ─────────────────────────────────────────────────
    if (action === "send_confirmed") {
      const draft = await getDraft(sessionId);

      if (!draft) {
        return {
          tool: "email_confirm",
          success: false,
          final: true,
          error: "No draft to send. Please create an email draft first."
        };
      }

      // FIX: spread draft fields — sendConfirmedEmail expects { to, subject, body, attachments }
      const { to, subject, body, attachments = [] } = draft;

      if (!to) {
        return {
          tool: "email_confirm",
          success: false,
          final: true,
          error: "Draft is missing recipient address. Please create a new email draft."
        };
      }

      const res = await sendConfirmedEmail({ to, subject, body, attachments });

      if (res.success) {
        await clearDraft(sessionId); // clean up after successful send
        return {
          tool: "email_confirm",
          success: true,
          final: true,
          data: { message: `✅ Email sent to ${to}`, result: res }
        };
      } else {
        return {
          tool: "email_confirm",
          success: false,
          final: true,
          error: res.error || "Send failed."
        };
      }
    }

    return {
      tool: "email_confirm",
      success: false,
      final: true,
      error: `Unknown action: "${action}". Expected "send_confirmed" or "cancel".`
    };

  } catch (err) {
    return {
      tool: "email_confirm",
      success: false,
      final: true,
      error: err?.message || String(err)
    };
  }
}
