/**
 * Generator correctness.
 *
 * One property, checked over a grid of several hundred definitions:
 *
 *     a definition is either REFUSED by validation, or the project generated
 *     from it TYPE-CHECKS under the generated project's own strict settings.
 *
 * The grid is built from adversarial-but-plausible inputs: names at the length
 * limits, every parameter type, required / optional / omitted in every order,
 * hyphen and underscore mixes, scoped and unscoped package names, and every
 * identifier the templates themselves emit (harvested from generated files at
 * run time, so a template change extends the grid by itself), offered both as a
 * tool name and as a parameter name.
 *
 * All projects are type-checked in ONE TypeScript program. By default the MCP SDK
 * packages are replaced by a small stand-in (declared below) while zod, vitest and
 * the Node types are the real ones from this repo's node_modules. Set
 * MCP_GRID_REAL_DEPS to a directory whose node_modules holds a generated
 * project's real dependencies to check against the real SDK instead.
 *
 * Each test names the future change that would turn it red.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { scaffoldServer } from "../src/tools/scaffold-server.js";
import { addTool } from "../src/tools/add-tool.js";
import { KNOWN_PARAM_TYPES, dockerImageName, renderReadme, type ToolDef } from "../src/services/codegen.js";
import { importedBindings, validateToolDefs } from "../src/services/validate.js";
import { HOSTILE_EVERYTHING, HOSTILE_INSTALL, blockStarts, links } from "./helpers/markdown-structure.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REAL_DEPS = process.env.MCP_GRID_REAL_DEPS;
const DEPS_ROOT = REAL_DEPS ?? REPO;

/** Stand-in for the MCP SDK packages (default mode). zod's real types drive the handler's argument type. */
const SDK_STAND_IN = `
declare module "@modelcontextprotocol/server" {
  import type { z } from "zod";
  type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
  export class McpServer {
    constructor(info: { name: string; version: string });
    registerTool<S extends z.ZodType>(
      name: string,
      config: { description?: string; inputSchema: S },
      cb: (args: z.infer<S>) => ToolResult | Promise<ToolResult>
    ): void;
    connect(transport: unknown): Promise<void>;
  }
  export function createMcpHandler(factory: () => McpServer): (request: unknown) => unknown;
}
declare module "@modelcontextprotocol/server/stdio" {
  import type { McpServer } from "@modelcontextprotocol/server";
  export function serveStdio(factory: () => McpServer): void;
}
declare module "@modelcontextprotocol/node" {
  export function toNodeHandler(handler: unknown): (req: unknown, res: unknown, body?: unknown) => void;
}
declare module "@modelcontextprotocol/express" {
  export function createMcpExpressApp(options: { host: string; allowedHosts: string[] }): {
    all(path: string, handler: (req: { body: unknown }, res: unknown) => unknown): void;
    listen(port: number, host: string, cb: () => void): void;
  };
}
declare module "@mcp_marketplace/license" {
  export function withLicense(server: unknown, options: { slug: string }): void;
}
`;

// ---------------------------------------------------------------- building the grid

type Param = { name: unknown; type?: unknown; required?: unknown; description: string };
const param = (name: unknown, type: unknown = "string", required?: unknown): Param =>
  required === undefined ? { name, type, description: "d" } : { name, type, required, description: "d" };
const tool = (name: unknown, parameters: Param[] = [param("city")]) => ({ name, description: "d", parameters, returns: "r" });

let work: string;
let nextId = 0;
const stats: Record<string, { offered: number; refused: number; accepted: number }> = {};
/** project id -> its .ts files (absolute). */
const projects = new Map<string, string[]>();
/** project id -> type errors. Filled once, by the single type-check in beforeAll. */
const failures = new Map<string, string[]>();
/** Named projects the per-finding tests look at. */
const named: Record<string, { id: string; dir: string; result: Record<string, unknown> }> = {};

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const abs = join(d, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (abs.endsWith(".ts")) out.push(abs);
    }
  };
  for (const sub of ["src", "tests"]) if (existsSync(join(dir, sub))) walk(join(dir, sub));
  return out;
}

