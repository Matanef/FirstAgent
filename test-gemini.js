// test-gemini.js
import dotenv from 'dotenv';
dotenv.config({ path: './server/.env' }); // Tells it to look inside the server folder

import { validateWithGemini } from './server/tools/geminiValidator.js';

async function runTest() {
  console.log("🚀 Testing Gemini Validator...");

  const testPayload = {
    filename: "test.js",
    originalCode: "function hello() { console.log('hi'); }",
    proposedCode: "function hello() { console.log('hello world'); }",
    intent: "Change the log message to 'hello world'"
  };

  try {
    const result = await validateWithGemini(testPayload);
    
    console.log("\n✅ CONNECTION SUCCESSFUL!");
    console.log("--------------------------");
    console.log("Valid:", result.valid);
    if (!result.valid) {
      console.log("Explanation:", result.explanation);
    } else {
      console.log("Gemini approved the change.");
    }
    
  } catch (error) {
    console.error("\n❌ TEST FAILED");
    console.error("Error Message:", error.message);
    if (error.message.includes("404")) {
      console.log("Hint: The model name 'gemini-2.5-flash' might be outdated. Try 'gemini-2.0-flash'.");
    }
  }
}

runTest();