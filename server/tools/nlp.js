// E:\testFolder\nlp.js

import natural from "natural";
import nlp from "compromise";
import nlpDates from "compromise-dates";

// Extend compromise with dates plugin
nlp.extend(nlpDates);

class Analyzer {
  static stemmer = natural.PorterStemmer;
  static analyzer = new natural.SentimentAnalyzer("English", Analyzer.stemmer, "afinn");

  static analyzeSentiment(text) {
    if (!text) return { score: 0, sentiment: "neutral" };

    const tokenizer = new natural.WordTokenizer();
    const tokens = tokenizer.tokenize(text);
    const score = Analyzer.analyzer.getSentiment(tokens) || 0;

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
}

class EntityExtractor {
  static compromise = nlp;

  static extractEntities(text) {
    const doc = EntityExtractor.compromise(text);
    
    return {
      people: typeof doc.people === 'function' ? doc.people().out('array') : [],
      places: typeof doc.places === 'function' ? doc.places().out('array') : [],
      organizations: typeof doc.organizations === 'function' ? doc.organizations().out('array') : [],
      dates: typeof doc.dates === 'function' ? doc.dates().json().map(d => d.text) : [],
      emails: typeof doc.emails === 'function' ? doc.emails().out('array') : [],
      numbers: typeof doc.numbers === 'function' ? doc.numbers().out('array') : []
    };
  }
}

export async function analyzeSentiment(text) {
  try {
    if (!text) throw new Error("Text cannot be empty");
    return Analyzer.analyzeSentiment(text);
  } catch (error) {
    throw new Error(`Sentiment analysis failed: ${error.message}`);
  }
}

export async function extractEntities(text) {
  try {
    if (!text) throw new Error("Text cannot be empty");
    return EntityExtractor.extractEntities(text);
  } catch (error) {
    throw new Error(`Entity extraction failed: ${error.message}`);
  }
}

export async function nlpTool(query) {
  try {
    if (typeof query.text !== "string" || query.text.length < 2) {
      throw new Error("Please provide valid text to analyze.");
    }

    const textToAnalyze = query.text;
    const sentiment = await analyzeSentiment(textToAnalyze);
    const entities = await extractEntities(textToAnalyze);

    const textSummary = `NLP Analysis Results:

Sentiment: ${sentiment.sentiment.toUpperCase()} (score: ${sentiment.score})

Entities Detected:
${entities.people.length > 0 ? `• People: ${entities.people.join(", ")}` : ""}
${entities.places.length > 0 ? `• Places: ${entities.places.join(", ")}` : ""}
${entities.organizations.length > 0 ? `• Organizations: ${entities.organizations.join(", ")}` : ""}
${entities.dates.length > 0 ? `• Dates: ${entities.dates.join(", ")}` : ""}
${entities.emails.length > 0 ? `• Emails: ${entities.emails.join(", ")}` : ""}
${Object.values(entities).every(arr => arr.length === 0) ? "• No entities detected" : ""}`;

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
            ${entities.people.length > 0 ? `<li>👤 <strong>People:</strong> ${entities.people.join(", ")}</li>` : ""}
            ${entities.places.length > 0 ? `<li>📍 <strong>Places:</strong> ${entities.places.join(", ")}</li>` : ""}
            ${entities.organizations.length > 0 ? `<li>🏢 <strong>Orgs:</strong> ${entities.organizations.join(", ")}</li>` : ""}
            ${entities.dates.length > 0 ? `<li>📅 <strong>Dates:</strong> ${entities.dates.join(", ")}</li>` : ""}
            ${entities.emails.length > 0 ? `<li>📧 <strong>Emails:</strong> ${entities.emails.join(", ")}</li>` : ""}
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

    return {
      tool: "nlp_tool",
      success: true,
      final: true,
      data: {
        sentiment,
        entities,
        html,
        text: textSummary
      }
    };

  } catch (error) {
    return {
      tool: "nlp_tool",
      success: false,
      final: true,
      error: `NLP Analysis failed: ${error.message}`
    };
  }
}