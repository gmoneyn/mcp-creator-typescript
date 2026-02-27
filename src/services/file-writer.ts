/**
 * file-writer.ts — Write generated files to disk + sentinel injection for add_tool.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Write a map of { relativePath: content } to a base directory.
 * Creates parent directories as needed.
 * Returns list of absolute paths written.
 */
export function writeProjectFiles(
  baseDir: string,
  files: Record<string, string>
): string[] {
  const written: string[] = [];

  for (const [relPath, content] of Object.entries(files)) {
    const absPath = resolve(baseDir, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, "utf-8");
    written.push(absPath);
  }

  return written;
}

/**
 * Find a sentinel line in a file and inject content after it.
 * Used by add_tool to inject imports and tool registrations into index.ts.
 *
 * Returns true if injection succeeded, false if sentinel not found.
 */
export function injectAfterSentinel(
  filePath: string,
  sentinel: string,
  content: string
): boolean {
  if (!existsSync(filePath)) return false;

  const fileContent = readFileSync(filePath, "utf-8");
  const lines = fileContent.split("\n");
  const sentinelIdx = lines.findIndex(line => line.includes(sentinel));

  if (sentinelIdx === -1) return false;

  lines.splice(sentinelIdx + 1, 0, content);
  writeFileSync(filePath, lines.join("\n"), "utf-8");
  return true;
}
