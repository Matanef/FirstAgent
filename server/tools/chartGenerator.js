// server/tools/chartGenerator.js
// Generates SVG or HTML charts from generic JSON data.

import { CONFIG } from "../utils/config.js";
import fs from "fs";
import path from "path";

/**
 * Generates SVG or HTML charts from generic JSON data.
 * @param {string|object} request - User input (string or {text, context})
 * @returns {object} Standard tool response
 */
export async function chartGenerator(request) {
  try {
    const text = typeof request === "string" ? request : (request?.text || "");
    const context = typeof request === "object" ? (request?.context || {}) : {};

    let jsonData = context.data;
    let labelKey = context.labelKey;
    let valueKey = context.valueKey;

// 1. Try to extract a JSON array hidden inside the English text
    if (!jsonData && text) {
      const arrayMatch = text.match(/\[\s*\{.*\}\s*\]/s);
      if (arrayMatch) {
        try { jsonData = JSON.parse(arrayMatch[0]); } catch (e) { console.warn("Failed to parse extracted array."); }
      }
    }

// 2. Safely extract keys (tightly bound to avoid greedy jumping)
    if (!labelKey) {
      const lMatch = text.match(/(?:labelKey[\s:=]+['"]([a-zA-Z0-9_]+)['"]|['"]([a-zA-Z0-9_]+)['"]\s*(?:as|for|is)(?:\s+the)?\s+labelKey)/i);
      if (lMatch) labelKey = lMatch[1] || lMatch[2];
    }
    if (!valueKey) {
      const vMatch = text.match(/(?:valueKey[\s:=]+['"]([a-zA-Z0-9_]+)['"]|['"]([a-zA-Z0-9_]+)['"]\s*(?:as|for|is)(?:\s+the)?\s+valueKey)/i);
      if (vMatch) valueKey = vMatch[1] || vMatch[2];
    }

    // 3. BULLETPROOF FALLBACK: If we STILL don't have keys, just guess them from the JSON!
    if (Array.isArray(jsonData) && jsonData.length > 0) {
      const availableKeys = Object.keys(jsonData[0]);
      if (!labelKey && availableKeys.length > 0) labelKey = availableKeys[0];
      if (!valueKey && availableKeys.length > 1) valueKey = availableKeys[1];
    }

    // Validate data format
    if (!Array.isArray(jsonData) || jsonData.length === 0) {
      throw new Error("Invalid data format: Data must be a non-empty array.");
    }

    // Extract label and value keys
    if (!labelKey || !valueKey) {
      throw new Error("Label and value keys are required (e.g., labelKey: 'name', valueKey: 'value').");
    }

    // Ensure all data items have the required keys
    for (const item of jsonData) {
      if (item[labelKey] === undefined || item[valueKey] === undefined) {
        throw new Error(`Data item missing required keys. Each item must have '${labelKey}' and '${valueKey}'.`);
      }
      if (typeof item[valueKey] !== 'number') {
        throw new Error(`Value for key '${valueKey}' must be a number.`);
      }
    }

    // Generate SVG vertical bar chart
    let svgContent = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"500\" height=\"400\" font-family=\"sans-serif\" font-size=\"10\" text-anchor=\"middle\">\n";
    const chartAreaHeight = 300; // Max height for bars to avoid hitting top/bottom of SVG
    const yAxisOffset = 50; // Space from bottom for labels/axis
    const barSpacing = 50; // Space allocated per bar (including its own width and gap)
    const barWidth = 40; // Actual width of each bar
    const xOffset = 10; // Initial x-offset for the first bar

    // Find max value for scaling bar heights
    const maxValue = Math.max(...jsonData.map(item => item[valueKey]));
    if (maxValue <= 0) {
        // Handle case where all values are zero or negative to prevent division by zero or incorrect scaling
        throw new Error("All values are zero or negative, cannot generate a meaningful chart.");
    }

    // Draw bars and labels
    jsonData.forEach((item, index) => {
      const value = item[valueKey];
      const scaledHeight = (value / maxValue) * chartAreaHeight;
      const x = xOffset + (index * barSpacing);
      const y = chartAreaHeight + yAxisOffset - scaledHeight; // Calculate y from bottom up

      // Draw bar
      svgContent += `  <rect x=\"${x}\" y=\"${y}\" width=\"${barWidth}\" height=\"${scaledHeight}\" fill=\"#6bacee\"/>\n`;
      
      // Draw label below bar
      svgContent += `  <text x=\"${x + (barWidth / 2)}\" y=\"${chartAreaHeight + yAxisOffset + 15}\" fill=\"black\">${item[labelKey]}</text>\n`;

      // Draw value above bar
      svgContent += `  <text x=\"${x + (barWidth / 2)}\" y=\"${y - 5}\" fill=\"gray\">${value}</text>\n`;
    });
    svgContent += "</svg>";

    // Save the chart to disk
    const chartsDir = CONFIG.CHARTS_DIR;
    // Ensure the directory exists
    if (!fs.existsSync(chartsDir)) {
      fs.mkdirSync(chartsDir, { recursive: true });
    }
    const outputFilePath = path.join(chartsDir, "chart.svg");
    fs.writeFileSync(outputFilePath, svgContent);

    return {
      tool: "chartGenerator",
      success: true,
      final: true,
      data: {
        text: `Chart saved to ${outputFilePath}`,
        preformatted: true,
        filePath: outputFilePath // Provide the file path for potential downstream use
      }
    };
  } catch (err) {
    console.error("[chartGenerator] Error:", err.message);
    return {
      tool: "chartGenerator",
      success: false,
      final: true,
      error: err.message
    };
  }
}