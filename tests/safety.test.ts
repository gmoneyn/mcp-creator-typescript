/**
 * Safety limits on the tools a language model can call.
 *
 * setup_github and publish_package are driven with a recording command runner, so
 * no git, gh or npm process is ever started here. Each test names the future change
 * that would turn it red.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setupGithub, makePublicSentence } from "../src/tools/setup-github.js";
import { publishPackage } from "../src/tools/publish-package.js";
import { buildPackage } from "../src/tools/build-package.js";
import { scaffoldServer } from "../src/tools/scaffold-server.js";
import { addTool } from "../src/tools/add-tool.js";
import { generateLaunchguide } from "../src/tools/generate-launchguide.js";
import { writeProjectFiles } from "../src/services/file-writer.js";
import { PathEscapeError, resolveInside } from "../src/services/path-guard.js";
import type { RunResult } from "../src/services/subprocess.js";

const TOOLS = JSON.stringify([
  { name: "get_weather", description: "Get weather", parameters: [{ name: "city", type: "string", required: true, description: "City" }], returns: "JSON" },
]);

let sandbox: string; // everything a test may touch
let outside: string; // stands for "somewhere else on disk": nothing may be written here
let savedHome: string | undefined;

/** A runner that records every command and reports success without running anything. */
function recorder() {
  const calls: Array<{ cmd: string[]; cwd?: string }> = [];
  const run = async (cmd: string[], opts: { cwd?: string } = {}): Promise<RunResult> => {
    calls.push({ cmd, cwd: opts.cwd });
    const line = cmd.join(" ");
    // No origin remote and no repository of that name yet: both lookups come back "not found".
    // A repository of its own: the recorder answers the three identity questions truthfully.
    if (line === "git rev-parse --absolute-git-dir") return { success: true, command: line, stdout: join(opts.cwd ?? "", ".git") + "\n", stderr: "", returnCode: 0 };
    if (line === "git rev-parse --git-common-dir") return { success: true, command: line, stdout: ".git\n", stderr: "", returnCode: 0 };
    if (line === "git rev-parse --show-toplevel") return { success: true, command: line, stdout: (opts.cwd ?? "") + "\n", stderr: "", returnCode: 0 };
    if (line.startsWith("git remote get-url") || line.startsWith("gh repo view")) {
      return { success: false, command: line, stdout: "", stderr: "not found", returnCode: 1 };
    }
    let stdout = "";
    if (line.startsWith("gh repo create")) stdout = "https://github.com/someone/demo\n";
    if (line.startsWith("npm pack")) {
      // Stand in for npm: leave a tarball where it was asked for, and report it.
      writeFileSync(join(cmd[cmd.indexOf("--pack-destination") + 1], "demo-1.0.0.tgz"), "tarball");
      stdout = JSON.stringify([{ filename: "demo-1.0.0.tgz", files: [{ path: "package.json" }, { path: "dist/index.js" }] }]);
    }
    return { success: true, command: line, stdout, stderr: "", returnCode: 0 };
  };
  return { calls, run };
}

/** A directory that satisfies every project rule: package.json, .gitignore, dist/. */
function makeProject(name: string): string {
  const dir = join(sandbox, name);
  mkdirSync(join(dir, "dist"), { recursive: true });
  mkdirSync(join(dir, ".git")); // the recorder runs no git, so the repository directory is made here
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
  writeFileSync(join(dir, ".gitignore"), "node_modules/\ndist/\n.env\n");
  writeFileSync(join(dir, "dist", "index.js"), "");
  return dir;
}

