// server/tools/index.js
// COMPLETE: All tools including applyPatch

import { calculator } from "./calculator.js";
import { weather } from "./weather.js";
import { finance } from "./finance.js";
import { financeFundamentals } from "./financeFundamentals.js";
import { search } from "./search.js";
import { sports } from "./sports.js";
import { youtube } from "./youtube.js";
import { shopping } from "./shopping.js";
import { news } from "./news.js";
import { file } from "./file.js";
import { fileWrite } from "./fileWrite.js";
import { email } from "./email.js";
import { tasks } from "./tasks.js";
import { memorytool } from "./memoryTool.js";
import { packageManager } from "./packageManager.js";
import { webDownload } from "./webDownload.js";
import { selfImprovement } from "./selfImprovement.js";
import { github } from "./github.js";
import { gitLocal } from "./gitLocal.js";
import { review } from "./review.js";
import { nlpTool as nlp_tool } from "./nlp.js";
import { githubTrending } from "./githubTrending.js";
import { applyPatch } from "./applyPatch.js";
import { fileReview } from "./fileReview.js";
import { duplicateScanner } from "./duplicateScanner.js";
import { webBrowser } from "./webBrowser.js";
import { moltbook } from "./moltbook.js";
import { contacts } from "./contacts.js";
import { calendar } from "./calendar.js";
import { documentQA } from "./documentQA.js";

export const TOOLS = {
  calculator,
  contacts,
  calendar,
  documentQA,
  weather,
  finance,
  financeFundamentals,
  search,
  sports,
  youtube,
  shopping,
  news,
  file,
  fileWrite,
  email,
  tasks,
  memorytool,
  packageManager,
  webDownload,
  selfImprovement,
  github,
  gitLocal,
  review,
  nlp_tool,
  githubTrending,
  applyPatch,
  fileReview,
  duplicateScanner,
  webBrowser,
  moltbook
};

// Validate all tools are functions at startup
console.log("\n🔧 Validating tool registry...");
let validCount = 0;
let invalidCount = 0;

for (const [name, tool] of Object.entries(TOOLS)) {
  if (typeof tool !== "function") {
    console.error(`❌ ERROR: Tool "${name}" is not a function!`);
    invalidCount++;
  } else {
    console.log(`✅ Tool registered: ${name}`);
    validCount++;
  }
}

console.log(`\n📊 Tool Registry Summary:`);
console.log(`   ✅ Valid tools: ${validCount}`);
if (invalidCount > 0) {
  console.log(`   ❌ Invalid tools: ${invalidCount}`);
}
console.log(`   📦 Total: ${Object.keys(TOOLS).length}\n`);

export default TOOLS;
