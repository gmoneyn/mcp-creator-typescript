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

export async function runCommand(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeout?: number } = {}
): Promise<RunResult> {
  const [bin, ...args] = cmd;
  const command = cmd.join(" ");

  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
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