beforeEach(() => {
  // realpath: on macOS the temp dir sits behind a symlink, and the tests compare real paths.
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "ts-mcp-creator-safety-")));
  outside = join(sandbox, "outside");
  mkdirSync(outside);
  savedHome = process.env.HOME;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("setup_github: project directory only", () => {
  // Red when: the default flips back to public, or the flag stops reaching gh.
  it("creates the repository private by default and says how to make it public", async () => {
    const dir = makeProject("ok-project");
    const { calls, run } = recorder();
    const out = JSON.parse(await setupGithub(dir, "demo", "", undefined, run));

    expect(out.success).toBe(true);
    const create = calls.filter((c) => c.cmd[0] === "gh" && c.cmd[1] === "repo" && c.cmd[2] === "create");
    expect(create.length).toBe(1);
    expect(create[0].cmd).toContain("--private");
    expect(create[0].cmd).not.toContain("--public");
    expect(out.private).toBe(true);
    expect(out.nextSteps).toContain(makePublicSentence("someone/demo"));
    expect(makePublicSentence("someone/demo")).toContain("gh repo edit someone/demo --visibility public");
  });

  // Red when: private=false reaches gh as --public. The parameter is still accepted, and
  // ignored: this tool never creates a public repository (tests/guards.test.ts, part 7).
  it("private=false is accepted and the repository is still created private", async () => {
    const dir = makeProject("public-project");
    const { calls, run } = recorder();
    const out = JSON.parse(await setupGithub(dir, "demo", "", false, run));

    const create = calls.filter((c) => c.cmd[0] === "gh" && c.cmd[1] === "repo" && c.cmd[2] === "create");
    expect(create[0].cmd).toContain("--private");
    expect(create[0].cmd).not.toContain("--public");
    expect(out.private).toBe(true);
    expect(out.publicRequestIgnored).toBe(true);
    expect(out.nextSteps).toContain(makePublicSentence("someone/demo"));
  });

  // Red when: the package.json rule is dropped, or any command runs before the check.
  it("refuses a directory with no package.json and runs nothing", async () => {
    const dir = join(sandbox, "not-a-project");
    mkdirSync(dir);
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    const { calls, run } = recorder();
    const out = JSON.parse(await setupGithub(dir, "demo", "", undefined, run));

    expect(out.success).toBe(false);
    expect(out.error).toContain("no package.json");
    expect(calls).toEqual([]);
  });

  // Red when: the .gitignore rule is dropped, `git add` runs without one, or one is created silently.
  it("refuses a project with no .gitignore, stages nothing, and does not create one", async () => {
    const dir = makeProject("no-gitignore");
    rmSync(join(dir, ".gitignore"));
    const { calls, run } = recorder();
    const out = JSON.parse(await setupGithub(dir, "demo", "", undefined, run));

    expect(out.success).toBe(false);
    expect(out.error).toContain("no .gitignore");
    expect(calls).toEqual([]);
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  });

  // Red when: the home-directory rule is dropped. The directory satisfies every OTHER
  // rule and is accepted until HOME points at it, so only that rule can refuse it.
  it("refuses the home directory even when it looks like a project", async () => {
    const dir = makeProject("pretend-home");
    const before = recorder();
    expect(JSON.parse(await setupGithub(dir, "demo", "", undefined, before.run)).success).toBe(true);

    process.env.HOME = dir;
    const { calls, run } = recorder();
    const out = JSON.parse(await setupGithub(dir, "demo", "", undefined, run));
    expect(out.success).toBe(false);
    expect(out.error).toContain("home directory");
    expect(calls).toEqual([]);
  });

  // Red when: the home check compares the path as typed instead of where it really leads.
  it("refuses a symlink that leads to the home directory", async () => {
    const dir = makeProject("pretend-home-2");
    const link = join(sandbox, "link-to-home");
    symlinkSync(dir, link);
    process.env.HOME = dir;
    const { calls, run } = recorder();
    const out = JSON.parse(await setupGithub(link, "demo", "", undefined, run));
    expect(out.success).toBe(false);
    expect(out.error).toContain("home directory");
    expect(calls).toEqual([]);
  });

  // Red when: the filesystem-root rule is dropped or checked after the other rules.
  it("refuses a filesystem root", async () => {
    const { calls, run } = recorder();
    const out = JSON.parse(await setupGithub("/", "demo", "", undefined, run));
    expect(out.success).toBe(false);
    expect(out.error).toContain("filesystem root");
    expect(calls).toEqual([]);
  });
});

