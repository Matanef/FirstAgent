// server/tools/index.js

import { calculator } from "./calculator.js";
import { finance } from "./finance.js";
import { search } from "./search.js";
import { file } from "./file.js";
import { llm } from "./llm.js";

export const TOOLS = {
  calculator: { execute: calculator },
  finance: { execute: finance },
  search: { execute: search },
  file: { execute: file },
  llm: { execute: llm }   // ← THIS IS THE FIX
};
