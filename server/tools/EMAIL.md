✍️ 1. Composing & AI Drafting (LLM Generation)

Because you added the LLM generator, sentiment dictionary, and word count extractor, you can give highly specific stylistic prompts.
    Note: The tool looks for specific keywords like happy, sad, professional, and word counts like 100 words.
    Basic AI Generation: "Write a 100 word professional email to boss@company.com about the Q3 budget."
    Sentiment / Tone Control: "Send an email to support@wifi.com regarding my broken router. Make it angry."
    Implicit Subject & Tone: "Write a grateful thank you email to efratimatan@gmail.com."
    Style overrides: "Email Mom about the family dinner this weekend in a casual vibe."
    Short/Precise constraints: "Write a 50 word sarcastic email to dave@work.com about his missing coffee mug."
📎 2. Attachments & Formatting
Your regex patterns (multiAttachRegex, attachmentPatterns, and HTML detection) allow you to bundle files and format text effortlessly.
    Note: Files must exist in your uploads, downloads, or root directory.
    Single Attachment: "Send an email to hr@company.com with resume.pdf attached saying here is my application."
    Multiple Attachments: "Email finance@company.com attach Q1_report.xlsx and receipts.pdf regarding the budget review."
    HTML Emails: "Send an HTML email to marketing@acme.com subject: Newsletter saying <h1>Great job team!</h1>"
🎯 3. Advanced Routing (CC, BCC, Explicit Subjects)
If you don't want the AI to generate the body, you can explicitly dictate the exact fields using your parsing keywords (cc:, bcc:, subject:, saying:).
    Full Explicit Routing: "Write an email to team@company.com cc: boss@company.com bcc: audit@company.com subject: Weekly Update saying the project is on track."
    Using Contact Names (via contacts.js): "Send an email to Matan subject: Lunch saying let's meet at 12."
    Just CC and Body: "Email john@example.com cc: jane@example.com saying please review the attached document."
📖 4. Browsing & Reading the Inbox
Your browseEmails function uses Gmail search syntax (q) mapped to natural language keywords.
    General Inbox Check: "Check my inbox." (or "Show my inbox", "Read my inbox")
    Filter by State: "List my unread important emails."
    Filter by Sender: "Browse my inbox for emails from newsletter@company.com."
    Filter by Topic: "Check my inbox regarding the upcoming flight."
🗑️ 5. Trashing & Deleting
Thanks to the interceptor we added at the top of the function, your agent safely routes these to the deleteEmails function using Gmail's trash capabilities.
    Delete by Sender: "Delete emails from annoying_spam@marketing.com."
    Delete by Date: "Trash emails before 2023-01-01."
    Delete by Topic: "Remove emails about 'Discount offer'."
    Combined Deletion: "Delete emails from promotions@store.com before 2024-01-01."
💡 Pro-Tip for your Agent:
Because your tool generates a Draft first, you can always test the wilder AI generation prompts (like #5 or #2) safely. It will pause and ask you to say "send it" or "cancel", giving you full control over what actually leaves your outbox!