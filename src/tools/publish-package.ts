/**
 * publish_package: publish the package to npm.
 *
 * Runs only in a project directory (package.json present; not the home directory, a
 * directory above it, or a filesystem root).
 *
 * What is checked is exactly what is published: the package is packed ONCE into a
 * fresh temporary directory, that tarball's file list is checked, and that same
 * tarball file is handed to `npm publish`. No lifecycle script runs at either step,
 * so nothing can add a file between the check and the upload. The build is therefore
 * not run here: publish what build_package built.
 */

import { join, resolve } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { runCommand } from "../services/subprocess.js";
import { checkProjectDir, linkedEntryReason } from "../services/path-guard.js";
import { describeHits, isSecretTemplate, listForMessage, looksLikeSecret, scanTemplates, SECRET_PATTERNS_TEXT } from "../services/secret-scan.js";

const refuse = (error: string): string => JSON.stringify({ success: false, error }, null, 2);

export async function publishPackage(
  projectDir: string,
  run: typeof runCommand = runCommand
): Promise<string> {
  const check = checkProjectDir(projectDir, "publish_package");
  if (!check.ok) {
    return JSON.stringify({ success: false, error: check.error });
  }
  const absDir = check.absDir;
  const pkgPath = resolve(absDir, "package.json");

  const linked = linkedEntryReason(absDir, ["dist", "node_modules"]);
  if (linked) {
    return JSON.stringify({ success: false, error: `publish_package refused: ${linked} Nothing was published.` });
  }

  // Check dist/ exists
  const distDir = resolve(absDir, "dist");
  if (!existsSync(distDir)) {
    return JSON.stringify({
      success: false,
      error: "No dist/ directory found. Run build_package first.",
    });
  }

  // Read package name for output
  let packageName = "unknown";
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    packageName = pkg.name ?? "unknown";
  } catch {
    // Continue anyway
  }

  // Pack once, into a directory nothing else knows about. A published version cannot
  // be taken back in any way that matters, so the tarball is checked before it leaves.
  const packDir = mkdtempSync(join(tmpdir(), "mcp-creator-pack-"));
  try {
    const pack = await run(
      ["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", packDir],
      { cwd: absDir, timeout: 120_000 }
    );
    let packed: string[] | null = null;
    let tarball: string | null = null;
    if (pack.success) {
      try {
        const data = JSON.parse(pack.stdout) as unknown;
        const entries = (Array.isArray(data) ? data : [data]) as Array<{ filename?: unknown; files?: Array<{ path?: unknown }> }>;
        if (entries.length === 1 && typeof entries[0].filename === "string") {
          packed = (entries[0].files ?? []).map((f) => String(f.path));
          // npm reports a scoped package as "@scope/name-1.0.0.tgz" and writes "scope-name-1.0.0.tgz".
          const reported = entries[0].filename;
          const candidates = [reported, reported.replace(/^@/, "").replace(/\//g, "-")];
          tarball = candidates.map((n) => join(packDir, n)).find((p) => isFile(p)) ?? null;
        }
      } catch {
        packed = null;
      }
    }
    if (packed === null || packed.length === 0 || tarball === null) {
      return refuse(
        "publish_package refused: could not pack the project and list what is in the package (npm pack did not return one tarball and its file list), " +
        `so it cannot confirm that no secret would be published. Nothing was published. ${pack.stderr.trim().slice(0, 300)}`
      );
    }

    const packedSecrets = packed.filter(looksLikeSecret).sort();
    if (packedSecrets.length > 0) {
      return refuse(
        `publish_package refused: the package would contain ${packedSecrets.length === 1 ? "a file that looks like a secret" : "files that look like secrets"}: ` +
        `${listForMessage(packedSecrets)}. Keep them out of the package (the "files" field in package.json, or .npmignore, decides what is packed), ` +
        `or rename them if they are not secrets, then call publish_package again. Nothing was published. File names treated as secrets: ${SECRET_PATTERNS_TEXT}.`
      );
    }

    // Templates are allowed by name; one that would be published must hold placeholders only.
    const packedTemplates = scanTemplates(absDir, packed.filter(isSecretTemplate));
    if (packedTemplates.hits.length > 0) {
      return refuse(
        `publish_package refused: a template file in the package holds a value shaped like a live credential: ${describeHits(packedTemplates.hits)}. ` +
        "Replace it with a placeholder (and rotate it if it was real), then call publish_package again. Nothing was published."
      );
    }
    if (packedTemplates.unscannable.length > 0) {
      return refuse(
        `publish_package refused: could not read ${listForMessage(packedTemplates.unscannable)} in full, so it cannot confirm the template holds no real credential. Nothing was published.`
      );
    }

    // Publish THAT file. --ignore-scripts: no prepublishOnly, prepare or publish script
    // runs, so the upload is the tarball that was just checked and nothing else.
    const result = await run(["npm", "publish", tarball, "--ignore-scripts"], { cwd: absDir, timeout: 120_000 });

    const nextSteps = result.success
      ? [
          `Published ${packageName} to npm!`,
          `Install: npx -y ${packageName}`,
          `npm page: https://www.npmjs.com/package/${packageName}`,
          "Use setup_github to create a GitHub repo, then generate_launchguide for marketplace submission.",
        ]
      : [
          "Publish failed. Common issues:",
          '- Not logged in: run "npm login"',
          "- Name taken: use check_npm_name to find available names",
          "- Version exists: bump version in package.json",
        ];

    return JSON.stringify({
      success: result.success,
      packageName,
      filesInPackage: packed.length,
      stdout: result.stdout,
      stderr: result.stderr,
      returnCode: result.returnCode,
      nextSteps,
    }, null, 2);
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
