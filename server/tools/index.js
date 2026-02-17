// server/tools/index.js

import { file } from "./file.js";
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
import { fileWrite } from "./fileWrite.js";
import { webDownload } from "./webDownload.js";
import { packageManager } from "./packageManager.js";

export const TOOLS = {
  file,
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
  fileWrite,        // ADD
  webDownload,      // ADD
  packageManager,   // ADD
};