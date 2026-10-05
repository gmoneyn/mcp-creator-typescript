/**
 * Generator output tests. Every case scaffolds real projects to a temp dir through
 * the same scaffoldServer() the MCP tool calls, then reads the files back.
 *
 * Each test names the future change that would turn it red.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { scaffoldServer } from "../src/tools/scaffold-server.js";
import { generateLaunchguide } from "../src/tools/generate-launchguide.js";
import { KNOWN_LIMITATION_REMOTE_PAID } from "../src/services/codegen.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Assembled from two pieces so this file never contains the string it bans
// (a repo-wide search for the wrong domain must stay at zero).
const WRONG_DOMAIN = "mcpmarketplace" + ".com";
const EM_DASH = "—";

const TOOLS = JSON.stringify([
  {
    name: "get_weather",
    description: "Get current weather for a city",
    parameters: [
      { name: "city", type: "string", required: true, description: "City name" },
      { name: "units", type: "string", required: false, description: "Temperature units (C or F)" },
    ],
    returns: "JSON weather data",
  },
]);

const VARIANTS = [
  { name: "local-free-mcp", hosting: "local", paid: false },
  { name: "remote-free-mcp", hosting: "remote", paid: false },
  { name: "local-paid-mcp", hosting: "local", paid: true },
  { name: "remote-paid-mcp", hosting: "remote", paid: true },
] as const;

type Generated = { files: Record<string, string>; result: string };

let outDir: string;
const gen: Record<string, Generated> = {};
let launchguideResult = "";

function readTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else out[relative(root, abs)] = readFileSync(abs, "utf-8");
    }
  };
  walk(root);
  return out;
}

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), "ts-mcp-creator-test-"));
  for (const v of VARIANTS) {
    const result = await scaffoldServer(v.name, "Weather tools for testing", TOOLS, outDir, undefined, v.paid, v.hosting);
    expect(JSON.parse(result).success).toBe(true);
    gen[v.name] = { files: readTree(join(outDir, v.name)), result };
  }
  launchguideResult = await generateLaunchguide(
    join(outDir, "local-free-mcp"), "local-free-mcp", "tagline", "description", "Data", "- feature", "tag"
  );
  gen["local-free-mcp"].files = readTree(join(outDir, "local-free-mcp"));
});

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

/** Every string a creator can receive: each generated file plus each tool's JSON reply. */
function everyGeneratedText(): Array<[string, string]> {
  const all: Array<[string, string]> = [];
  for (const v of VARIANTS) {
    for (const [path, content] of Object.entries(gen[v.name].files)) all.push([`${v.name}/${path}`, content]);
    all.push([`${v.name} scaffold_server reply`, gen[v.name].result]);
  }
  all.push(["generate_launchguide reply", launchguideResult]);
  return all;
}

describe("marketplace URL", () => {
  // Red when: any template, next-step string or tool reply points at the wrong domain again.
  it("no generated file or tool reply mentions the wrong domain", () => {
    const texts = everyGeneratedText();
    expect(texts.length).toBeGreaterThan(40); // 4 projects of 12+ files each: guards against scanning nothing
    const offenders = texts.filter(([, text]) => text.includes(WRONG_DOMAIN)).map(([where]) => where);
    expect(offenders).toEqual([]);
  });

  // Red when: a source file or the package README reintroduces the wrong domain in a
  // string no scaffold variant above happens to emit.
  it("no shipped source file mentions the wrong domain", () => {
    const sources = { ...readTree(join(REPO, "src")), "README.md": readFileSync(join(REPO, "README.md"), "utf-8") };
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    const offenders = Object.entries(sources).filter(([, text]) => text.includes(WRONG_DOMAIN)).map(([where]) => where);
    expect(offenders).toEqual([]);
  });

  // Red when: the submission link stops being the /submit page on our domain.
  it("generate_launchguide sends the creator to the submit page on our domain", () => {
    const steps: string[] = JSON.parse(launchguideResult).nextSteps;
    expect(steps.some((s) => s.includes("https://mcp-marketplace.io/submit"))).toBe(true);
  });

  // Red when: the paid README's purchase link changes host.
  it("paid READMEs link the purchase to our domain", () => {
    for (const name of ["local-paid-mcp", "remote-paid-mcp"]) {
      expect(gen[name].files["README.md"]).toContain("(https://mcp-marketplace.io)");
    }
  });
});