describe("publish_package: project directory only", () => {
  // Red when: a normal project can no longer be published, or the command or its directory changes.
  it("runs npm publish once, in the project directory", async () => {
    const dir = makeProject("publishable");
    const { calls, run } = recorder();
    const out = JSON.parse(await publishPackage(dir, run));
    expect(out.success).toBe(true);
    expect(calls.length).toBe(2);
    const [pack, publish] = calls;
    expect(pack.cmd.slice(0, 5)).toEqual(["npm", "pack", "--json", "--ignore-scripts", "--pack-destination"]);
    // The file that is published is the one that was packed, and no script runs.
    expect(publish.cmd).toEqual(["npm", "publish", join(pack.cmd[5], "demo-1.0.0.tgz"), "--ignore-scripts"]);
    expect(publish.cwd).toBe(dir);
  });

  // Red when: npm publish can be pointed at a directory that is not a project.
  it("refuses a directory with no package.json and runs nothing", async () => {
    const dir = join(sandbox, "empty");
    mkdirSync(join(dir, "dist"), { recursive: true });
    const { calls, run } = recorder();
    const out = JSON.parse(await publishPackage(dir, run));
    expect(out.success).toBe(false);
    expect(out.error).toContain("no package.json");
    expect(calls).toEqual([]);
  });

  // Red when: the home-directory rule is dropped for publish (same near-miss shape as above).
  it("refuses the home directory even when it has a package.json and a dist", async () => {
    const dir = makeProject("pretend-home-3");
    const before = recorder();
    expect(JSON.parse(await publishPackage(dir, before.run)).success).toBe(true);

    process.env.HOME = dir;
    const { calls, run } = recorder();
    const out = JSON.parse(await publishPackage(dir, run));
    expect(out.success).toBe(false);
    expect(out.error).toContain("home directory");
    expect(calls).toEqual([]);
  });

  // Red when: the filesystem-root rule is dropped for publish.
  it("refuses a filesystem root", async () => {
    const { calls, run } = recorder();
    const out = JSON.parse(await publishPackage("/", run));
    expect(out.success).toBe(false);
    expect(out.error).toContain("filesystem root");
    expect(calls).toEqual([]);
  });
});

describe("build_package: project directory only", () => {
  // Red when: build_package (npm install + a build script) can be pointed at the home directory.
  it("refuses the home directory and a filesystem root, and runs nothing", async () => {
    const dir = makeProject("pretend-home-4");
    const before = recorder();
    expect(JSON.parse(await buildPackage(dir, before.run)).success).toBe(true);
    expect(before.calls.map((c) => c.cmd.join(" "))).toEqual(["npm install", "npm run build"]);

    process.env.HOME = dir;
    const { calls, run } = recorder();
    expect(JSON.parse(await buildPackage(dir, run)).error).toContain("home directory");
    expect(JSON.parse(await buildPackage("/", run)).error).toContain("filesystem root");
    expect(calls).toEqual([]);
  });
});

