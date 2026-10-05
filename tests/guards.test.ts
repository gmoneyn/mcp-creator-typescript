/**
 * Guard review (independent security review, 2026-10-05). The reviewer's executed
 * triggers are the test cases here.
 *
 * setup_github runs REAL git in a temp directory (isolated from the machine's git
 * config) against a FAKE gh, and publish_package runs the real `npm pack --dry-run`
 * against a FAKE `npm publish`, so nothing leaves the machine. Each test names the
 * future change that would turn it red.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { setupGithub, makePublicSentence } from "../src/tools/setup-github.js";
import { publishPackage } from "../src/tools/publish-package.js";
import { buildPackage } from "../src/tools/build-package.js";
import { addTool } from "../src/tools/add-tool.js";
import { scaffoldServer } from "../src/tools/scaffold-server.js";
import { generateLaunchguide } from "../src/tools/generate-launchguide.js";
import { childEnvironment, runCommand, type RunResult } from "../src/services/subprocess.js";
import { isSecretTemplate, looksLikeSecret, scanForCredentials } from "../src/services/secret-scan.js";
import { UnsafeTargetError, writeProjectFiles } from "../src/services/file-writer.js";
import { validateToolDefs } from "../src/services/validate.js";
import { containment, resolveInside, sameEntry, PathEscapeError } from "../src/services/path-guard.js";

let sandbox: string;
let savedHome: string | undefined;
let savedGitDir: string | undefined;

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "ts-mcp-creator-guards-")));
  savedHome = process.env.HOME;
  savedGitDir = process.env.GIT_DIR;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = savedGitDir;
  rmSync(sandbox, { recursive: true, force: true });
});

/** Is this filesystem case-insensitive? (macOS and Windows by default; Linux is not.) */
function caseInsensitive(): boolean {
  mkdirSync(join(sandbox, "casecheck"), { recursive: true });
  return existsSync(join(sandbox, "CASECHECK"));
}

/** Isolated from the machine: no global or system git config, a fixed identity. */
const GIT_VARS = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};
const git = (cwd: string, ...args: string[]) => runCommand(["git", ...args], { cwd, env: GIT_VARS });
const fake = (cmd: string[], stdout = "", ok = true): RunResult => ({ success: ok, command: cmd.join(" "), stdout, stderr: ok ? "" : "not found", returnCode: ok ? 0 : 1 });

/**
 * Real git, fake gh. `view` answers `gh repo view <repo>`: a JSON string when the
 * repository exists, null when it does not (the default).
 */
function gitRunner(view: (repo: string) => string | null = () => null) {
  const calls: string[][] = [];
  const run = async (cmd: string[], opts: { cwd?: string; timeout?: number } = {}): Promise<RunResult> => {
    calls.push(cmd);
    if (cmd[0] === "gh") {
      if (cmd[1] === "--version") return fake(cmd, "gh version test\n");
      if (cmd[1] === "repo" && cmd[2] === "view") {
        const answer = view(cmd[cmd.length - 1]);
        return answer === null ? fake(cmd, "", false) : fake(cmd, answer);
      }
      if (cmd[1] === "repo" && cmd[2] === "create") return fake(cmd, "https://github.com/someone/demo\n");
      return fake(cmd, "", false);
    }
    return runCommand(cmd, { ...opts, env: GIT_VARS });
  };
  const said = (text: string) => calls.some((c) => c.join(" ").startsWith(text));
  return { calls, run, said };
}

const GOOD_IGNORE = "node_modules/\ndist/\n.env\n";

/** Stand in for `npm pack`: leave a tarball where it was asked for, and report it and its files. */
function fakePack(cmd: string[], files: string[] = ["package.json", "dist/index.js"]): RunResult {
  writeFileSync(join(cmd[cmd.indexOf("--pack-destination") + 1], "demo-1.0.0.tgz"), "tarball");
  return fake(cmd, JSON.stringify([{ filename: "demo-1.0.0.tgz", files: files.map((path) => ({ path })) }]));
}

/** A scaffold-shaped project. */
function project(name: string, files: Record<string, string> = {}, ignore = GOOD_IGNORE): string {
  const dir = join(sandbox, name);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: name.toLowerCase(), version: "1.0.0", files: ["dist"] }));
  writeFileSync(join(dir, ".gitignore"), ignore);
  writeFileSync(join(dir, "index.js"), "// code\n");
  writeFileSync(join(dir, "dist", "index.js"), "// built\n");
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}
const hasCommit = async (dir: string) => (await git(dir, "rev-parse", "--verify", "-q", "HEAD")).success;
const commitCount = async (dir: string) => Number((await git(dir, "rev-list", "--all", "--count")).stdout.trim() || "0");

// ---------------------------------------------------------------- 1. history

