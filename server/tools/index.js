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
import { scheduler } from "./scheduler.js";
import { contacts } from "./contacts.js";
import { calendar } from "./calendar.js";
import { documentQA } from "./documentQA.js";
import { lotrJokes } from "./lotrJokes.js";
import { workflow } from "./workflowTool.js";
import { folderAccess } from "./folderAccess.js";
import { codeReview } from "./codeReview.js";
import { codeTransform } from "./codeTransform.js";
import { projectGraph } from "./projectGraph.js";
import { projectIndex } from "./projectIndex.js";
import { githubScanner } from "./githubScanner.js";
import { selfEvolve } from "./selfEvolve.js";
import { whatsapp } from "./whatsapp.js";
import { x } from "./x.js";
import { sheets } from "./sheets.js";
import { smartEvolution } from "./smartEvolution.js";
import { systemMonitor } from "./systemMonitor.js";
import { webhookTunnel } from "./webhookTunnel.js";
import { markdownCompiler } from "./markdownCompiler.js";
import { codeSandbox } from "./codeSandbox.js";
import { codeRag } from "./codeRag.js";
import { projectSnapshot } from "./projectSnapshot.js";
import { chartGenerator } from "./chartGenerator.js";
import { spotifyController } from "./spotify.js";
import { mcpBridge } from "./mcpBridge.js";

export const TOOLS = {
  calculator,
  contacts,
  calendar,
  chartGenerator,
  codeSandbox,
  codeRag,
  documentQA,
  lotrJokes,
  workflow,
  weather,
  finance,
  financeFundamentals,
  search,
  sports,
  spotifyController,
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
  moltbook,
  scheduler,
  folderAccess,
  codeReview,
  codeTransform,
  projectGraph,
  projectIndex,
  projectSnapshot,
  githubScanner,
  selfEvolve,
  whatsapp,
  x,
  sheets,
  smartEvolution,
  systemMonitor,
  markdownCompiler,
  webhookTunnel,
  mcpBridge
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

