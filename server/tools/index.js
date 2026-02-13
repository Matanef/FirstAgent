import { calculator } from "./calculator.js";
import { getTopStocks, getStockPrice } from "./finance.js";
import { searchWeb } from "./search.js";
import * as file from "./file.js";

export const TOOLS = {
  calculator: { execute: calculator },
  finance: { execute: getTopStocks },
  stock_price: { execute: getStockPrice },
  search: { execute: searchWeb },
  file
};
