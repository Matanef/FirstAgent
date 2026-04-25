// server/routing/index.js
// Routing table evaluator. Imports the static ROUTING_TABLE from rules.js and
// merges in any skill-registered routing rules at query time.
// Exported: evaluateRoutingTable(lower, trimmed, chatContext) → step[] | null

import { ROUTING_TABLE } from "./rules.js";
import { extractCity, formatCity } from "./helpers.js";
import { getMemory } from "../memory.js";
import { logRoutingDecision } from "../routes/dashboard.js";

// ── ROUTING TABLE EVALUATOR ──────────────────────────────────
/**
 * Evaluate all rules in the routing table (static + skill-registered) and return
 * the highest-priority match as a single-step plan array.
 *
 * Returns: [{ tool, input, context, reasoning, priority }] or null if no match.
 * The `priority` field is included so callers (e.g. intentClassifier override) can
 * threshold-check the winning rule's confidence.
 *
 * @param {string} lower      - Message lowercased
 * @param {string} trimmed    - Message trimmed (original casing)
 * @param {object} chatContext - Conversation context (conversationId, fileIds, etc.)
 */
export async function evaluateRoutingTable(lower, trimmed, chatContext) {
  // Merge static table with dynamically registered skill rules.
  // skillRoutingRules is populated by loadSkills() in executor.js.
  // We import it lazily here to avoid circular dependency issues at module load time.
  let skillRules = [];
  try {
    const { skillRoutingRules } = await import("../executor.js");
    skillRules = skillRoutingRules || [];
  } catch {
    // executor not loaded yet (e.g. during tests) — skip skill rules
  }

  const allRules = [...ROUTING_TABLE, ...skillRules];

  // Find all matching rules (pass match, fail guard)
  const candidates = allRules.filter(rule => {
    try {
      if (!rule.match(lower, trimmed, chatContext)) return false;
      if (rule.guard && rule.guard(lower, trimmed, chatContext)) return false;
      return true;
    } catch (e) {
      console.warn(`[routing] Rule error for "${rule.tool}":`, e.message);
      return false;
    }
  });

  if (candidates.length === 0) return null;

  // Sort by priority descending — highest wins
  candidates.sort((a, b) => b.priority - a.priority);

  // Try candidates in priority order — if a validate() hook rejects,
  // fall through to the next candidate instead of sending garbage context.
  for (const winner of candidates) {
    // Build context
    let ctx = {};
    if (winner.contextAsync && winner.tool === "weather") {
      // Special async handling for weather city extraction + memory lookup
      let extracted = extractCity(trimmed);
      if (!extracted) {
        try {
          const memory = await getMemory();
          const profile = memory.profile || {};
          const savedLocation = profile.location || profile.city || null;
          if (savedLocation) {
            extracted = formatCity(savedLocation);
            console.log(`[routing] Using saved location from memory: ${extracted}`);
          }
        } catch (e) {
          console.warn("[routing] Could not read memory for location:", e.message);
        }
      }
      ctx = extracted ? { city: extracted } : {};
    } else if (winner.context) {
      ctx = winner.context(lower, trimmed, chatContext || {});
    }

    // Validate extracted context — if the tool rejects it, try next candidate
    if (winner.validate) {
      try {
        if (!winner.validate(ctx, lower, trimmed)) {
          console.log(`[routing] ${winner.tool} REJECTED by validate (priority ${winner.priority}), trying next`);
          continue;
        }
      } catch (e) {
        console.warn(`[routing] validate error for "${winner.tool}":`, e.message);
        continue;
      }
    }

    // Handle finance → search redirect
    if (ctx.__redirectTool) {
      const redirectTool = ctx.__redirectTool;
      delete ctx.__redirectTool;
      console.log(`[routing] ${winner.tool} redirected to ${redirectTool} (priority ${winner.priority})`);
      logRoutingDecision(trimmed, redirectTool, winner.priority, `routing_table_${winner.tool}_redirect`);
      return [{ tool: redirectTool, input: trimmed, context: ctx,
                reasoning: `routing_table_${winner.tool}_redirect`, priority: winner.priority }];
    }

    console.log(`[routing] → ${winner.tool} (priority ${winner.priority}, ${candidates.length} candidate${candidates.length > 1 ? "s" : ""})`);
    logRoutingDecision(trimmed, winner.tool, winner.priority, `routing_table_${winner.tool}`);
    return [{ tool: winner.tool, input: trimmed, context: ctx,
              reasoning: `routing_table_${winner.tool}`, priority: winner.priority }];
  }

  // All candidates rejected by validate — no match
  console.log(`[routing] all ${candidates.length} candidates rejected by validate`);
  return null;
}
