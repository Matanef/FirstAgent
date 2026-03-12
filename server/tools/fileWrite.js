// server/tools/fileWrite.js
// File writing capability — supports structured input and natural language parsing

import fs from "fs/promises";
import path from "path";
import { llm } from "./llm.js";

// Sandboxes where agent can write
const WRITABLE_SANDBOXES = [
  path.resolve("D:/local-llm-ui"),
  path.resolve("E:/testFolder")
];

// Critical files that should NEVER be overwritten without a backup
const PROTECTED_FILES = [
  "package.json",
  "package-lock.json",
  ".env",
  "memory.json"
];

/**
 * Validates if the path is within allowed directories.
 */
function isPathWritable(resolvedPath) {
  return WRITABLE_SANDBOXES.some(root => resolvedPath.startsWith(root));
}

/**
 * Checks if the file requires mandatory backups.
 */
function isProtected(filename) {
  return PROTECTED_FILES.some(pf => filename.endsWith(pf));
}

/**
 * Creates a backup of the file before modification.
 * @throws {Error} if backup creation fails.
 */
async function createBackup(filepath) {
  try {
    // Check if the file actually exists before backing it up
    await fs.access(filepath);
  } catch {
    // File doesn't exist yet, no backup needed
    return null; 
  }

  try {
    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-');
    const backupPath = `${filepath}.backup-${timestamp}`;
    await fs.copyFile(filepath, backupPath);
    return backupPath;
  } catch (err) {
    throw new Error(`Failed to create backup for ${filepath}: ${err.message}`);
  }
}

/**
 * Internal: performs the actual file write with safety checks.
 */
async function performWrite(requestedPath, content, mode = "write", backup = true) {
  const resolvedPath = path.resolve(requestedPath);
  
  if (!isPathWritable(resolvedPath)) {
    throw new Error(`Path is outside of allowed sandboxes: ${resolvedPath}`);
  }

  const filename = path.basename(resolvedPath);
  let backupPath = null;

  if (backup || isProtected(filename)) {
    backupPath = await createBackup(resolvedPath);
  }

  try {
    // Ensure the directory exists
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });

    if (mode === "append") {
      await fs.appendFile(resolvedPath, content, "utf8");
    } else {
      await fs.writeFile(resolvedPath, content, "utf8");
    }

    return {
      tool: "fileWrite",
      success: true,
      final: true,
      data: {
        file: filename,
        path: resolvedPath,
        backup: backupPath,
        mode,
        size: content.length,
        message: `✅ Successfully ${mode === 'append' ? 'appended to' : 'wrote'} file: ${filename}`,
        text: `Successfully ${mode === 'append' ? 'appended to' : 'wrote'} ${filename}.\nLocation: ${resolvedPath}${backupPath ? `\nBackup created at: ${backupPath}` : ''}`
      }
    };
  } catch (err) {
    throw new Error(`File system operation failed: ${err.message}`);
  }
}

/**
 * Parses natural language to extract file path, content, and write mode using XML tags.
 */
/**
 * Parses natural language to extract file path, content, and write mode using custom boundaries.
 */
async function parseNaturalLanguageWrite(text) {
  const prompt = `
Extract the requested file path and content to write from the following user request.
User Request: "${text}"

You MUST respond exactly in this format using these exact boundaries. Do NOT use XML tags or JSON. Do NOT escape HTML characters.

===PATH===
The exact file path goes here
===MODE===
write
===CONTENT===
The exact raw code or text goes here
===END===

If the user wants to append, set mode to "append". Otherwise, set it to "write".
`;

  const result = await llm(prompt);
  const llmOutput = result?.data?.text || result?.output || "";

  // Extract data using custom boundaries (Immune to JSON and XML encoding rules!)
  const pathMatch = llmOutput.match(/===PATH===([\s\S]*?)===MODE===/i);
  const modeMatch = llmOutput.match(/===MODE===([\s\S]*?)===CONTENT===/i);
  const contentMatch = llmOutput.match(/===CONTENT===([\s\S]*?)===END===/i);

  if (!pathMatch || !contentMatch) {
    console.error("❌ [fileWrite] Failed to parse boundaries from LLM output:\\n", llmOutput);
    throw new Error("Could not extract path and content. The LLM formatting failed.");
  }

  // Grab the raw content and just strip off any markdown blocks if the LLM snuck them in
  let cleanContent = contentMatch[1].trim();
  cleanContent = cleanContent
    .replace(/^```[a-z]*\n?/im, '') 
    .replace(/\n?```$/im, '');

  return {
    path: pathMatch[1].trim(),
    mode: modeMatch ? modeMatch[1].trim().toLowerCase() : "write",
    content: cleanContent
  };
}

