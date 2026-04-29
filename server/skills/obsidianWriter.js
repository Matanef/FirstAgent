// server/skills/obsidianWriter.js
// Obsidian vault I/O skill — create/edit notes, folders, canvas files
// Part of the Obsidian Knowledge OS

import {
  getVaultPath,
  writeNote,
  readNote,
  createFolder,
  listNotes,
  generateCanvas,
  resolveWikilinks,
  enrichWithWikilinks,
  findStubs,
  reapStubs,
  buildFrontmatter,
  promoteStubToNotes,
  VAULT_JOURNAL_ROOT,
  VAULT_STUBS_ROOT,
} from "../utils/obsidianUtils.js";
import { loadAgentConstraints } from "../utils/writingRules.js";
import { getPersonalitySummary } from "../personality.js";
import { llm } from "../tools/llm.js";

const TOOL_NAME = "obsidianWriter";
const MAX_STUBS_PER_OPERATION = 5;
const STUB_MAX_AGE_DAYS = 14;

/**
 * Obsidian Writer skill — manages vault notes, folders, and canvas files.
 *
 * Actions (auto-detected from text):
 * - createNote / write note — Write .md with Obsidian-flavored markdown
 * - createFolder — Create folder + optional MOC index
 * - createCanvas — Generate .canvas JSON file with nodes/edges
 * - appendToNote — Append content to existing note
 * - readNote — Read and return note contents
 * - listNotes — List notes in a folder
 * - populateStubs — Fill up to 5 stub notes with real content
 * - reapStubs — Delete stubs older than 14 days
 *
 * @param {string|Object} request - User input or {text, context}
 * @returns {Object} Standard tool response
 */
export async function obsidianWriter(request) {
  try {
    const text = typeof request === "string" ? request : (request?.text || "");
    const context = typeof request === "object" ? (request?.context || {}) : {};
    const chainData = context.chainContext?.previousOutput || "";

    // Check vault configuration
    const vault = getVaultPath();
    if (!vault) {
      return {
        tool: TOOL_NAME,
        success: false,
        final: true,
        error: "OBSIDIAN_VAULT_PATH not configured. Add it to your .env file.",
      };
    }

    // Detect action from text
    const action = detectAction(text);
    const lower = text.toLowerCase();

    switch (action) {
      case "createNote":
        return await handleCreateNote(text, context, chainData);

      case "createFolder":
        return await handleCreateFolder(text);

      case "createCanvas":
        return await handleCreateCanvas(text, context, chainData);

      case "appendToNote":
        return await handleAppendToNote(text, context, chainData);

      case "readNote":
        return await handleReadNote(text);

      case "listNotes":
        return await handleListNotes(text);

      case "populateStubs":
        return await handlePopulateStubs();

      case "reapStubs":
        return await handleReapStubs();

      default:
        // Default: treat as createNote with LLM content generation
        return await handleCreateNote(text, context, chainData);
    }
  } catch (err) {
    return {
      tool: TOOL_NAME,
      success: false,
      final: true,
      error: `Action failed: ${err.message}`,
    };
  }
}

// ============================================================
// ACTION DETECTION
// ============================================================

function detectAction(text) {
  const lower = text.toLowerCase();

  // Updated to be much more forgiving with phrasing (e.g. "populate empty stub notes")
  if (/\b(populate|fill)\b.*?\b(stub|empty\s*note)/i.test(lower)) return "populateStubs";
  if (/\b(reap|clean|prune|delete)\b.*?\b(stub|empty\s*note)/i.test(lower)) return "reapStubs";
  
  if (/\b(read|show|get|open|view)\s+(note|file|vault)/i.test(lower)) return "readNote";
  if (/\b(list|browse|show\s+all|find)\s+(notes?|files?|vault)/i.test(lower)) return "listNotes";
  if (/\b(append|add\s+to|update)\s+(note|file)/i.test(lower)) return "appendToNote";
  if (/\b(create|new|make)\s+(folder|directory)/i.test(lower)) return "createFolder";
  if (/\b(create|new|make|generate)\s+canvas/i.test(lower)) return "createCanvas";
  if (/\b(create|new|write|make)\s+(note|file|page|doc)/i.test(lower)) return "createNote";

  // If previous step's data is passed, default to create note
  return "createNote";
}

