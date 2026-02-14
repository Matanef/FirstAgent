// server/tools/index.js

import { calculator } from "./calculator.js";
import { file } from "./file.js";
import { finance } from "./finance.js";
import { search } from "./search.js";
import { llm } from "./llm.js";
import { weather } from "./weather.js";
import { financeFundamentals } from "./financeFundamentals.js";

export const TOOLS = {
  calculator,
  file,
  finance,
  "finance-fundamentals": financeFundamentals,
  search,
  llm,
  weather
};