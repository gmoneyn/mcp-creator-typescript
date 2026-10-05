/**
 * path-guard.ts: limits on WHERE this server's tools may act.
 *
 * Every tool here is callable by a language model, and a model can be steered by
 * hostile text it was given to read. So the directory a tool is pointed at is
 * untrusted input: these checks decide whether it is a project we should touch.
 *
 * Two paths are compared by IDENTITY (device + inode from the filesystem), never as
 * strings. On a case-insensitive filesystem "/Users/me" and "/USERS/ME" are one
 * directory with two spellings, and a string comparison treats them as different.
 */

import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";

/** Thrown when a write would land outside the directory it was meant for. */
export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathEscapeError";
  }
}

/**
 * The real location of `p`, following every symlink, for paths that may not exist yet.
 * realpathSync alone throws on a missing path, and a write through a DANGLING symlink
 * creates the file at the link's target, so a link is followed even when its target is absent.
 */
export function canonicalPath(p: string, depth = 0): string {
  if (depth > 64) {
    throw new PathEscapeError(`Too many levels of symbolic links while resolving ${p}`);
  }
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    // Missing, or a link that does not resolve. Work out which below.
  }

  let isLink = false;
  try {
    isLink = lstatSync(abs).isSymbolicLink();
  } catch {
    isLink = false;
  }
  if (isLink) {
    return canonicalPath(resolve(dirname(abs), readlinkSync(abs)), depth + 1);
  }

  const parent = dirname(abs);
  if (parent === abs) return abs; // filesystem root
  return join(canonicalPath(parent, depth + 1), basename(abs));
}

// ---------------------------------------------------------------- identity

interface Identity {
  dev: bigint;
  ino: bigint;
}

/** What the filesystem says this path IS, or null when nothing is there. */
function identityOf(p: string): Identity | null {
  try {
    const s = statSync(p, { bigint: true });
    return { dev: s.dev, ino: s.ino };
  } catch {
    return null;
  }
}

const sameIdentity = (a: Identity | null, b: Identity | null): boolean =>
  a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;

/** True when both paths exist and are the same filesystem entry, however each is spelled. */
export function sameEntry(a: string, b: string): boolean {
  return sameIdentity(identityOf(a), identityOf(b));
}

/** The deepest part of `p` that exists, and the names below it that do not exist yet. */
function splitExisting(p: string): { existing: string; missing: string[] } {
  const missing: string[] = [];
  let cur = p;
  while (identityOf(cur) === null) {
    const parent = dirname(cur);
    if (parent === cur) break;
    missing.unshift(basename(cur));
    cur = parent;
  }
  return { existing: cur, missing };
}

/**
 * Where `candidate` is relative to `base` (both already canonical): strictly inside it,
 * the same entry, or outside. Decided by walking up from the candidate and asking the
 * filesystem at each level whether that directory IS the base.
 */
export function containment(base: string, candidate: string): "inside" | "same" | "outside" {
  const b = splitExisting(base);
  const c = splitExisting(candidate);

  if (b.missing.length === 0) {
    const baseId = identityOf(b.existing);
    let cur = c.existing;
    let below = c.missing.length;
    for (;;) {
      if (sameIdentity(identityOf(cur), baseId)) return below > 0 ? "inside" : "same";
      const parent = dirname(cur);
      if (parent === cur) return "outside";
      cur = parent;
      below++;
    }
  }

  // The base does not exist yet (scaffolding into a new directory). The candidate must
  // hang off the same existing directory and continue with the same new names. Names
  // that do not exist have no identity, so they are compared exactly; a different
  // spelling is treated as outside.
  if (!sameIdentity(identityOf(b.existing), identityOf(c.existing))) return "outside";
  if (c.missing.length < b.missing.length) return "outside";
  for (let i = 0; i < b.missing.length; i++) {
    if (c.missing[i] !== b.missing[i]) return "outside";
  }
  return c.missing.length > b.missing.length ? "inside" : "same";
}

