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

// ── SECURITY: Directories the agent must NEVER write to (kills RCE via dynamic skills) ──
const PROTECTED_DIRS = [
  path.resolve("D:/local-llm-ui/server"),
  path.resolve("D:/local-llm-ui/client"),
  path.resolve("D:/local-llm-ui/node_modules"),
  path.resolve("D:/local-llm-ui/.git"),
  path.resolve("D:/local-llm-ui/.env"),
];

// Critical files that should NEVER be overwritten without a backup
const PROTECTED_FILES = [
  "package.json",
  "package-lock.json",
  ".env",
  ".env.local",
  ".env.production",
  "memory.json",
  "service_account.json"
];

/**
 * Validates if the path is within allowed directories and not in a protected zone.
 * Uses path.relative() to prevent startsWith bypass (e.g. "D:/local-llm-uievil/").
 * Blocks writes to server/, client/, node_modules/, .git/, and .env.
 */
function isPathWritable(resolvedPath) {
  // Block protected infrastructure directories
  for (const protDir of PROTECTED_DIRS) {
    const rel = path.relative(protDir, resolvedPath);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return false;
    // Also catch exact match (e.g. .env file itself)
    if (resolvedPath === protDir) return false;
  }

  // Verify path is inside a writable sandbox (using path.relative to avoid startsWith bypass)
  return WRITABLE_SANDBOXES.some(root => {
    const rel = path.relative(root, resolvedPath);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  });
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

    const targetPath = context.targetPath || null;

    // ── CHAIN CONTEXT: generate improved file from review suggestions ──
    if (context.generateImproved && context.chainContext?.previousOutput && context.sourceFile) {
      const reviewOutput = context.chainContext.previousOutput;
      const sourceFile = context.sourceFile;
      console.log(`📝 [fileWrite] Generating improved version of "${sourceFile}" using review suggestions`);

      let originalContent = "";
      try {
        originalContent = await fs.readFile(path.resolve(sourceFile), "utf-8");
      } catch (readErr) {
        try {
          const resolved = path.resolve("D:/local-llm-ui", sourceFile);
          originalContent = await fs.readFile(resolved, "utf-8");
        } catch {
          throw new Error(`Could not read source file: ${sourceFile}`);
        }
      }

      const maxChars = 150000;
      const truncatedSource = originalContent.length > maxChars
        ? originalContent.slice(0, maxChars) + "\n\n// ... (truncated for LLM context)"
        : originalContent;

      const improvePrompt = `You are a senior code refactoring expert. Given the ORIGINAL SOURCE CODE and REVIEW SUGGESTIONS below, produce an IMPROVED VERSION of the code.

USER'S SPECIFIC INSTRUCTION: "${text}"

CRITICAL INSTRUCTIONS:
1. You MUST output the ENTIRE updated file from start to finish. Do NOT be lazy. Do NOT output partial snippets. Do NOT leave placeholders like "// rest of the code".
2. You must wrap your final, complete code exactly between the boundaries ===CODE_START=== and ===CODE_END===.
3. Do not break existing Node.js logic. Do not use browser-only APIs like DOMParser.
4. Keep all existing configurations, exports, and imports intact unless explicitly told to change them.
5. Pay close attention to the USER'S SPECIFIC INSTRUCTION. Ensure your rewritten code accomplishes exactly what they asked for!

REVIEW SUGGESTIONS:
${reviewOutput}

ORIGINAL SOURCE CODE:
\`\`\`javascript
${truncatedSource}
\`\`\`

OUTPUT YOUR ENTIRE REWRITTEN CODE BELOW. You MUST start your code with ===CODE_START=== and end with ===CODE_END===.
AFTER the ===CODE_END=== tag, provide a brief bulleted list summarizing the improvements you made.`;

// Use longer timeout for massive files
      const genTimeout = truncatedSource.length > 20000 ? 1800_000 : 300_000;
      console.log(`📝 [fileWrite] Calling LLM for improved code (${truncatedSource.length} chars, timeout: ${genTimeout / 1000}s)...`);
      
      // We let Ollama auto-manage the memory allocation!
      const llmResult = await llm(improvePrompt, { 
        timeoutMs: genTimeout
      });

      if (!llmResult || !llmResult.success) {
        throw new Error(`LLM generation aborted: ${llmResult?.error || llmResult?.data?.text || "Unknown error"}`);
      }
      
      const improvedCode = llmResult.data?.text || llmResult.text || (typeof llmResult === "string" ? llmResult : null);
      
      // Secondary Guardrail: Don't write literal error strings
      if (!improvedCode || improvedCode.length < 50 || improvedCode.includes("The language model encountered an error")) {
        throw new Error("LLM failed to generate improved code or timed out.");
      }

      // STRICT EXTRACTION
      let cleanCode = improvedCode;
      let changelog = "";
      
      // Make the end tag optional in the regex just in case Qwen forgot it
      const boundaryMatch = improvedCode.match(/===CODE_START===([\s\S]*?)(?:===CODE_END===|$)/i);
      
      if (boundaryMatch) {
        cleanCode = boundaryMatch[1];
        
        // Capture everything AFTER the code as our changelog
        const afterMatch = improvedCode.match(/===CODE_END===([\s\S]*)/i);
        if (afterMatch && afterMatch[1].trim().length > 0) {
          changelog = afterMatch[1].trim();
        }
      }
      
      // THE NUCLEAR OPTION: Manually assassinate any surviving tags, markdown fences, or chatty text
      cleanCode = cleanCode.replace(/===CODE_START===/gi, "");
      cleanCode = cleanCode.replace(/===CODE_END===/gi, "");
      cleanCode = cleanCode.replace(/```(javascript|js|typescript|ts)?/gi, ""); // Kill opening markdown
      cleanCode = cleanCode.replace(/```/g, ""); // Kill closing markdown
      cleanCode = cleanCode.replace(/^(Here is|Sure|Okay|Below is|I have applied)[^\n]*\n+/gi, "");
      
      cleanCode = cleanCode.trim();

      // ── THE TRUNCATION GUARD (Anti-Laziness Shield) ──
      // If the original file was over 3KB, and the LLM shrank the code by more than 20%
      if (originalContent.length > 3000 && cleanCode.length < (originalContent.length * 0.8)) {
        const origKB = Math.round(originalContent.length / 1024);
        const newKB = Math.round(cleanCode.length / 1024);
        
        throw new Error(
          `LLM Safety Guard: The generated code was severely truncated (${origKB}KB down to ${newKB}KB). ` +
          `The LLM got lazy. For large files, please use the 'Refactor' tool instead of a full file rewrite.`
        );
      }

      const finalPath = targetPath || `${sourceFile}.improved.js`;
      console.log(`📝 [fileWrite] Writing improved file to ${finalPath} (${cleanCode.length} chars)`);
      
      // Intercept the write result and attach the changelog
      const writeResult = await performWrite(finalPath, cleanCode, "write");
      
      if (changelog) {
        writeResult.data.text += `\n\n**What I Improved:**\n${changelog}`;
      } else {
        writeResult.data.text += `\n\n**What I Improved:**\nApplied code review suggestions to optimize and refactor the code.`;
      }
      
      return writeResult;
    } // <-- This is the bracket that usually gets deleted by mistake!

    // Use our extracted parsing function for generic text writes
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

// ── CHUNKED PROSE PROCESSING ──
// For large text/prose files that exceed LLM output token limits.
// Splits by headings or paragraph blocks, processes each chunk, reassembles.

const CHUNK_SIZE = 3000; // ~750 tokens — safe for 7B models with 2k output limit

/**
 * Split text into logical chunks by headings, then by paragraph blocks.
 * Preserves document structure so sections aren't split mid-paragraph.
 */
function splitIntoChunks(text, maxChars = CHUNK_SIZE) {
  // First try splitting by headings (markdown # or underline-style)
  const headingRe = /^(#{1,6}\s.+|.+\n[=\-]{3,})$/gm;
  const sections = [];
  let lastIdx = 0;

  for (const match of text.matchAll(headingRe)) {
    if (match.index > lastIdx) {
      sections.push(text.slice(lastIdx, match.index));
    }
    lastIdx = match.index;
  }
  if (lastIdx < text.length) {
    sections.push(text.slice(lastIdx));
  }

  // If no headings found, split by double-newlines (paragraph breaks)
  if (sections.length <= 1) {
    const paragraphs = text.split(/\n\s*\n/);
    sections.length = 0;
    sections.push(...paragraphs.map(p => p.trim()).filter(Boolean));
  }

  // Merge small sections and split oversized ones
  const chunks = [];
  let current = "";

  for (const section of sections) {
    if (current.length + section.length + 2 > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }

    if (section.length > maxChars) {
      // Section too large even alone — force-split by lines
      if (current.length > 0) {
        chunks.push(current.trim());
        current = "";
      }
      const lines = section.split("\n");
      let lineBuf = "";
      for (const line of lines) {
        if (lineBuf.length + line.length + 1 > maxChars && lineBuf.length > 0) {
          chunks.push(lineBuf.trim());
          lineBuf = "";
        }
        lineBuf += (lineBuf ? "\n" : "") + line;
      }
      if (lineBuf.trim()) current = lineBuf;
    } else {
      current += (current ? "\n\n" : "") + section;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

/**
 * Process a large prose file in chunks through the LLM.
 * Each chunk gets the same editing instructions; results are reassembled.
 */
async function handleChunkedProseWrite(text, context) {
  const sourceFile = context.sourceFile || context.targetPath;
  if (!sourceFile) {
    return { tool: "fileWrite", success: false, final: true, error: "No source file specified for chunked processing." };
  }

  let originalContent;
  try {
    originalContent = await fs.readFile(path.resolve(sourceFile), "utf-8");
  } catch {
    try {
      originalContent = await fs.readFile(path.resolve("D:/local-llm-ui", sourceFile), "utf-8");
    } catch {
      return { tool: "fileWrite", success: false, final: true, error: `Could not read source file: ${sourceFile}` };
    }
  }

  const chunks = splitIntoChunks(originalContent);
  console.log(`📝 [fileWrite] Chunked processing: ${originalContent.length} chars → ${chunks.length} chunks`);

  const processedChunks = [];
  let failed = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`📝 [fileWrite] Processing chunk ${i + 1}/${chunks.length} (${chunk.length} chars)...`);

    const chunkPrompt = `You are a text editor processing part ${i + 1} of ${chunks.length} of a document.

TASK: ${text}

INSTRUCTIONS:
- Apply the task ONLY to the text below.
- Output ONLY the processed text. No explanations, no markdown fences, no preamble.
- Preserve ALL formatting, headings, lists, and structure.
- Do NOT add content that wasn't in the original.
- Do NOT truncate or summarize — output the FULL processed version of this section.

TEXT TO PROCESS:
${chunk}`;

    try {
      const result = await llm(chunkPrompt, { timeoutMs: 120_000, skipKnowledge: true });
      const output = result?.data?.text || result?.text || "";

      if (!output || output.length < chunk.length * 0.3) {
        console.warn(`📝 [fileWrite] Chunk ${i + 1} output suspiciously short (${output.length} vs ${chunk.length}), keeping original`);
        processedChunks.push(chunk);
        failed++;
      } else {
        // Strip any markdown fences the LLM might have added
        const clean = output.replace(/^```[a-z]*\n?/im, "").replace(/\n?```$/im, "").trim();
        processedChunks.push(clean);
      }
    } catch (err) {
      console.warn(`📝 [fileWrite] Chunk ${i + 1} failed: ${err.message}, keeping original`);
      processedChunks.push(chunk);
      failed++;
    }
  }

  const finalContent = processedChunks.join("\n\n");
  const targetPath = context.targetPath || `${sourceFile}.processed`;

  console.log(`📝 [fileWrite] Reassembled ${processedChunks.length} chunks → ${finalContent.length} chars (${failed} failed, kept original)`);

  const writeResult = await performWrite(targetPath, finalContent, "write");
  writeResult.data.text += `\n\nChunked processing: ${chunks.length} sections, ${failed} kept original due to errors.`;

  return writeResult;
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
      // Chunked prose processing — explicitly requested or auto-detected for large prose files
      if (request.context?.chunked || request.context?.mode === "chunked") {
        return await handleChunkedProseWrite(request.text, request.context);
      }
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