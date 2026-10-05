/**
 * Second hardening round:
 *   1. scaffold_server and add_tool never overwrite.
 *   2. setup_github refuses to commit files that look like secrets (decided by git).
 *   3. Names are validated and free text is escaped before any source is generated.
 *
 * The setup_github tests run REAL git in a temp directory (isolated from the machine's
 * git config) and a FAKE gh, so nothing leaves the machine. Each test names the future
 * change that would turn it red.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";

import { setupGithub } from "../src/tools/setup-github.js";
import { scaffoldServer } from "../src/tools/scaffold-server.js";
import { addTool } from "../src/tools/add-tool.js";
import { runCommand, type RunResult } from "../src/services/subprocess.js";
import { looksLikeSecret } from "../src/services/secret-scan.js";
import { validatePackageName, validateToolDefs } from "../src/services/validate.js";

const TOOL = { name: "get_weather", description: "Get weather", parameters: [{ name: "city", type: "string", required: true, description: "City" }], returns: "JSON" };
const TOOLS = JSON.stringify([TOOL]);

let sandbox: string;

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "ts-mcp-creator-hardening-")));
});
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 1. never overwrite

describe("scaffold_server never overwrites", () => {
  // Red when: the existing-directory check is removed and a second run replaces files again.
  it("refuses a target directory that exists and is not empty, naming it, and changes nothing", async () => {
    expect(JSON.parse(await scaffoldServer("my-mcp", "d", TOOLS, sandbox)).success).toBe(true);
    const dir = join(sandbox, "my-mcp");
    const implemented = "export async function getWeather(city: string) { return `real work for ${city}`; }\n";
    writeFileSync(join(dir, "src/tools/get-weather.ts"), implemented);

    const again = JSON.parse(await scaffoldServer("my-mcp", "d", TOOLS, sandbox));
    expect(again.success).toBe(false);
    expect(again.error).toContain(dir);
    expect(again.error).toContain("already exists and is not empty");
    expect(readFileSync(join(dir, "src/tools/get-weather.ts"), "utf-8")).toBe(implemented);
  });

  // Red when: the check looks for a project marker instead of "not empty", so a folder
  // that is not a project (here: one unrelated file) is written into.
  it("refuses an existing folder that is not a project", async () => {
    const dir = join(sandbox, "notes");
    mkdirSync(dir);
    writeFileSync(join(dir, "README.md"), "my notes");
    const res = JSON.parse(await scaffoldServer("notes", "d", TOOLS, sandbox));
    expect(res.success).toBe(false);
    expect(readFileSync(join(dir, "README.md"), "utf-8")).toBe("my notes");
    expect(existsSync(join(dir, "package.json"))).toBe(false);
  });

  // Red when: the check becomes "exists" and an empty folder the user just made is refused.
  it("still scaffolds into an existing empty directory", async () => {
    mkdirSync(join(sandbox, "fresh-mcp"));
    expect(JSON.parse(await scaffoldServer("fresh-mcp", "d", TOOLS, sandbox)).success).toBe(true);
    expect(existsSync(join(sandbox, "fresh-mcp", "src/index.ts"))).toBe(true);
  });
});

describe("add_tool never replaces an existing tool", () => {
  // Red when: add_tool writes the tool file without checking that it is new. Both
  // spellings map to the same file (get-weather.ts), so both must be refused.
  it("refuses a tool whose file already exists and leaves the implementation and index.ts alone", async () => {
    await scaffoldServer("my-mcp", "d", TOOLS, sandbox);
    const dir = join(sandbox, "my-mcp");
    const implemented = "export async function getWeather(city: string) { return `real work for ${city}`; }\n";
    writeFileSync(join(dir, "src/tools/get-weather.ts"), implemented);
    const indexBefore = readFileSync(join(dir, "src/index.ts"), "utf-8");

    for (const name of ["get_weather", "get-weather"]) {
      const res = JSON.parse(await addTool(dir, JSON.stringify({ ...TOOL, name })));
      expect(res.success, name).toBe(false);
      expect(res.error).toContain("already exists");
      expect(res.error).toContain(join(dir, "src/tools/get-weather.ts"));
    }
    expect(readFileSync(join(dir, "src/tools/get-weather.ts"), "utf-8")).toBe(implemented);
    expect(readFileSync(join(dir, "src/index.ts"), "utf-8")).toBe(indexBefore);
  });

  // Red when: the no-overwrite check blocks the supported way to extend a project.
  it("still adds a new tool to an existing project", async () => {
    await scaffoldServer("my-mcp", "d", TOOLS, sandbox);
    const dir = join(sandbox, "my-mcp");
    const res = JSON.parse(await addTool(dir, JSON.stringify({ ...TOOL, name: "get_forecast" })));
    expect(res.success).toBe(true);
    expect(existsSync(join(dir, "src/tools/get-forecast.ts"))).toBe(true);
  });
});

// ---------------------------------------------------------------- 2. secrets

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

/** Real git, fake gh. `beforeAdd` runs just before `git add -A`, to stand in for a race. */
function gitRunner(beforeAdd?: () => void) {
  const calls: string[] = [];
  const run = async (cmd: string[], opts: { cwd?: string; timeout?: number } = {}): Promise<RunResult> => {
    calls.push(cmd.join(" "));
    if (cmd[0] === "gh") {
      if (cmd[1] === "repo" && cmd[2] === "view") {
        return { success: false, command: cmd.join(" "), stdout: "", stderr: "not found", returnCode: 1 };
      }
      const stdout = cmd[1] === "repo" ? "https://github.com/someone/demo\n" : "gh version test\n";
      return { success: true, command: cmd.join(" "), stdout, stderr: "", returnCode: 0 };
    }
    if (cmd.join(" ") === "git add -A") beforeAdd?.();
    return runCommand(cmd, { ...opts, env: GIT_VARS });
  };
  return { calls, run };
}

