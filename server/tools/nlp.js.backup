// server/tools/nlp.js
// FIXED: Natural Language Processing - Sentiment Analysis & Entity Recognition
// Returns text for LLM summarization, HTML in data field for UI

import natural from "natural";
import nlp from "compromise";
import nlpDates from "compromise-dates";

// Extend compromise with dates plugin
nlp.extend(nlpDates);

const Analyzer = natural.SentimentAnalyzer;
const stemmer = natural.PorterStemmer;
const analyzer = new Analyzer("English", stemmer, "afinn");

/**
 * analyzeSentiment
 * Returns a score between -5 and 5
 */
export function analyzeSentiment(text) {
  if (!text) return { score: 0, sentiment: "neutral" };

  const tokenizer = new natural.WordTokenizer();
  const tokens = tokenizer.tokenize(text);
  const score = analyzer.getSentiment(tokens) || 0;

  let sentiment = "neutral";
  if (score > 0.5) sentiment = "positive";
  else if (score < -0.5) sentiment = "negative";

  const divisor = tokens.length || 1;
  return {
    score: Math.round(score * 100) / 100,
    sentiment,
    comparative: score / divisor
  };
}

/**
 * extractEntities
 * Uses compromise to pull out names, places, etc.
 */
export function extractEntities(text) {
  const doc = nlp(text);

  return {
    people: typeof doc.people === 'function' ? doc.people().out('array') : [],
    places: typeof doc.places === 'function' ? doc.places().out('array') : [],
    organizations: typeof doc.organizations === 'function' ? doc.organizations().out('array') : [],
    dates: typeof doc.dates === 'function' ? doc.dates().json().map(d => d.text) : [],
    emails: typeof doc.emails === 'function' ? doc.emails().out('array') : [],
    numbers: typeof doc.numbers === 'function' ? doc.numbers().out('array') : []
  };
}

/**
 * NLP Tool
 * FIXED: Returns text summary for LLM, HTML in data field only
 */
export async function nlpTool(query) {
  try {
    const textToAnalyze = query.text || query;

    if (typeof textToAnalyze !== 'string' || textToAnalyze.length < 2) {
      return {
        tool: "nlp_tool",
        success: false,
        final: true,
        error: "Please provide text to analyze."
      };
    }

    const sentiment = analyzeSentiment(textToAnalyze);
    const entities = extractEntities(textToAnalyze);

    // Build text summary for LLM
    const textSummary = `NLP Analysis Results:

Sentiment: ${sentiment.sentiment.toUpperCase()} (score: ${sentiment.score})

Entities Detected:
${entities.people.length > 0 ? `• People: ${entities.people.join(', ')}` : ''}
${entities.places.length > 0 ? `• Places: ${entities.places.join(', ')}` : ''}
${entities.organizations.length > 0 ? `• Organizations: ${entities.organizations.join(', ')}` : ''}
${entities.dates.length > 0 ? `• Dates: ${entities.dates.join(', ')}` : ''}
${entities.emails.length > 0 ? `• Emails: ${entities.emails.join(', ')}` : ''}
${Object.values(entities).every(arr => arr.length === 0) ? '• No entities detected' : ''}`;

    // Build HTML for rich display (stored in data, not returned as main text)
    const html = `
      <div class="nlp-analysis">
        <h3>🔍 NLP Analysis</h3>
        
        <div class="sentiment-box ${sentiment.sentiment}">
          <strong>Sentiment:</strong> ${sentiment.sentiment.toUpperCase()} (${sentiment.score})
        </div>

        <div class="entities-section">
          <h4>Entities Detected:</h4>
          ${entities.people.length > 0 || entities.places.length > 0 || entities.organizations.length > 0 || entities.dates.length > 0 || entities.emails.length > 0 ? `
          <ul>
            ${entities.people.length > 0 ? `<li>👤 <strong>People:</strong> ${entities.people.join(', ')}</li>` : ''}
            ${entities.places.length > 0 ? `<li>📍 <strong>Places:</strong> ${entities.places.join(', ')}</li>` : ''}
            ${entities.organizations.length > 0 ? `<li>🏢 <strong>Orgs:</strong> ${entities.organizations.join(', ')}</li>` : ''}
            ${entities.dates.length > 0 ? `<li>📅 <strong>Dates:</strong> ${entities.dates.join(', ')}</li>` : ''}
            ${entities.emails.length > 0 ? `<li>📧 <strong>Emails:</strong> ${entities.emails.join(', ')}</li>` : ''}
          </ul>
          ` : '<p>No entities detected.</p>'}
        </div>
      </div>
      
      <style>
        .nlp-analysis {
          background: var(--bg-tertiary);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 1rem;
          margin: 1rem 0;
        }
        .sentiment-box {
          padding: 0.75rem;
          border-radius: 6px;
          margin-bottom: 1rem;
          text-align: center;
          font-weight: 600;
        }
        .sentiment-box.positive { background: #d4edda; color: #155724; }
        .sentiment-box.negative { background: #f8d7da; color: #721c24; }
        .sentiment-box.neutral { background: #e2e3e5; color: #383d41; }
        .entities-section h4 {
          margin-top: 1rem;
          color: var(--text-primary);
        }
        .entities-section ul {
          list-style: none;
          padding: 0;
        }
        .entities-section li {
          margin-bottom: 0.5rem;
          font-size: 0.9rem;
        }
      </style>
    `;

    // CRITICAL FIX: Return text in main output, HTML in data
    return {
      tool: "nlp_tool",
      success: true,
      final: true,
      data: {
        sentiment,
        entities,
        html,  // HTML stored here for optional rich rendering
        text: textSummary  // Clean text for LLM
      }
    };

  } catch (err) {
    return {
      tool: "nlp_tool",
      success: false,
      final: true,
      error: `NLP Analysis failed: ${err.message}`
    };
  }
}