/**
 * Resolve `target` against `baseDir` and return the absolute path, or throw
 * PathEscapeError when the result is not strictly inside `baseDir`. Catches
 * `..` segments, absolute paths elsewhere, and symlinks (of the file or of any
 * directory on the way to it) that lead out.
 */
export function resolveInside(baseDir: string, target: string): string {
  const base = resolve(baseDir);
  const candidate = resolve(base, target);
  const realBase = canonicalPath(base);
  const realCandidate = canonicalPath(candidate);

  if (containment(realBase, realCandidate) !== "inside") {
    throw new PathEscapeError(
      `Refusing to write ${JSON.stringify(target)}: it resolves to ${realCandidate}, which is outside the project directory ${realBase}.`
    );
  }
  return candidate;
}

/**
 * Why `dir` is off limits as a place to act, or null. Off limits: a filesystem root,
 * the home directory, and every directory above the home directory.
 */
export function forbiddenDirReason(dir: string): string | null {
  const real = canonicalPath(dir);
  if (parse(real).root === real) {
    return `${real} is a filesystem root, not a project directory.`;
  }
  const id = identityOf(real);
  if (id === null) return null; // nothing there yet, so it is not the home directory or above it

  let home: string;
  try {
    home = canonicalPath(homedir());
  } catch {
    return null;
  }
  if (sameIdentity(id, identityOf(home))) {
    return `${real} is your home directory, not a project directory.`;
  }
  for (let cur = dirname(home); ; cur = dirname(cur)) {
    if (sameIdentity(id, identityOf(cur))) {
      return `${real} contains your home directory (${home}), so it is not a project directory.`;
    }
    if (dirname(cur) === cur) break;
  }
  return null;
}

export type ProjectDirCheck =
  | { ok: true; absDir: string }
  | { ok: false; error: string };

/**
 * Accept `projectDir` only when it is an existing project: a directory that is not the
 * home directory, a directory above it, or a filesystem root, and that contains a
 * package.json. With `requireGitignore`, it must also already contain a .gitignore
 * (never created here).
 */
export function checkProjectDir(
  projectDir: string,
  toolName: string,
  opts: { requireGitignore?: boolean } = {}
): ProjectDirCheck {
  const absDir = resolve(projectDir);

  let isDir = false;
  try {
    isDir = statSync(absDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return { ok: false, error: `${toolName} refused: ${absDir} is not an existing directory.` };
  }

  const forbidden = forbiddenDirReason(absDir);
  if (forbidden) {
    return { ok: false, error: `${toolName} refused: ${forbidden}` };
  }

  if (!isFile(join(absDir, "package.json"))) {
    return {
      ok: false,
      error: `${toolName} refused: no package.json in ${absDir}. This tool only runs in a project directory.`,
    };
  }

  if (opts.requireGitignore && !existsSync(join(absDir, ".gitignore"))) {
    return {
      ok: false,
      error:
        `${toolName} refused: no .gitignore in ${absDir}. This tool stages every file in the directory, ` +
        `so it will not run without one, and it will not create one for you. Add a .gitignore that excludes ` +
        `node_modules/, dist/ and .env (scaffold_server writes one), then call ${toolName} again.`,
    };
  }

  return { ok: true, absDir };
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Why one of the named entries of a project is not safe to read or write through, or
 * null. An entry that is a symbolic link, or that really lives outside the project,
 * would send a build or an install somewhere else (tsup empties its output directory
 * before writing to it). An entry that does not exist yet is fine.
 */
export function linkedEntryReason(absDir: string, names: string[]): string | null {
  const realProject = canonicalPath(absDir);
  for (const name of names) {
    const entry = join(absDir, name);
    let isLink: boolean;
    try {
      isLink = lstatSync(entry).isSymbolicLink();
    } catch {
      continue; // not there yet
    }
    if (isLink) {
      return `${entry} is a symbolic link, so writing to it would write somewhere else. Replace it with a real directory inside the project.`;
    }
    if (containment(realProject, canonicalPath(entry)) !== "inside") {
      return `${entry} is not inside the project directory.`;
    }
  }
  return null;
}
