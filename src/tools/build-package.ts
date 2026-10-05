/**
 * build_package — Run 'npm run build' (tsup) in the project directory.
 */

import { resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { runCommand } from "../services/subprocess.js";
import { checkProjectDir, linkedEntryReason } from "../services/path-guard.js";

export async function buildPackage(
  projectDir: string,
  run: typeof runCommand = runCommand
): Promise<string> {
  // npm install and the build script both run code from this directory.
  const check = checkProjectDir(projectDir, "build_package");
  if (!check.ok) {
    return JSON.stringify({ success: false, error: check.error });
  }
  const absDir = check.absDir;

  // npm install writes node_modules and the build empties and rewrites dist. Neither
  // may be a link to somewhere else.
  const linked = linkedEntryReason(absDir, ["node_modules", "dist"]);
  if (linked) {
    return JSON.stringify({ success: false, error: `build_package refused: ${linked} Nothing was run.` });
  }

  // Ensure deps are installed
  if (!existsSync(resolve(absDir, "node_modules"))) {
    const installResult = await run(["npm", "install"], { cwd: absDir, timeout: 120_000 });
    if (!installResult.success) {
      return JSON.stringify({
        success: false,
        step: "npm install",
        error: installResult.stderr,
        stdout: installResult.stdout,
      });
    }
  }

  const result = await run(["npm", "run", "build"], { cwd: absDir, timeout: 60_000 });

  // List built files
  let builtFiles: string[] = [];
  const distDir = resolve(absDir, "dist");
  if (existsSync(distDir)) {
    builtFiles = readdirSync(distDir);
  }

  const nextSteps = result.success
    ? [
        `Build successful. ${builtFiles.length} file(s) in dist/.`,
        "Run npm test to verify.",
        "When ready, use publish_package to publish to npm.",
      ]
    : [
        "Build failed. Check the error output and fix the issues.",
        "Common fixes: npm install, check for TypeScript errors.",
      ];

  return JSON.stringify({
    success: result.success,
    stdout: result.stdout,
    stderr: result.stderr,
    returnCode: result.returnCode,
    builtFiles,
    nextSteps,
  }, null, 2);
}