describe("1. setup_github refuses when the existing history holds a secret", () => {
  // Red when: only the working tree and the index are checked before the push.
  // The reviewer's trigger: .env committed earlier, then removed from the index and ignored.
  it("refuses a .env that was committed earlier and removed since, and names it", async () => {
    const dir = project("history");
    await git(dir, "init", "-q");
    writeFileSync(join(dir, ".env"), "TOKEN=abc");
    await git(dir, "add", "-f", ".env", "package.json");
    await git(dir, "commit", "-q", "-m", "oops");
    await git(dir, "rm", "-q", "--cached", ".env");
    await git(dir, "commit", "-q", "-m", "remove it");
    rmSync(join(dir, ".env"));
    const before = await commitCount(dir);

    const { run, said } = gitRunner();
    const out = JSON.parse(await setupGithub(dir, "demo", "", undefined, run));
    expect(out.success).toBe(false);
    expect(out.error).toContain("history contains");
    expect(out.error).toContain(".env");
    expect(out.error).toContain("start a fresh repository");
    expect(said("git add -A")).toBe(false);
    expect(said("gh repo create")).toBe(false);
    expect(await commitCount(dir)).toBe(before);
  });

  // Red when: only the current branch is listed (a secret on another branch or tag is pushed
  // by anyone who later pushes that ref, and `--all` is what was asked for).
  it("refuses a secret that is only on another branch", async () => {
    const dir = project("side-branch");
    await git(dir, "init", "-q", "-b", "main");
    await git(dir, "add", "package.json");
    await git(dir, "commit", "-q", "-m", "base");
    await git(dir, "checkout", "-q", "-b", "side");
    writeFileSync(join(dir, "deploy.pem"), "k");
    await git(dir, "add", "-f", "deploy.pem");
    await git(dir, "commit", "-q", "-m", "side secret");
    await git(dir, "checkout", "-q", "main");

    const { run, said } = gitRunner();
    const out = JSON.parse(await setupGithub(dir, "demo", "", undefined, run));
    expect(out.success).toBe(false);
    expect(out.error).toContain("deploy.pem");
    expect(said("gh repo create")).toBe(false);
  });

  // Red when: the history check refuses a repository whose history is clean (a control:
  // the same steps without the secret must go through, with and without earlier commits).
  it("accepts a repository with earlier commits and no secret in them, and a brand new one", async () => {
    const withHistory = project("clean-history");
    await git(withHistory, "init", "-q");
    await git(withHistory, "add", "package.json");
    await git(withHistory, "commit", "-q", "-m", "base");
    expect(JSON.parse(await setupGithub(withHistory, "demo", "", undefined, gitRunner().run)).success).toBe(true);

    const fresh = project("fresh");
    const { run, said } = gitRunner();
    expect(JSON.parse(await setupGithub(fresh, "demo", "", undefined, run)).success).toBe(true);
    expect(said("git -c log.showRoot=true log --all")).toBe(true);
    expect(await hasCommit(fresh)).toBe(true);
  });
});

// ---------------------------------------------------------------- 2. identity, not spelling

describe("2. directories are compared by identity", () => {
  // Red when: the home check compares path strings. The reviewer's trigger: .../fakehome
  // refused, .../FAKEHOME accepted. (Only a case-insensitive filesystem has a second
  // spelling; on a case-sensitive one the other spelling does not exist and is refused for that.)
  it("refuses the home directory under a different letter case", async () => {
    const home = project("fakehome");
    process.env.HOME = home;
    const other = join(sandbox, "FAKEHOME");
    const calls: string[][] = [];
    const run = async (cmd: string[]) => { calls.push(cmd); return fake(cmd, "[]"); };
    const out = JSON.parse(await publishPackage(other, run));

    expect(out.success).toBe(false);
    expect(calls).toEqual([]);
    if (caseInsensitive()) expect(out.error).toContain("home directory");
    else expect(out.error).toContain("not an existing directory");
  });

  // Red when: only the home directory itself is refused. The parent here satisfies every
  // other rule, and an identical sibling that is NOT above home is accepted.
  it("refuses every directory above the home directory, and not its siblings", async () => {
    const parent = project("above");
    const home = join(parent, "users", "me");
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    const sibling = project("beside");

    const run = async (cmd: string[]) => (cmd[1] === "pack" ? fakePack(cmd) : fake(cmd, ""));
    const refused = JSON.parse(await publishPackage(parent, run));
    expect(refused.success).toBe(false);
    expect(refused.error).toContain("contains your home directory");
    expect(JSON.parse(await publishPackage(join(parent, "users"), run)).success).toBe(false);
    expect(JSON.parse(await publishPackage(sibling, run)).success).toBe(true);
  });

  // Red when: the escape check compares strings. Both directions are shown: another
  // spelling of the project root is still INSIDE, and a path outside does not get in
  // through a case trick.
  it("resolveInside: another spelling of the root is inside; outside stays outside", () => {
    const root = join(sandbox, "proj");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(sandbox, "proj-other"));
    writeFileSync(join(sandbox, "proj-other", "victim.txt"), "x");

    if (caseInsensitive()) {
      // The same directory, spelled differently on each side of the comparison.
      expect(resolveInside(root, join(sandbox, "PROJ", "src", "a.ts"))).toBe(join(sandbox, "PROJ", "src", "a.ts"));
      expect(resolveInside(join(sandbox, "PROJ"), join(root, "src", "a.ts"))).toBe(join(root, "src", "a.ts"));
      expect(sameEntry(root, join(sandbox, "PROJ"))).toBe(true);
    }
    // A link back to the root is the root, whatever it is called.
    symlinkSync(root, join(sandbox, "alias"));
    expect(resolveInside(join(sandbox, "alias"), join(root, "src", "a.ts"))).toBe(join(root, "src", "a.ts"));

    // Outside, however it is spelled.
    for (const target of [join(sandbox, "proj-other", "victim.txt"), join(sandbox, "PROJ-OTHER", "victim.txt"), "../PROJ-other/victim.txt", "../proj-other/new.txt", join(sandbox, "PROJ-other")]) {
      expect(() => resolveInside(root, target), target).toThrow(PathEscapeError);
    }
    expect(containment(root, join(root, "src"))).toBe("inside");
    expect(containment(root, root)).toBe("same");
    expect(containment(root, sandbox)).toBe("outside");
    expect(containment(join(sandbox, "new", "proj"), join(sandbox, "new", "proj", "src", "a.ts"))).toBe("inside");
    expect(containment(join(sandbox, "new", "proj"), join(sandbox, "new", "other", "a.ts"))).toBe("outside");
  });
});

// ---------------------------------------------------------------- 3. more names, and a .gitignore that works