/** A scaffold-shaped project. `ignore` is the .gitignore content; `files` are extra files. */
function project(name: string, files: Record<string, string> = {}, ignore = "node_modules/\ndist/\n.env\n"): string {
  const dir = join(sandbox, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
  writeFileSync(join(dir, ".gitignore"), ignore);
  writeFileSync(join(dir, "index.js"), "// code\n");
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

const committed = async (dir: string) => (await git(dir, "ls-tree", "-r", "--name-only", "HEAD")).stdout.split("\n").filter(Boolean);
const staged = async (dir: string) => (await git(dir, "diff", "--cached", "--name-only")).stdout.split("\n").filter(Boolean);
const hasCommit = async (dir: string) => (await git(dir, "rev-parse", "--verify", "-q", "HEAD")).success;

describe("setup_github refuses to commit files that look like secrets", () => {
  // Red when: a normal project can no longer be staged, committed and handed to gh.
  it("commits and creates the repo when there is nothing secret-looking", async () => {
    const dir = project("clean");
    const { calls, run } = gitRunner();
    const out = JSON.parse(await setupGithub(dir, "demo", "", undefined, run));
    expect(out.success).toBe(true);
    expect(await committed(dir)).toEqual([".gitignore", "index.js", "package.json"]);
    expect(calls.filter((c) => c.startsWith("gh repo create")).length).toBe(1);
  });

  // Red when: a name pattern is dropped from the list, the tree walk stops descending,
  // or check 1 is removed (the file would then be staged: `git add -A` appears in calls).
  it.each([
    ".env",
    ".env.production",
    "config/server.pem",
    "deep/a/b/private.key",
    "keys/id_rsa",
    "keys/id_ed25519.pub",
    ".npmrc",
    "tools/.pypirc",
  ])("refuses %s when git would add it, names it, and stages nothing", async (secret) => {
    const dir = project("has-secret", { [secret]: "TOKEN=abc" }, "node_modules/\ndist/\n");
    const { calls, run } = gitRunner();
    const out = JSON.parse(await setupGithub(dir, "demo", "", undefined, run));

    expect(out.success).toBe(false);
    expect(out.error).toContain(secret);
    expect(out.error).toContain("add them to .gitignore or delete them");
    expect(out.error).toContain("rename them");
    expect(calls).not.toContain("git add -A");
    expect(calls.some((c) => c.startsWith("gh repo create"))).toBe(false);
    expect(await staged(dir)).toEqual([]);
    expect(await hasCommit(dir)).toBe(false);
  });

  // Red when: the template exceptions are removed and every scaffold (which ships
  // .env.example) is refused.
  it("allows .env.example and .env.sample", async () => {
    const dir = project("templates", { ".env.example": "KEY=", "docs/.env.sample": "KEY=" });
    const out = JSON.parse(await setupGithub(dir, "demo", "", undefined, gitRunner().run));
    expect(out.success).toBe(true);
    expect(await committed(dir)).toEqual(expect.arrayContaining([".env.example", "docs/.env.sample"]));
  });

  // Red when: an ignored secret is refused anyway (the tool would be unusable for any
  // project with a real .env), or an ignored file ends up committed.
  it("accepts a secret-looking file that .gitignore excludes, and does not commit it", async () => {
    const dir = project("ignored", { ".env": "TOKEN=abc", "certs/tls.key": "k" }, "node_modules/\n.env\n*.key\n");
    const out = JSON.parse(await setupGithub(dir, "demo", "", undefined, gitRunner().run));
    expect(out.success).toBe(true);
    expect(await committed(dir)).toEqual([".gitignore", "index.js", "package.json"]);
  });

  // Red when: "ignored" is decided by reading .gitignore here instead of asking git.
  // The file is excluded only by .git/info/exclude, which .gitignore does not mention.
  it("asks git: a file excluded only by .git/info/exclude is accepted", async () => {
    const dir = project("info-exclude", { "local.key": "k" });
    await git(dir, "init", "-q");
    writeFileSync(join(dir, ".git/info/exclude"), "local.key\n");
    const out = JSON.parse(await setupGithub(dir, "demo", "", undefined, gitRunner().run));
    expect(out.success).toBe(true);
    expect(await committed(dir)).not.toContain("local.key");
  });

  // Red when: the check before staging switches to `--no-index` or to pattern matching.
  // .gitignore lists *.key, but this file is already tracked, so git commits it
  // regardless; only the index-aware question gets that right BEFORE anything is staged.
  // (With the wrong question the check after staging still refuses, but only after
  // `git add -A` has run, which is what the last assertion separates.)
  it("asks git: a file that is already tracked is refused before staging even though .gitignore lists it", async () => {
    const dir = project("tracked", { "old.key": "k" }, "node_modules/\n*.key\n");
    await git(dir, "init", "-q");
    await git(dir, "add", "-f", "old.key");
    const { calls, run } = gitRunner();
    const out = JSON.parse(await setupGithub(dir, "demo", "", undefined, run));
    expect(out.success).toBe(false);
    expect(out.error).toContain("old.key");
    expect(calls.some((c) => c.startsWith("git commit"))).toBe(false);
    expect(calls).not.toContain("git add -A");
  });

  // Red when: check 2 (after staging) is removed. Check 1 skips node_modules by design,
  // and node_modules is ignored, so a file that was force-added there is seen only when
  // the index is listed after staging.
  it("check after staging: refuses and unstages a secret that check 1 did not see", async () => {
    const dir = project("tracked-in-modules", { "node_modules/pkg/.npmrc": "//registry/:_authToken=abc" });
    await git(dir, "init", "-q");
    await git(dir, "add", "-f", "node_modules/pkg/.npmrc");
    const { calls, run } = gitRunner();
    const out = JSON.parse(await setupGithub(dir, "demo", "", undefined, run));

    expect(calls).toContain("git add -A"); // check 1 passed, so this is check 2 refusing
    expect(out.success).toBe(false);
    expect(out.error).toContain("node_modules/pkg/.npmrc");
    expect(out.error).toContain("unstaged");
    expect(await staged(dir)).not.toContain("node_modules/pkg/.npmrc");
    expect(await hasCommit(dir)).toBe(false);
    expect(calls.some((c) => c.startsWith("git commit") || c.startsWith("gh repo create"))).toBe(false);
  });

  // Red when: check 2 is removed or runs before staging. The file does not exist during
  // check 1 and appears just before `git add -A`, as a file created in between would.
  it("check after staging: refuses and unstages a secret created between the check and git add", async () => {
    const dir = project("race");
    const { calls, run } = gitRunner(() => writeFileSync(join(dir, "late.pem"), "key"));
    const out = JSON.parse(await setupGithub(dir, "demo", "", undefined, run));

    expect(out.success).toBe(false);
    expect(out.error).toContain("late.pem");
    expect(await staged(dir)).not.toContain("late.pem");
    expect(await staged(dir)).toContain("package.json"); // only the secret was unstaged
    expect(await hasCommit(dir)).toBe(false);
    expect(calls.some((c) => c.startsWith("gh repo create"))).toBe(false);
  });

  // Red when: a pattern is loosened or tightened by accident (the near-misses matter:
  // source files and templates must not be refused).
  it("name rules: secrets match, near-misses do not", () => {
    for (const yes of [".env", ".ENV", ".env.local", "a/b/.env.production", "x.pem", "x.KEY", "id_rsa", "id_rsa.pub", "id_ed25519", ".npmrc", ".pypirc", ".netrc", "cert.p12"]) {
      expect(looksLikeSecret(yes), yes).toBe(true);
    }
    for (const no of [".env.example", ".env.sample", "docs/.env.example", "keyboard.ts", "my.keys", "env.ts", ".environment", "pem.md", "npmrc.md", "README.md"]) {
      expect(looksLikeSecret(no), no).toBe(false);
    }
  });
});

// ---------------------------------------------------------------- 3. names and free text

describe("names are validated before anything is generated", () => {
  // Red when: the package-name rule is loosened to admit a character that can leave a
  // string literal, a path segment or a shell word.
  it("package names: plain names pass, everything else is refused", () => {
    for (const ok of ["my-weather-mcp", "@scope/name", "a.b_c-1", "x"]) {
      expect(validatePackageName(ok).ok, ok).toBe(true);
    }
    for (const bad of ["My-Pkg", 'a"b', "a b", "a\nb", "`x`", "${x}", "a/b/c", "@scope", "-lead", ".hidden", "a;b", "a$(id)", "", "x".repeat(215)]) {
      expect(validatePackageName(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  // Red when: the tool-name rule admits a character that is not safe in an identifier,
  // a file name or an import path, or stops rejecting names that break the generated file.
  it("tool names: identifier-safe names pass, everything else is refused", () => {
    const def = (name: unknown) => [{ ...TOOL, name }];
    for (const ok of ["get_weather", "get-weather", "GetWeather2", "a"]) {
      expect(validateToolDefs(def(ok)).ok, ok).toBe(true);
    }
    for (const bad of ["get weather", "1abc", 'a"b', "a;b", "a`b", "../x", "a.b", "_lead", "delete", "server", "z", "", "x".repeat(65), 7]) {
      expect(validateToolDefs(def(bad)).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  // Red when: two tools that generate the same file or function are both accepted
  // (the second would silently replace the first), or parameter names stop being checked.
  it("refuses clashing tools and unsafe parameter names", () => {
    expect(validateToolDefs([{ ...TOOL, name: "get_weather" }, { ...TOOL, name: "get-weather" }]).ok).toBe(false);
    expect(validateToolDefs([{ ...TOOL, name: "GetX" }, { ...TOOL, name: "getx" }]).ok).toBe(false);
    const withParam = (name: unknown, type: unknown = "string") => [{ ...TOOL, parameters: [{ name, type, description: "d" }] }];
    expect(validateToolDefs(withParam("city_name")).ok).toBe(true);
    for (const bad of ["a-b", "x y", "class", "result", "1a", 'a"b', "a}) => { process.exit(7) //"]) {
      expect(validateToolDefs(withParam(bad)).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(validateToolDefs(withParam("city", 5)).ok).toBe(false);
    expect(validateToolDefs([{ ...TOOL, parameters: [{ name: "a", type: "string", description: "d" }, { name: "a", type: "string", description: "d" }] }]).ok).toBe(false);
  });

  // Red when: validation runs after files are written, or scaffold_server / add_tool stop calling it.
  it("scaffold_server and add_tool refuse a bad name and write nothing", async () => {
    const badPkg = JSON.parse(await scaffoldServer('evil";process.exit(7);//', "d", TOOLS, sandbox));
    expect(badPkg.success).toBe(false);
    expect(badPkg.error).toContain("not a valid package name");

    const badTool = JSON.parse(await scaffoldServer("ok-mcp", "d", JSON.stringify([{ ...TOOL, name: 'x"; process.exit(7); //' }]), sandbox));
    expect(badTool.success).toBe(false);
    expect(existsSync(join(sandbox, "ok-mcp"))).toBe(false);

    const badVar = JSON.parse(await scaffoldServer("ok-mcp", "d", TOOLS, sandbox, JSON.stringify([{ name: "A=1\nB", description: "d" }])));
    expect(badVar.success).toBe(false);
    expect(existsSync(join(sandbox, "ok-mcp"))).toBe(false);

    await scaffoldServer("ok-mcp", "d", TOOLS, sandbox);
    const dir = join(sandbox, "ok-mcp");
    const indexBefore = readFileSync(join(dir, "src/index.ts"), "utf-8");
    const badAdd = JSON.parse(await addTool(dir, JSON.stringify({ ...TOOL, name: "x y" })));
    expect(badAdd.success).toBe(false);
    expect(readFileSync(join(dir, "src/index.ts"), "utf-8")).toBe(indexBefore);
  });
});

/** Every character that ends or alters one of the contexts a description lands in. */
const HOSTILE =
  'say "hi" \\ two\\\\ `tick` ${process.exit(7)} */ process.exit(7); /* \'q\' \\" end\\' +
  "\nline two\r\nline three \u2028 sep </script> | pipe # hash";

/**
 * Parse generated TypeScript; returns the AST and its syntax errors AS MESSAGE STRINGS.
 * (A raw diagnostic holds the whole source file; handing one to expect() makes the
 * failure report so large that the test worker runs out of memory instead of failing.)
 */
function parse(code: string) {
  const sf = ts.createSourceFile("generated.ts", code, ts.ScriptTarget.ES2022, true);
  const errors = (ts.transpileModule(code, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).diagnostics ?? [])
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
  const nodes: ts.Node[] = [];
  const visit = (n: ts.Node) => { nodes.push(n); n.forEachChild(visit); };
  visit(sf);
  return { sf, errors, nodes };
}
/** Values of every `description: "..."` property that is a plain string literal. */
const descriptionLiterals = (nodes: ts.Node[]) =>
  nodes.filter(ts.isPropertyAssignment).filter((p) => p.name.getText() === "description").map((p) => (ts.isStringLiteral(p.initializer) ? p.initializer.text : "<<not a string literal>>"));
/** Values of the first argument of every `.describe("...")` call. */
const describeLiterals = (nodes: ts.Node[]) =>
  nodes.filter(ts.isCallExpression).filter((c) => ts.isPropertyAccessExpression(c.expression) && c.expression.name.text === "describe").map((c) => (ts.isStringLiteral(c.arguments[0]) ? (c.arguments[0] as ts.StringLiteral).text : "<<not a string literal>>"));
/** Any `something.exit` in the code: the payload's process.exit(7) would show up here. */
const exitAccesses = (nodes: ts.Node[]) => nodes.filter(ts.isPropertyAccessExpression).filter((p) => p.name.text === "exit").length;

describe("free text cannot change the generated code", () => {
  const hostileTool = { name: "get_weather", description: HOSTILE, returns: HOSTILE, parameters: [{ name: "city", type: "string", required: true, description: HOSTILE }] };

  async function scaffoldHostile() {
    const res = JSON.parse(await scaffoldServer("hostile-mcp", HOSTILE, JSON.stringify([hostileTool]), sandbox, JSON.stringify([{ name: "API_KEY", description: HOSTILE, required: true }])));
    expect(res.success).toBe(true);
    const dir = join(sandbox, "hostile-mcp");
    return { dir, read: (rel: string) => readFileSync(join(dir, rel), "utf-8") };
  }

  // Red when: a description is put into a string literal with anything weaker than a
  // full literal encoder (the old code escaped only double quotes).
  it("string literal context: the generated strings equal the input and the file still parses", async () => {
    const { read } = await scaffoldHostile();
    const { errors, nodes } = parse(read("src/index.ts"));
    expect(errors).toEqual([]);
    expect(descriptionLiterals(nodes)).toEqual([HOSTILE]);
    expect(describeLiterals(nodes)).toEqual([HOSTILE]);
    expect(exitAccesses(nodes)).toBe(0);
  });

  // Red when: a description or "returns" text can close the block comment in a tool module.
  it("block comment context: the tool module is still exactly one function", async () => {
    const { read } = await scaffoldHostile();
    const { sf, errors, nodes } = parse(read("src/tools/get-weather.ts"));
    expect(errors).toEqual([]);
    expect(sf.statements.length).toBe(1);
    expect(ts.isFunctionDeclaration(sf.statements[0])).toBe(true);
    expect(exitAccesses(nodes)).toBe(0);
  });

  // Red when: add_tool's registration (a separate template) loses the same escaping.
  it("add_tool: same guarantee for the injected registration and the new tool module", async () => {
    const { dir, read } = await scaffoldHostile();
    expect(JSON.parse(await addTool(dir, JSON.stringify({ ...hostileTool, name: "get_alerts" }))).success).toBe(true);
    const index = parse(read("src/index.ts"));
    expect(index.errors).toEqual([]);
    expect(descriptionLiterals(index.nodes)).toEqual([HOSTILE, HOSTILE]);
    expect(describeLiterals(index.nodes)).toEqual([HOSTILE, HOSTILE]);
    expect(exitAccesses(index.nodes)).toBe(0);
    const mod = parse(read("src/tools/get-alerts.ts"));
    expect(mod.errors).toEqual([]);
    expect(mod.sf.statements.length).toBe(1);
  });

  // Red when: package.json stops being built with a JSON encoder.
  it("JSON context: package.json description equals the input", async () => {
    const { read } = await scaffoldHostile();
    expect(JSON.parse(read("package.json")).description).toBe(HOSTILE);
  });

  // Red when: a line break in an env var description can start a new line in the env
  // file, which would let a description add its own NAME=value assignment.
  it("env file context: a description cannot add an assignment line", async () => {
    const { read } = await scaffoldHostile();
    const lines = read(".env.example").split("\n");
    const assignments = lines.filter((l) => l !== "" && !l.startsWith("#"));
    expect(assignments).toEqual(["API_KEY="]);
  });

  // Red when: a line break or "|" in a tool description can break out of its table row.
  it("markdown table context: the tool row stays one row with two cells", async () => {
    const { read } = await scaffoldHostile();
    const rows = read("README.md").split("\n").filter((l) => l.startsWith("| `get_weather` |"));
    expect(rows.length).toBe(1);
    const unescapedPipes = rows[0].replace(/\\\|/g, "").split("|").length - 1;
    expect(unescapedPipes).toBe(3);
  });
});