/** Offer one definition to scaffold_server. Refused or accepted; accepted projects are type-checked later. */
async function offer(section: string, pkg: string, tools: unknown[], opts: { hosting?: string; paid?: boolean; name?: string; description?: string } = {}) {
  const s = (stats[section] ??= { offered: 0, refused: 0, accepted: 0 });
  s.offered++;
  const id = `p${nextId++}`;
  const out = join(work, id);
  const result = JSON.parse(await scaffoldServer(pkg, opts.description ?? "d", JSON.stringify(tools), out, undefined, opts.paid, opts.hosting ?? "local"));
  if (result.success) {
    s.accepted++;
    projects.set(id, tsFilesUnder(join(out, pkg)));
  } else {
    s.refused++;
  }
  if (opts.name) named[opts.name] = { id, dir: join(out, pkg), result };
  return result;
}

/** Every identifier that appears anywhere in a generated TypeScript file. */
function identifiersIn(files: string[]): Set<string> {
  const found = new Set<string>();
  for (const file of files) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf-8"), ts.ScriptTarget.ES2022, true);
    const visit = (n: ts.Node) => { if (ts.isIdentifier(n)) found.add(n.text); n.forEachChild(visit); };
    visit(sf);
  }
  return found;
}

/** Type-check every file in ONE program; returns project id -> messages. */
function typecheck(files: string[], extraRoots: string[]): Map<string, string[]> {
  const program = ts.createProgram([...extraRoots, ...files], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
    types: ["node"],
    typeRoots: [join(DEPS_ROOT, "node_modules", "@types")],
  });
  const byProject = new Map<string, string[]>();
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const message = ts.flattenDiagnosticMessageText(d.messageText, " ");
    let id = "(program)";
    let where = "";
    if (d.file) {
      const rel = relative(work, d.file.fileName);
      if (rel.startsWith("..")) continue; // a dependency's own file, not ours
      id = rel.split(sep)[0];
      const { line } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
      where = `${rel.split(sep).slice(-2).join("/")}:${line + 1} `;
    }
    byProject.set(id, [...(byProject.get(id) ?? []), `${where}TS${d.code} ${message}`.slice(0, 220)]);
  }
  return byProject;
}

const LIMIT_TOOL = "t" + "x".repeat(63); // 64 characters, the limit
const LIMIT_PARAM = "p" + "x".repeat(63);
const LIMIT_PACKAGE = "x".repeat(214);
const LIMIT_SCOPED = "@s/" + "y".repeat(211);
const PACKAGES = ["a", "my-weather-mcp", "@acme/weather", "a.b_c-1", "0start", "@a0/b.c_d-e", LIMIT_PACKAGE, LIMIT_SCOPED];

const JS_WORDS = [
  "arguments", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else",
  "enum", "eval", "export", "extends", "false", "finally", "for", "function", "if", "implements", "import", "in", "instanceof",
  "interface", "let", "new", "null", "package", "private", "protected", "public", "return", "static", "super", "switch", "this",
  "throw", "true", "try", "typeof", "undefined", "var", "void", "while", "with", "yield",
];
/** Not reserved by the language, but each has a meaning somewhere in TypeScript or the runtime. */
const LOADED_WORDS = [
  "type", "as", "of", "from", "async", "get", "set", "any", "string", "number", "boolean", "object", "unknown", "never", "symbol",
  "bigint", "module", "require", "exports", "global", "globalThis", "NaN", "Infinity", "Object", "Array", "Number", "Symbol", "Map",
  "Set", "Date", "Math", "Reflect", "Proxy", "Function", "RegExp", "name", "length", "self", "window", "document", "fetch",
  "setTimeout", "Buffer", "abstract", "declare", "readonly", "namespace", "is", "keyof", "infer", "satisfies", "accessor", "using",
  "override", "out", "asserts", "unique", "target", "meta", "Promise", "JSON", "Error", "String", "Boolean", "describe", "it", "expect",
];
const TOOL_SHAPES = [
  "a", "A", "get_weather", "get-weather", "get__weather", "get--weather", "get-_weather", "get_", "get-", "g-e-t", "GetWeather",
  "getWeather", "get_weather_2", "get2_fa", "a_1", "X9", "a-b_c-d_e", LIMIT_TOOL, "t" + "-x".repeat(31) + "y",
];
const PARAM_SHAPES = ["a", "A", "_", "__", "_a", "a1", "city_name", "cityName", "CITY", "a_b_c", LIMIT_PARAM];
const PAIR_NAMES = [
  "get_weather", "get-weather", "get__weather", "getWeather", "GetWeather", "get_Weather", "getweather", "GETWEATHER",
  "get_weather_", "get-weather-2", "get_weather2", "weather_get",
];
const REQUIRED_STATES = [true, false, undefined] as const;