describe("3. secret names and a .gitignore that actually ignores", () => {
  // Red when: a name is dropped from the list, or a near-miss starts matching.
  it("name rules: the added names match, near-misses do not", () => {
    for (const yes of [
      "credentials.json", "service-account.json", ".git-credentials", ".envrc", ".htpasswd", "release.keystore",
      "android/app/upload.jks", "AuthKey_ABC123.p8", "server.ppk", ".pgpass", "credentials", "credentials.yml",
      "service-account-prod.json", "prod.tfvars", "terraform.tfstate", "terraform.tfstate.backup", ".aws/credentials",
      "home/.docker/config.json", "kubeconfig", "vault.kdbx", "CREDENTIALS.JSON",
    ]) {
      expect(looksLikeSecret(yes), yes).toBe(true);
    }
    for (const no of [
      "config.json", "docker/config.json", "credential-helper.md", "keystore.ts", "tfvars.md", "docs/kubeconfig.md",
      "service-account.md", "service-accounts/readme.txt", "htpasswd.txt", "envrc.md", "src/index.ts", "package.json",
    ]) {
      expect(looksLikeSecret(no), no).toBe(false);
    }
  });

  // Red when: one of the six files the reviewer got committed and handed to push is accepted again.
  it.each(["credentials.json", "service-account.json", ".git-credentials", ".envrc", ".htpasswd", "release.keystore"])(
    "setup_github refuses %s and stages nothing",
    async (secret) => {
      const dir = project("named", { [secret]: "secret" });
      const { run, said } = gitRunner();
      const out = JSON.parse(await setupGithub(dir, "demo", "", undefined, run));
      expect(out.success).toBe(false);
      expect(out.error).toContain(secret);
      expect(said("git add -A")).toBe(false);
      expect(said("gh repo create")).toBe(false);
    }
  );

  // Red when: a .gitignore only has to exist. The reviewer's trigger: an empty one passed.
  it("refuses a .gitignore that does not ignore node_modules/ and .env, naming what is missing", async () => {
    const empty = project("empty-ignore", {}, "");
    const a = gitRunner();
    const outEmpty = JSON.parse(await setupGithub(empty, "demo", "", undefined, a.run));
    expect(outEmpty.success).toBe(false);
    expect(outEmpty.error).toContain("would not ignore node_modules/ or .env");
    expect(a.said("git add -A")).toBe(false);

    const half = project("half-ignore", {}, "node_modules/\n");
    const outHalf = JSON.parse(await setupGithub(half, "demo", "", undefined, gitRunner().run));
    expect(outHalf.success).toBe(false);
    expect(outHalf.error).toContain("would not ignore .env");
    expect(outHalf.error).not.toContain("node_modules/ or");
  });

  // Red when: "does it ignore them" is decided by reading .gitignore instead of asking git.
  // Here .gitignore is empty and the two rules live in .git/info/exclude.
  it("asks git: rules that live outside .gitignore count", async () => {
    const dir = project("excluded-elsewhere", {}, "");
    await git(dir, "init", "-q");
    writeFileSync(join(dir, ".git/info/exclude"), "node_modules/\n.env\ndist/\n");
    expect(JSON.parse(await setupGithub(dir, "demo", "", undefined, gitRunner().run)).success).toBe(true);
  });
});

// ---------------------------------------------------------------- 4. a backslash is not a separator

describe("4. a backslash in a file name does not hide it", () => {
  // Red when: backslashes are turned into "/" before the name is taken (the name then
  // became "x"). The reviewer's trigger: a file literally named `.env.\x`.
  it("flags and refuses a file named .env.\\x", async () => {
    const name = ".env.\\x";
    expect(looksLikeSecret(name)).toBe(true);
    expect(looksLikeSecret("sub/dir/" + name)).toBe(true);
    expect(looksLikeSecret("a\\b.txt")).toBe(false);

    const dir = project("backslash");
    try {
      writeFileSync(join(dir, name), "TOKEN=abc");
    } catch {
      return; // a filesystem that cannot hold this name (Windows) cannot have the problem
    }
    const { run, said } = gitRunner();
    const out = JSON.parse(await setupGithub(dir, "demo", "", undefined, run));
    expect(out.success).toBe(false);
    expect(out.error).toContain(name);
    expect(said("git add -A")).toBe(false);
  });
});

// ---------------------------------------------------------------- 5. the child environment

describe("5. git, gh and npm do not inherit variables that redirect them", () => {
  // Red when: a GIT_* or npm_config_* variable reaches a child process, or a variable
  // the tools need in order to authenticate stops reaching it.
  it("childEnvironment removes GIT_* and npm_config_* in any case and keeps the rest", () => {
    const out = childEnvironment({ EXTRA: "1", GIT_AUTHOR_NAME: "explicit" }, {
      PATH: "/bin", HOME: "/home/me", NODE_OPTIONS: "--require /tmp/evil.js", node_options: "--inspect", GH_TOKEN: "t", GITHUB_TOKEN: "t", NPM_TOKEN: "t", NODE_AUTH_TOKEN: "t", SSH_AUTH_SOCK: "/s", HTTPS_PROXY: "p",
      GIT_DIR: "/other/.git", GIT_WORK_TREE: "/other", GIT_INDEX_FILE: "/x", GIT_SSH_COMMAND: "evil", git_dir: "/lower",
      npm_config_registry: "https://evil.example", NPM_CONFIG_USERCONFIG: "/tmp/x", npm_config_ignore_scripts: "false",
      GITHUB_ACTIONS: "true", GITLAB: "kept", NPM: "kept",
    });
    expect(Object.keys(out).sort()).toEqual(
      ["EXTRA", "GH_TOKEN", "GITHUB_ACTIONS", "GITHUB_TOKEN", "GITLAB", "GIT_AUTHOR_NAME", "HOME", "HTTPS_PROXY", "NODE_AUTH_TOKEN", "NPM", "NPM_TOKEN", "PATH", "SSH_AUTH_SOCK"]
    );
    expect(out.GIT_AUTHOR_NAME).toBe("explicit"); // given by our own code, not inherited
  });

  // Red when: runCommand passes the ambient environment through. The reviewer's trigger:
  // with GIT_DIR pointing at ANOTHER repository, git add and git commit ran there.
  it("with GIT_DIR pointing at another repository, the commit lands in the project and the other is untouched", async () => {
    const other = join(sandbox, "other");
    mkdirSync(other);
    await git(other, "init", "-q");
    const dir = project("mine");

    process.env.GIT_DIR = join(other, ".git");
    const out = JSON.parse(await setupGithub(dir, "demo", "", undefined, gitRunner().run));
    delete process.env.GIT_DIR;

    expect(out.success).toBe(true);
    expect(await hasCommit(dir)).toBe(true);
    expect(await hasCommit(other)).toBe(false);
    expect((await git(other, "status", "--porcelain")).stdout.trim()).toBe("");
    expect((await git(dir, "ls-tree", "-r", "--name-only", "HEAD")).stdout).toContain("package.json");
  });
});