describe("file writes are confined to the project directory", () => {
  // Red when: the path check is removed from writeProjectFiles, or it starts writing before checking.
  it("refuses a .. path, writes nothing outside, and writes none of the batch", () => {
    const base = join(sandbox, "proj");
    expect(() => writeProjectFiles(base, { "ok.txt": "fine", "../outside/escaped.txt": "x" })).toThrow(PathEscapeError);
    expect(existsSync(join(outside, "escaped.txt"))).toBe(false);
    expect(existsSync(join(base, "ok.txt"))).toBe(false);
  });

  // Red when: an absolute path is accepted as a file name.
  it("refuses an absolute path elsewhere", () => {
    const base = join(sandbox, "proj");
    const target = join(outside, "abs.txt");
    expect(() => writeProjectFiles(base, { [target]: "x" })).toThrow(PathEscapeError);
    expect(existsSync(target)).toBe(false);
  });

  // Red when: the check goes back to comparing path text, which a linked directory passes.
  it("refuses a path through a directory symlink that leads out", () => {
    const base = join(sandbox, "proj");
    mkdirSync(base);
    symlinkSync(outside, join(base, "linked-dir"));
    expect(() => writeProjectFiles(base, { "linked-dir/via-link.txt": "x" })).toThrow(PathEscapeError);
    expect(existsSync(join(outside, "via-link.txt"))).toBe(false);
  });

  // Red when: an existing file that is a link to somewhere else gets overwritten through the link.
  it("refuses to overwrite through a file symlink that leads out", () => {
    const base = join(sandbox, "proj");
    mkdirSync(base);
    const victim = join(outside, "victim.txt");
    writeFileSync(victim, "original");
    symlinkSync(victim, join(base, "README.md"));
    expect(() => writeProjectFiles(base, { "README.md": "overwritten" })).toThrow(PathEscapeError);
    expect(readFileSync(victim, "utf-8")).toBe("original");
  });

  // Red when: a link whose target does not exist yet is treated as an ordinary new file
  // (writing through it creates the target outside the project).
  it("refuses a dangling symlink that would create a file outside", () => {
    const base = join(sandbox, "proj");
    mkdirSync(base);
    const target = join(outside, "created-by-link.txt");
    symlinkSync(target, join(base, "notes.txt"));
    expect(() => writeProjectFiles(base, { "notes.txt": "x" })).toThrow(PathEscapeError);
    expect(existsSync(target)).toBe(false);
  });

  // Red when: the guard becomes so strict that ordinary scaffolding breaks: new nested
  // folders, a base directory that does not exist yet, or a link that stays inside the project.
  it("still allows nested new paths, a new base directory, and a link that stays inside", () => {
    const base = join(sandbox, "brand", "new", "proj");
    const written = writeProjectFiles(base, { "src/tools/a.ts": "a", "README.md": "r" });
    expect(written.length).toBe(2);
    expect(readFileSync(join(base, "src/tools/a.ts"), "utf-8")).toBe("a");

    mkdirSync(join(base, "real"));
    symlinkSync(join(base, "real"), join(base, "alias"));
    expect(resolveInside(base, "alias/inside.txt")).toBe(join(base, "alias/inside.txt"));
  });
});