/** Every sequence of `states` of the given length. */
function sequences<T>(states: readonly T[], length: number): T[][] {
  if (length === 0) return [[]];
  return sequences(states, length - 1).flatMap((head) => states.map((s) => [...head, s]));
}

let harvested: string[] = [];
let addToolStats = { offered: 0, refused: 0, accepted: 0 };
let controlMessages: string[] = [];

beforeAll(async () => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "ts-mcp-creator-grid-")));
  // Generated files resolve zod, vitest and the Node types by walking up to this link.
  symlinkSync(join(DEPS_ROOT, "node_modules"), join(work, "node_modules"), "dir");

  // --- The nine reported inputs, kept as named projects.
  await offer("reported inputs", "f4-mcp", [tool("echo", [{ name: "value", type: "string", description: "d" }])], { name: "omittedRequired" });
  await offer("reported inputs", "f4b-mcp", [tool("echo", [param("value", "string", false)])], { name: "explicitOptional" });
  await offer("reported inputs", "f7-mcp", [tool("echo", [param("first", "string", false), param("second", "string", true)])], { name: "optionalThenRequired" });
  await offer("reported inputs", "@acme/weather", [tool("get_weather")], { hosting: "remote", name: "scopedRemote" });
  await offer("reported inputs", "@acme/weather", [tool("get_weather")], { hosting: "local", name: "scopedLocal" });

  // --- Harvest: every identifier the templates emit, from one project of each variant.
  const seedFiles: string[] = [];
  for (const [hosting, paid] of [["local", false], ["remote", false], ["local", true], ["remote", true]] as const) {
    const r = await offer("seed variants", "seed-mcp", [tool("get_weather", [param("city"), param("units", "string", false)])], { hosting, paid });
    seedFiles.push(...tsFilesUnder(join(work, `p${nextId - 1}`, "seed-mcp")));
    expect(r.success).toBe(true);
  }
  harvested = [...identifiersIn(seedFiles)].sort();

  // --- 0. Hostile free text in EVERY free-text field (server, tool, parameter, returns), all four variants.
  const freeText = (text: string) => [{ name: "get_weather", description: text, returns: text, parameters: [{ name: "city", type: "string", description: text }] }];
  for (const [hosting, paid] of [["local", false], ["remote", false], ["local", true], ["remote", true]] as const) {
    const key = `${hosting}-${paid}`;
    await offer("hostile free text x variants", "text-mcp", freeText("PLAIN"), { hosting, paid, description: "PLAIN", name: `text-plain-${key}` });
    await offer("hostile free text x variants", "text-mcp", freeText(HOSTILE_INSTALL), { hosting, paid, description: HOSTILE_INSTALL, name: `text-install-${key}` });
    await offer("hostile free text x variants", "text-mcp", freeText(HOSTILE_EVERYTHING), { hosting, paid, description: HOSTILE_EVERYTHING, name: `text-everything-${key}` });
  }

  // --- 1. Package names x the four variants.
  for (const pkg of PACKAGES) {
    for (const [hosting, paid] of [["local", false], ["remote", false], ["local", true], ["remote", true]] as const) {
      await offer("package names x variants", pkg, [tool("get_weather")], { hosting, paid });
    }
  }

  // --- 2. Tool names: shapes, language words, loaded words, Object.prototype members, harvested identifiers.
  const toolCandidates = [...new Set([...TOOL_SHAPES, ...JS_WORDS, ...LOADED_WORDS, ...Object.getOwnPropertyNames(Object.prototype), "prototype", ...harvested])];
  for (const name of toolCandidates) {
    await offer("tool names", "grid-mcp", [tool(name, [param("city"), param("units", "string", false)])]);
  }

  // --- 3. Parameter names: the same sources, plus the tool's own function name.
  const paramCandidates = [...new Set([...PARAM_SHAPES, ...JS_WORDS, ...LOADED_WORDS, ...Object.getOwnPropertyNames(Object.prototype), "prototype", "echo", ...harvested])];
  for (const name of paramCandidates) {
    await offer("parameter names", "grid-mcp", [tool("echo", [param(name), param("other", "integer", false)])]);
  }

  // --- 4. Every parameter type (and case variants, and types that must be refused) x required / optional / omitted.
  const types = [...KNOWN_PARAM_TYPES, "String", "INT", "Bool", "__proto__", "constructor", "toString", "array", "object", "any", ""];
  for (const type of types) {
    for (const required of REQUIRED_STATES) {
      await offer("types x required", "grid-mcp", [tool("echo", [param("value", type, required)])]);
    }
  }
  await offer("types x required", "grid-mcp", [tool("echo", [{ name: "value", description: "d" }])]); // no type at all
  await offer("types x required", "grid-mcp", [tool("echo", [param("value", 5)])]);
  await offer("types x required", "grid-mcp", [tool("echo", [param("value", "string", "false")])]); // required as a string

  // --- 5. required / optional / omitted in EVERY order, for 1 to 4 parameters, types rotating.
  let rotate = 0;
  for (const length of [1, 2, 3, 4]) {
    for (const seq of sequences(REQUIRED_STATES, length)) {
      const params = seq.map((required, i) => param(`p${i}`, KNOWN_PARAM_TYPES[rotate++ % KNOWN_PARAM_TYPES.length], required));
      await offer("required orders", "grid-mcp", [tool("echo", params)]);
    }
  }

  // --- 6. Two tools in one project: every pair of names that are close to each other.
  for (let i = 0; i < PAIR_NAMES.length; i++) {
    for (let j = i + 1; j < PAIR_NAMES.length; j++) {
      await offer("tool pairs", "grid-mcp", [tool(PAIR_NAMES[i]), tool(PAIR_NAMES[j], [param("region", "bool", false), param("days", "int")])]);
    }
  }

  // --- 7. add_tool: every tool-name candidate added, one after another, to ONE project.
  await offer("add_tool base", "base-mcp", [tool("get_weather")], { name: "addToolBase" });
  const baseDir = named.addToolBase.dir;
  const orders = sequences(REQUIRED_STATES, 3);
  let n = 0;
  for (const name of [...new Set([...PAIR_NAMES, ...toolCandidates])]) {
    const params = orders[n++ % orders.length].map((required, i) => param(`q${i}`, KNOWN_PARAM_TYPES[(n + i) % KNOWN_PARAM_TYPES.length], required));
    const r = JSON.parse(await addTool(baseDir, JSON.stringify(tool(name, params))));
    addToolStats.offered++;
    r.success ? addToolStats.accepted++ : addToolStats.refused++;
  }
  projects.set(named.addToolBase.id, tsFilesUnder(baseDir));

  // --- Controls: files that MUST fail, so a silent type-check cannot pass for a clean one.
  mkdirSync(join(work, "control"));
  writeFileSync(join(work, "control", "plain.ts"), `export const n: number = "not a number";\n`);
  writeFileSync(
    join(work, "control", "through-the-sdk.ts"),
    `import { McpServer } from "@modelcontextprotocol/server";\nimport { z } from "zod";\n` +
    `const s = new McpServer({ name: "c", version: "1" });\n` +
    `s.registerTool("t", { inputSchema: z.object({ a: z.string().optional() }) }, async ({ a }) => {\n` +
    `  const mustBeString: string = a;\n  return { content: [{ type: "text", text: mustBeString }] };\n});\n`
  );
  const extraRoots = [join(work, "control", "plain.ts"), join(work, "control", "through-the-sdk.ts")];
  if (!REAL_DEPS) {
    writeFileSync(join(work, "sdk-stand-in.d.ts"), SDK_STAND_IN);
    extraRoots.push(join(work, "sdk-stand-in.d.ts"));
  }

  const all = typecheck([...projects.values()].flat(), extraRoots);
  controlMessages = all.get("control") ?? [];
  all.delete("control");
  for (const [id, messages] of all) failures.set(id, messages);

  const total = Object.values(stats).reduce((a, s) => ({ offered: a.offered + s.offered, refused: a.refused + s.refused, accepted: a.accepted + s.accepted }), { offered: 0, refused: 0, accepted: 0 });
  const lines = Object.entries(stats).map(([k, s]) => `  ${k}: ${s.offered} offered, ${s.refused} refused, ${s.accepted} type-checked`);
  console.log(
    `CONTROLS: ${controlMessages.join(" || ")}\n` +
    `GRID (${REAL_DEPS ? "REAL SDK from " + REAL_DEPS : "stand-in SDK, real zod + vitest + node types"})\n${lines.join("\n")}\n` +
    `  add_tool onto one project: ${addToolStats.offered} offered, ${addToolStats.refused} refused, ${addToolStats.accepted} added (that project is type-checked once)\n` +
    `  TOTAL: ${total.offered + addToolStats.offered} combinations; ${total.accepted} generated projects in one program, ${[...projects.values()].flat().length} files; ` +
    `${harvested.length} identifiers harvested from the templates; projects with type errors: ${failures.size}`
  );
}, 900_000);

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