/**
 * Handles processing of natural language file write requests.
 */
async function handleNaturalLanguageWrite(text, context = {}) {
  try {
    console.log("🧠 [fileWrite] Parsing natural language intent...");

    // First, try to use any context path provided by the Orchestrator/UI
    const targetPath = context.targetPath || null;

    // ── CHAIN CONTEXT: generate improved file from review suggestions ──
    if (context.generateImproved && context.chainContext?.previousOutput && context.sourceFile) {
      const reviewOutput = context.chainContext.previousOutput;
      const sourceFile = context.sourceFile;
      console.log(`📝 [fileWrite] Generating improved version of "${sourceFile}" using review suggestions`);

      // Read the original source file
      let originalContent = "";
      try {
        originalContent = await fs.readFile(path.resolve(sourceFile), "utf-8");
        console.log(`📝 [fileWrite] Read source file: ${originalContent.length} chars`);
      } catch (readErr) {
        // Try resolving relative to project root
        try {
          const resolved = path.resolve("D:/local-llm-ui", sourceFile);
          originalContent = await fs.readFile(resolved, "utf-8");
          console.log(`📝 [fileWrite] Read source file (resolved): ${originalContent.length} chars`);
        } catch {
          throw new Error(`Could not read source file: ${sourceFile}`);
        }
      }

      // Truncate if file is very large (LLM context limit)
      const maxChars = 50000;
      const truncatedSource = originalContent.length > maxChars
        ? originalContent.slice(0, maxChars) + "\n\n// ... (truncated for LLM context)"
        : originalContent;

      // Use LLM to generate improved version based on review suggestions
      const improvePrompt = `You are a senior code refactoring expert. Given the ORIGINAL SOURCE CODE and REVIEW SUGGESTIONS below, produce an IMPROVED VERSION of the code.

RULES:
- Apply the review suggestions where they make sense
- Keep the same overall structure and functionality
- Add comments explaining major changes
- Output ONLY the improved code, no explanations before or after

REVIEW SUGGESTIONS:
${reviewOutput}

ORIGINAL SOURCE CODE:
\`\`\`
${truncatedSource}
\`\`\`

IMPROVED CODE:`;

      const improvedCode = await llm(improvePrompt);
      if (!improvedCode || improvedCode.length < 50) {
        throw new Error("LLM failed to generate improved code.");
      }

      // Strip markdown code fences if present
      let cleanCode = improvedCode
        .replace(/^```[\w]*\n?/m, "")
        .replace(/\n?```\s*$/m, "")
        .trim();

      const finalPath = targetPath || `${sourceFile}.improved.js`;
      console.log(`📝 [fileWrite] Writing improved file to ${finalPath} (${cleanCode.length} chars)`);
      return await performWrite(finalPath, cleanCode, "write");
    }

    // Use our new extracted parsing function
    const { path: extractedPath, content, mode } = await parseNaturalLanguageWrite(text);

    const finalPath = targetPath || extractedPath;

    if (!finalPath || !content) {
      throw new Error("Path and content are required.");
    }

    console.log(`📝 [fileWrite] Writing to ${finalPath} via Natural Language`);
    return await performWrite(finalPath, content, mode);

  } catch (err) {
    console.error("❌ [fileWrite] NL parse error:", err.message);
    return {
      tool: "fileWrite",
      success: false,
      final: true,
      error: `Natural language write failed: ${err.message}`
    };
  }
}

/**
 * Main Tool Export
 */
export async function fileWrite(request) {
  try {
    // 1. Natural Language Input (String)
    if (typeof request === "string") {
      return await handleNaturalLanguageWrite(request);
    }

    // 2. Message Object (from coordinator) with text but no explicit path/content
    if (request && request.text && !request.path) {
      return await handleNaturalLanguageWrite(request.text, request.context);
    }

    // 3. Structured Input { path, content, mode, backup }
    const { path: requestedPath, content, mode = "write", backup = true } = request;

    if (!requestedPath || !content) {
      return { 
        tool: "fileWrite", 
        success: false, 
        final: true, 
        error: "Path and content are required for structured writes." 
      };
    }

    return await performWrite(requestedPath, content, mode, backup);

  } catch (err) {
    console.error("❌ [fileWrite] ERROR:", err);
    return { 
      tool: "fileWrite", 
      success: false, 
      final: true, 
      error: `File operation failed: ${err.message}` 
    };
  }
}