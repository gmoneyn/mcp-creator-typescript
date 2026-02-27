/**
 * build_package — Run 'npm run build' (tsup) in the project directory.
 */

import { resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { runCommand } from "../services/subprocess.js";

export async function buildPackage(projectDir: string): Promise<string> {
  const absDir = resolve(projectDir);

  if (!existsSync(resolve(absDir, "package.json"))) {
    return JSON.stringify({
      success: false,
      error: `No package.json found in ${absDir}.`,
    });
  }

  // Ensure deps are installed
  if (!existsSync(resolve(absDir, "node_modules"))) {
    const installResult = await runCommand(["npm", "install"], { cwd: absDir, timeout: 120_000 });
    if (!installResult.success) {
      return JSON.stringify({
        success: false,
        step: "npm install",
        error: installResult.stderr,
        stdout: installResult.stdout,
      });
    }
  }

  const result = await runCommand(["npm", "run", "build"], { cwd: absDir, timeout: 60_000 });

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
