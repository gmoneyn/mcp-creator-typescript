/**
 * secret-scan.ts: find files that look like credentials, by NAME, before they are
 * staged, committed, pushed or packed. Used by setup_github and publish_package.
 *
 * This only answers "does this path look like a secret". Whether git would
 * actually publish the file is a separate question that only git can answer
 * (.gitignore, .git/info/exclude, the user's global excludes, and whether the file is
 * already tracked all bear on it), so the caller asks git with `git check-ignore`.
 *
 * Paths are git-style: "/" separates directories, on every platform. A backslash is an
 * ordinary character in a file name and is NOT treated as a separator.
 *
 * A TEMPLATE of a secret file (.env.example, .env.template, id_rsa.sample,
 * service-account.example.json ...) is allowed by name, because projects ship them on
 * purpose. Its CONTENT is checked instead: a template that holds a value shaped like a
 * live credential is refused (scanForCredentials).
 */

import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Directories never descended into. */
const SKIP_DIRS = new Set(["node_modules", ".git"]);

/** A dot-separated part of a file name that marks the file as a template of something. */
const TEMPLATE_MARKERS = new Set(["example", "sample", "template", "dist"]);

/** File names that are a secret whatever directory they are in. */
const EXACT_NAMES = new Set([
  ".env", ".envrc", ".npmrc", ".pypirc", ".netrc", ".pgpass", ".htpasswd", ".git-credentials", "kubeconfig",
  // A credentials FILE, by its exact name. Deliberately not a prefix: credentials.ts,
  // credentialsProvider.ts and credentials-howto.md are source and documentation.
  "credentials", "credentials.json", "credentials.ini", "credentials.csv", "credentials.yml", "credentials.yaml",
  "credentials.txt", "credentials.xml",
]);
const SUFFIXES = [
  ".pem", ".key", ".p12", ".pfx", ".p8", ".ppk", ".keystore", ".jks", ".kdbx", ".tfvars", ".tfstate", ".tfstate.backup",
];
const PREFIXES = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];
/** Names that are a secret only inside a particular directory. */
const PATH_ENDINGS = [".aws/credentials", ".docker/config.json"];

/** Human-readable form of the rules above, for refusal messages. */
export const SECRET_PATTERNS_TEXT =
  ".env, .env.*, .envrc, *.pem, *.key, *.p12, *.pfx, *.p8, *.ppk, *.keystore, *.jks, *.kdbx, *.tfvars, *.tfstate, " +
  "id_rsa*, id_dsa*, id_ecdsa*, id_ed25519*, credentials and credentials.{json,ini,csv,yml,yaml,txt,xml}, service-account*.json, " +
  ".npmrc, .pypirc, .netrc, .pgpass, .htpasswd, .git-credentials, kubeconfig, .aws/credentials, .docker/config.json. " +
  "A template of one of these (a name with .example, .sample, .template or .dist in it, such as .env.example) is allowed, and its content is checked instead";

/** The name rules themselves, with no template exception. `lower` is a lowercased git-style path. */
function matchesSecretName(lower: string): boolean {
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  if (EXACT_NAMES.has(name)) return true;
  if (name.startsWith(".env.")) return true;
  if (SUFFIXES.some((s) => name.endsWith(s))) return true;
  if (PREFIXES.some((p) => name.startsWith(p))) return true;
  if (name.startsWith("service-account") && name.endsWith(".json")) return true;
  if (PATH_ENDINGS.some((e) => lower === e || lower.endsWith("/" + e))) return true;
  return false;
}

/**
 * True when the path is a TEMPLATE of a secret-looking file: taking one template
 * marker out of its name leaves a name the rules above match (.env.example -> .env,
 * service-account.example.json -> service-account.json). The marker may not be the
 * first part of the name: "example.pem" is a key called example, not a template.
 */
export function isSecretTemplate(path: string): boolean {
  const lower = path.toLowerCase();
  const slash = lower.lastIndexOf("/");
  const dir = lower.slice(0, slash + 1);
  const parts = lower.slice(slash + 1).split(".");
  for (let i = 1; i < parts.length; i++) {
    if (!TEMPLATE_MARKERS.has(parts[i])) continue;
    const without = [...parts.slice(0, i), ...parts.slice(i + 1)].join(".");
    if (matchesSecretName(dir + without)) return true;
  }
  return false;
}

/** True when the path looks like a credential and is not a template of one. Case-insensitive. */
export function looksLikeSecret(path: string): boolean {
  if (isSecretTemplate(path)) return false;
  return matchesSecretName(path.toLowerCase());
}

export interface ScanResult {
  /** Secret-looking paths relative to the scanned root, "/" separated, sorted. */
  files: string[];
  /** Templates of secret files (allowed by name; their content is checked separately), sorted. */
  templates: string[];
  /** Directories that could not be read. Non-empty means the scan is incomplete. */
  unreadable: string[];
}

/**
 * Every secret-looking file and every secret template under `root`, anywhere in the
 * tree, skipping node_modules and .git. Symlinked directories are not followed (git
 * does not follow them either); a symlink whose own name looks like a secret is reported.
 */
