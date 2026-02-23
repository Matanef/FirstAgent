// server/tools/duplicateScanner.js
// Tool: scans directories for duplicate files using two-stage hash detection

import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import crypto from "crypto";
import { PROJECT_ROOT } from "../utils/config.js";

// ============================================================
// CONSTANTS
// ============================================================
const MAX_FILES = 10000;
const MAX_DEPTH = 10;
const MAX_HASH_SIZE = 100 * 1024 * 1024; // 100MB
const CHUNK_SIZE = 4096; // 4KB for first-chunk hash
const TIMEOUT_MS = 60000; // 60s
const LEVENSHTEIN_THRESHOLD = 3;

const EXECUTABLE_EXTENSIONS = new Set([
    ".exe", ".bat", ".cmd", ".sh", ".bash", ".py", ".pl", ".rb",
    ".msi", ".dll", ".so", ".patch", ".com", ".scr", ".pif",
    ".ps1", ".vbs", ".wsf"
]);

// Sandbox roots — only scan within these
const ALLOWED_ROOTS = [
    PROJECT_ROOT,
    "E:/testFolder"
].map(p => path.resolve(p));

// ============================================================
// HELPERS
// ============================================================

function isExecutable(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return EXECUTABLE_EXTENSIONS.has(ext);
}

function sanitizePath(inputPath) {
    const normalized = path.resolve(inputPath);
    if (inputPath.includes("..")) return null;
    const allowed = ALLOWED_ROOTS.some(root => normalized.startsWith(root));
    return allowed ? normalized : null;
}

async function hashFile(filePath, fullHash = false) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        const stream = createReadStream(filePath, fullHash ? {} : { start: 0, end: CHUNK_SIZE - 1 });
        stream.on("data", chunk => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
        stream.on("error", reject);
    });
}

function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

