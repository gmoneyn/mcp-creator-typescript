/**
 * codegen.ts — Pure template functions that generate TypeScript MCP server files.
 * No I/O — every function returns a string.
 */

import { guideBlock, guideLine, mdText, oneLine, tableCell } from "./markdown.js";

export { oneLine, tableCell };

// --- Types ---

export interface ToolParam {
  name: string;
  type: string;
  required?: boolean;
  description: string;
  default?: unknown;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: ToolParam[];
  returns: string;
}

// --- Helpers ---

/** my-cool-mcp → myCoolMcp (for imports) */
export function toCamelCase(name: string): string {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/** get_weather → getWeather */
export function snakeToCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * The function name generated for a tool: get_weather and get-weather both give getWeather.
 * Tool names are validated first (validate.ts), so the result is always a plain identifier.
 */
export function toolFunctionName(name: string): string {
  return name.replace(/[-_]+([A-Za-z0-9])?/g, (_, c?: string) => (c ? c.toUpperCase() : ""));
}

/** The file name (without extension) generated for a tool: get_weather gives get-weather. */
export function toolFileName(name: string): string {
  return name.replace(/_/g, "-");
}

// --- Escaping free text for the place it lands in ---
// Names are validated and never escaped. Descriptions are free text and are escaped
// here, per context, so no description can change the generated code.

/** A JavaScript string literal (with its quotes) whose value is exactly `text`. */
export function jsString(text: unknown): string {
  return JSON.stringify(String(text ?? ""))
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Text for the inside of a block comment: cannot close the comment, stays on one line. */
export function commentText(text: unknown): string {
  return String(text ?? "")
    .replace(/\*\//g, "*\\/")
    .replace(/[\r\n\u2028\u2029]+/g, " ");
}

// --- Parameter types ---

interface ParamTypeInfo {
  zod: string;
  ts: string;
  /** A literal of this type, for the generated test's call. */
  sample: string;
}

const STRING_TYPE: ParamTypeInfo = { zod: "z.string()", ts: "string", sample: `"test"` };
const INT_TYPE: ParamTypeInfo = { zod: "z.number().int()", ts: "number", sample: "1" };
const NUMBER_TYPE: ParamTypeInfo = { zod: "z.number()", ts: "number", sample: "1" };
const BOOLEAN_TYPE: ParamTypeInfo = { zod: "z.boolean()", ts: "boolean", sample: "true" };

/**
 * Every accepted parameter type. A Map, not an object literal: an object lookup also
 * finds inherited properties, so "__proto__" or "constructor" would come back as a
 * non-string and be written into the generated source.
 */
const PARAM_TYPES: ReadonlyMap<string, ParamTypeInfo> = new Map([
  ["string", STRING_TYPE],
  ["str", STRING_TYPE],
  ["integer", INT_TYPE],
  ["int", INT_TYPE],
  ["number", NUMBER_TYPE],
  ["float", NUMBER_TYPE],
  ["boolean", BOOLEAN_TYPE],
  ["bool", BOOLEAN_TYPE],
]);

/** The accepted type names, for validation and messages. Matching is case-insensitive. */
export const KNOWN_PARAM_TYPES: readonly string[] = [...PARAM_TYPES.keys()];

export function isKnownParamType(type: unknown): type is string {
  return typeof type === "string" && PARAM_TYPES.has(type.toLowerCase());
}

/** Validation refuses unknown types first; the fallback only keeps this total. */
function paramType(type: string): ParamTypeInfo {
  return PARAM_TYPES.get(String(type).toLowerCase()) ?? STRING_TYPE;
}

// --- Parameter rules shared by EVERY renderer ---
// The schema, the function signature, the call site and the generated test must agree
// on which parameters are required and in which order they are passed. They used to
// decide separately and disagreed; these two functions are now the only place.

/** A parameter is required unless it says `required: false`. Omitted means required. */
export function isRequired(p: ToolParam): boolean {
  return p.required !== false;
}

/**
 * The order parameters are passed in: required ones first, then optional ones, each
 * group in the order it was declared. TypeScript does not allow a required parameter
 * after an optional one, so the declared order cannot always be used as it is.
 */
export function orderedParams(tool: ToolDef): ToolParam[] {
  return [...tool.parameters.filter(isRequired), ...tool.parameters.filter((p) => !isRequired(p))];
}

/**
 * A Docker image name derived from the package name. An npm name is not always a valid
 * image reference ("@scope/name" is not), so runs of anything other than a lowercase
 * letter or digit become one "-".
 */
export function dockerImageName(packageName: string): string {
  const name = packageName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return name || "mcp-server";
}

/** The command name for package.json "bin": the package name without its scope. */
export function binName(packageName: string): string {
  return packageName.slice(packageName.lastIndexOf("/") + 1);
}

/** The registerTool(...) block for one tool. Used by the scaffold AND by add_tool. */
function registrationLines(tool: ToolDef, indent: string): string[] {
  const fnName = toolFunctionName(tool.name);
  const callArgs = orderedParams(tool).map((p) => p.name).join(", ");
  const destructured = tool.parameters.map((p) => p.name).join(", ");

  const lines: string[] = [];
  // MCP 2026-07-28 / SDK v2: registerTool(name, config, cb). The v1
  // server.tool(name, description, shape, cb) signature is gone.
  lines.push(`${indent}server.registerTool(`);
  lines.push(`${indent}  "${tool.name}",`);
  lines.push(`${indent}  {`);
  lines.push(`${indent}    description: ${jsString(tool.description)},`);
  lines.push(`${indent}    inputSchema: z.object({`);
  for (const p of tool.parameters) {
    const optional = isRequired(p) ? "" : ".optional()";
    lines.push(`${indent}      ${p.name}: ${paramType(p.type).zod}${optional}.describe(${jsString(p.description)}),`);
  }
  lines.push(`${indent}    }),`);
  lines.push(`${indent}  },`);
  lines.push(`${indent}  async ({ ${destructured} }) => {`);
  lines.push(`${indent}    try {`);
  lines.push(`${indent}      const result = await ${fnName}(${callArgs});`);
  lines.push(`${indent}      return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };`);
  lines.push(`${indent}    } catch (e) {`);
  lines.push(`${indent}      return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }] };`);
  lines.push(`${indent}    }`);
  lines.push(`${indent}  }`);
  lines.push(`${indent});`);
  return lines;
}

// --- Project-Level Templates ---

export function renderPackageJson(
  packageName: string,
  description: string,
  opts: { paid?: boolean; hosting?: string } = {}
): string {
  const deps: Record<string, string> = {
    // MCP 2026-07-28 (stateless core). NOTE: v2 is a PACKAGE RENAME, not a version
    // bump — "@modelcontextprotocol/sdk" is the pre-stateless v1 line.
    "@modelcontextprotocol/server": "^2.0.0",
    zod: "^4.0.0",
  };
  if (opts.paid) {
    deps["@mcp_marketplace/license"] = "^1.1.0";
  }
  if (opts.hosting === "remote") {
    deps["@modelcontextprotocol/express"] = "^2.0.0";
    deps["@modelcontextprotocol/node"] = "^2.0.0";
    deps["express"] = "^5.2.0";
  }
  // express ships no types of its own; without this the mount handler's
  // (req, res) params are implicit-any and the generated project fails strict tsc.
  const extraDev: Record<string, string> =
    opts.hosting === "remote" ? { "@types/express": "^5.0.0" } : {};

  const devDeps: Record<string, string> = {
    "@types/node": "^22.0.0",
    tsup: "^8.0.0",
    typescript: "^5.5.0",
    vitest: "^2.0.0",
    ...extraDev,
  };

  const pkg: Record<string, unknown> = {
    name: packageName,
    version: "1.0.0",
    description,
    type: "module",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    scripts: {
      build: "tsup",
      dev: "tsup --watch",
      test: "vitest run",
      prepublishOnly: "npm run build",
    },
    dependencies: deps,
    devDependencies: devDeps,
    files: ["dist"],
    keywords: ["mcp", packageName, "ai-tools"],
    license: "MIT",
    engines: { node: ">=20" },
  };

  // Local servers get a bin entry for CLI usage; remote servers are started via node
  if (opts.hosting !== "remote") {
    pkg.bin = { [binName(packageName)]: "dist/index.js" };
  }

  return JSON.stringify(pkg, null, 2) + "\n";
}

export function renderTsconfig(): string {
  const cfg = {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      outDir: "dist",
      rootDir: "src",
      declaration: true,
      sourceMap: true,
    },
    include: ["src"],
    exclude: ["node_modules", "dist", "tests"],
  };
  return JSON.stringify(cfg, null, 2) + "\n";
}

export function renderTsupConfig(opts: { hosting?: string } = {}): string {
  const bannerLine = opts.hosting === "remote"
    ? ""
    : `\n  banner: { js: "#!/usr/bin/env node" },`;
  return `import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  dts: true,${bannerLine}
});
`;
}

export function renderGitignore(): string {
  return `node_modules/
dist/
*.tsbuildinfo
.env
.DS_Store
`;
}

// --- Server (index.ts) ---

export function renderIndex(
  packageName: string,
  tools: ToolDef[],
  opts: { paid?: boolean; paidTools?: string[]; hosting?: string } = {}
): string {
  if (opts.hosting === "remote") {
    return renderRemoteIndex(packageName, tools, opts);
  }
  return renderLocalIndex(packageName, tools, opts);
}

function renderLocalIndex(
  packageName: string,
  tools: ToolDef[],
  opts: { paid?: boolean; paidTools?: string[] } = {}
): string {
  const lines: string[] = [];

  lines.push(`/**`);
  lines.push(` * ${packageName}: MCP server.`);
  lines.push(` */`);
  lines.push(``);
  lines.push(`import { McpServer } from "@modelcontextprotocol/server";`);
  lines.push(`import { serveStdio } from "@modelcontextprotocol/server/stdio";`);

  if (opts.paid) {
    lines.push(`import { withLicense } from "@mcp_marketplace/license";`);
  }

  lines.push(`import { z } from "zod";`);
  lines.push(``);

  // Tool imports
  lines.push(`// --- IMPORTS ---`);
  for (const tool of tools) {
    const fnName = toolFunctionName(tool.name);
    const fileName = toolFileName(tool.name);
    lines.push(`import { ${fnName} } from "./tools/${fileName}.js";`);
  }
  lines.push(`// --- END IMPORTS ---`);
  lines.push(``);

  // MCP 2026-07-28: serveStdio owns the connection and takes a FACTORY. One
  // instance is pinned per connection; the same factory also serves 2025-era
  // clients, so the two eras can never drift apart.
  lines.push(`serveStdio(() => {`);
  lines.push(`  const server = new McpServer({`);
  lines.push(`    name: ${jsString(packageName)},`);
  lines.push(`    version: "1.0.0",`);
  lines.push(`  });`);
  lines.push(``);

  lines.push(`  // --- TOOLS ---`);
  lines.push(``);

  renderToolRegistrations(lines, tools, "  ");

  lines.push(`  // --- END TOOLS ---`);
  lines.push(``);

  if (opts.paid) {
    lines.push(`  withLicense(server, { slug: "${packageName}" });`);
    lines.push(``);
  }

  lines.push(`  return server;`);
  lines.push(`});`);

  return lines.join("\n") + "\n";
}

function renderRemoteIndex(
  packageName: string,
  tools: ToolDef[],
  opts: { paid?: boolean; paidTools?: string[] } = {}
): string {
  const lines: string[] = [];

  lines.push(`/**`);
  lines.push(` * ${packageName}: remote MCP server (Streamable HTTP).`);
  lines.push(` */`);
  lines.push(``);
  lines.push(`import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";`);
  lines.push(`import { toNodeHandler } from "@modelcontextprotocol/node";`);
  lines.push(`import { createMcpExpressApp } from "@modelcontextprotocol/express";`);

  if (opts.paid) {
    lines.push(`import { withLicense } from "@mcp_marketplace/license";`);
  }

  lines.push(`import { z } from "zod";`);
  lines.push(``);

  // Tool imports
  lines.push(`// --- IMPORTS ---`);
  for (const tool of tools) {
    const fnName = toolFunctionName(tool.name);
    const fileName = toolFileName(tool.name);
    lines.push(`import { ${fnName} } from "./tools/${fileName}.js";`);
  }
  lines.push(`// --- END IMPORTS ---`);
  lines.push(``);

  // MCP 2026-07-28: no sessions. createMcpHandler takes a factory and serves
  // each request independently; the same factory backs the stateless legacy
  // fallback, so the modern and 2025-era paths cannot drift apart.
  lines.push(`const handler = createMcpHandler(() => {`);
  lines.push(`  const server = new McpServer({`);
  lines.push(`    name: ${jsString(packageName)},`);
  lines.push(`    version: "1.0.0",`);
  lines.push(`  });`);
  lines.push(``);

  lines.push(`  // --- TOOLS ---`);
  lines.push(``);

  renderToolRegistrations(lines, tools, "  ");

  lines.push(`  // --- END TOOLS ---`);
  lines.push(``);

  if (opts.paid) {
    // The gate itself is unchanged in this release. The comment is emitted so the
    // person hosting the server reads the limit at the line that enforces it.
    lines.push(`  // KNOWN LIMITATION: this checks the license key in THIS server's environment`);
    lines.push(`  // (MCP_LICENSE_KEY), so it does not tell one caller from another. Per-buyer`);
    lines.push(`  // checks on a hosted server need a per-request key check, coming with the`);
    lines.push(`  // next license SDK release. With no key on the server, the process exits on`);
    lines.push(`  // the first request.`);
    lines.push(`  withLicense(server, { slug: "${packageName}" });`);
    lines.push(``);
  }

  lines.push(`  return server;`);
  lines.push(`});`);
  lines.push(``);

  // Express app. NOTE: createMcpExpressApp only auto-applies DNS-rebinding /
  // Host-header protection for LOCALHOST hosts. Binding 0.0.0.0 (required for
  // container/hosted deploys) DISABLES it, so we require an explicit allowlist
  // and warn loudly when it is absent rather than claiming protection we lost.
  lines.push(`const allowedHosts = (process.env.MCP_ALLOWED_HOSTS ?? "")`);
  lines.push(`  .split(",").map((s) => s.trim()).filter(Boolean);`);
  lines.push(`if (allowedHosts.length === 0) {`);
  lines.push(`  // FAIL CLOSED: a warning does not protect anything. Binding 0.0.0.0 turns off`);
  lines.push(`  // the automatic localhost Host/Origin allowlist, so an unset MCP_ALLOWED_HOSTS`);
  lines.push(`  // means publicly bound with no validation.`);
  lines.push(`  console.error(`);
  lines.push(`    "[mcp] REFUSING TO START: binding 0.0.0.0 requires MCP_ALLOWED_HOSTS " +`);
  lines.push(`    "(comma-separated Host values), otherwise Host/Origin validation is disabled " +`);
  lines.push(`    "and the server is exposed to DNS-rebinding. Example: MCP_ALLOWED_HOSTS=my.host,localhost"`);
  lines.push(`  );`);
  lines.push(`  process.exit(1);`);
  lines.push(`}`);
  // No session map, no GET stream endpoint, no DELETE teardown — 2026-07-28
  // removed protocol sessions (SEP-2567), so a single mount serves everything.
  lines.push(`const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts });`);
  lines.push(`const nodeHandler = toNodeHandler(handler);`);
  lines.push(``);
  lines.push(`// createMcpExpressApp installs express.json(), so by the time we run the`);
  lines.push(`// request stream is ALREADY DRAINED. toNodeHandler takes the parsed body as`);
  lines.push(`// its 3rd arg, and it deliberately IGNORES a function there (Express's`);
  lines.push(`// \`next\`), so mounting toNodeHandler(handler) directly yields an empty body`);
  lines.push(`// on every request. Forward req.body explicitly.`);
  lines.push(`app.all("/mcp", (req, res) => nodeHandler(req, res, req.body));`);
  lines.push(``);

  // Start server
  lines.push(`const port = parseInt(process.env.PORT || "8000");`);
  lines.push(`app.listen(port, "0.0.0.0", () => {`);
  lines.push(`  console.log(\`MCP server running on http://0.0.0.0:\${port}/mcp\`);`);
  lines.push(`});`);

  return lines.join("\n") + "\n";
}

/** Render tool registrations (shared between local and remote). */
function renderToolRegistrations(lines: string[], tools: ToolDef[], indent: string = ""): void {
  for (const tool of tools) {
    lines.push(...registrationLines(tool, indent));
    lines.push(``);
  }
}

// --- Tool Module ---

export function renderToolModule(tool: ToolDef): string {
  const fnName = toolFunctionName(tool.name);

  // Build function params: same order and same required rule as the call site.
  const params = orderedParams(tool)
    .map((p) => `${p.name}${isRequired(p) ? "" : "?"}: ${paramType(p.type).ts}`)
    .join(", ");

  return `/**
 * ${tool.name}: ${commentText(tool.description)}
 * Returns: ${commentText(tool.returns)}
 */

export async function ${fnName}(${params}): Promise<string> {
  // TODO: Replace this stub with your real implementation.
  const result = {
${tool.parameters.map(p => `    ${p.name},`).join("\n")}
    status: "ok",
  };

  return JSON.stringify(result, null, 2);
}
`;
}

// --- Test Templates ---

/**
 * Generated tests are named tests/test-<tool>.ts (add_tool writes the same shape).
 * vitest's default include only matches *.test.ts / *.spec.ts, so without this
 * config the documented `npm test` exits 1 with "No test files found".
 */
export function renderVitestConfig(): string {
  return `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.ts"],
  },
});
`;
}

export function renderTestServer(packageName: string, tools: ToolDef[]): string {
  const toolNames = tools.map(t => `"${t.name}"`).join(", ");

  return `import { describe, it, expect } from "vitest";

describe("${packageName} server", () => {
  it("should have all expected tool names", () => {
    const expected = [${toolNames}];
    // This test verifies the tool list is maintained.
    // For full integration testing, use the MCP inspector.
    expect(expected.length).toBe(${tools.length});
  });
});
`;
}

export function renderTestTool(tool: ToolDef): string {
  const fnName = toolFunctionName(tool.name);
  const fileName = toolFileName(tool.name);

  // Build test args
  const args = orderedParams(tool)
    .filter(isRequired)
    .map((p) => paramType(p.type).sample)
    .join(", ");

  return `import { describe, it, expect } from "vitest";
import { ${fnName} } from "../src/tools/${fileName}.js";

describe("${tool.name}", () => {
  it("should return valid JSON", async () => {
    const result = await ${fnName}(${args});
    const data = JSON.parse(result);
    expect(data).toBeDefined();
    expect(typeof data).toBe("object");
  });
});
`;
}

// --- README ---

/** Our marketplace. NOT the unhyphenated .com domain, which belongs to someone else. */
export const MARKETPLACE_URL = "https://mcp-marketplace.io";
export const MARKETPLACE_SUBMIT_URL = "https://mcp-marketplace.io/submit";

/** The variable the generated remote entry point requires before it will start. */
export const ALLOWED_HOSTS_VAR = "MCP_ALLOWED_HOSTS";

/** Emitted into the README of a paid + remote scaffold. */
export const KNOWN_LIMITATION_REMOTE_PAID =
  "This scaffold checks the license key set on the server, so it does not yet tell one caller from another. " +
  "Per-buyer checks on a hosted server need a per-request key check, coming with the next license SDK release. " +
  "If no key is set on the server, the process exits on the first request.";

export function renderReadme(
  packageName: string,
  description: string,
  tools: ToolDef[],
  opts: { paid?: boolean; hosting?: string } = {}
): string {
  const lines: string[] = [];

  lines.push(`# ${packageName}`);
  lines.push(``);
  // Free text, rendered wherever this README is shown: one line, nothing in it can
  // become a heading, a code block, a link or HTML.
  lines.push(mdText(description));
  lines.push(``);

  const remote = opts.hosting === "remote";

  if (opts.paid) {
    lines.push(`## Requirements`);
    lines.push(``);
    if (remote) {
      // Hosted server: the key is read from the SERVER's environment, never from the caller.
      lines.push(`- **License key**: whoever hosts this server sets \`MCP_LICENSE_KEY\` in the server's environment. Purchase one from [MCP Marketplace](${MARKETPLACE_URL}). People connecting to the server do not send a key.`);
    } else {
      lines.push(`- **License key**: purchase from [MCP Marketplace](${MARKETPLACE_URL}) to get your \`MCP_LICENSE_KEY\``);
    }
    lines.push(`- Node.js 20+`);
    lines.push(``);
  }

  if (remote) {
    // Remote: show URL-based config and deployment instructions.
    // No Authorization header in the client config, paid or not: the generated
    // server never reads one, so telling a caller to send a key would be false.
    lines.push(`## Usage`);
    lines.push(``);
    lines.push(`Add to your MCP client config:`);
    lines.push(``);
    lines.push("```json");
    const remoteConfig: Record<string, unknown> = {
      mcpServers: {
        [packageName]: {
          url: `https://your-server.com/mcp`,
        },
      },
    };
    lines.push(JSON.stringify(remoteConfig, null, 2));
    lines.push("```");
    lines.push(``);

    const keyFlag = opts.paid ? ` -e MCP_LICENSE_KEY=your-license-key-here` : ``;
    const keyVar = opts.paid ? `MCP_LICENSE_KEY=your-license-key-here ` : ``;

    lines.push(`## Deployment`);
    lines.push(``);
    lines.push(`\`${ALLOWED_HOSTS_VAR}\` is required. It is a comma-separated list of the hostnames clients use to reach this server, without a port (\`localhost\` for a local test, your public hostname such as \`mcp.example.com\` once deployed). The server refuses to start without it, and answers 403 to a request whose Host header is not on the list.`);
    lines.push(``);
    lines.push(`With Docker:`);
    lines.push(``);
    lines.push("```bash");
    const image = dockerImageName(packageName);
    lines.push(`docker build -t ${image} .`);
    lines.push(`docker run -p 8000:8000 -e ${ALLOWED_HOSTS_VAR}=localhost${keyFlag} ${image}`);
    lines.push("```");
    lines.push(``);
    lines.push(`Without Docker:`);
    lines.push(``);
    lines.push("```bash");
    lines.push(`npm install`);
    lines.push(`npm run build`);
    lines.push(`${ALLOWED_HOSTS_VAR}=localhost ${keyVar}node dist/index.js`);
    lines.push("```");
    lines.push(``);
    lines.push(`Then point your MCP client at \`http://localhost:8000/mcp\` to test.`);
    lines.push(``);
    lines.push(`Deploy the Docker container to Railway, Fly.io, AWS, or any cloud provider, and set \`${ALLOWED_HOSTS_VAR}\` there to the public hostname.`);
    lines.push(``);

    if (opts.paid) {
      lines.push(`## Known limitation`);
      lines.push(``);
      lines.push(KNOWN_LIMITATION_REMOTE_PAID);
      lines.push(``);
    }
  } else {
    // Local: show npx-based config
    lines.push(`## Installation`);
    lines.push(``);
    lines.push("```json");
    const config: Record<string, unknown> = {
      mcpServers: {
        [packageName]: {
          command: "npx",
          args: ["-y", packageName],
          ...(opts.paid
            ? { env: { MCP_LICENSE_KEY: "your-license-key-here" } }
            : {}),
        },
      },
    };
    lines.push(JSON.stringify(config, null, 2));
    lines.push("```");
    lines.push(``);
  }

  lines.push(`## Tools`);
  lines.push(``);
  lines.push(`| Tool | Description |`);
  lines.push(`|------|-------------|`);
  for (const t of tools) {
    lines.push(`| \`${t.name}\` | ${tableCell(t.description)} |`);
  }
  lines.push(``);

  lines.push(`## Development`);
  lines.push(``);
  lines.push("```bash");
  lines.push(`npm install`);
  lines.push(`npm run build`);
  lines.push(`npm test`);
  lines.push("```");
  lines.push(``);

  return lines.join("\n");
}

// --- .env.example ---

export function renderEnvExample(
  envVars?: Array<{ name: string; description: string; required?: boolean }>,
  opts: { paid?: boolean; hosting?: string } = {}
): string | null {
  const lines: string[] = [];

  if (opts.paid) {
    lines.push(
      opts.hosting === "remote"
        ? `# Required: license key from MCP Marketplace, set by whoever hosts this server (callers do not send one)`
        : `# Required: License key from MCP Marketplace`
    );
    lines.push(`MCP_LICENSE_KEY=`);
    lines.push(``);
  }

  if (opts.hosting === "remote") {
    lines.push(`# Required: comma-separated hostnames clients use to reach this server, no port. The server refuses to start without it.`);
    lines.push(`${ALLOWED_HOSTS_VAR}=localhost`);
    lines.push(``);
    lines.push(`# Server port (optional, default 8000)`);
    lines.push(`PORT=8000`);
    lines.push(``);
  }

  if (envVars && envVars.length > 0) {
    for (const v of envVars) {
      lines.push(`# ${oneLine(v.description)}${v.required ? " (required)" : " (optional)"}`);
      lines.push(`${v.name}=`);
      lines.push(``);
    }
  }

  if (lines.length === 0) return null;
  return lines.join("\n");
}

// --- LAUNCHGUIDE.md ---

export function renderLaunchguide(opts: {
  packageName: string;
  tagline: string;
  description: string;
  category: string;
  features: string;
  tags: string;
  setupRequirements?: string;
  docsUrl?: string;
  useCases?: string;
  gettingStarted?: string;
}): string {
  // Every field is caller-supplied free text. guideLine / guideBlock (markdown.ts) keep
  // a field from starting a section or any other block, and from forming a link or
  // HTML, while leaving ordinary text exactly as written: the marketplace reads this
  // file line by line and shows the values as plain strings.
  return `# ${guideLine(opts.packageName)}

## Tagline
${guideLine(opts.tagline)}

## Description
${guideBlock(opts.description)}

## Setup Requirements
${opts.setupRequirements === undefined || opts.setupRequirements === null ? "No environment variables required." : guideBlock(opts.setupRequirements)}

## Category
${guideLine(opts.category)}

## Use Cases
${guideLine(opts.useCases ?? "")}

## Features
${guideBlock(opts.features)}

## Getting Started
${guideBlock(opts.gettingStarted ?? "")}

## Tags
${guideLine(opts.tags)}

${opts.docsUrl ? `## Documentation URL\n${guideLine(opts.docsUrl)}\n` : ""}`;
}

// --- Dockerfile (remote hosting) ---

export function renderDockerfile(packageName: string): string {
  return `# Build stage: needs devDependencies (tsup lives there).
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime stage: production deps only.
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

ENV PORT=8000
EXPOSE \${PORT}

# ${ALLOWED_HOSTS_VAR} is required at run time and is deliberately NOT set in this image:
# a default baked in here would be wrong for every real deployment. Pass it when you
# start the container (docker run -e ${ALLOWED_HOSTS_VAR}=your.host ...). The server
# refuses to start without it.

CMD ["node", "dist/index.js"]
`;
}

// --- Add Tool (sentinel injection content) ---

export function renderAddToolImport(tool: ToolDef): string {
  const fnName = toolFunctionName(tool.name);
  const fileName = toolFileName(tool.name);
  return `import { ${fnName} } from "./tools/${fileName}.js";`;
}

export function renderAddToolRegistration(tool: ToolDef): string {
  return ["", ...registrationLines(tool, "")].join("\n");
}
