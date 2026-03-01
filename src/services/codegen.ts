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
    "@modelcontextprotocol/sdk": "^1.27.0",
    zod: "^3.23.0",
  };
  if (opts.paid) {
    deps["@mcp_marketplace/license"] = "^1.1.0";
  }
  if (opts.hosting === "remote") {
    deps["express"] = "^5.2.0";
  }

  const devDeps: Record<string, string> = {
    "@types/node": "^22.0.0",
    tsup: "^8.0.0",
    typescript: "^5.5.0",
    vitest: "^2.0.0",
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
    engines: { node: ">=18" },
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
  target: "node18",
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
  lines.push(`import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";`);
  lines.push(`import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";`);

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

  lines.push(`const server = new McpServer({`);
  lines.push(`  name: "${packageName}",`);
  lines.push(`  version: "1.0.0",`);
  lines.push(`});`);
  lines.push(``);

  // Tool registrations
  lines.push(`// --- TOOLS ---`);
  lines.push(``);

  renderToolRegistrations(lines, tools);

  lines.push(`// --- END TOOLS ---`);
  lines.push(``);

  if (opts.paid) {
    lines.push(`withLicense(server, { slug: "${packageName}" });`);
    lines.push(``);
  }

  lines.push(`const transport = new StdioServerTransport();`);
  lines.push(`await server.connect(transport);`);

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
  lines.push(`import express from "express";`);
  lines.push(`import { randomUUID } from "node:crypto";`);
  lines.push(`import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";`);
  lines.push(`import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";`);
  lines.push(`import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";`);

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

  // Server factory function — each session gets its own McpServer instance
  lines.push(`function createServer(): McpServer {`);
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
  lines.push(`}`);
  lines.push(``);

  // Express app + Streamable HTTP transport
  lines.push(`const app = express();`);
  lines.push(`app.use(express.json());`);
  lines.push(``);
  lines.push(`const transports: Record<string, StreamableHTTPServerTransport> = {};`);
  lines.push(``);

  // POST handler
  lines.push(`app.post("/mcp", async (req, res) => {`);
  lines.push(`  const sessionId = req.headers["mcp-session-id"] as string | undefined;`);
  lines.push(``);
  lines.push(`  if (sessionId && transports[sessionId]) {`);
  lines.push(`    await transports[sessionId].handleRequest(req, res, req.body);`);
  lines.push(`    return;`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  if (!sessionId && isInitializeRequest(req.body)) {`);
  lines.push(`    const transport = new StreamableHTTPServerTransport({`);
  lines.push(`      sessionIdGenerator: () => randomUUID(),`);
  lines.push(`      onsessioninitialized: (id: string) => { transports[id] = transport; },`);
  lines.push(`    });`);
  lines.push(`    transport.onclose = () => {`);
  lines.push(`      if (transport.sessionId) delete transports[transport.sessionId];`);
  lines.push(`    };`);
  lines.push(`    const server = createServer();`);
  lines.push(`    await server.connect(transport);`);
  lines.push(`    await transport.handleRequest(req, res, req.body);`);
  lines.push(`    return;`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  res.status(400).json({`);
  lines.push(`    jsonrpc: "2.0",`);
  lines.push(`    error: { code: -32000, message: "Bad Request: No valid session ID" },`);
  lines.push(`    id: null,`);
  lines.push(`  });`);
  lines.push(`});`);
  lines.push(``);

  // GET handler
  lines.push(`app.get("/mcp", async (req, res) => {`);
  lines.push(`  const sessionId = req.headers["mcp-session-id"] as string | undefined;`);
  lines.push(`  if (!sessionId || !transports[sessionId]) {`);
  lines.push(`    res.status(400).send("Invalid or missing session ID");`);
  lines.push(`    return;`);
  lines.push(`  }`);
  lines.push(`  await transports[sessionId].handleRequest(req, res);`);
  lines.push(`});`);
  lines.push(``);

  // DELETE handler
  lines.push(`app.delete("/mcp", async (req, res) => {`);
  lines.push(`  const sessionId = req.headers["mcp-session-id"] as string | undefined;`);
  lines.push(`  if (!sessionId || !transports[sessionId]) {`);
  lines.push(`    res.status(400).send("Invalid or missing session ID");`);
  lines.push(`    return;`);
  lines.push(`  }`);
  lines.push(`  await transports[sessionId].handleRequest(req, res);`);
  lines.push(`});`);
  lines.push(``);

  // Start server
  lines.push(`const port = parseInt(process.env.PORT || "8000");`);
  lines.push(`app.listen(port, "0.0.0.0", () => {`);
  lines.push(`  console.log(\`MCP server running on http://0.0.0.0:\${port}/mcp\`);`);
  lines.push(`});`);
  lines.push(``);

  // Graceful shutdown
  lines.push(`process.on("SIGINT", async () => {`);
  lines.push(`  for (const id of Object.keys(transports)) {`);
  lines.push(`    await transports[id].close();`);
  lines.push(`    delete transports[id];`);
  lines.push(`  }`);
  lines.push(`  process.exit(0);`);
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
      schemaEntries.push(`${indent}    ${p.name}: ${zodStr},`);
    }

    // Build destructured params
    const paramNames = tool.parameters.map(p => p.name).join(", ");

    lines.push(`${indent}server.tool(`);
    lines.push(`${indent}  "${tool.name}",`);
    lines.push(`${indent}  "${tool.description.replace(/"/g, '\\"')}",`);
    lines.push(`${indent}  {`);
    for (const entry of schemaEntries) {
      lines.push(entry);
    }
    lines.push(`${indent}  },`);
    lines.push(`${indent}  async ({ ${paramNames} }) => {`);
    lines.push(`${indent}    try {`);
    lines.push(`${indent}      const result = await ${fnName}(${paramNames});`);
    lines.push(`${indent}      return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };`);
    lines.push(`${indent}    } catch (e) {`);
    lines.push(`${indent}      return { content: [{ type: "text", text: JSON.stringify({ error: (e as Error).message }) }] };`);
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
  return `FROM node:18-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN npm run build

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
    schemaEntries.push(`    ${p.name}: ${zodStr},`);
  }
  const paramNames = tool.parameters.map(p => p.name).join(", ");

  const lines: string[] = [];
  lines.push(``);
  lines.push(`server.tool(`);
  lines.push(`  "${tool.name}",`);
  lines.push(`  "${tool.description.replace(/"/g, '\\"')}",`);
  lines.push(`  {`);
  for (const entry of schemaEntries) {
    lines.push(entry);
  }
  lines.push(`  },`);
  lines.push(`  async ({ ${paramNames} }) => {`);
  lines.push(`    try {`);
  lines.push(`      const result = await ${fnName}(${paramNames});`);
  lines.push(`      return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };`);
  lines.push(`    } catch (e) {`);
  lines.push(`      return { content: [{ type: "text", text: JSON.stringify({ error: (e as Error).message }) }] };`);
  lines.push(`    }`);
  lines.push(`  }`);
  lines.push(`);`);

  return lines.join("\n");
}
