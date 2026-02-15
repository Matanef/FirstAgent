// tools/index.js — Section 5: Tool Registry

import { calculator } from "./calculator.js";
import { search } from "./search.js";
import { finance } from "./finance.js";
import { financeFundamentals } from "./financeFundamentals.js";
import { weather } from "./weather.js";
import { llm } from "./llm.js";
import { file } from "./file.js";
import { mathIntent } from "./math-intent.js";

// Export a unified tool registry
export const TOOLS = {
  calculator,
  search,
  finance,
  financeFundamentals,
  weather,
  llm,
  file,
  mathIntent
};