describe("generated text style", () => {
  // Red when: an em dash is added to any template string that reaches a generated file or reply.
  it("contains no em dash", () => {
    const offenders = everyGeneratedText().filter(([, text]) => text.includes(EM_DASH)).map(([where]) => where);
    expect(offenders).toEqual([]);
  });
});

describe("remote scaffold: MCP_ALLOWED_HOSTS", () => {
  const remotes = ["remote-free-mcp", "remote-paid-mcp"];

  // Red when: the fail-closed guard is removed or turned into a warning.
  it("entry point still refuses to start without it", () => {
    for (const name of remotes) {
      const index = gen[name].files["src/index.ts"];
      const guard = index.slice(index.indexOf("if (allowedHosts.length === 0) {"), index.indexOf("const app = createMcpExpressApp"));
      expect(guard).toContain("REFUSING TO START");
      expect(guard).toContain("process.exit(1);");
      expect(index).toContain('createMcpExpressApp({ host: "0.0.0.0", allowedHosts })');
    }
  });

  // Red when: a README run command is written (or reverted) without the variable, which
  // makes the documented command produce a server that exits at startup.
  it("every README run command sets it", () => {
    for (const name of remotes) {
      const lines = gen[name].files["README.md"].split("\n");
      const runLines = lines.filter((l) => l.startsWith("docker run") || l.endsWith("node dist/index.js"));
      expect(runLines.length).toBe(2); // one Docker command, one plain node command
      for (const line of runLines) expect(line).toMatch(/MCP_ALLOWED_HOSTS=\S+/);
    }
  });

  // Red when: the scaffold_server reply tells the creator to run the container without the variable.
  it("scaffold_server next steps set it on the docker run command", () => {
    for (const name of remotes) {
      const steps: string[] = JSON.parse(gen[name].result).nextSteps;
      const run = steps.filter((s) => s.includes("docker run"));
      expect(run.length).toBe(1);
      expect(run[0]).toMatch(/docker run .*-e MCP_ALLOWED_HOSTS=\S+/);
    }
  });

  // Red when: .env.example drops the variable, its example value, or the explanation above it.
  it(".env.example explains it and gives an example value", () => {
    for (const name of remotes) {
      const lines = gen[name].files[".env.example"].split("\n");
      const at = lines.indexOf("MCP_ALLOWED_HOSTS=localhost");
      expect(at).toBeGreaterThan(0);
      expect(lines[at - 1]).toMatch(/^# Required: .*refuses to start without it/);
    }
  });

  // Red when: the Dockerfile stops naming the variable, or someone bakes a default into the image.
  it("Dockerfile names it in a comment and never sets it", () => {
    for (const name of remotes) {
      const lines = gen[name].files["Dockerfile"].split("\n");
      expect(lines.some((l) => l.startsWith("#") && l.includes("MCP_ALLOWED_HOSTS"))).toBe(true);
      expect(lines.filter((l) => !l.startsWith("#") && l.includes("MCP_ALLOWED_HOSTS"))).toEqual([]);
    }
  });

  // Red when: remote-only instructions leak into a local (stdio) scaffold.
  it("local scaffolds do not mention it", () => {
    for (const name of ["local-free-mcp", "local-paid-mcp"]) {
      for (const [path, content] of Object.entries(gen[name].files)) {
        expect(content.includes("MCP_ALLOWED_HOSTS"), `${name}/${path}`).toBe(false);
      }
    }
  });
});

describe("paid scaffold: license instructions", () => {
  // Red when: the limitation paragraph is removed or reworded away from the shared constant
  // while the gate still checks only the server's own key.
  it("paid + remote README carries the Known limitation paragraph", () => {
    const readme = gen["remote-paid-mcp"].files["README.md"];
    expect(readme).toContain("## Known limitation");
    expect(readme).toContain(KNOWN_LIMITATION_REMOTE_PAID);
    expect(KNOWN_LIMITATION_REMOTE_PAID).toContain("does not yet tell one caller from another");
  });

  // Red when: the remote README again tells the CALLER to send or set a key the server never reads.
  it("paid + remote README tells the host, not the caller, to set the key", () => {
    const readme = gen["remote-paid-mcp"].files["README.md"];
    expect(readme).not.toContain("Authorization");
    expect(readme).not.toContain("mcp_live_");
    expect(readme).toContain("whoever hosts this server sets `MCP_LICENSE_KEY`");
    expect(readme).toContain("People connecting to the server do not send a key.");
  });

  // Red when: the limitation text is emitted for a variant it does not describe.
  it("the limitation paragraph appears only for paid + remote", () => {
    for (const name of ["local-free-mcp", "remote-free-mcp", "local-paid-mcp"]) {
      expect(gen[name].files["README.md"]).not.toContain("Known limitation");
    }
  });

  // Red when: the comment is separated from the gate line, or the gate call itself is changed.
  it("paid + remote entry point carries the limitation comment directly above the gate", () => {
    const lines = gen["remote-paid-mcp"].files["src/index.ts"].split("\n");
    const gate = lines.indexOf('  withLicense(server, { slug: "remote-paid-mcp" });');
    expect(gate).toBeGreaterThan(0);
    expect(lines[gate - 1].trim().startsWith("//")).toBe(true);
    const comment = lines.slice(gate - 5, gate).join("\n");
    expect(comment).toContain("KNOWN LIMITATION");
    expect(comment).toContain("does not tell one caller from another");
  });

  // Red when: the local gate call is changed or dropped (this release must not alter it).
  it("paid + local entry point keeps the gate call and the client-side key instruction", () => {
    expect(gen["local-paid-mcp"].files["src/index.ts"]).toContain('  withLicense(server, { slug: "local-paid-mcp" });');
    expect(gen["local-paid-mcp"].files["README.md"]).toContain('"MCP_LICENSE_KEY": "your-license-key-here"');
  });

  // Red when: a free scaffold starts importing or calling the license SDK.
  it("free scaffolds carry no license gate", () => {
    for (const name of ["local-free-mcp", "remote-free-mcp"]) {
      expect(gen[name].files["src/index.ts"]).not.toContain("withLicense");
      expect(gen[name].files["package.json"]).not.toContain("@mcp_marketplace/license");
    }
  });
});

describe("generated project shape", () => {
  // Red when: the generator goes back to the v1 package, or drops a remote dependency.
  it("depends on the SDK v2 packages, not the v1 package", () => {
    for (const v of VARIANTS) {
      const deps = JSON.parse(gen[v.name].files["package.json"]).dependencies;
      expect(Object.keys(deps)).toContain("@modelcontextprotocol/server");
      expect(Object.keys(deps)).not.toContain("@modelcontextprotocol/sdk");
      expect(gen[v.name].files["src/index.ts"]).not.toContain("@modelcontextprotocol/sdk");
      if (v.hosting === "remote") {
        expect(Object.keys(deps)).toEqual(expect.arrayContaining(["@modelcontextprotocol/express", "@modelcontextprotocol/node", "express"]));
      }
    }
  });

  // Red when: the vitest config is dropped or its include stops matching the generated
  // test file names, which makes the documented `npm test` exit 1 with no test files.
  it("ships a vitest config whose include matches the generated test files", () => {
    for (const v of VARIANTS) {
      const files = gen[v.name].files;
      expect(files["vitest.config.ts"]).toContain('include: ["tests/**/*.ts"]');
      expect(Object.keys(files).filter((f) => f.startsWith("tests/") && f.endsWith(".ts")).length).toBe(2);
    }
  });
});

describe("release version", () => {
  // Red when: package.json is bumped and the lockfile or the server's reported version is not.
  it("package.json, both lockfile root entries and the server version agree", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf-8"));
    const lock = JSON.parse(readFileSync(join(REPO, "package-lock.json"), "utf-8"));
    const index = readFileSync(join(REPO, "src/index.ts"), "utf-8");
    const reported = /name: "mcp-creator-typescript",\s+version: "([^"]+)"/.exec(index);
    expect(reported).not.toBeNull();
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""].version).toBe(pkg.version);
    expect(reported![1]).toBe(pkg.version);
  });
});
