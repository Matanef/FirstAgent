// server/tools/index.js

import { llm } from "./llm.js";
import { file } from "./file.js";
import { fileWrite } from "./fileWrite.js";
import { webDownload } from "./webDownload.js";
import { packageManager } from "./packageManager.js";

import { search } from "./search.js";
import { news } from "./news.js";
import { finance } from "./finance.js";
import { financeFundamentals } from "./financeFundamentals.js";
import { calculator } from "./calculator.js";
import { weather } from "./weather.js";
import { sports } from "./sports.js";
import { youtube } from "./youtube.js";
import { shopping } from "./shopping.js";
import { email } from "./email.js";
import { tasks } from "./tasks.js";
import { memorytool } from "./memoryTool.js";
import { logTelemetry } from "../telemetryAudit.js";
import { logIntentDecision } from "../intentDebugger.js";

export const TOOLS = {
  llm,              // for direct conversation / meta / memory
  file,             // read/list project and testFolder
  fileWrite,        // write/modify files (with backup rules)
  webDownload,      // download code/content from web/GitHub/npm info
  packageManager,   // npm install/uninstall/list
  memorytool,       // Provides a way for deleying Location from memory

  search,
  news,
  finance,
  financeFundamentals,
  calculator,
  weather,
  sports,
  youtube,
  shopping,
  email,
  tasks,
  logTelemetry,
  logIntentDecision
};