export function findSecretLookingFiles(root: string): ScanResult {
  const files: string[] = [];
  const templates: string[] = [];
  const unreadable: string[] = [];

  const walk = (dir: string, rel: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      unreadable.push(rel || ".");
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      let isDir = false;
      try {
        isDir = lstatSync(abs).isDirectory();
      } catch {
        unreadable.push(relPath);
        continue;
      }
      if (isDir) {
        if (!SKIP_DIRS.has(entry)) walk(abs, relPath);
      } else if (isSecretTemplate(relPath)) {
        templates.push(relPath);
      } else if (looksLikeSecret(relPath)) {
        files.push(relPath);
      }
    }
  };

  walk(root, "");
  return { files: files.sort(), templates: templates.sort(), unreadable: unreadable.sort() };
}

/** A list for a message: at most `max` names, and how many were left out. */
export function listForMessage(files: string[], max = 20): string {
  const shown = files.slice(0, max).join(", ");
  return files.length > max ? `${shown} (and ${files.length - max} more, ${files.length} in total)` : shown;
}

// ---------------------------------------------------------------- template content

/** Where a credential-shaped value sits. Never carries the value itself. */
export interface CredentialHit {
  file: string;
  line: number;
  kind: string;
}

interface TokenShape {
  kind: string;
  /** Group 1 is the part after the prefix. */
  re: RegExp;
  /** Real tokens of this kind mix letters and digits; a body that does not is a placeholder. */
  mixed: boolean;
}

/** Well-known credential prefixes followed by a token long enough to be real. */
const TOKEN_SHAPES: TokenShape[] = [
  { kind: "sk- API key", re: /(?<![A-Za-z0-9_-])sk-([A-Za-z0-9_-]{20,})/, mixed: true },
  { kind: "GitHub token", re: /(?<![A-Za-z0-9_])gh[po]_([A-Za-z0-9]{36,})/, mixed: true },
  { kind: "GitHub fine-grained token", re: /(?<![A-Za-z0-9_])github_pat_([A-Za-z0-9_]{36,})/, mixed: true },
  { kind: "GitLab token", re: /(?<![A-Za-z0-9_-])glpat-([A-Za-z0-9_-]{20,})/, mixed: true },
  { kind: "AWS access key id", re: /(?<![A-Za-z0-9])A[KS]IA([0-9A-Z]{16})(?![0-9A-Z])/, mixed: false },
  { kind: "PyPI token", re: /(?<![A-Za-z0-9_-])pypi-([A-Za-z0-9_-]{32,})/, mixed: true },
  { kind: "npm token", re: /(?<![A-Za-z0-9_])npm_([A-Za-z0-9]{36,})/, mixed: true },
  { kind: "Slack token", re: /(?<![A-Za-z0-9_-])xox[bp]-([A-Za-z0-9-]{20,})/, mixed: true },
  { kind: "Stripe live key", re: /(?<![A-Za-z0-9_])[sr]k_live_([A-Za-z0-9]{20,})/, mixed: true },
  { kind: "MCP Marketplace license key", re: /(?<![A-Za-z0-9_])mcp_live_([A-Za-z0-9_-]{20,})/, mixed: true },
];
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PLACEHOLDER_WORDS = /your|example|placeholder|changeme|change_me|replace|xxxx|dummy|sample|insert|todo/;

/** A token body that is plainly a stand-in: a placeholder word, one repeated character, letters only. */
function isPlaceholder(body: string, mixed: boolean): boolean {
  if (PLACEHOLDER_WORDS.test(body.toLowerCase())) return true;
  if (new Set(body).size < 6) return true;
  if (mixed && !(/[0-9]/.test(body) && /[A-Za-z]/.test(body))) return true;
  return false;
}

/**
 * Lines of `content` that hold a value shaped like a live credential: a private-key
 * block, or a well-known prefix followed by a long token that is not a placeholder.
 * Reports file, line number and kind; never the value.
 */
export function scanForCredentials(content: string, file: string): CredentialHit[] {
  const hits: CredentialHit[] = [];
  const lines = content.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (PRIVATE_KEY_BLOCK.test(text)) {
      hits.push({ file, line: i + 1, kind: "private key block" });
      continue;
    }
    for (const shape of TOKEN_SHAPES) {
      const match = shape.re.exec(text);
      if (match && !isPlaceholder(match[1], shape.mixed)) {
        hits.push({ file, line: i + 1, kind: shape.kind });
        break;
      }
    }
  }
  return hits;
}

/** Largest template this will read. A bigger one is reported as unscannable, not skipped. */
const TEMPLATE_MAX_BYTES = 1024 * 1024;

/**
 * Scan template files under `root`. `hits` are credential-shaped values;
 * `unscannable` are templates that could not be read in full (too large, unreadable).
 */
export function scanTemplates(root: string, templates: string[]): { hits: CredentialHit[]; unscannable: string[] } {
  const hits: CredentialHit[] = [];
  const unscannable: string[] = [];
  for (const rel of templates) {
    const abs = join(root, rel);
    try {
      if (statSync(abs).size > TEMPLATE_MAX_BYTES) {
        unscannable.push(rel);
        continue;
      }
      hits.push(...scanForCredentials(readFileSync(abs, "utf-8"), rel));
    } catch {
      unscannable.push(rel);
    }
  }
  return { hits, unscannable };
}

/** "file line N (kind)" for a message. */
export function describeHits(hits: CredentialHit[], max = 20): string {
  return listForMessage(hits.map((h) => `${h.file} line ${h.line} (${h.kind})`), max);
}
