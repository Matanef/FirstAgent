// server/tools/geminiValidator.js
import { GoogleGenAI, Type } from '@google/genai';

// Initialize the SDK. It automatically picks up process.env.GEMINI_API_KEY
const ai = new GoogleGenAI({});

/**
 * Sends proposed code to Gemini to validate logic, syntax, and intent.
 */
export async function validateWithGemini({ filename, originalCode, proposedCode, intent }) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is missing from .env");
  }

  const prompt = `You are the Senior Staff Engineer acting as a final code reviewer (Critic).
An autonomous AI agent (Actor) has attempted to modify a file.
Your job is to prevent the agent from breaking the system.

FILE TARGET: ${filename}
USER'S GOAL/INTENT: ${intent}

--- ORIGINAL CODE ---
${originalCode}

--- AGENT'S PROPOSED CODE ---
${proposedCode}

CRITICAL CHECKS:
1. Did the agent accidentally delete code or truncate the file?
2. Did the agent introduce syntax errors, duplicate functions, or ReferenceErrors?
3. Did the agent use variables before defining them?
4. Does the code actually fulfill the User's Goal?

If the code is flawless, set "valid" to true.
If the code is broken, dangerous, or hallucinates, set "valid" to false, explain EXACTLY why, and provide the fully fixed proposed code.`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash', // Fast and excellent at code review
      contents: prompt,
      config: {
        // Force the AI to return this exact JSON structure
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            valid: { 
                type: Type.BOOLEAN, 
                description: "True if the code is safe and flawless, false if there are logic errors." 
            },
            explanation: { 
                type: Type.STRING, 
                description: "If valid is false, explain exactly what the agent did wrong." 
            },
            fixedCode: { 
                type: Type.STRING, 
                description: "If valid is false, provide the ENTIRE corrected file content." 
            }
          },
          required: ["valid", "explanation"]
        }
      }
    });

    try {
      const data = JSON.parse(response.text);
      return data;
    } catch (parseErr) {
      console.error("Failed to parse JSON response from Gemini:", parseErr);
      throw new Error("Invalid response from Gemini");
    }
  } catch (err) {
    console.error("❌ Gemini API Error:", err.message);
    throw err;
  }
}