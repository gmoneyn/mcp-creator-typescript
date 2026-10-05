/**
 * file-writer.ts: write generated files to disk + sentinel injection for add_tool.
 *
 * Every write goes through writeFileSafely():
 *   - the path is confined to the project (resolveInside);
 *   - an existing target must be an ordinary file with ONE name. A symbolic link is not
 *     followed, and a file that is hard-linked elsewhere is refused: writing to it
 *     would change the other name's content too, wherever that name lives;
 *   - the content is written to a new file beside the target and renamed over it, so
 *     the target's old content is never truncated in place.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { resolveInside } from "./path-guard.js";

/** Thrown when an existing file is not something this tool should write over. */
export class UnsafeTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeTargetError";
  }
}

/**
 * Refuse to write over `absPath` when it exists and is a symbolic link, is not a
 * regular file, or has more than one hard link. Returns the existing file's permission
 * bits, or null when nothing is there yet.
 */
export function assertSafeToReplace(absPath: string): number | null {
  let st;
  try {
    st = lstatSync(absPath);
  } catch {
    return null; // nothing there: a new file
  }
  if (st.isSymbolicLink()) {
    throw new UnsafeTargetError(`Refusing to write ${absPath}: it is a symbolic link, and this tool does not write through links.`);
  }
  if (!st.isFile()) {
    throw new UnsafeTargetError(`Refusing to write ${absPath}: it exists and is not a regular file.`);
  }
  if (st.nlink > 1) {
    throw new UnsafeTargetError(
      `Refusing to write ${absPath}: it is hard-linked (${st.nlink} names share its content), so changing it would change another file as well. ` +
      "Replace it with an independent copy first."
    );
  }
  return st.mode & 0o777;
}

/** Write `content` to an already-confined absolute path, without following or truncating what is there. */
function writeFileSafely(absPath: string, content: string): void {
  const mode = assertSafeToReplace(absPath);
  const dir = dirname(absPath);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${basename(absPath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    // "wx": create, and fail if anything (a link included) already has this name.
    const fd = openSync(temp, "wx", mode ?? 0o666);
    try {
      writeSync(fd, content, null, "utf-8");
    } finally {
      closeSync(fd);
    }
    if (mode !== null) chmodSync(temp, mode);
    // rename replaces the NAME; it never writes into the old file's content.
    renameSync(temp, absPath);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
}

/**
 * Write a map of { relativePath: content } to a base directory.
 * Creates parent directories as needed.
 * Returns list of absolute paths written.
 *
 * Every path is confined to baseDir (see resolveInside) and every existing target is
 * checked (see assertSafeToReplace). ALL paths are checked before ANY file is written,
 * so one bad path leaves nothing behind.
 * Throws PathEscapeError or UnsafeTargetError.
 */
export function writeProjectFiles(
  baseDir: string,
  files: Record<string, string>
): string[] {
  const written: string[] = [];

  for (const relPath of Object.keys(files)) {
    assertSafeToReplace(resolveInside(baseDir, relPath));
  }

  for (const [relPath, content] of Object.entries(files)) {
    // Checked again at write time: a directory created by an earlier iteration
    // cannot be a link, but the tree is not ours alone.
    const absPath = resolveInside(baseDir, relPath);
    writeFileSafely(absPath, content);
    written.push(absPath);
  }

  return written;
}

/**
 * Find a sentinel line in a file and inject content after it.
 * Used by add_tool to inject imports and tool registrations into index.ts.
 *
 * Returns true if injection succeeded, false if sentinel not found.
 *
 * The caller passes a path already confined with resolveInside(). The file itself is
 * checked here before it is replaced (assertSafeToReplace).
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
  writeFileSafely(filePath, lines.join("\n"));
  return true;
}
