// server/utils/nlpUtils.js
import { analyzeSentiment, extractEntities } from "../tools/nlp.js";

/**
 * Executes a safe background NLP analysis and returns default values on failure.
 */
export function getBackgroundNLP(queryText) {
    let sentiment = { sentiment: "neutral", score: 0 };
    let entities = { people: [], places: [], organizations: [], dates: [] };

    try {
        sentiment = analyzeSentiment(queryText);
        entities = extractEntities(queryText);
        console.log(`🧠 Background NLP: Sentiment=${sentiment.sentiment}(${sentiment.score}), Entities=${(entities.people?.length || 0) + (entities.places?.length || 0)}`);
    } catch (err) {
        console.error("⚠️ Background NLP analysis failed:", err.message);
    }

    return { sentiment, entities };
}
