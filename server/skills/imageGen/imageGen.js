import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { llm } from "../../tools/llm.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const COMFY_URL = "http://127.0.0.1:8188";

export async function generateImage(message) {
    let rawInput = typeof message === "object" ? (message.text || message.input || message.sceneDescription) : message;
    
    // 1. Intercept the hidden routing tag from the UI (Default to local)
    let engine = "local"; 
    if (typeof message === "object" && message.imageModelPref) engine = message.imageModelPref;
    if (rawInput.includes("[MODEL:cloud]")) { 
        engine = "cloud"; 
        rawInput = rawInput.replace("[MODEL:cloud]", "").trim(); 
    }
    if (rawInput.includes("[MODEL:local]")) { 
        engine = "local"; 
        rawInput = rawInput.replace("[MODEL:local]", "").trim(); 
    }
    
    console.log(`\n⚙️ [imageGen] Engine Selected: ${engine.toUpperCase()}`);

    // 2. Shared LLM Art Director Step
    const compilePrompt = `You are an elite AI Art Director. 
    Read the user's scene description and write a highly structured, diffusion-optimized image prompt.
    CRITICAL RULES:
    - NO PROSE OR NARRATIVE. 
    - USE NUMBERING FOR MULTIPLE SUBJECTS (e.g., "1. A young man..., 2. An older man...").
    - LAYER CAKE STRUCTURE: [Style] -> [Camera Angle] -> [Numbered Subjects] -> [Action] -> [Setting] -> [Lighting].
    - OUTPUT FORMAT: You MUST output a single, raw, plain-text string. DO NOT output JSON. DO NOT output arrays or objects.
    
    Scene Description: "${rawInput}"`;

    try {
        const refinedRes = await llm(compilePrompt, { 
            model: "qwen2.5:7b", 
            options: { temperature: 0.1 },
            skipKnowledge: true 
        });
        
        const compiledPrompt = refinedRes?.data?.text || rawInput;
        const safePromptString = typeof compiledPrompt === 'object' ? JSON.stringify(compiledPrompt) : compiledPrompt;
        
        console.log(`🎨 [imageGen] Final Prompt: "${safePromptString}"`);

        // ==========================================
        // ROUTE 1: POLLINATIONS (CLOUD)
        // ==========================================
        if (engine === "cloud") {
            const apiKey = process.env.POLLINATIONS_API_KEY || "";
            const seed = Math.floor(Math.random() * 1000000);
            const encodedPrompt = encodeURIComponent(safePromptString);
            const keyParam = apiKey ? `&key=${apiKey}` : "";
            
            // Using your proxy endpoint to prevent CORS
            const imageUrl = `/pollinations-api/image/${encodedPrompt}?width=1024&height=1024&seed=${seed}&nologo=true${keyParam}`;

            console.log(`✅ [imageGen] Pollinations URL generated.`);
            return {
                success: true,
                data: {
                    text: `Successfully generated image via Cloud.`,
                    url: imageUrl,
                    html: `<div style="margin-top:20px; text-align:center;">
                            <img src="${imageUrl}" referrerpolicy="no-referrer" style="max-width: 100%; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,0.6);" />
                           </div>`,
                    preformatted: true
                }
            };
        }

        // ==========================================
        // ROUTE 2: COMFYUI (LOCAL GPU)
        // ==========================================
        if (engine === "local") {
            const templatePath = path.join(__dirname, 'comfy_template.json');
            const workflowData = fs.readFileSync(templatePath, 'utf8');
            let workflow = JSON.parse(workflowData);

            // Inject the dynamic data into the Comfy template
            workflow["3"].inputs.seed = Math.floor(Math.random() * 1000000000000); 
            workflow["6"].inputs.text = safePromptString;

            console.log(`🚀 [imageGen] Sending job to ComfyUI at ${COMFY_URL}...`);
            const queueRes = await fetch(`${COMFY_URL}/prompt`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: workflow })
            });

            const queueData = await queueRes.json();
            const prompt_id = queueData.prompt_id;
            
            if (!prompt_id) throw new Error("ComfyUI did not return a prompt_id.");

            console.log(`⏳ [imageGen] Job queued. Waiting for completion...`);
            let isDone = false;
            let generatedFilename = "";

            while (!isDone) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                const historyRes = await fetch(`${COMFY_URL}/history/${prompt_id}`);
                const historyData = await historyRes.json();

                if (historyData[prompt_id]) {
                    isDone = true;
                    const outputs = historyData[prompt_id].outputs;
                    if (outputs["9"] && outputs["9"].images && outputs["9"].images.length > 0) {
                        generatedFilename = outputs["9"].images[0].filename;
                    }
                }
            }

            if (generatedFilename) {
                const finalImageUrl = `${COMFY_URL}/view?filename=${generatedFilename}&type=output`;
                console.log(`✅ [imageGen] Fetching image to bypass CORS...`);
                
                // Fetch the image internally and convert to Base64 to bypass browser security
                const imgResponse = await fetch(finalImageUrl);
                const arrayBuffer = await imgResponse.arrayBuffer();
                const base64Image = Buffer.from(arrayBuffer).toString('base64');
                const dataUri = `data:image/png;base64,${base64Image}`;

                return {
                    success: true,
                    data: {
                        text: `Successfully generated image via Local GPU.`,
                        url: finalImageUrl, // Keeping for logging purposes
                        html: `<div style="margin-top:20px; text-align:center;">
                                <img src="${dataUri}" style="max-width: 100%; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,0.6);" />
                               </div>`,
                        preformatted: true
                    }
                };
            } else {
                throw new Error("ComfyUI finished the job, but couldn't locate the saved file.");
            }
        }

    } catch (error) {
        console.error("❌ [imageGen] Error:", error.message);
        return { success: false, error: error.message };
    }
}