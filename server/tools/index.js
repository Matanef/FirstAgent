// server/tools/index.js

import { calculator } from "./calculator.js";
import { finance } from "./finance.js";
import { search } from "./search.js";
import { fileTool } from "./file.js";

export const TOOLS = {
  calculator: { execute: calculator },
  finance: { execute: finance },
  search: { execute: search },
  file: { execute: fileTool }
};
