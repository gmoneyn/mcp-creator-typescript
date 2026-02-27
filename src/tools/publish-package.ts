/**
 * publish_package — Run 'npm publish' to publish the package to npm.
 */

import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { runCommand } from "../services/subprocess.js";

export async function publishPackage(projectDir: string): Promise<string> {
  const absDir = resolve(projectDir);
  const pkgPath = resolve(absDir, "package.json");

  if (!existsSync(pkgPath)) {
    return JSON.stringify({
      success: false,
      error: `No package.json found in ${absDir}.`,
    });
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

  const result = await runCommand(["npm", "publish"], { cwd: absDir, timeout: 120_000 });

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
    stdout: result.stdout,
    stderr: result.stderr,
    returnCode: result.returnCode,
    nextSteps,
  }, null, 2);
}
