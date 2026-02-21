// server/tools/webDownload.js
// Download code, libraries, and learning materials from the internet

import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";

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

    return {
      tool: "webDownload",
      success: true,
      final: true,
      data: {
        filepath: result.filepath,
        size: result.size,
        sizeFormatted: `${(result.size / 1024).toFixed(2)} KB`
      },
      reasoning: `Downloaded ${path.basename(result.filepath)} (${(result.size / 1024).toFixed(2)} KB)`
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