describe("scaffold_server, add_tool, generate_launchguide stay inside the project", () => {
  // Red when: package_name can again move the project out of output_dir.
  it("scaffold_server refuses a package_name that leaves output_dir", async () => {
    const out = join(sandbox, "workspace");
    mkdirSync(out);
    for (const name of ["../outside/evil", join(outside, "evil-abs"), "", ".."]) {
      const res = JSON.parse(await scaffoldServer(name, "d", TOOLS, out));
      expect(res.success, JSON.stringify(name)).toBe(false);
      expect(res.error).toContain("scaffold_server refused");
    }
    expect(existsSync(join(outside, "evil"))).toBe(false);
    expect(existsSync(join(outside, "evil-abs"))).toBe(false);
    expect(existsSync(join(out, "package.json"))).toBe(false);
  });

  // Red when: a tool name that points out of the project is accepted. Name validation
  // refuses it first; the write confinement tested above is the second line behind it.
  it("scaffold_server refuses a tool name that leaves the project and writes nothing", async () => {
    const out = join(sandbox, "workspace");
    const evil = JSON.stringify([{ name: "../../../../outside/evil", description: "d", parameters: [], returns: "r" }]);
    const res = JSON.parse(await scaffoldServer("my-mcp", "d", evil, out));
    expect(res.success).toBe(false);
    expect(res.error).toContain("scaffold_server refused");
    expect(existsSync(join(outside, "evil.ts"))).toBe(false);
    expect(existsSync(join(out, "my-mcp", "package.json"))).toBe(false);
  });

  // Red when: scaffolding into a directory the caller names (not created yet) stops working.
  it("scaffold_server still scaffolds into a new directory the caller names", async () => {
    const out = join(sandbox, "does", "not", "exist", "yet");
    const res = JSON.parse(await scaffoldServer("my-mcp", "d", TOOLS, out));
    expect(res.success).toBe(true);
    expect(existsSync(join(out, "my-mcp", "src", "index.ts"))).toBe(true);
    expect(existsSync(join(out, "my-mcp", ".gitignore"))).toBe(true);
  });

  // Red when: add_tool writes a tool file named by the caller without the confinement check.
  it("add_tool refuses a tool name that leaves the project and leaves index.ts alone", async () => {
    const out = join(sandbox, "workspace");
    await scaffoldServer("my-mcp", "d", TOOLS, out);
    const dir = join(out, "my-mcp");
    const before = readFileSync(join(dir, "src/index.ts"), "utf-8");
    const res = JSON.parse(await addTool(dir, JSON.stringify({ name: "../../../../outside/evil", description: "d", parameters: [] })));
    expect(res.success).toBe(false);
    expect(existsSync(join(outside, "evil.ts"))).toBe(false);
    expect(readFileSync(join(dir, "src/index.ts"), "utf-8")).toBe(before);
  });

  // Red when: add_tool injects into src/index.ts without checking where that path really leads.
  it("add_tool refuses when src/index.ts is a link out of the project", async () => {
    const dir = join(sandbox, "linked-project");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "linked-project", version: "1.0.0" }));
    const victim = join(outside, "index.ts");
    writeFileSync(victim, "// --- IMPORTS ---\n// --- END TOOLS ---\n");
    symlinkSync(victim, join(dir, "src", "index.ts"));
    const res = JSON.parse(await addTool(dir, JSON.stringify({ name: "get_x", description: "d", parameters: [] })));
    expect(res.success).toBe(false);
    expect(readFileSync(victim, "utf-8")).toBe("// --- IMPORTS ---\n// --- END TOOLS ---\n");
    expect(existsSync(join(dir, "src", "tools", "get-x.ts"))).toBe(false);
  });

  // Red when: add_tool stops working on an ordinary scaffold (the guard must not block normal use).
  it("add_tool still adds a tool to an ordinary scaffold", async () => {
    const out = join(sandbox, "workspace");
    await scaffoldServer("my-mcp", "d", TOOLS, out);
    const dir = join(out, "my-mcp");
    const res = JSON.parse(await addTool(dir, JSON.stringify({ name: "get_x", description: "d", parameters: [] })));
    expect(res.success).toBe(true);
    expect(readFileSync(join(dir, "src/index.ts"), "utf-8")).toContain('from "./tools/get-x.js"');
  });

  // Red when: generate_launchguide writes LAUNCHGUIDE.md through a link, or into the home directory or a root.
  it("generate_launchguide refuses a link out, the home directory and a root", async () => {
    const dir = makeProject("lg-project");
    const victim = join(outside, "victim.md");
    writeFileSync(victim, "original");
    symlinkSync(victim, join(dir, "LAUNCHGUIDE.md"));
    const args = ["pkg", "t", "d", "Data", "- f", "tag"] as const;
    expect(JSON.parse(await generateLaunchguide(dir, ...args)).success).toBe(false);
    expect(readFileSync(victim, "utf-8")).toBe("original");

    const home = makeProject("pretend-home-5");
    expect(JSON.parse(await generateLaunchguide(home, ...args)).success).toBe(true);
    process.env.HOME = home;
    expect(JSON.parse(await generateLaunchguide(home, ...args)).error).toContain("home directory");
    expect(JSON.parse(await generateLaunchguide("/", ...args)).error).toContain("filesystem root");
  });
});