// ---------------------------------------------------------------- 6. repo_name, the tarball, add_tool

describe("6. repo_name, what npm would publish, and add_tool's directory", () => {
  // Red when: repo_name reaches gh unchecked (a leading dash is an option; owner/name
  // creates the repository somewhere else), or stops being passed after "--".
  it("refuses a repo_name that is not a plain repository name, before anything runs", async () => {
    const dir = project("names");
    for (const bad of ["-rf", "--public", "owner/name", "a b", "", ".", "..", "x;y", "x".repeat(101), "name\nnext"]) {
      const { calls, run } = gitRunner();
      const out = JSON.parse(await setupGithub(dir, bad, "", undefined, run));
      expect(out.success, JSON.stringify(bad)).toBe(false);
      expect(out.error).toContain("not a valid repository name");
      expect(calls).toEqual([]);
    }
    const { calls, run } = gitRunner();
    expect(JSON.parse(await setupGithub(dir, "my-repo.v2_x", "A description", undefined, run)).success).toBe(true);
    const create = calls.find((c) => c[0] === "gh" && c[2] === "create")!;
    expect(create.slice(-2)).toEqual(["--", "my-repo.v2_x"]);
    expect(create).toContain("--description=A description");
  });

  /** The real `npm pack`; a fake `npm publish` that records what it was handed. */
  function npmRunner() {
    const calls: string[] = [];
    const published: Array<{ args: string[]; tarballFiles: string[] }> = [];
    const run = async (cmd: string[], opts: { cwd?: string; timeout?: number } = {}): Promise<RunResult> => {
      calls.push(cmd.slice(0, 2).join(" "));
      if (cmd[1] === "publish") {
        // What is in the file that was handed over? (tar lists "package/<path>".)
        const listing = await runCommand(["tar", "-tzf", cmd[2]]);
        published.push({ args: cmd.slice(2), tarballFiles: listing.stdout.split("\n").filter(Boolean).map((l) => l.replace(/^package\//, "")).sort() });
        return fake(cmd, "+ published");
      }
      return runCommand(cmd, { ...opts, env: { npm_config_userconfig: "/dev/null", npm_config_update_notifier: "false" } });
    };
    return { calls, run, published };
  }

  // Red when: publish_package runs `npm publish` without first looking at what the
  // package would contain, or stops refusing a secret-looking file in that list.
  it("publish_package refuses a package that would contain a secret, and publishes a clean one", async () => {
    const clean = project("clean-package");
    const a = npmRunner();
    const ok = JSON.parse(await publishPackage(clean, a.run));
    expect(ok.success).toBe(true);
    expect(ok.filesInPackage).toBeGreaterThan(1);
    expect(a.calls).toEqual(["npm pack", "npm publish"]);
    expect(a.published.length).toBe(1);
    expect(a.published[0].args.length).toBe(2);
    expect(a.published[0].args[0]).toMatch(/clean-package-1\.0\.0\.tgz$/);
    expect(a.published[0].args[1]).toBe("--ignore-scripts");
    expect(a.published[0].tarballFiles).toEqual(["dist/index.js", "package.json"]);
    expect(ok.filesInPackage).toBe(2);
    expect(existsSync(dirname(a.published[0].args[0]))).toBe(false); // the temporary directory is gone

    const leaky = project("leaky-package", { "dist/credentials.json": "{}", "dist/deploy.pem": "k" });
    const b = npmRunner();
    const refused = JSON.parse(await publishPackage(leaky, b.run));
    expect(refused.success).toBe(false);
    expect(refused.error).toContain("dist/credentials.json");
    expect(refused.error).toContain("dist/deploy.pem");
    expect(b.calls).toEqual(["npm pack"]);
  }, 60_000);

  // Red when: a failed or unreadable file list is treated as "nothing to worry about".
  it("publish_package refuses when it cannot get the file list", async () => {
    const dir = project("no-list");
    const noTarball = JSON.stringify([{ filename: "demo-1.0.0.tgz", files: [{ path: "package.json" }] }]); // reported, never written
    for (const answer of [fake(["npm"], "not json"), fake(["npm"], "", false), fake(["npm"], "[]"), fake(["npm"], noTarball)]) {
      const calls: string[] = [];
      const out = JSON.parse(await publishPackage(dir, async (cmd) => { calls.push(cmd.join(" ")); return answer; }));
      expect(out.success).toBe(false);
      expect(out.error).toContain("could not pack the project and list what is in the package");
      expect(calls.some((c) => c.startsWith("npm publish"))).toBe(false);
    }
  });

  // Red when: add_tool skips the project-directory check the other tools make.
  it("add_tool refuses a directory with no package.json, the home directory, and a directory above it", async () => {
    const tool = JSON.stringify({ name: "get_x", description: "d", parameters: [] });
    const tools = JSON.stringify([{ name: "get_weather", description: "d", parameters: [], returns: "r" }]);

    await scaffoldServer("p-mcp", "d", tools, join(sandbox, "ws"));
    const proj = join(sandbox, "ws", "p-mcp");
    rmSync(join(proj, "package.json"));
    const noPkg = JSON.parse(await addTool(proj, tool));
    expect(noPkg.success).toBe(false);
    expect(noPkg.error).toContain("no package.json");

    await scaffoldServer("h-mcp", "d", tools, join(sandbox, "ws2"));
    const home = join(sandbox, "ws2", "h-mcp");
    expect(JSON.parse(await addTool(home, JSON.stringify({ name: "get_a", description: "d", parameters: [] }))).success).toBe(true);
    process.env.HOME = home;
    const atHome = JSON.parse(await addTool(home, tool));
    expect(atHome.success).toBe(false);
    expect(atHome.error).toContain("home directory");
    expect(existsSync(join(home, "src/tools/get-x.ts"))).toBe(false);
  });
});

// ---------------------------------------------------------------- 7. never public

describe("7. the tool never creates a public repository and never pushes to an existing one", () => {
  // Red when: private=false reaches gh as --public again (a model steered by hostile text
  // can pass that argument), or the result stops giving the owner the exact command.
  it("private=false still creates a private repository and says how the owner makes it public", async () => {
    for (const asked of [false, true, undefined]) {
      const dir = project(`vis-${asked}`);
      const { calls, run } = gitRunner();
      const out = JSON.parse(await setupGithub(dir, "demo", "", asked, run));
      const create = calls.find((c) => c[0] === "gh" && c[2] === "create")!;

      expect(out.success).toBe(true);
      expect(create).toContain("--private");
      expect(calls.flat().some((a) => a.startsWith("--public") || a === "--internal")).toBe(false);
      expect(out.private).toBe(true);
      expect(out.visibility).toBe("private");
      expect(out.publicRequestIgnored).toBe(asked === false);
      expect(out.nextSteps).toContain(makePublicSentence("someone/demo"));
    }
    expect(makePublicSentence("someone/demo")).toContain("gh repo edit someone/demo --visibility public --accept-visibility-change-consequences");
    expect(makePublicSentence("someone/demo")).toContain("owner's own step");
  });

  // Red when: the tool pushes to (or tries to create over) a repository that already
  // exists, or does not say that the existing one is public.
  it("refuses when a repository of that name already exists, and says so when it is public", async () => {
    const pub = gitRunner(() => JSON.stringify({ nameWithOwner: "someone/demo", visibility: "PUBLIC" }));
    const outPublic = JSON.parse(await setupGithub(project("exists-public"), "demo", "", undefined, pub.run));
    expect(outPublic.success).toBe(false);
    expect(outPublic.error).toContain("someone/demo, which is PUBLIC");
    expect(outPublic.error).toContain("never pushes to a public repository");
    expect(pub.said("git add -A")).toBe(false);
    expect(pub.said("gh repo create")).toBe(false);

    const priv = gitRunner(() => JSON.stringify({ nameWithOwner: "someone/demo", visibility: "PRIVATE" }));
    const outPrivate = JSON.parse(await setupGithub(project("exists-private"), "demo", "", undefined, priv.run));
    expect(outPrivate.success).toBe(false);
    expect(outPrivate.error).toContain("already exists");
    expect(priv.said("gh repo create")).toBe(false);
  });

  // Red when: a project that already has an origin remote is pushed, or its public
  // remote is not named as the reason.
  it("refuses a project that already has an origin remote, and says so when that remote is public", async () => {
    const dir = project("has-origin");
    await git(dir, "init", "-q");
    await git(dir, "remote", "add", "origin", "https://github.com/someone/old.git");
    const seen: string[] = [];
    const r = gitRunner((repo) => { seen.push(repo); return repo.includes("someone/old") ? JSON.stringify({ nameWithOwner: "someone/old", visibility: "PUBLIC" }) : null; });
    const out = JSON.parse(await setupGithub(dir, "demo", "", undefined, r.run));
    expect(out.success).toBe(false);
    expect(out.error).toContain("already has a remote named origin");
    expect(out.error).toContain("someone/old, which is PUBLIC");
    expect(seen).toEqual(["https://github.com/someone/old.git"]);
    expect(r.said("git add -A")).toBe(false);
    expect(r.said("gh repo create")).toBe(false);
    expect(await hasCommit(dir)).toBe(false);
  });
});

// ---------------------------------------------------------------- 8. the project's own .git

describe("8. setup_github acts only on the project's own .git directory", () => {
  // Red when: "the top level is this directory" is accepted as proof that the repository
  // is this project's own. A linked worktree and a .git that is a link both pass that,
  // and staging or committing there changes ANOTHER repository.
  it("refuses a linked worktree, a .git symlink and a redirected common directory; the other repository is untouched", async () => {
    const main = project("main-repo");
    await git(main, "init", "-q", "-b", "main");
    await git(main, "add", "package.json", ".gitignore");
    await git(main, "commit", "-q", "-m", "base");
    const state = async () => [
      (await git(main, "rev-parse", "HEAD")).stdout.trim(),
      (await git(main, "rev-list", "--all", "--count")).stdout.trim(),
      (await git(main, "status", "--porcelain")).stdout,
    ];

    // (a) a linked worktree: its .git is a FILE pointing into the main repository
    const worktree = join(sandbox, "worktree");
    await git(main, "worktree", "add", "-q", "-b", "wt", worktree);
    writeFileSync(join(worktree, "new.js"), "// new\n");
    const before = await state();
    expect(lstatSync(join(worktree, ".git")).isFile()).toBe(true);
    const a = gitRunner();
    const outA = JSON.parse(await setupGithub(worktree, "demo", "", undefined, a.run));
    expect(outA.success).toBe(false);
    expect(outA.error).toContain("linked worktree");
    expect(a.said("git add")).toBe(false);
    expect(a.said("git commit")).toBe(false);

    // (b) .git is a symbolic link to another repository's git directory
    const linked = project("linked-git");
    symlinkSync(join(main, ".git"), join(linked, ".git"));
    const b = gitRunner();
    const outB = JSON.parse(await setupGithub(linked, "demo", "", undefined, b.run));
    expect(outB.success).toBe(false);
    expect(outB.error).toContain("symbolic link");
    expect(b.said("git add")).toBe(false);

    // (c) a real .git directory whose common directory has been pointed at the main repository
    const redirected = project("redirected");
    await git(redirected, "init", "-q");
    writeFileSync(join(redirected, ".git", "commondir"), join(main, ".git") + "\n");
    const c = gitRunner();
    const outC = JSON.parse(await setupGithub(redirected, "demo", "", undefined, c.run));
    expect(outC.success).toBe(false);
    expect(outC.error).toContain("this project's own repository");
    expect(c.said("git add")).toBe(false);

    expect(await state()).toEqual(before);
  });
});

// ---------------------------------------------------------------- 9. links and second names

describe("9. a write never goes through a link or over a file that has a second name", () => {
  const TOOLS = JSON.stringify([{ name: "get_weather", description: "d", parameters: [], returns: "r" }]);

  // Red when: an existing file is written in place without looking at its link count.
  // src/index.ts here shares its content with a file OUTSIDE the project.
  it("add_tool refuses when src/index.ts is hard-linked elsewhere; the other file keeps its content", async () => {
    await scaffoldServer("hl-mcp", "d", TOOLS, join(sandbox, "ws"));
    const proj = join(sandbox, "ws", "hl-mcp");
    const outsideName = join(sandbox, "outside-index.ts");
    linkSync(join(proj, "src/index.ts"), outsideName);
    const original = readFileSync(outsideName, "utf-8");

    const res = JSON.parse(await addTool(proj, JSON.stringify({ name: "get_x", description: "d", parameters: [] })));
    expect(res.success).toBe(false);
    expect(res.error).toContain("hard-linked");
    expect(readFileSync(outsideName, "utf-8")).toBe(original);
    expect(existsSync(join(proj, "src/tools/get-x.ts"))).toBe(false);
  });

  // Red when: generate_launchguide or the shared writer follows a final link or writes
  // over a hard-linked file.
  it("generate_launchguide refuses a hard-linked LAUNCHGUIDE.md; the writer refuses a final symlink even inside the project", async () => {
    const dir = project("lg");
    writeFileSync(join(sandbox, "shared.md"), "shared");
    linkSync(join(sandbox, "shared.md"), join(dir, "LAUNCHGUIDE.md"));
    const res = JSON.parse(await generateLaunchguide(dir, "lg", "t", "d", "Data", "- f", "tag"));
    expect(res.success).toBe(false);
    expect(res.error).toContain("hard-linked");
    expect(readFileSync(join(sandbox, "shared.md"), "utf-8")).toBe("shared");

    writeFileSync(join(dir, "real.md"), "real");
    symlinkSync(join(dir, "real.md"), join(dir, "alias.md"));
    expect(() => writeProjectFiles(dir, { "alias.md": "x" })).toThrow(UnsafeTargetError);
    expect(readFileSync(join(dir, "real.md"), "utf-8")).toBe("real");
    mkdirSync(join(dir, "a-directory"));
    expect(() => writeProjectFiles(dir, { "a-directory": "x" })).toThrow(UnsafeTargetError);
  });

  // Red when: the writer goes back to writing INTO the existing file (the name would keep
  // its inode), stops replacing an ordinary file, or leaves its temporary file behind.
  it("an ordinary existing file is replaced by a new file under the same name, and nothing temporary is left", async () => {
    const dir = project("plain");
    expect(JSON.parse(await generateLaunchguide(dir, "plain", "first", "d", "Data", "- f", "tag")).success).toBe(true);
    const inodeBefore = lstatSync(join(dir, "LAUNCHGUIDE.md")).ino;
    expect(JSON.parse(await generateLaunchguide(dir, "plain", "second", "d", "Data", "- f", "tag")).success).toBe(true);
    expect(readFileSync(join(dir, "LAUNCHGUIDE.md"), "utf-8")).toContain("## Tagline\nsecond");
    expect(lstatSync(join(dir, "LAUNCHGUIDE.md")).ino).not.toBe(inodeBefore);
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});

// ---------------------------------------------------------------- 10. what a template holds

describe("10. an env template is allowed by name, so its content is checked", () => {
  // Built at run time so that no token-shaped string exists in this file.
  const BODY = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
  const LIVE: Array<[string, string]> = [
    ["sk- API key", "sk" + "-proj-" + BODY],
    ["GitHub token", "gh" + "p_" + BODY],
    ["GitHub token", "gh" + "o_" + BODY],
    ["GitHub fine-grained token", "github" + "_pat_" + BODY + "_" + BODY],
    ["GitLab token", "gl" + "pat-" + BODY.slice(0, 24)],
    ["AWS access key id", "AK" + "IA" + "Q7W3E9R2T5Y8U1I4"],
    ["AWS access key id", "AS" + "IA" + "Q7W3E9R2T5Y8U1I4"],
    ["PyPI token", "py" + "pi-" + BODY + BODY],
    ["npm token", "np" + "m_" + BODY],
    ["Slack token", "xo" + "xb-" + "1234567890-" + BODY.slice(0, 16)],
    ["Slack token", "xo" + "xp-" + "1234567890-" + BODY.slice(0, 16)],
    ["Stripe live key", "sk" + "_live_" + BODY.slice(0, 24)],
    ["Stripe live key", "rk" + "_live_" + BODY.slice(0, 24)],
    ["MCP Marketplace license key", "mcp" + "_live_" + BODY.slice(0, 24)],
    ["private key block", "-----BEGIN " + "OPENSSH PRIVATE KEY-----"],
  ];
  const PLACEHOLDERS = [
    "API_KEY=",
    "API_KEY=changeme",
    "OPENAI_API_KEY=sk" + "-your-api-key-goes-here-please",
    "GITHUB_TOKEN=gh" + "p_" + "x".repeat(36),
    "AWS_ACCESS_KEY_ID=AK" + "IAIOSFODNN7EXAMPLE",
    "NPM_TOKEN=np" + "m_your_token_here",
    "MCP_LICENSE_KEY=mcp" + "_live_your_key_here",
    "STRIPE_KEY=sk" + "_live_",
    "NOTE=task-force-alpha-bravo-charlie-delta-echo-9",
    "# Required: License key from MCP Marketplace",
  ];

  // Red when: a credential prefix is dropped from the list, a placeholder starts to be
  // refused (every scaffold ships a template), or a hit starts carrying the value.
  it("flags a live-shaped value by file, line and kind, never by value; placeholders pass", () => {
    for (const [kind, value] of LIVE) {
      const hits = scanForCredentials(`# comment\nTOKEN=${value}\n`, ".env.example");
      expect(hits, kind).toEqual([{ file: ".env.example", line: 2, kind }]);
      expect(JSON.stringify(hits)).not.toContain(value);
    }
    expect(scanForCredentials(PLACEHOLDERS.join("\n"), ".env.example")).toEqual([]);
  });

  // Red when: setup_github stops reading a template it is about to commit, or its
  // refusal prints the value.
  it("setup_github refuses a template holding a live-shaped value, names file and line, and stages nothing", async () => {
    const value = "gh" + "p_" + BODY;
    const dir = project("leaky-template", { ".env.example": `API_URL=https://example.com\nGITHUB_TOKEN=${value}\n` });
    const { run, said } = gitRunner();
    const res = await setupGithub(dir, "demo", "", undefined, run);
    const out = JSON.parse(res);
    expect(out.success).toBe(false);
    expect(out.error).toContain(".env.example line 2 (GitHub token)");
    expect(res).not.toContain(value);
    expect(said("git add -A")).toBe(false);

    const fine = project("fine-template", { ".env.example": PLACEHOLDERS.join("\n") + "\n" });
    expect(JSON.parse(await setupGithub(fine, "demo", "", undefined, gitRunner().run)).success).toBe(true);
  });

  // Red when: publish_package lets a template with a live-shaped value into the package.
  it("publish_package refuses a packed template holding a live-shaped value", async () => {
    const value = "np" + "m_" + BODY;
    const dir = project("leaky-package-template", { "dist/.env.example": `NPM_TOKEN=${value}\n` });
    const calls: string[] = [];
    const run = async (cmd: string[], opts: { cwd?: string; timeout?: number } = {}): Promise<RunResult> => {
      calls.push(cmd.join(" "));
      if (cmd[1] === "publish") return fake(cmd, "+ published");
      return runCommand(cmd, { ...opts, env: { npm_config_userconfig: "/dev/null", npm_config_update_notifier: "false" } });
    };
    const res = await publishPackage(dir, run);
    expect(JSON.parse(res).success).toBe(false);
    expect(JSON.parse(res).error).toContain("dist/.env.example line 1 (npm token)");
    expect(res).not.toContain(value);
    expect(calls.some((c) => c.startsWith("npm publish"))).toBe(false);
  }, 60_000);
});

// ---------------------------------------------------------------- 11. where a build writes

describe("11. build_package and publish_package do not build into a link", () => {
  // Red when: dist or node_modules may be a link. The build empties its output
  // directory before writing, so a linked dist would empty some other directory.
  it("refuse when dist or node_modules is a symbolic link, and run nothing", async () => {
    const elsewhere = join(sandbox, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "keep.txt"), "keep");
    const calls: string[] = [];
    const run = async (cmd: string[]) => { calls.push(cmd.join(" ")); return fake(cmd, ""); };

    const linkedDist = project("linked-dist");
    rmSync(join(linkedDist, "dist"), { recursive: true });
    symlinkSync(elsewhere, join(linkedDist, "dist"));
    for (const out of [JSON.parse(await buildPackage(linkedDist, run)), JSON.parse(await publishPackage(linkedDist, run))]) {
      expect(out.success).toBe(false);
      expect(out.error).toContain("symbolic link");
    }

    const linkedModules = project("linked-modules");
    symlinkSync(elsewhere, join(linkedModules, "node_modules"));
    expect(JSON.parse(await buildPackage(linkedModules, run)).error).toContain("symbolic link");
    expect(JSON.parse(await publishPackage(linkedModules, run)).error).toContain("symbolic link");

    expect(calls).toEqual([]);
    expect(readFileSync(join(elsewhere, "keep.txt"), "utf-8")).toBe("keep");

    // Control: the same project with real directories goes through.
    const ok = project("real-dirs");
    expect(JSON.parse(await buildPackage(ok, run)).success).toBe(true);
    expect(calls).toEqual(["npm install", "npm run build"]);
  });
});

// ---------------------------------------------------------------- letter case in tool names

describe("tool names that differ only by letter case never share a file", () => {
  // Red when: two such names are accepted in one definition, or add_tool decides "already
  // there" with a lookup that depends on the filesystem being case-insensitive.
  it("two in one definition are refused; add_tool refuses one whose file exists under another case", async () => {
    const t = (name: string) => ({ name, description: "d", parameters: [], returns: "r" });
    expect(validateToolDefs([t("get_x"), t("GET_X")]).ok).toBe(false);
    expect(validateToolDefs([t("getX"), t("getx")]).ok).toBe(false);

    await scaffoldServer("case-mcp", "d", JSON.stringify([t("get_x")]), join(sandbox, "ws"));
    const proj = join(sandbox, "ws", "case-mcp");
    for (const name of ["GET_X", "Get_X", "get-X"]) {
      const res = JSON.parse(await addTool(proj, JSON.stringify(t(name))));
      expect(res.success, name).toBe(false);
      expect(res.error).toContain("already exists");
    }
    expect(readdirSync(join(proj, "src/tools"))).toEqual(["get-x.ts"]);
  });
});

// ---------------------------------------------------------------- confirmation pass

describe("confirmation pass: honest files are not secrets, and what is checked is what is published", () => {
  const HONEST_SOURCE = ["src/credentials.ts", "src/credentialsProvider.ts", "docs/credentials-howto.md"];
  const HONEST_TEMPLATES = [".env.template", ".env.local.example", "config/service-account.example.json"];

  // Red when: "credentials" is matched as a prefix again (source and documentation are
  // refused), a template variant of a secret name stops being recognised as a template,
  // or the real secret names stop being refused.
  it("source files and templates pass by name; the real names are still secrets", () => {
    for (const name of [...HONEST_SOURCE, ...HONEST_TEMPLATES, ".env.example", ".env.sample", ".env.dist", "certs/server.pem.sample", "credentials.example.json", "id_rsa.example"]) {
      expect(looksLikeSecret(name), name).toBe(false);
    }
    for (const name of HONEST_SOURCE) expect(isSecretTemplate(name), name).toBe(false);
    for (const name of [...HONEST_TEMPLATES, ".env.example", "certs/server.pem.sample"]) expect(isSecretTemplate(name), name).toBe(true);

    for (const name of ["credentials.json", "service-account.json", "credentials", "credentials.yml", ".aws/credentials", ".env.production", "example.pem", "sample.key", "template.json.pem"]) {
      expect(looksLikeSecret(name), name).toBe(true);
    }
    for (const name of ["example.pem", "README.md", "src/example.ts", "dist/index.js"]) expect(isSecretTemplate(name), name).toBe(false);
  });

  // Red when: setup_github refuses a project for holding those honest files, in the
  // working tree or in its history (a name in an old commit would block every later push).
  it("setup_github accepts a project with those files, also when they are already in its history", async () => {
    const files = Object.fromEntries([...HONEST_SOURCE, ...HONEST_TEMPLATES].map((f) => [f, "// nothing secret\n"]));
    const fresh = project("honest", files);
    expect(JSON.parse(await setupGithub(fresh, "demo", "", undefined, gitRunner().run)).success).toBe(true);
    const tree = (await git(fresh, "ls-tree", "-r", "--name-only", "HEAD")).stdout.split("\n");
    for (const f of [...HONEST_SOURCE, ...HONEST_TEMPLATES]) expect(tree, f).toContain(f);

    const withHistory = project("honest-history", files);
    await git(withHistory, "init", "-q");
    await git(withHistory, "add", "-A");
    await git(withHistory, "commit", "-q", "-m", "earlier work");
    expect(JSON.parse(await setupGithub(withHistory, "demo", "", undefined, gitRunner().run)).success).toBe(true);
  });

  // Red when: a template is allowed by name without its content being read, or the
  // refusal for a real secret name stops saying that renaming is a way out.
  it("a .env.template holding a token-shaped value is refused by content; a name refusal says rename", async () => {
    const value = "gh" + "p_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    const leaky = project("leaky-env-template", { ".env.template": `API_URL=https://example.com\nGITHUB_TOKEN=${value}\n` });
    const a = gitRunner();
    const res = await setupGithub(leaky, "demo", "", undefined, a.run);
    expect(JSON.parse(res).success).toBe(false);
    expect(JSON.parse(res).error).toContain(".env.template line 2 (GitHub token)");
    expect(res).not.toContain(value);
    expect(a.said("git add -A")).toBe(false);

    const named = JSON.parse(await setupGithub(project("still-refused", { "credentials.json": "{}" }), "demo", "", undefined, gitRunner().run));
    expect(named.success).toBe(false);
    expect(named.error).toContain("credentials.json");
    expect(named.error).toContain("rename them");
  });

  // Red when: a lifecycle script can run between the check and the upload (at pack or at
  // publish), or the upload is anything other than the tarball that was checked. Both
  // scripts here would add a secret-looking file to the package.
  it("publish_package runs no lifecycle script and publishes the exact tarball it checked", async () => {
    const dir = project("scripted");
    const addSecret = `node -e "require('fs').writeFileSync('dist/credentials.json','{}')"`;
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: "@acme/scripted", version: "1.0.0", files: ["dist"],
      scripts: { prepack: addSecret, prepare: addSecret, prepublishOnly: addSecret },
    }));
    const published: Array<{ args: string[]; files: string[] }> = [];
    const run = async (cmd: string[], opts: { cwd?: string; timeout?: number } = {}): Promise<RunResult> => {
      if (cmd[1] === "publish") {
        const listing = await runCommand(["tar", "-tzf", cmd[2]]);
        published.push({ args: cmd.slice(2), files: listing.stdout.split("\n").filter(Boolean).map((l) => l.replace(/^package\//, "")).sort() });
        return fake(cmd, "+ published");
      }
      return runCommand(cmd, { ...opts, env: { npm_config_userconfig: "/dev/null", npm_config_update_notifier: "false" } });
    };
    const out = JSON.parse(await publishPackage(dir, run));

    expect(out.success).toBe(true);
    expect(existsSync(join(dir, "dist", "credentials.json"))).toBe(false); // no script ran
    expect(published.length).toBe(1);
    expect(published[0].args[0]).toMatch(/acme-scripted-1\.0\.0\.tgz$/); // a scoped name still resolves to the real file
    expect(published[0].args.slice(1)).toEqual(["--ignore-scripts"]);
    expect(published[0].files).toEqual(["dist/index.js", "package.json"]);
    expect(out.filesInPackage).toBe(published[0].files.length);
  }, 60_000);
});
