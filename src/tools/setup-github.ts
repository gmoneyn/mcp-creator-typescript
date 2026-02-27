/**
 * setup_github — Initialize git repo, create on GitHub, and push.
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { runCommand } from "../services/subprocess.js";

export async function setupGithub(
  projectDir: string,
  repoName: string,
  description: string = "",
  isPrivate: boolean = false
): Promise<string> {
  const absDir = resolve(projectDir);

  if (!existsSync(absDir)) {
    return JSON.stringify({
      success: false,
      error: `Directory does not exist: ${absDir}`,
    });
  }

  // Check gh is available
  const ghCheck = await runCommand(["gh", "--version"]);
  if (!ghCheck.success) {
    return JSON.stringify({
      success: false,
      error: 'gh CLI not found. Install from https://cli.github.com and run "gh auth login".',
    });
  }

  // git init if needed
  if (!existsSync(resolve(absDir, ".git"))) {
    const initResult = await runCommand(["git", "init"], { cwd: absDir });
    if (!initResult.success) {
      return JSON.stringify({ success: false, error: `git init failed: ${initResult.stderr}` });
    }
  }

  // git add + commit
  await runCommand(["git", "add", "-A"], { cwd: absDir });
  const commitResult = await runCommand(
    ["git", "commit", "-m", "Initial commit"],
    { cwd: absDir }
  );
  // Commit may fail if nothing to commit — that's ok

  // Create GitHub repo
  const visibility = isPrivate ? "--private" : "--public";
  const args = ["gh", "repo", "create", repoName, visibility, "--source", ".", "--push"];
  if (description) {
    args.push("--description", description);
  }

  const createResult = await runCommand(args, { cwd: absDir, timeout: 30_000 });

  if (!createResult.success) {
    return JSON.stringify({
      success: false,
      error: createResult.stderr,
      stdout: createResult.stdout,
      hint: "Common fixes: check gh auth, ensure repo name is available.",
    });
  }

  // Extract repo URL
  const repoUrl = createResult.stdout.trim().split("\n")[0] ?? `https://github.com/${repoName}`;

  return JSON.stringify({
    success: true,
    repoUrl,
    repoName,
    private: isPrivate,
    nextSteps: [
      `GitHub repo created: ${repoUrl}`,
      "Use generate_launchguide to create LAUNCHGUIDE.md for marketplace submission.",
    ],
  }, null, 2);
}
