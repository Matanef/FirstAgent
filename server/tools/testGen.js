// server/tools/testGen.js
import fs from "fs/promises";
import path from "path";
import { llm } from "./llm.js";
import { PROJECT_ROOT } from "../utils/config.js";

/**
 * Generates unit tests for a specific file using the LLM.
 */
export async function testGen(request) {
  const text = typeof request === "string" ? request : request?.text || "";
  const context = request?.context || {};
  
  // Extract path from text (e.g., "generate tests for server/tools/calculator.js")
  const filePathMatch = text.match(/(?:for|file)\s+([^\s]+\.js)/i);
  const targetFile = context.path || (filePathMatch ? filePathMatch[1] : null);

  if (!targetFile) {
    return { success: false, error: "No target file specified for test generation." };
  }

  try {
    const fullPath = path.resolve(PROJECT_ROOT, targetFile);
    const code = await fs.readFile(fullPath, "utf8");

    const prompt = `You are a Senior QA Engineer. Create a comprehensive suite of unit tests for the following Node.js file.
    
FILE PATH: ${targetFile}
CODE:
${code}

RULES:
1. Use Vitest or Jest syntax (describe/it/expect).
2. This project uses ES MODULES. Use 'import' instead of 'require'.
3. Mock external dependencies (like 'node-fetch' or 'googleapis') if necessary.
4. Cover edge cases (null inputs, empty strings, error handling).
5. Output ONLY the code for the test file. No explanation.

The test file should be named: ${targetFile.replace(".js", ".test.js")}`;

    console.log(`🧠 [testGen] Generating tests for: ${targetFile}`);
    const response = await llm(prompt);
    const testCode = response?.data?.text || "";

    if (!testCode.includes("import") && !testCode.includes("describe")) {
      throw new Error("LLM failed to generate valid test code.");
    }

    const testPath = fullPath.replace(".js", ".test.js");
    await fs.writeFile(testPath, testCode, "utf8");

    return {
      tool: "testGen",
      success: true,
      final: true,
      data: {
        file: targetFile,
        testFile: path.relative(PROJECT_ROOT, testPath),
        message: `Successfully generated tests for ${targetFile}`
      }
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}