const errorsFor = (name: string) => failures.get(named[name].id) ?? [];
const read = (name: string, rel: string) => readFileSync(join(named[name].dir, rel), "utf-8");
const refused = (tools: unknown[]) => !validateToolDefs(tools).ok;

// ---------------------------------------------------------------- the property

describe("property: refused, or it type-checks", () => {
  // Red when: the type-check step stops reporting errors (wrong options, files not in the
  // program, the stand-in typed as `any`). Both controls contain a deliberate type error.
  it("the type-check can fail: both control files are reported, each for its planted error only", () => {
    // TS2322 = "Type X is not assignable to type Y". Anything else (for example TS2307,
    // module not found) would mean the control failed for the wrong reason.
    const plain = controlMessages.filter((m) => m.includes("plain.ts"));
    const throughSdk = controlMessages.filter((m) => m.includes("through-the-sdk.ts"));
    expect(plain.length).toBe(1);
    expect(plain[0]).toContain("TS2322");
    expect(throughSdk.length).toBe(1);
    expect(throughSdk[0]).toContain("TS2322");
    expect(throughSdk[0]).toContain("string | undefined"); // zod's inference reached the handler
    expect(controlMessages.length).toBe(2);
  });

  // Red when: ANY accepted definition in the grid generates a project that does not
  // type-check. That covers a new template identifier that collides with a tool or
  // parameter name (the grid harvests the templates), a renderer that disagrees with
  // another about required/optional or argument order, or a name rule that is loosened.
  it("every accepted definition generates a project that type-checks", () => {
    const report = [...failures].slice(0, 25).map(([id, messages]) => `${id}: ${messages.slice(0, 3).join(" | ")}`);
    expect({ projectsWithErrors: failures.size, first: report }).toEqual({ projectsWithErrors: 0, first: [] });
  });

  // Red when: free text reaches a generated README as Markdown again. (That the same
  // projects still type-check with this text in every description is part of the
  // property above.)
  it("hostile free text leaves every generated README with the same blocks and links", () => {
    expect(stats["hostile free text x variants"]).toEqual({ offered: 12, refused: 0, accepted: 12 });
    for (const key of ["local-false", "remote-false", "local-true", "remote-true"]) {
      const plain = read(`text-plain-${key}`, "README.md");
      for (const kind of ["install", "everything"]) {
        const attacked = read(`text-${kind}-${key}`, "README.md");
        expect(blockStarts(attacked), `${kind} ${key}`).toEqual(blockStarts(plain));
        expect(links(attacked), `${kind} ${key}`).toEqual(links(plain));
        expect(errorsFor(`text-${kind}-${key}`)).toEqual([]);
      }
    }
  });

  // Red when: the grid quietly shrinks (a section stops generating, or validation starts
  // refusing everything, which would make the property above pass on nothing).
  it("the grid is not empty where it matters", () => {
    expect(harvested.length).toBeGreaterThan(40);
    expect(stats["package names x variants"].accepted).toBe(PACKAGES.length * 4);
    expect(stats["required orders"]).toEqual({ offered: 120, refused: 0, accepted: 120 });
    expect(stats["tool names"].accepted).toBeGreaterThan(60);
    expect(stats["tool names"].refused).toBeGreaterThan(40);
    expect(stats["parameter names"].accepted).toBeGreaterThan(60);
    expect(stats["parameter names"].refused).toBeGreaterThan(40);
    expect(stats["tool pairs"].accepted).toBeGreaterThan(20);
    expect(stats["tool pairs"].refused).toBeGreaterThan(5);
    expect(addToolStats.accepted).toBeGreaterThan(60);
    expect(addToolStats.refused).toBeGreaterThan(40);
  });
});

