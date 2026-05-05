// server/skills/imageGen/imageGen.js
import { llm } from "../../tools/llm.js";

export async function generateImage(message) {
  const rawInput = typeof message === "object" ? (message.text || message.input) : message;
  const apiKey = process.env.POLLINATIONS_API_KEY;

  try {
    // 1. The Generalized Art Director Prompt
    const refinerPrompt = `You are a Master Art Director translating user requests into visual descriptions for an image generator.

CRITICAL RULES:
1. NO NAMES ALLOWED: Never output proper nouns (characters, actors, franchises). Translate them into pure physical descriptions emphasizing iconic traits.
2. UNIVERSAL APPLICATION: This tool handles EVERYTHING from sci-fi battles to a dog eating a hotdog. Describe exactly what is happening based ONLY on the user's request.
3. JSON ONLY: Output strictly valid JSON.
4. OUTPUT FORMAT: You MUST output a single, raw, plain-text string. DO NOT output JSON. DO NOT output arrays or objects.

Analyze: "${rawInput}"

Output EXACTLY this JSON structure:
{
  "lore_check": "Analyze the request. What is the context? If it's a known pop-culture scene, recall the exact details, outfits, and who is doing what to whom.",
  "art_style": "Specify exact style (e.g., '8-bit pixel art', 'oil painting'). Default: 'photorealistic, cinematic'.",
  "subjects_description": "Pure physical descriptions of the entities involved. Focus on identifying physical traits and clothing. NO NAMES. NO ARRAYS.",
  "action_and_pose": "Describe exactly what the subjects are physically doing, their poses, and any props they hold. Be specific about how they interact (e.g., 'The young woman is pointing a gun at the older man').",
  "background": "Physical description of the setting and lighting."
}`;

    const refinedRes = await llm(refinerPrompt, { 
      model: "qwen2.5:7b", // Using Qwen 2.5 for strict JSON adherence
      options: { temperature: 0.1, num_predict: 400 },
      skipKnowledge: true 
    });
    
    let llmOutput = refinedRes?.data?.text || "";
    let sceneData = {};
    let visualPrompt = "";

    try {
      // 2. BULLETPROOF JSON EXTRACTION: Finds the first '{' and last '}'
      const jsonMatch = llmOutput.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON object found in LLM output.");
      
      sceneData = JSON.parse(jsonMatch[0]);

      console.log(`🧠 [imageGen] Lore Check: "${sceneData.lore_check}"`);
      console.log(`🎬 [imageGen] Art Director successfully parsed scene blueprint!`);

      // 3. COMPILER: Handles arrays just in case, then stitches the generic fields together
      let subjects = sceneData.subjects_description;
      if (Array.isArray(subjects)) {
         subjects = subjects.map(c => typeof c === 'string' ? c : JSON.stringify(c)).join(" AND ");
      }

      visualPrompt = [
        sceneData.art_style,
        subjects,
        sceneData.action_and_pose,
        sceneData.background
      ].filter(Boolean).join(", ");

    } catch (parseError) {
      console.warn(`⚠️ [imageGen] Art Director failed JSON parse: ${parseError.message}. Falling back.`);
      visualPrompt = `${rawInput}, cinematic, highly detailed`;
    }

    console.log(`🎨 [imageGen] Final Compiled Prompt sent to API: "${visualPrompt}"`);
    
    const seed = Math.floor(Math.random() * 1000000);
    const encodedPrompt = encodeURIComponent(visualPrompt);
    
    // 4. 🚀 THE ULTIMATE URL
    const imageUrl = `/pollinations-api/image/${encodedPrompt}?width=1024&height=1024&seed=${seed}&nologo=true&key=${apiKey}`;

    return {
      success: true,
      data: { 
        text: `Successfully generated image.`,
        url: imageUrl,
        html: `<div style="margin-top:20px; text-align:center;">
                <img 
                  src="${imageUrl}" 
                  referrerpolicy="no-referrer"
                  style="max-width: 100%; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,0.6);" 
                />
               </div>`,
        preformatted: true 
      }
    };
  } catch (error) {
    console.error(`❌ [imageGen] Error:`, error.message);
    return { success: false, error: error.message };
  }
}