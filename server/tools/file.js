// file.js
import fs from "fs";
import path from "path";

const ROOT_DIR = process.cwd(); // restrict to project root

function sanitizePath(userPath) {
  const resolved = path.resolve(ROOT_DIR, userPath);
  if (!resolved.startsWith(ROOT_DIR)) {
    throw new Error("Access denied");
  }
  return resolved;
}

function scanDirectory(dirPath) {
  const items = fs.readdirSync(dirPath);

  return items.map(item => {
    const fullPath = path.join(dirPath, item);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      return {
        type: "folder",
        name: item,
        children: scanDirectory(fullPath)
      };
    } else {
      return {
        type: "file",
        name: item,
        size: stat.size
      };
    }
  });
}

export async function fileTool(inputPath) {
  try {
    const safePath = sanitizePath(inputPath);
    const stat = fs.statSync(safePath);

    if (stat.isDirectory()) {
      return {
        tool: "file",
        success: true,
        final: true,
        data: {
          type: "directory",
          path: inputPath,
          structure: scanDirectory(safePath)
        }
      };
    } else {
      const content = fs.readFileSync(safePath, "utf-8");

      return {
        tool: "file",
        success: true,
        final: true,
        data: {
          type: "file",
          path: inputPath,
          content
        }
      };
    }

  } catch (err) {
    return {
      tool: "file",
      success: false,
      final: true,
      error: err.message
    };
  }
}
