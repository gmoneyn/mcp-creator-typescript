/**
 * subprocess.ts — Safe child_process wrapper for running shell commands.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RunResult {
  success: boolean;
  command: string;
  stdout: string;
  stderr: string;
  returnCode: number;
}

/**
 * The environment a child process (git, gh, npm) is started with: this process's own,
 * MINUS every variable that can silently point git or npm somewhere else.
 *
 * Removed, in any letter case:
 *   GIT_*          GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE make git act on a different
 *                  repository than the directory it is run in; GIT_CONFIG_* and
 *                  GIT_SSH_COMMAND change what it runs.
 *   npm_config_*   every npm setting can be given this way (registry, userconfig,
 *                  prefix, ignore-scripts ...), and a server started through npx
 *                  inherits a full set that describes npx's own run, not the project.
 *   NODE_OPTIONS   npm and anything it starts are Node programs; this variable can make
 *                  each of them load a file or change how it runs.
 *
 * Everything else passes through unchanged. The variables that matter, and why:
 *   PATH                          to find git, gh, npm and node.
 *   HOME / USERPROFILE / APPDATA  where git, gh and npm keep their own configuration
 *                                 and saved logins (~/.gitconfig, ~/.config/gh, ~/.npmrc).
 *   GH_TOKEN, GITHUB_TOKEN, GH_ENTERPRISE_TOKEN, GH_HOST, GH_CONFIG_DIR, XDG_CONFIG_HOME
 *                                 how gh authenticates and where it looks.
 *   NPM_TOKEN, NODE_AUTH_TOKEN    referenced from .npmrc files to authenticate npm.
 *   SSH_AUTH_SOCK                 the ssh agent, for a push over ssh.
 *   HTTP_PROXY, HTTPS_PROXY, NO_PROXY, SSL_CERT_FILE, NODE_EXTRA_CA_CERTS
 *                                 network settings a machine may need to reach anything.
 *
 * `extra` is added last and is NOT filtered: it comes from this server's own code,
 * never from the ambient environment.
 */
export function childEnvironment(
  extra: Record<string, string> = {},
  base: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (/^GIT_/i.test(key) || /^npm_config_/i.test(key) || /^NODE_OPTIONS$/i.test(key)) continue;
    out[key] = value;
  }
  return { ...out, ...extra };
}

export async function runCommand(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeout?: number } = {}
): Promise<RunResult> {
  const [bin, ...args] = cmd;
  const command = cmd.join(" ");

  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd: opts.cwd,
      env: childEnvironment(opts.env),
      timeout: opts.timeout ?? 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    return {
      success: true,
      command,
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      returnCode: 0,
    };
  } catch (e: unknown) {
    const err = e as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      message?: string;
    };

    // Command not found
    if (err.code === "ENOENT") {
      return {
        success: false,
        command,
        stdout: "",
        stderr: `Command not found: ${bin}`,
        returnCode: 127,
      };
    }

    return {
      success: false,
      command,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? err.message ?? "Unknown error",
      returnCode: typeof err.code === "number" ? err.code : 1,
    };
  }
}
