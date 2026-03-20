// server/tools/webDownload.js
// Download code, libraries, and learning materials from the internet

import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";
import { extractFromWebContent } from "../knowledge.js";

const DOWNLOAD_DIR = path.resolve("D:/local-llm-ui/downloads");

/**
 * Download a file from URL
 */
async function downloadFile(url, filename) {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const content = await response.text();

    // Ensure download directory exists
    await fs.mkdir(DOWNLOAD_DIR, { recursive: true });

    const filepath = path.join(DOWNLOAD_DIR, filename);
    await fs.writeFile(filepath, content, "utf8");

    return {
      success: true,
      filepath,
      size: content.length
    };

  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
}

/**
 * Download from GitHub raw URL
 */
async function downloadFromGitHub(url) {
  // Convert GitHub URL to raw if needed
  let rawUrl = url;

  if (url.includes("github.com") && !url.includes("raw.githubusercontent.com")) {
    rawUrl = url
      .replace("github.com", "raw.githubusercontent.com")
      .replace("/blob/", "/");
  }

  const filename = path.basename(new URL(rawUrl).pathname);
  return await downloadFile(rawUrl, filename);
}

/**
 * Download npm package info
 */
async function fetchNpmPackageInfo(packageName) {
  try {
    const url = `https://registry.npmjs.org/${packageName}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Package not found: ${packageName}`);
    }

    const data = await response.json();

    return {
      name: data.name,
      version: data["dist-tags"]?.latest,
      description: data.description,
      homepage: data.homepage,
      repository: data.repository?.url,
      keywords: data.keywords,
      license: data.license
    };

  } catch (err) {
    return {
      error: err.message
    };
  }
}

/**
 * Main web download tool
 */
export async function webDownload(request) {
  try {
    let url = request.url;
    let type = request.type || "auto";
    let filename = request.filename;

    if (!url && typeof request === 'object') {
      const text = request.text || "";
      // Simple regex to find URL in text if it's just a URL string
      if (/^https?:\/\/\S+$/.test(text.trim())) {
        url = text.trim();
      } else if (text.trim().includes(" ")) {
        // Conversational, try to extract the first URL
        const match = text.match(/https?:\/\/\S+/);
        if (match) url = match[0];
      } else {
        url = text.trim();
      }
    }

    if (!url && typeof request === 'string') {
      url = request.trim();
    }

    if (!url) {
      return {
        tool: "webDownload",
        success: false,
        final: true,
        error: "URL is required"
      };
    }

    // Determine download type
    let result;

    if (type === "github" || url.includes("github.com")) {
      result = await downloadFromGitHub(url);
    } else if (type === "npm") {
      // For npm, we just fetch info, user needs to install via packageManager tool
      const packageName = url.replace(/^npm:/, "");
      const info = await fetchNpmPackageInfo(packageName);

      return {
        tool: "webDownload",
        success: !info.error,
        final: true,
        data: {
          type: "npm-info",
          package: info,
          suggestion: `To install, use: npm install ${packageName}`
        },
        reasoning: info.error ? info.error : `Found package ${info.name}@${info.version}`
      };
    } else {
      // Generic download
      const fname = filename || path.basename(new URL(url).pathname) || "download.txt";
      result = await downloadFile(url, fname);
    }

    if (!result.success) {
      return {
        tool: "webDownload",
        success: false,
        final: true,
        error: result.error
      };
    }

    // For text-based files, also return content so LLM can read/summarize/follow instructions
    let contentPreview = null;
    let plainText = null;
    let extractedTitle = null;
    const textExtensions = ['.md', '.txt', '.json', '.js', '.html', '.css', '.csv', '.xml', '.yaml', '.yml', '.py', '.sh', '.bat'];
    const ext = path.extname(result.filepath).toLowerCase();
    if (textExtensions.includes(ext) || !ext) {
      try {
        const fullContent = await fs.readFile(result.filepath, 'utf8');

        // If this looks like HTML, extract clean text (strip scripts, styles, tags)
        const isHTML = fullContent.trimStart().startsWith('<!') || fullContent.trimStart().startsWith('<html') || /<html[\s>]/i.test(fullContent.slice(0, 500));
        if (isHTML) {
          // Extract page title
          const titleMatch = fullContent.match(/<title[^>]*>(.*?)<\/title>/i);
          const pageTitle = titleMatch ? titleMatch[1].replace(/\s*[-–|].*$/, '').trim() : '';
          extractedTitle = pageTitle;

          // Strip scripts, styles, nav, header, footer, then tags
          plainText = fullContent
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
            .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
            .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
            .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\s+/g, ' ')
            .trim();

          // Provide generous preview for article content
          const MAX_TEXT = 12000;
          contentPreview = (pageTitle ? `Title: ${pageTitle}\n\n` : '') +
            (plainText.length > MAX_TEXT
              ? plainText.slice(0, MAX_TEXT) + `\n\n... (truncated, ${plainText.length} total chars)`
              : plainText);
        } else {
          // Non-HTML text files: provide as-is
          const MAX_CONTENT = 8000;
          contentPreview = fullContent.length > MAX_CONTENT
            ? fullContent.slice(0, MAX_CONTENT) + `\n\n... (truncated, ${fullContent.length} total chars)`
            : fullContent;
          plainText = contentPreview;
        }
      } catch { /* ignore read errors */ }
    }

    // Store facts in passive knowledge system (awaited so we can report what was learned)
    let learnedFacts = [];
    if (plainText && plainText.length > 50) {
      try {
        learnedFacts = await extractFromWebContent(extractedTitle || path.basename(result.filepath), plainText, url) || [];
      } catch (e) {
        console.warn("[webDownload] Knowledge extraction failed:", e.message);
      }
    }

    return {
      tool: "webDownload",
      success: true,
      final: true,
      data: {
        filepath: result.filepath,
        size: result.size,
        sizeFormatted: `${(result.size / 1024).toFixed(2)} KB`,
        content: contentPreview,
        plain: plainText || contentPreview,
        text: contentPreview
          ? `Downloaded ${path.basename(result.filepath)} (${(result.size / 1024).toFixed(2)} KB)\n\nContent:\n${contentPreview}`
          : `Downloaded ${path.basename(result.filepath)} (${(result.size / 1024).toFixed(2)} KB)`,
        learnedFacts
      },
      reasoning: `Downloaded and read ${path.basename(result.filepath)} (${(result.size / 1024).toFixed(2)} KB)`
    };

  } catch (err) {
    return {
      tool: "webDownload",
      success: false,
      final: true,
      error: `Download failed: ${err.message}`
    };
  }
}
