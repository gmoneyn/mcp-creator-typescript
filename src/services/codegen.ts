/**
 * codegen.ts — Pure template functions that generate TypeScript MCP server files.
 * No I/O — every function returns a string.
 */

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

/** Map user type strings to Zod schemas */
function zodType(type: string): string {
  const map: Record<string, string> = {
    string: "z.string()",
    str: "z.string()",
    integer: "z.number().int()",
    int: "z.number().int()",
    number: "z.number()",
    float: "z.number()",
    boolean: "z.boolean()",
    bool: "z.boolean()",
  };
  return map[type.toLowerCase()] ?? "z.string()";
}

/** Map user type strings to TypeScript types */
function tsType(type: string): string {
  const map: Record<string, string> = {
    string: "string",
    str: "string",
    integer: "number",
    int: "number",
    number: "number",
    float: "number",
    boolean: "boolean",
    bool: "boolean",
  };
  return map[type.toLowerCase()] ?? "string";
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
    pkg.bin = { [packageName]: "dist/index.js" };
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
  lines.push(` * ${packageName} — MCP server.`);
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
    const fnName = snakeToCamel(tool.name);
    const fileName = tool.name.replace(/_/g, "-");
    lines.push(`import { ${fnName} } from "./tools/${fileName}.js";`);
  }
  lines.push(`// --- END IMPORTS ---`);
  lines.push(``);

  // MCP 2026-07-28: serveStdio owns the connection and takes a FACTORY. One
  // instance is pinned per connection; the same factory also serves 2025-era
  // clients, so the two eras can never drift apart.
  lines.push(`serveStdio(() => {`);
  lines.push(`  const server = new McpServer({`);
  lines.push(`    name: "${packageName}",`);
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
  lines.push(` * ${packageName} — Remote MCP server (Streamable HTTP).`);
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
    const fnName = snakeToCamel(tool.name);
    const fileName = tool.name.replace(/_/g, "-");
    lines.push(`import { ${fnName} } from "./tools/${fileName}.js";`);
  }
  lines.push(`// --- END IMPORTS ---`);
  lines.push(``);

  // MCP 2026-07-28: no sessions. createMcpHandler takes a factory and serves
  // each request independently; the same factory backs the stateless legacy
  // fallback, so the modern and 2025-era paths cannot drift apart.
  lines.push(`const handler = createMcpHandler(() => {`);
  lines.push(`  const server = new McpServer({`);
  lines.push(`    name: "${packageName}",`);
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
  lines.push(``);

  // Express app. NOTE: createMcpExpressApp only auto-applies DNS-rebinding /
  // Host-header protection for LOCALHOST hosts. Binding 0.0.0.0 (required for
  // container/hosted deploys) DISABLES it, so we require an explicit allowlist
  // and warn loudly when it is absent rather than claiming protection we lost.
  lines.push(`const allowedHosts = (process.env.MCP_ALLOWED_HOSTS ?? "")`);
  lines.push(`  .split(",").map((s) => s.trim()).filter(Boolean);`);
  lines.push(`if (allowedHosts.length === 0) {`);
  lines.push(`  // FAIL CLOSED — a warning does not protect anything. Binding 0.0.0.0 turns off`);
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
  lines.push(`// its 3rd arg — and it deliberately IGNORES a function there (Express's`);
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
    const fnName = snakeToCamel(tool.name);

    // Build zod schema object
    const schemaEntries: string[] = [];
    for (const p of tool.parameters) {
      let zodStr = zodType(p.type);
      if (!p.required) zodStr += ".optional()";
      zodStr += `.describe("${p.description.replace(/"/g, '\\"')}")`;
      schemaEntries.push(`${indent}      ${p.name}: ${zodStr},`);
    }

    // Build destructured params
    const paramNames = tool.parameters.map(p => p.name).join(", ");

    // MCP 2026-07-28 / SDK v2: registerTool(name, config, cb). The v1
    // server.tool(name, description, shape, cb) signature is gone.
    lines.push(`${indent}server.registerTool(`);
    lines.push(`${indent}  "${tool.name}",`);
    lines.push(`${indent}  {`);
    lines.push(`${indent}    description: "${tool.description.replace(/"/g, '\\"')}",`);
    lines.push(`${indent}    inputSchema: z.object({`);
    for (const entry of schemaEntries) {
      lines.push(entry);
    }
    lines.push(`${indent}    }),`);
    lines.push(`${indent}  },`);
    lines.push(`${indent}  async ({ ${paramNames} }) => {`);
    lines.push(`${indent}    try {`);
    lines.push(`${indent}      const result = await ${fnName}(${paramNames});`);
    lines.push(`${indent}      return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };`);
    lines.push(`${indent}    } catch (e) {`);
    lines.push(`${indent}      return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }] };`);
    lines.push(`${indent}    }`);
    lines.push(`${indent}  }`);
    lines.push(`${indent});`);
    lines.push(``);
  }
}

// --- Tool Module ---

