/**
 * check_setup — Verify node >= 18, npm, git, gh CLI, and npm auth.
 */

import { runCommand } from "../services/subprocess.js";

interface CheckItem {
  installed: boolean;
  version?: string;
  authenticated?: boolean;
  username?: string;
  error?: string;
}

export async function checkSetup(): Promise<string> {
  const checks: Record<string, CheckItem> = {};
  const missingSteps: string[] = [];

  // Node.js
  const nodeResult = await runCommand(["node", "--version"]);
  if (nodeResult.success) {
    const ver = nodeResult.stdout.trim();
    const major = parseInt(ver.replace("v", ""), 10);
    checks.node = { installed: true, version: ver };
    if (major < 18) {
      missingSteps.push(`Node.js ${ver} detected — upgrade to v18+ (required).`);
    }
  } else {
    checks.node = { installed: false, error: "Node.js not found" };
    missingSteps.push("Install Node.js 18+ from https://nodejs.org");
  }

  // npm
  const npmResult = await runCommand(["npm", "--version"]);
  if (npmResult.success) {
    checks.npm = { installed: true, version: npmResult.stdout.trim() };
  } else {
    checks.npm = { installed: false, error: "npm not found" };
    missingSteps.push("Install npm (comes with Node.js).");
  }

  // npm auth (npm whoami)
  const npmAuth = await runCommand(["npm", "whoami"]);
  if (npmAuth.success) {
    const username = npmAuth.stdout.trim();
    checks.npmAuth = { installed: true, authenticated: true, username };
  } else {
    checks.npmAuth = { installed: true, authenticated: false, error: "Not logged in to npm" };
    missingSteps.push('Run "npm login" to authenticate with npm.');
  }

  // git
  const gitResult = await runCommand(["git", "--version"]);
  if (gitResult.success) {
    checks.git = { installed: true, version: gitResult.stdout.trim().replace("git version ", "") };
  } else {
    checks.git = { installed: false, error: "git not found" };
    missingSteps.push("Install git: https://git-scm.com");
  }

  // gh CLI
  const ghResult = await runCommand(["gh", "--version"]);
  if (ghResult.success) {
    const ver = ghResult.stdout.split("\n")[0]?.trim() ?? "";
    checks.gh = { installed: true, version: ver };

    // Check gh auth
    const ghAuth = await runCommand(["gh", "auth", "status"]);
    if (ghAuth.success || ghAuth.stderr.includes("Logged in")) {
      checks.gh.authenticated = true;

      // Get username
      const ghUser = await runCommand(["gh", "api", "user", "--jq", ".login"]);
      if (ghUser.success) {
        checks.gh.username = ghUser.stdout.trim();
      }
    } else {
      checks.gh.authenticated = false;
      missingSteps.push('Run "gh auth login" to authenticate with GitHub.');
    }
  } else {
    checks.gh = { installed: false, error: "gh CLI not found" };
    missingSteps.push("Install GitHub CLI: https://cli.github.com");
  }

  const allReady = missingSteps.length === 0;

  return JSON.stringify({
    checks,
    allReady,
    missingSteps,
    nextSteps: allReady
      ? ["All tools ready! Use check_npm_name to check package name availability, then scaffold_server to create a project."]
      : ["Fix the missing steps above, then run check_setup again."],
  }, null, 2);
}
