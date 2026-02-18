// server/tools/imageGen.js
import Replicate from "replicate";
import { CONFIG } from "../utils/config.js";

export async function imageGen(query) {
  if (!CONFIG.REPLICATE_API_TOKEN) {
    return {
      tool: "imageGen",
      success: false,
      final: true,
      error: "Replicate API token not configured. Get one at https://replicate.com/account/api-tokens"
    };
  }
  
  const replicate = new Replicate({
    auth: CONFIG.REPLICATE_API_TOKEN
  });
  
  const output = await replicate.run(
    "stability-ai/sdxl:latest",
    {
      input: {
        prompt: query,
        num_outputs: 1
      }
    }
  );
  
  return {
    tool: "imageGen",
    success: true,
    final: true,
    data: {
      images: output,
      prompt: query
    }
  };
}