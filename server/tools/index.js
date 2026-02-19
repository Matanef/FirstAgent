// server/tools/index.js
// COMPLETE FIX: All tools properly exported including selfImprovement and github

import { calculator } from "./calculator.js";
import { weather } from "./weather.js";
import { finance } from "./finance.js";
import { financeFundamentals } from "./financeFundamentals.js";
import { search } from "./search.js";
import { sports } from "./sports.js";
import { youtube } from "./youtube.js";
import { llm } from "./llm.js";
import { imageGen } from "./imageGen.js";
import { shopping } from "./shopping.js";
import { news } from "./news.js";
import { file } from "./file.js";
import { fileWrite } from "./fileWrite.js";
import { email } from "./email.js";
import { tasks } from "./tasks.js";
import { memorytool } from "./memoryTool.js";
import { packageManager } from "./packageManager.js";
import { webDownload } from "./webDownload.js";
import { selfImprovement } from "./selfImprovement.js";  // FIX #4, #5: Was missing!
import { github } from "./github.js";  // FIX #9: Was missing!
import { logTelemetry } from "../telemetryAudit.js";
import { logIntentDecision } from "../intentDebugger.js";
import { review } from "./review.js"

export const TOOLS = {
  calculator,
  weather,
  finance,
  financeFundamentals,
  search,
  sports,
  youtube,
  shopping,
  news,
  imageGen,
  file,
  fileWrite,
  email,
  tasks,
  llm,
  memorytool,
  packageManager,
  webDownload,
  selfImprovement,  // ✅ Now exported!
  github,
  logTelemetry,
  logIntentDecision,              // ✅ Now exported!
  review
};

// Validate all tools are functions at startup
console.log("\n🔧 Validating tool registry...");
for (const [name, tool] of Object.entries(TOOLS)) {
  if (typeof tool !== "function") {
    console.error(`❌ ERROR: Tool "${name}" is not a function!`);
  } else {
    console.log(`✅ Tool registered: ${name}`);
  }
}
console.log(`\n📊 Total tools: ${Object.keys(TOOLS).length}\n`);

export default TOOLS;