// ============================================================
// DIRECTORY WALKER
// ============================================================
async function walkDir(dir, options = {}) {
    const {
        maxDepth = MAX_DEPTH,
        maxFiles = MAX_FILES,
        nameFilter = null,
        typeFilter = null,
        abortSignal = null
    } = options;

    const files = [];
    let scanned = 0;

    async function walk(currentDir, depth) {
        if (depth > maxDepth || files.length >= maxFiles) return;
        if (abortSignal?.aborted) return;

        let entries;
        try {
            entries = await fs.readdir(currentDir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (files.length >= maxFiles || abortSignal?.aborted) return;

            const fullPath = path.join(currentDir, entry.name);

            if (entry.isDirectory()) {
                if (["node_modules", ".git", ".svn", "__pycache__", ".claude"].includes(entry.name)) continue;
                await walk(fullPath, depth + 1);
            } else if (entry.isFile()) {
                scanned++;

                if (nameFilter && !entry.name.toLowerCase().includes(nameFilter.toLowerCase())) continue;

                if (typeFilter) {
                    const ext = path.extname(entry.name).toLowerCase();
                    const normalizedType = typeFilter.startsWith(".") ? typeFilter.toLowerCase() : `.${typeFilter.toLowerCase()}`;
                    if (ext !== normalizedType) continue;
                }

                try {
                    const stat = await fs.stat(fullPath);
                    files.push({
                        path: fullPath,
                        name: entry.name,
                        size: stat.size,
                        mtime: stat.mtime.toISOString(),
                        ino: stat.ino,
                        isExecutable: isExecutable(fullPath)
                    });
                } catch {
                    // Skip unreadable files
                }
            }
        }
    }

    await walk(dir, 0);
    return { files, scanned };
}

// ============================================================
// DUPLICATE DETECTION
// ============================================================
async function findDuplicates(files, options = {}) {
    const { snippetFilter = null, abortSignal = null } = options;
    const groups = [];

    // Stage 1: Group by size
    const sizeGroups = new Map();
    for (const file of files) {
        if (!sizeGroups.has(file.size)) sizeGroups.set(file.size, []);
        sizeGroups.get(file.size).push(file);
    }

    const candidates = [];
    for (const [, group] of sizeGroups) {
        if (group.length > 1) candidates.push(...group);
    }

    console.log(`  📊 Size grouping: ${files.length} files → ${candidates.length} candidates`);

    // Stage 2: Chunk hash (first 4KB)
    const chunkGroups = new Map();
    for (const file of candidates) {
        if (abortSignal?.aborted) break;
        if (file.size > MAX_HASH_SIZE) continue;

        try {
            const chunkHash = await hashFile(file.path, false);
            const key = `${file.size}-${chunkHash}`;
            if (!chunkGroups.has(key)) chunkGroups.set(key, []);
            chunkGroups.get(key).push(file);
        } catch {
            // Skip unhashable
        }
    }

    // Stage 3: Full hash to confirm
    for (const [, group] of chunkGroups) {
        if (group.length < 2) continue;
        if (abortSignal?.aborted) break;

        const fullHashGroups = new Map();
        for (const file of group) {
            try {
                const fullHash = await hashFile(file.path, true);
                if (!fullHashGroups.has(fullHash)) fullHashGroups.set(fullHash, []);
                fullHashGroups.get(fullHash).push(file);
            } catch { /* skip */ }
        }

        for (const [hash, dupGroup] of fullHashGroups) {
            if (dupGroup.length < 2) continue;

            // Filter hard links (same inode = same file)
            const inodes = new Set();
            const realDups = [];
            for (const f of dupGroup) {
                if (f.ino && inodes.has(f.ino)) continue;
                if (f.ino) inodes.add(f.ino);
                realDups.push(f);
            }

            if (realDups.length >= 2) {
                // Apply snippet filter
                if (snippetFilter) {
                    let hasMatch = false;
                    for (const f of realDups) {
                        try {
                            const buf = Buffer.alloc(1024);
                            const fd = await fs.open(f.path, "r");
                            await fd.read(buf, 0, 1024, 0);
                            await fd.close();
                            if (buf.toString("utf8").includes(snippetFilter)) {
                                hasMatch = true;
                                break;
                            }
                        } catch { /* skip */ }
                    }
                    if (!hasMatch) continue;
                }

                groups.push({
                    hash: hash.slice(0, 12),
                    matchType: "exact",
                    files: realDups.map(f => ({
                        path: f.path, name: f.name, size: f.size,
                        mtime: f.mtime, isExecutable: f.isExecutable
                    }))
                });
            }
        }
    }

    // Stage 4: Metadata duplicates (same name + size, different folders)
    const nameGroups = new Map();
    for (const file of files) {
        const key = `${file.name.toLowerCase()}-${file.size}`;
        if (!nameGroups.has(key)) nameGroups.set(key, []);
        nameGroups.get(key).push(file);
    }

    for (const [, group] of nameGroups) {
        if (group.length < 2) continue;
        const dirs = new Set(group.map(f => path.dirname(f.path)));
        if (dirs.size < 2) continue;

        const alreadyGrouped = groups.some(g =>
            g.files.some(gf => group.some(f => gf.path === f.path))
        );
        if (alreadyGrouped) continue;

        groups.push({
            hash: "metadata",
            matchType: "metadata",
            files: group.map(f => ({
                path: f.path, name: f.name, size: f.size,
                mtime: f.mtime, isExecutable: f.isExecutable
            }))
        });
    }

    // Stage 5: Fuzzy name duplicates (Levenshtein)
    const nameList = files.map(f => ({ name: f.name.toLowerCase(), file: f }));
    const fuzzyPairs = new Set();
    const limit = Math.min(nameList.length, 500);
    for (let i = 0; i < limit; i++) {
        for (let j = i + 1; j < limit; j++) {
            const dist = levenshtein(nameList[i].name, nameList[j].name);
            if (dist > 0 && dist <= LEVENSHTEIN_THRESHOLD) {
                const pairKey = [nameList[i].file.path, nameList[j].file.path].sort().join("|");
                if (fuzzyPairs.has(pairKey)) continue;
                fuzzyPairs.add(pairKey);

                const alreadyCovered = groups.some(g =>
                    g.files.some(gf => gf.path === nameList[i].file.path) &&
                    g.files.some(gf => gf.path === nameList[j].file.path)
                );
                if (alreadyCovered) continue;

                groups.push({
                    hash: "fuzzy",
                    matchType: "fuzzy_name",
                    files: [nameList[i].file, nameList[j].file].map(f => ({
                        path: f.path, name: f.name, size: f.size,
                        mtime: f.mtime, isExecutable: f.isExecutable
                    }))
                });
            }
        }
    }

    return groups;
}

// ============================================================
// NATURAL LANGUAGE PARSING
// ============================================================
function parseNaturalLanguage(text) {
    const context = {};

    const pathMatch = text.match(/(?:in|under|at|from)\s+([a-zA-Z]:[\\\/][^\s,]+|[.\/][^\s,]+)/i);
    if (pathMatch) context.path = pathMatch[1];

    const typeMatch = text.toLowerCase().match(/(?:that are|type)\s+(\.\w+|\w+)\s+files?/);
    if (typeMatch) context.type = typeMatch[1];
    const extMatch = text.toLowerCase().match(/\.(txt|js|jsx|ts|tsx|json|css|md|py|html|xml|csv|pdf|png|jpg)\b/);
    if (!context.type && extMatch) context.type = extMatch[0];

    const nameMatch = text.match(/(?:named?|called)\s+["']?([^"'\s,]+)["']?/i);
    if (nameMatch) context.name = nameMatch[1];

    return context;
}

// ============================================================
// MAIN TOOL EXPORT
// ============================================================
export async function duplicateScanner(input) {
    const text = typeof input === "string" ? input : input?.text || "";
    const context = typeof input === "object" ? input?.context || {} : {};

    const nlp = parseNaturalLanguage(text);
    const scanPath = context.path || nlp.path || ".";
    const nameFilter = context.name || nlp.name || null;
    const typeFilter = context.type || nlp.type || null;
    const snippet = context.snippet || null;
    const maxDepth = context.maxDepth || MAX_DEPTH;

    let resolvedPath;
    if (path.isAbsolute(scanPath)) {
        resolvedPath = sanitizePath(scanPath);
    } else {
        resolvedPath = sanitizePath(path.resolve(PROJECT_ROOT, scanPath));
    }

    if (!resolvedPath) {
        return {
            tool: "duplicateScanner",
            success: false,
            final: true,
            error: `Path "${scanPath}" is outside allowed sandbox roots. Allowed: ${ALLOWED_ROOTS.join(", ")}`,
            data: {}
        };
    }

    console.log(`🔍 Scanning for duplicates in: ${resolvedPath}`);
    console.log(`   Filters — name: ${nameFilter || "any"}, type: ${typeFilter || "any"}, depth: ${maxDepth}`);

    const startTime = Date.now();
    const abortController = new AbortController();
    const timeout = setTimeout(() => {
        abortController.abort();
        console.log("⏰ Scan timed out, returning partial results");
    }, TIMEOUT_MS);

    try {
        const { files, scanned } = await walkDir(resolvedPath, {
            maxDepth, maxFiles: MAX_FILES,
            nameFilter, typeFilter,
            abortSignal: abortController.signal
        });

        console.log(`  📂 Found ${files.length} files (scanned ${scanned} entries)`);

        if (files.length === 0) {
            return {
                tool: "duplicateScanner",
                success: true,
                final: true,
                data: {
                    groups: [],
                    stats: { scanned, matched: 0, groups: 0, elapsed: Date.now() - startTime },
                    text: "No files found matching the criteria."
                }
            };
        }

        const groups = await findDuplicates(files, {
            snippetFilter: snippet,
            abortSignal: abortController.signal
        });

        const elapsed = Date.now() - startTime;
        const timedOut = abortController.signal.aborted;
        const totalDuplicates = groups.reduce((sum, g) => sum + g.files.length, 0);

        console.log(`  ✅ Found ${groups.length} duplicate groups in ${elapsed}ms${timedOut ? " (timed out)" : ""}`);

        return {
            tool: "duplicateScanner",
            success: true,
            final: true,
            data: {
                groups,
                stats: { scanned, matched: files.length, groups: groups.length, totalDuplicates, elapsed, timedOut },
                scanPath: resolvedPath,
                text: groups.length === 0
                    ? `No duplicate files found in ${resolvedPath} (scanned ${scanned} entries in ${elapsed}ms).`
                    : `Found ${groups.length} group(s) of duplicate files (${totalDuplicates} total) in ${resolvedPath}.`
            }
        };
    } catch (err) {
        return {
            tool: "duplicateScanner", success: false, final: true,
            error: err.message, data: {}
        };
    } finally {
        clearTimeout(timeout);
    }
}