// ---------------------------------------------------------------- the nine reported inputs

describe("reported inputs", () => {
  // 1. Red when: the type table is looked up as a plain object again (inherited
  // properties such as "__proto__" come back as a non-string), or unknown types are accepted.
  it("1: a type that is not in the known set is refused; every known type is accepted", () => {
    for (const type of ["__proto__", "constructor", "toString", "array", "object", "", 5]) {
      expect(refused([tool("echo", [param("value", type)])]), JSON.stringify(type)).toBe(true);
    }
    expect(refused([tool("echo", [{ name: "value", description: "d" }])]), "no type at all").toBe(true);
    for (const type of [...KNOWN_PARAM_TYPES, "String", "INT"]) {
      expect(refused([tool("echo", [param("value", type)])]), type).toBe(false);
    }
    // 11 accepted types x 3 required states were generated and type-checked in the grid.
    expect(stats["types x required"].accepted).toBe((KNOWN_PARAM_TYPES.length + 3) * 3);
  });

  // 2. Red when: add_tool decides "already there" from file names alone. get_weather and
  // get__weather have different files and the same function name.
  it("2: add_tool refuses a tool whose function name the project already imports", async () => {
    const dir = join(work, "finding2");
    expect(JSON.parse(await scaffoldServer("f2-mcp", "d", JSON.stringify([tool("get_weather")]), dir)).success).toBe(true);
    const project = join(dir, "f2-mcp");
    const before = readFileSync(join(project, "src/index.ts"), "utf-8");

    const res = JSON.parse(await addTool(project, JSON.stringify(tool("get__weather"))));
    expect(res.success).toBe(false);
    expect(res.error).toContain('"getWeather"');
    expect(readFileSync(join(project, "src/index.ts"), "utf-8")).toBe(before);
    expect(existsSync(join(project, "src/tools/get--weather.ts"))).toBe(false);

    expect([...importedBindings(`import a from "x";\nimport { b, c as d, type E } from 'y';\nimport * as ns from "z";\nimport f, { g } from "w";`)].sort())
      .toEqual(["E", "a", "b", "d", "f", "g", "ns"]);
  });

  // 3. Red when: a parameter or tool function may take the name of a global the generated
  // code calls. (The grid enforces the general rule; these are the three reported names.)
  it("3: JSON, Error and String are refused as parameter names and as tool names", () => {
    for (const name of ["JSON", "Error", "String"]) {
      expect(refused([tool("echo", [param(name)])]), `parameter ${name}`).toBe(true);
      expect(refused([tool(name)]), `tool ${name}`).toBe(true);
    }
  });

  // 4. Red when: any renderer goes back to its own reading of an omitted `required`.
  it("4: an omitted `required` means required in the schema AND in the signature", () => {
    expect(errorsFor("omittedRequired")).toEqual([]);
    expect(read("omittedRequired", "src/index.ts")).not.toContain(".optional()");
    expect(read("omittedRequired", "src/tools/echo.ts")).toContain("export async function echo(value: string): Promise<string>");
    expect(read("omittedRequired", "tests/test-echo.ts")).toContain('await echo("test")');

    expect(errorsFor("explicitOptional")).toEqual([]);
    expect(read("explicitOptional", "src/index.ts")).toContain("value: z.string().optional().describe(");
    expect(read("explicitOptional", "src/tools/echo.ts")).toContain("export async function echo(value?: string): Promise<string>");
    expect(refused([tool("echo", [param("value", "string", "false")])])).toBe(true);
  });

  // 5. Red when: a parameter may be named after a member of Object.prototype
  // ("__proto__" as an object-literal key sets the prototype instead of adding a key).
  it("5: __proto__, constructor, prototype and other Object.prototype members are refused as parameter names", () => {
    for (const name of ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf"]) {
      expect(refused([tool("echo", [param(name)])]), name).toBe(true);
    }
  });

  // 6. Red when: a tool function may take a name the generated test file imports from vitest.
  it("6: describe, it and expect are refused as tool names", () => {
    for (const name of ["describe", "it", "expect"]) {
      expect(refused([tool(name)]), name).toBe(true);
    }
  });

  // 7. Red when: the signature, the call site or the generated test stops using the shared
  // required-first order (a required parameter after an optional one is not legal TypeScript).
  it("7: an optional parameter before a required one is reordered consistently", () => {
    expect(named.optionalThenRequired.result.success).toBe(true);
    expect(errorsFor("optionalThenRequired")).toEqual([]);
    expect(read("optionalThenRequired", "src/tools/echo.ts")).toContain("export async function echo(second: string, first?: string): Promise<string>");
    expect(read("optionalThenRequired", "src/index.ts")).toContain("const result = await echo(second, first);");
    expect(read("optionalThenRequired", "tests/test-echo.ts")).toContain('await echo("test")');
  });

  // 8. Red when: the npm package name is used as a Docker image name again, or the
  // derived name can break Docker's image-name grammar.
  it("8: a scoped package gets a valid Docker image name in the README and next steps", () => {
    expect(errorsFor("scopedRemote")).toEqual([]);
    const commands = read("scopedRemote", "README.md").split("\n").filter((l) => l.startsWith("docker "));
    expect(commands).toEqual([
      "docker build -t acme-weather .",
      "docker run -p 8000:8000 -e MCP_ALLOWED_HOSTS=localhost acme-weather",
    ]);
    const steps = (named.scopedRemote.result.nextSteps as string[]).filter((s) => s.includes("docker "));
    expect(steps).toEqual(["docker build -t acme-weather . && docker run -p 8000:8000 -e MCP_ALLOWED_HOSTS=localhost acme-weather"]);

    // Docker's grammar for one path component of an image name.
    const DOCKER_NAME = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*$/;
    for (const pkg of [...PACKAGES, "a..b", "a__.b", "trailing-", "a.-_b", "@x_/y-"]) {
      expect(dockerImageName(pkg), pkg).toMatch(DOCKER_NAME);
    }
    expect(dockerImageName("my-weather-mcp")).toBe("my-weather-mcp");

    // The local variant's command name drops the scope too.
    expect(errorsFor("scopedLocal")).toEqual([]);
    expect(Object.keys(JSON.parse(read("scopedLocal", "package.json")).bin)).toEqual(["weather"]);
  });

  // 9. Red when: pipes are escaped without first escaping the backslashes already in the
  // text (the two backslashes then cancel and the pipe ends the cell).
  it("9: a backslash before a pipe cannot end a README table cell", () => {
    /** Split a table row the way GFM does: a backslash escapes the character after it. */
    const cells = (row: string) => {
      const out: string[] = [];
      let cell = "";
      for (let i = 0; i < row.length; i++) {
        if (row[i] === "\\" && i + 1 < row.length) { cell += row[i] + row[i + 1]; i++; }
        else if (row[i] === "|") { out.push(cell); cell = ""; }
        else cell += row[i];
      }
      out.push(cell);
      return out;
    };
    for (const text of ["a\\|b", "a\\\\|b", "a\\\\\\|b", "\\", "|", "a|b\\", "\\|\\|", "plain"]) {
      const readme = renderReadme("p", "d", [{ name: "echo", description: text, parameters: [], returns: "r" } as ToolDef]);
      const rows = readme.split("\n").filter((l) => l.startsWith("| `echo` |"));
      expect(rows.length, JSON.stringify(text)).toBe(1);
      // "| `echo` | <cell> |" is: empty, name, description, empty.
      expect(cells(rows[0]).length, JSON.stringify(text)).toBe(4);
    }
  });
});
