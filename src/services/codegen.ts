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
  opts: { paid?: boolean } = {}
): string {
  const deps: Record<string, string> = {
    "@modelcontextprotocol/sdk": "^1.27.0",
    zod: "^3.23.0",
  };
  if (opts.paid) {
    deps["@mcp_marketplace/license"] = "^1.1.0";
  }

  const pkg = {
    name: packageName,
    version: "1.0.0",
    description,
    type: "module",
    bin: { [packageName]: "dist/index.js" },
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    scripts: {
      build: "tsup",
      dev: "tsup --watch",
      test: "vitest run",
      prepublishOnly: "npm run build",
    },
    dependencies: deps,
    devDependencies: {
      "@types/node": "^22.0.0",
      tsup: "^8.0.0",
      typescript: "^5.5.0",
      vitest: "^2.0.0",
    },
    files: ["dist"],
    keywords: ["mcp", packageName, "ai-tools"],
    license: "MIT",
    engines: { node: ">=18" },
  };

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

export function renderTsupConfig(): string {
  return `import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  clean: true,
  dts: true,
  banner: { js: "#!/usr/bin/env node" },
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

  for (const tool of tools) {
    const fnName = snakeToCamel(tool.name);

    // Build zod schema object
    const schemaEntries: string[] = [];
    for (const p of tool.parameters) {
      let zodStr = zodType(p.type);
      if (!p.required) zodStr += ".optional()";
      zodStr += `.describe("${p.description.replace(/"/g, '\\"')}")`;
      schemaEntries.push(`    ${p.name}: ${zodStr},`);
    }

    // Build destructured params
    const paramNames = tool.parameters.map(p => p.name).join(", ");

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
    lines.push(``);
  }

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
  opts: { paid?: boolean } = {}
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
  opts: { paid?: boolean } = {}
): string | null {
  const lines: string[] = [];

  if (opts.paid) {
    lines.push(`# Required: License key from MCP Marketplace`);
    lines.push(`MCP_LICENSE_KEY=`);
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

## Features
${opts.features}

## Tags
${opts.tags}

${opts.docsUrl ? `## Documentation URL\n${opts.docsUrl}\n` : ""}`;
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