// (enrichWithWikilinks lives in server/utils/obsidianUtils.js — single source of truth)
/* DEPRECATED LOCAL COPY KEPT FOR REFERENCE — do not call.
async function _deadEnrichWithWikilinks(content, notePath) {
  if (!content || typeof content !== "string") return content;
  if (content.length < 200) return content; // too short to be worth enriching

  // Don't link the note's own title back to itself.
  const noteTitle = (notePath || "").replace(/\.md$/i, "").split("/").pop().replace(/-/g, " ");

  const prompt = `You will receive a markdown note. Identify 3-8 distinct noun phrases that represent concrete concepts, people, places, technologies, or topics worth linking to other notes in a personal knowledge vault.

Return JSON only:
{ "wikilinks": ["phrase1", "phrase2", ...] }

Rules:
- Each phrase: 1-4 words, the EXACT casing/spelling as it appears in the note (preserve original).
- Concrete concepts only. Avoid generic words: "thing", "idea", "concept", "approach", "system", "method", "way", "stuff", "topic".
- Do NOT include the note's own title: "${noteTitle}".
- Do NOT include phrases that are already wrapped in [[...]] in the source.
- Prefer proper nouns and multi-word technical terms over single common words.
- No duplicates.

Note:
"""
${content.slice(0, 4000)}
"""

JSON:`;

  let phrases = [];
  try {
    const res = await llm(prompt, {
      timeoutMs: 15000,
      format: "json",
      skipKnowledge: true,
      skipLanguageDetection: true,
      options: { temperature: 0.2, num_ctx: 4096 }
    });
    const txt = res?.data?.text || res?.text || "";
    let parsed;
    try { parsed = JSON.parse(txt); }
    catch {
      const m = txt.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch { parsed = null; } }
    }
    if (parsed && Array.isArray(parsed.wikilinks)) {
      phrases = parsed.wikilinks
        .filter(p => typeof p === "string")
        .map(p => p.trim())
        .filter(p => p.length >= 2 && p.length <= 60)
        .filter(p => p.toLowerCase() !== noteTitle.toLowerCase());
    }
  } catch (err) {
    console.log(`[obsidianWriter] wikilink enrichment LLM failed (non-blocking): ${err.message}`);
    return content;
  }

  if (phrases.length === 0) {
    console.log(`[obsidianWriter] wikilink enrichment: no candidate phrases for "${notePath}"`);
    return content;
  }

  // Cap to 8 to avoid overlinking.
  phrases = phrases.slice(0, 8);

  // Split content into protected regions (frontmatter, code fences, existing wikilinks)
  // and live regions where we can substitute. Simple approach: process line-by-line.
  let inFrontmatter = false;
  let inCodeFence = false;
  const replaced = new Set();
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track frontmatter
    if (i === 0 && line.trim() === "---") { inFrontmatter = true; continue; }
    if (inFrontmatter) { if (line.trim() === "---") inFrontmatter = false; continue; }

    // Track code fences
    if (/^\s*```/.test(line)) { inCodeFence = !inCodeFence; continue; }
    if (inCodeFence) continue;

    for (const phrase of phrases) {
      if (replaced.has(phrase)) continue; // only first occurrence
      // Word-boundary aware regex. CLAUDE.md note: \b doesn't work for non-Latin
      // scripts, so we use lookbehind/lookahead for non-word chars OR string ends.
      const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(^|[^\\w[])(${escaped})(?=[^\\w\\]]|$)`, "i");
      const m = line.match(re);
      if (!m) continue;
      // Check we didn't land inside an existing [[...]]: rough heuristic — look at
      // the 3 chars before the match for "[[" without closing "]]" on this side.
      const idx = m.index + m[1].length;
      const before = line.slice(Math.max(0, idx - 2), idx);
      if (before === "[[") continue;
      // Substitute
      lines[i] = line.slice(0, idx) + `[[${m[2]}]]` + line.slice(idx + m[2].length);
      replaced.add(phrase);
    }
  }

  if (replaced.size > 0) {
    console.log(`[obsidianWriter] wikilink enrichment: linked ${replaced.size}/${phrases.length} phrases in "${notePath}" → [${[...replaced].join(", ")}]`);
    return lines.join("\n");
  }
  console.log(`[obsidianWriter] wikilink enrichment: 0 phrases matched in "${notePath}" (had ${phrases.length} candidates)`);
  return content;
}
*/

