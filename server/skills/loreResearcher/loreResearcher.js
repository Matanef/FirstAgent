import { llm } from "../../tools/llm.js";

export async function researchLore(message) {
  const rawInput = typeof message === "object" ? (message.text || message.input) : message;

  try {
// 1. Refine the search extraction to get better Wiki hits
    const extractPrompt = `Extract ONLY the TV show/movie title and the specific character names from this request. 
    Do NOT include actions, locations, "physical appearance", or extra words.
    Output ONLY a clean search query string. 
    Example: "Battlestar Galactica Boomer William Adama"
    Request: "${rawInput}"`;

    const searchQueryRes = await llm(extractPrompt, { model: "qwen2.5:7b", skipKnowledge: true });
    const searchQuery = encodeURIComponent(searchQueryRes?.data?.text?.trim() || rawInput);

    console.log(`🔎 [loreResearcher] Searching Wikipedia for: ${searchQueryRes?.data?.text}`);

    // 2. Fetch the data (Increased limit to 5 to get more lore)
    const wikiResponse = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${searchQuery}&utf8=&format=json&srlimit=5`);
    const wikiData = await wikiResponse.json();
    
    // Strip HTML tags from the Wikipedia snippets
    const searchResults = wikiData.query.search.map(r => r.snippet.replace(/(<([^>]+)>)/gi, "")).join(" | ");

    if (!searchResults) {
        return { success: false, text: "Could not find enough lore on Wikipedia to build a prompt." };
    }

// 3. The Masterclass Prompt Compiler
    const compilePrompt = `You are an elite AI Art Director and Prompt Engineer for diffusion models. 
    1. Read the Wikipedia research.
    2. Combine it with your OWN deep knowledge of the franchise to recall EXACT physical details (clothing, hair, colors).
    3. Read the Original User Request to understand the action, setting, and requested style (e.g., 8-bit).
    4. Write a highly structured, diffusion-optimized image prompt.
    
    CRITICAL DIFFUSION RULES (OBEY STRICTLY):
    - NO PROSE OR NARRATIVE: Do not write a story. Do not describe unseen emotions.
    - NO NAMES: NEVER use character or franchise names. Translate them into pure visual descriptions.
    - USE NUMBERING FOR MULTIPLE SUBJECTS: To prevent "concept bleeding," you MUST number every character (e.g., "1. A young woman..., 2. An older man...").
    
    THE "LAYER CAKE" STRUCTURE:
    Your output MUST be a single, comma-separated paragraph following this EXACT order:
    [Medium/Style (e.g., 8-bit pixel art, CRT scanlines)] -> [Dynamic Camera Angle/Framing (e.g., Low angle cowboy shot)] -> [Numbered Subjects & Wardrobe] -> [Specific Action & Physical Impact (e.g., muzzle flash, empty hands)] -> [Setting/Environment] -> [Lighting/Atmosphere (e.g., harsh neon lighting, volumetric smoke)].
    
    NEGATIVE PROMPTING:
    Add this exact string to the very end of your output: "Avoid: tangled limbs, fused bodies, text, narrative."
    
    Research: "${searchResults}"
    Original User Request: "${rawInput}"`;

    const finalPromptRes = await llm(compilePrompt, { 
        model: "qwen2.5:7b", 
        options: { temperature: 0.2 } 
    });

    const finalPrompt = finalPromptRes?.data?.text;

    return {
      success: true,
      data: {
        text: `Here is your highly researched, lore-accurate image prompt. Copy and paste this to the imageGen tool:\n\n**"${finalPrompt}"**`,
        preformatted: false
      }
    };

  } catch (error) {
    console.error(`❌ [loreResearcher] Error:`, error.message);
    return { success: false, error: error.message };
  }
}