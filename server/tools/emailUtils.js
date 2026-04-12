export const emailRegex = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,63}/i;
export const subjectRegex = /subject[:\s]+([^\n]+)/i;
export const sayingRegex = /saying[:\s]+(.+?)(?:\s+with\s+(?:the\s+)?(?:planner|executor|subject|attachment)|$)/is;

export const attachmentPatterns = [
  /with\s+(.+?\.(?:pdf|docx|xlsx|png|jpg|jpeg|txt|csv))\s+attached/gi,
  /attach(?:ing)?\s+(.+?\.(?:pdf|docx|xlsx|png|jpg|jpeg|txt|csv))/gi,
  /send\s+(?:the\s+)?(.+?\.(?:pdf|docx|xlsx|png|jpg|jpeg|txt|csv))/gi
];

export const SENTIMENT_KEYWORDS = [
  'happy', 'sad', 'funny', 'formal', 'official', 'comforting', 'motivational', 
  'romantic', 'angry', 'apologetic', 'professional', 'casual', 'friendly', 
  'serious', 'solemn', 'sarcastic', 'enthusiastic', 'grateful'
];

// server/tools/emailUtils.js
export function stripMarkdown(text) {
  // Only strip underscores, backticks, and tildes. 
  // Keep asterisks so the email tool can use them for logic/cleaning.
  return text.replace(/[_`~]/g, "").trim();
}

/**
 * Detects the sentiment of a given text.
 * @param {string} text - The text to analyze.
 * @returns {string|null} - The detected sentiment keyword or null if none found.
 */
export function detectSentiment(text) {
  const lower = text.toLowerCase();
  const sentimentPattern = new RegExp(
    `\\b(?<keyword>${SENTIMENT_KEYWORDS.join('|')})\\b|` + 
    `\\bmake (?:it|the email)\\s+(?<makeIt>[a-z]+)\\b|` + 
    `\\b(?:in|with)\\s+(?:a|an)?\\s*(?<style>[a-z]+)\\s+(?:style|tone|vibe|way)\\b|` + 
    `\\b(?<beforeEmail>[a-z]+)\\s+(?:thank you\\s+)?email\\b`,
    "i"
  );

  const match = lower.match(sentimentPattern);
  if (!match) return null;

  const found = match.groups.keyword || match.groups.makeIt || match.groups.style || match.groups.beforeEmail;
  return SENTIMENT_KEYWORDS.includes(found) ? found : null;
}