export function renderToolModule(tool: ToolDef): string {
  const fnName = snakeToCamel(tool.name);

  // Build function params
  const params = tool.parameters
    .map(p => {
      const ts = tsType(p.type);
      return p.required !== false ? `${p.name}: ${ts}` : `${p.name}?: ${ts}`;
    })
    .join(", ");

  return `/**
 * ${tool.name} — ${tool.description}
 * Returns: ${tool.returns}
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
  const fnName = snakeToCamel(tool.name);
  const fileName = tool.name.replace(/_/g, "-");

  // Build test args
  const args = tool.parameters
    .filter(p => p.required !== false)
    .map(p => {
      if (tsType(p.type) === "number") return "1";
      if (tsType(p.type) === "boolean") return "true";
      return `"test"`;
    })
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

export function renderReadme(
  packageName: string,
  description: string,
  tools: ToolDef[],
  opts: { paid?: boolean; hosting?: string } = {}
): string {
  const lines: string[] = [];

  lines.push(`# ${packageName}`);
  lines.push(``);
  lines.push(description);
  lines.push(``);

  if (opts.paid) {
    lines.push(`## Requirements`);
    lines.push(``);
    lines.push(`- **License key** — purchase from [MCP Marketplace](https://mcpmarketplace.com) to get your \`MCP_LICENSE_KEY\``);
    lines.push(`- Node.js 18+`);
    lines.push(``);
  }

  if (opts.hosting === "remote") {
    // Remote: show URL-based config and deployment instructions
    lines.push(`## Usage`);
    lines.push(``);
    lines.push(`Add to your MCP client config:`);
    lines.push(``);
    lines.push("```json");
    const remoteConfig: Record<string, unknown> = {
      mcpServers: {
        [packageName]: {
          url: `https://your-server.com/mcp`,
          ...(opts.paid
            ? { headers: { Authorization: "Bearer mcp_live_your_key_here" } }
            : {}),
        },
      },
    };
    lines.push(JSON.stringify(remoteConfig, null, 2));
    lines.push("```");
    lines.push(``);

    lines.push(`## Deployment`);
    lines.push(``);
    lines.push("```bash");
    lines.push(`docker build -t ${packageName} .`);
    lines.push(`docker run -p 8000:8000 ${packageName}`);
    lines.push("```");
    lines.push(``);
    lines.push(`Then point your MCP client at \`http://localhost:8000/mcp\` to test.`);
    lines.push(``);
    lines.push(`Deploy the Docker container to Railway, Fly.io, AWS, or any cloud provider.`);
    lines.push(``);
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
    lines.push(`| \`${t.name}\` | ${t.description} |`);
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
    lines.push(`# Required: License key from MCP Marketplace`);
    lines.push(`MCP_LICENSE_KEY=`);
    lines.push(``);
  }

  if (opts.hosting === "remote") {
    lines.push(`# Server port (optional, default 8000)`);
    lines.push(`PORT=8000`);
    lines.push(``);
  }

  if (envVars && envVars.length > 0) {
    for (const v of envVars) {
      lines.push(`# ${v.description}${v.required ? " (required)" : " (optional)"}`);
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
  return `# ${opts.packageName}

## Tagline
${opts.tagline}

## Description
${opts.description}

## Setup Requirements
${opts.setupRequirements ?? "No environment variables required."}

## Category
${opts.category}

## Use Cases
${opts.useCases ?? ""}

## Features
${opts.features}

## Getting Started
${opts.gettingStarted ?? ""}

## Tags
${opts.tags}

${opts.docsUrl ? `## Documentation URL\n${opts.docsUrl}\n` : ""}`;
}

// --- Dockerfile (remote hosting) ---

export function renderDockerfile(packageName: string): string {
  return `# Build stage — needs devDependencies (tsup lives there).
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime stage — production deps only.
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

ENV PORT=8000
EXPOSE \${PORT}

CMD ["node", "dist/index.js"]
`;
}

// --- Add Tool (sentinel injection content) ---

export function renderAddToolImport(tool: ToolDef): string {
  const fnName = snakeToCamel(tool.name);
  const fileName = tool.name.replace(/_/g, "-");
  return `import { ${fnName} } from "./tools/${fileName}.js";`;
}

export function renderAddToolRegistration(tool: ToolDef): string {
  const fnName = snakeToCamel(tool.name);
  const schemaEntries: string[] = [];
  for (const p of tool.parameters) {
    let zodStr = zodType(p.type);
    if (!p.required) zodStr += ".optional()";
    zodStr += `.describe("${p.description.replace(/"/g, '\\"')}")`;
    schemaEntries.push(`      ${p.name}: ${zodStr},`);
  }
  const paramNames = tool.parameters.map(p => p.name).join(", ");

  const lines: string[] = [];
  lines.push(``);
  lines.push(`server.registerTool(`);
  lines.push(`  "${tool.name}",`);
  lines.push(`  {`);
  lines.push(`    description: "${tool.description.replace(/"/g, '\\"')}",`);
  lines.push(`    inputSchema: z.object({`);
  for (const entry of schemaEntries) {
    lines.push(entry);
  }
  lines.push(`    }),`);
  lines.push(`  },`);
  lines.push(`  async ({ ${paramNames} }) => {`);
  lines.push(`    try {`);
  lines.push(`      const result = await ${fnName}(${paramNames});`);
  lines.push(`      return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };`);
  lines.push(`    } catch (e) {`);
  lines.push(`      return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }] };`);
  lines.push(`    }`);
  lines.push(`  }`);
  lines.push(`);`);

  return lines.join("\n");
}