// ============================================================
// HANDLERS
// ============================================================

async function handleCreateNote(text, context, chainData) {
  // Extract path and content from text or context
  const pathMatch = text.match(/(?:in|to|at|path:?)\s+["""]?([^\s"""]+\.md|[^\s"""]+\/[^\s"""]+)["""]?/i)
    || text.match(/note\s+["""]?([^\s"""]+)["""]?/i);

  let notePath = pathMatch ? pathMatch[1] : null;
  let noteContent = chainData || "";

  // If we have chain data from deepResearch or gitPulse, use it directly.
  // Main projects land in Journal/ per the Knowledge OS vault layout.
  if (chainData && !notePath) {
    // Extract a title from the chain data
    const titleMatch = chainData.match(/^#\s+(.+)/m);
    const title = titleMatch ? titleMatch[1] : "Research Note";
    const safeName = title.replace(/[^a-zA-Z0-9\s\u0590-\u05FF-]/g, "").trim().replace(/\s+/g, "-");
    notePath = `${VAULT_JOURNAL_ROOT}/${safeName}.md`;
    noteContent = chainData;
  }

  // If no content from chain, generate with LLM
  if (!noteContent) {
    const topic = text.replace(/\b(create|write|make|new)\s+(note|file|page|doc)\s*/i, "").trim();
    if (!topic) {
      return {
        tool: TOOL_NAME,
        success: false,
        final: true,
        error: "No topic or content provided. Specify what to write about.",
      };
    }

    try {
      const result = await llm(
        `Write a well-structured Obsidian note about: ${topic}\n\nUse:\n- YAML frontmatter (title, tags, created date)\n- Headers (##, ###)\n- Bullet points where appropriate\n- [[wikilinks]] to related concepts\n- > [!note] callouts for key insights\n- Mermaid diagrams if relevant\n\nWrite the complete note:`,
        { skipLanguageDetection: true }
      );
      noteContent = result?.data?.text || "";
    } catch (err) {
      return {
        tool: TOOL_NAME,
        success: false,
        final: true,
        error: `LLM generation failed: ${err.message}`,
      };
    }

    if (!notePath) {
      const safeName = topic.replace(/[^a-zA-Z0-9\s\u0590-\u05FF-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60);
      notePath = `${safeName}.md`;
    }
  }

  // Add frontmatter if content doesn't already have it
  if (!noteContent.startsWith("---")) {
    const title = notePath.replace(/\.md$/, "").split("/").pop().replace(/-/g, " ");
    noteContent = buildFrontmatter({
      title: `"${title}"`,
      created: new Date().toISOString(),
      tags: ["note"],
    }) + noteContent;
  }

  // ── WIKILINK ENRICHMENT PASS ──
  // The noteWriter LLM produces prose without [[wikilinks]]. Run a small post-pass
  // that asks an LLM to identify 3-8 distinct concepts in the note body, then wrap
  // the FIRST occurrence of each in [[...]]. Subsequent occurrences are left alone
  // to keep the note readable. resolveWikilinks() then creates stub files for any
  // new links whose target notes don't exist.
  {
    const noteTitle = (notePath || "").replace(/\.md$/i, "").split("/").pop().replace(/-/g, " ");
    noteContent = await enrichWithWikilinks(noteContent, { noteTitle, label: "obsidianWriter" });
  }

  // Write the note (with enriched wikilinks)
  const result = await writeNote(notePath, noteContent);

  // Resolve wikilinks and create stubs. All stubs go to the central Stubs/
  // folder regardless of where the parent note lives — keeps the vault tidy.
  const stubs = await resolveWikilinks(noteContent, {
    createStubs: true,
    stubFolder: VAULT_STUBS_ROOT,
  });

  let response = `✅ Note created: ${notePath}`;
  if (stubs.length > 0) {
    response += `\n📝 Created ${stubs.length} stub note(s): ${stubs.join(", ")}`;
  }

  return {
    tool: TOOL_NAME,
    success: true,
    final: true,
    data: {
      text: response,
      preformatted: true,
      notePath,
      fullPath: result.fullPath,
      stubsCreated: stubs,
    },
  };
}

async function handleCreateFolder(text) {
  const pathMatch = text.match(/folder\s+["""]?([^\s"""]+)["""]?/i);
  const folderPath = pathMatch ? pathMatch[1] : "Untitled-Folder";
  const withMOC = /\b(with|include|add)\s+(moc|index|map)/i.test(text);

  const result = await createFolder(folderPath, { createMOC: withMOC });

  return {
    tool: TOOL_NAME,
    success: true,
    final: true,
    data: {
      text: `✅ Folder created: ${folderPath}${withMOC ? " (with MOC index)" : ""}`,
      preformatted: true,
      folderPath,
      fullPath: result.fullPath,
    },
  };
}

async function handleCreateCanvas(text, context, chainData) {
  // Extract title
  const titleMatch = text.match(/canvas\s+(?:for|about|of|named?)\s+["""]?(.+?)["""]?$/i);
  const title = titleMatch ? titleMatch[1].trim() : "Research Map";

  // If we have chain data, split it into nodes
  let nodes = [];
  let edges = [];

  if (chainData) {
    // Try to parse chain data as structured sections
    const sections = chainData.split(/(?=^##\s)/m).filter(Boolean);
    nodes = sections.map((section, i) => {
      const headerMatch = section.match(/^##\s+(.+)/);
      return {
        id: `node-${i}`,
        text: section.slice(0, 500),
      };
    });

    // Create sequential edges
    for (let i = 0; i < nodes.length - 1; i++) {
      edges.push({ from: `node-${i}`, to: `node-${i + 1}` });
    }
  } else {
    // Generate placeholder nodes from LLM
    try {
      const result = await llm(
        `Generate 6-8 key concepts related to "${title}" as a JSON array of strings. Example: ["Concept 1", "Concept 2"]. Return ONLY the JSON array:`,
        { skipLanguageDetection: true }
      );
      const concepts = JSON.parse(result?.data?.text?.match(/\[.*\]/s)?.[0] || "[]");
      nodes = concepts.map((c, i) => ({ id: `node-${i}`, text: `## ${c}\n\nKey concept in ${title}` }));

      // Central hub pattern
      if (nodes.length > 1) {
        for (let i = 1; i < nodes.length; i++) {
          edges.push({ from: "node-0", to: `node-${i}` });
        }
      }
    } catch {
      nodes = [{ id: "node-0", text: `# ${title}\n\nAdd content here` }];
    }
  }

  if (nodes.length === 0) {
    nodes = [{ id: "node-0", text: `# ${title}\n\nAdd content here` }];
  }

  const canvasJson = generateCanvas(nodes, edges);
  const safeName = title.replace(/[^a-zA-Z0-9\s\u0590-\u05FF-]/g, "").trim().replace(/\s+/g, "-");
  const canvasPath = `${safeName}.canvas`;

  await writeNote(canvasPath, canvasJson);

  return {
    tool: TOOL_NAME,
    success: true,
    final: true,
    data: {
      text: `✅ Canvas created: ${canvasPath} (${nodes.length} nodes, ${edges.length} edges)`,
      preformatted: true,
      canvasPath,
      nodeCount: nodes.length,
    },
  };
}

async function handleAppendToNote(text, context, chainData) {
  const pathMatch = text.match(/(?:to|note)\s+["""]?([^\s"""]+\.md|[^\s"""]+\/[^\s"""]+)["""]?/i);
  if (!pathMatch) {
    return {
      tool: TOOL_NAME,
      success: false,
      final: true,
      error: "Specify which note to append to (e.g., 'append to Research/topic.md')",
    };
  }

  const notePath = pathMatch[1];
  const content = chainData || text.replace(/.*?(append|add)\s+to\s+\S+\s*/i, "").trim();

  if (!content) {
    return {
      tool: TOOL_NAME,
      success: false,
      final: true,
      error: "No content to append. Provide text or chain from another skill.",
    };
  }

  const existing = await readNote(notePath);
  if (existing === null) {
    return {
      tool: TOOL_NAME,
      success: false,
      final: true,
      error: `Note not found: ${notePath}`,
    };
  }

  await writeNote(notePath, content, { append: true });

  return {
    tool: TOOL_NAME,
    success: true,
    final: true,
    data: {
      text: `✅ Appended content to ${notePath}`,
      preformatted: true,
      notePath,
    },
  };
}

async function handleReadNote(text) {
  const pathMatch = text.match(/(?:read|show|get|open|view)\s+(?:note\s+)?["""]?([^\s"""]+\.md|[^\s"""]+\/[^\s"""]+)["""]?/i);
  if (!pathMatch) {
    return {
      tool: TOOL_NAME,
      success: false,
      final: true,
      error: "Specify which note to read (e.g., 'read note Research/topic.md')",
    };
  }

  const notePath = pathMatch[1];
  const content = await readNote(notePath);

  if (content === null) {
    return {
      tool: TOOL_NAME,
      success: false,
      final: true,
      error: `Note not found: ${notePath}`,
    };
  }

  return {
    tool: TOOL_NAME,
    success: true,
    final: true,
    data: {
      text: content,
      preformatted: true,
      notePath,
    },
  };
}

async function handleListNotes(text) {
  const pathMatch = text.match(/(?:in|from|at)\s+["""]?([^\s"""]+)["""]?/i);
  const folderPath = pathMatch ? pathMatch[1] : "";
  const recursive = /\b(all|recursive|deep)\b/i.test(text);

  const notes = await listNotes(folderPath, { recursive });

  return {
    tool: TOOL_NAME,
    success: true,
    final: true,
    data: {
      text: notes.length > 0
        ? `📂 Notes${folderPath ? ` in ${folderPath}` : ""}:\n${notes.map(n => `  • ${n}`).join("\n")}`
        : `📂 No notes found${folderPath ? ` in ${folderPath}` : ""}`,
      preformatted: true,
      notes,
      count: notes.length,
    },
  };
}

async function handlePopulateStubs() {
  const stubs = await findStubs(MAX_STUBS_PER_OPERATION);
  if (stubs.length === 0) { /* ... return ... */ }

  const personality = await getPersonalitySummary(); 
  const constraints = await loadAgentConstraints(); // <--- ADD THIS LINE HERE

  const populated = [];

  for (const stub of stubs) {
    try {
      const result = await llm(
        `Context: You are ${personality}. 
Target Domains: ${constraints.research.domainLock.join(", ")}.

Task: Write a deep-dive technical note about: "${stub.title}".

Structure Requirements:
- Write at least 300 words.
- Use exactly ${constraints.writing.minParagraphsPerSection} paragraphs.
- Include at least ${constraints.writing.minBulletsPerSection} technical bullet points.
- Formatting: Use [[wikilinks]] for all technical terms.
- Accuracy: If the topic is "Dataview", use dv.pages() or dv.table() syntax.

Write the note content (no frontmatter):`,
        { skipLanguageDetection: true }
      );

      const content = result?.data?.text;
      if (!content) continue;

      // Read existing stub and replace content while keeping frontmatter
      const existing = await readNote(stub.path);
      if (!existing) continue;

      // Update frontmatter status from stub → populated
      const updated = existing
        .replace(/status:\s*stub/, "status: populated")
        .replace(/> \[!stub\][\s\S]*?(?=\n[^>]|\n$)/, content);

      // If the callout replacement didn't work, just append
      if (updated === existing) {
        await writeNote(stub.path, content, { append: true });
      } else {
        await writeNote(stub.path, updated);
      }

      // Promote the populated stub: Stubs/{title}.md → Notes/{title}.md.
      // If the stub lived outside Stubs/ (legacy placement), we still move
      // it to Notes/ so the vault layout is consistent going forward.
      const moveResult = await promoteStubToNotes(stub.path);
      const finalPath = moveResult.success ? moveResult.to : stub.path;
      populated.push(finalPath);
    } catch {
      // Skip failed stubs
    }
  }

  return {
    tool: TOOL_NAME,
    success: true,
    final: true,
    data: {
      text: `📝 Populated ${populated.length}/${stubs.length} stub notes (moved to Notes/):\n${populated.map(p => `  ✅ ${p}`).join("\n")}`,
      preformatted: true,
      populated,
      total: stubs.length,
    },
  };
}

async function handleReapStubs() {
  const result = await reapStubs(STUB_MAX_AGE_DAYS);

  return {
    tool: TOOL_NAME,
    success: true,
    final: true,
    data: {
      text: result.reaped > 0
        ? `🧹 Reaped ${result.reaped} stale stub(s):\n${result.paths.map(p => `  🗑️ ${p}`).join("\n")}`
        : "No stale stubs found (all stubs are newer than 14 days).",
      preformatted: true,
      reaped: result.reaped,
    },
  };
}
