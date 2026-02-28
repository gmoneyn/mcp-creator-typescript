/**
 * mcp-creator-typescript — Scaffold, build, and publish TypeScript MCP servers to npm.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { getCreatorProfile, updateCreatorProfile } from "./tools/creator-profile.js";
import { checkSetup } from "./tools/check-setup.js";
import { checkNpmNameTool } from "./tools/check-npm-name.js";
import { scaffoldServer } from "./tools/scaffold-server.js";
import { addTool } from "./tools/add-tool.js";
import { buildPackage } from "./tools/build-package.js";
import { publishPackage } from "./tools/publish-package.js";
import { setupGithub } from "./tools/setup-github.js";
import { generateLaunchguide } from "./tools/generate-launchguide.js";

const server = new McpServer({
  name: "mcp-creator-typescript",
  version: "1.0.0",
});

// --- TOOLS ---

server.tool(
  "get_creator_profile",
  "Load your persistent creator profile from ~/.mcp-creator-typescript/profile.json. Shows setup state, npm username, GitHub username, and project history.",
  {},
  async () => {
    try {
      const result = await getCreatorProfile();
      return { content: [{ type: "text", text: result }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ error: (e as Error).message }) }] };
    }
  }
);

server.tool(
  "update_creator_profile",
  "Update your persistent creator profile. Save setup state, npm username, GitHub username, default output directory, or add a project to history.",
  {
    setup_complete: z.boolean().optional().describe("Mark setup as complete"),
    npm_username: z.string().optional().describe("Your npm username"),
    github_username: z.string().optional().describe("Your GitHub username"),
    default_output_dir: z.string().optional().describe("Default directory for new projects"),
    add_project: z.string().optional().describe('JSON string: {"name": "...", "npmUrl": "...", "githubUrl": "...", "description": "..."}'),
  },
  async ({ setup_complete, npm_username, github_username, default_output_dir, add_project }) => {
    try {
      const result = await updateCreatorProfile(setup_complete, npm_username, github_username, default_output_dir, add_project);
      return { content: [{ type: "text", text: result }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ error: (e as Error).message }) }] };
    }
  }
);

server.tool(
  "check_setup",
  "Verify your development environment. Checks: Node.js >= 18, npm, npm auth (npm whoami), git, and GitHub CLI (gh). Reports what's missing and how to fix it.",
  {},
  async () => {
    try {
      const result = await checkSetup();
      return { content: [{ type: "text", text: result }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ error: (e as Error).message }) }] };
    }
  }
);

server.tool(
  "check_npm_name",
  "Check if an npm package name is available. Queries the npm registry — 404 means available, 200 means taken. Suggests alternatives if taken.",
  {
    package_name: z.string().describe("The npm package name to check (e.g. 'my-mcp-server')"),
  },
  async ({ package_name }) => {
    try {
      const result = await checkNpmNameTool(package_name);
      return { content: [{ type: "text", text: result }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ error: (e as Error).message }) }] };
    }
  }
);

server.tool(
  "scaffold_server",
  "Generate a complete, runnable TypeScript MCP server project. Creates: package.json, tsconfig, tsup config, src/index.ts with tool registrations, tool modules with TODO stubs, tests, and README. Supports optional license SDK for paid servers. Use hosting='remote' to generate a Streamable HTTP server with Dockerfile for cloud deployment.",
  {
    package_name: z.string().describe("npm package name (e.g. 'my-weather-mcp')"),
    description: z.string().describe("Short description of what the server does"),
    tools: z.string().describe('JSON array of tool definitions: [{"name": "tool_name", "description": "...", "parameters": [{"name": "param", "type": "string", "required": true, "description": "..."}], "returns": "..."}]'),
    output_dir: z.string().optional().describe("Parent directory for the project (default: current directory)"),
    env_vars: z.string().optional().describe('JSON array of env vars: [{"name": "API_KEY", "description": "...", "required": true}]'),
    paid: z.boolean().optional().describe("Include @mcp_marketplace/license SDK for paid servers"),
    hosting: z.string().optional().describe("'local' (default, stdio) or 'remote' (Streamable HTTP for cloud deployment with Dockerfile)"),
  },
  async ({ package_name, description, tools, output_dir, env_vars, paid, hosting }) => {
    try {
      const result = await scaffoldServer(package_name, description, tools, output_dir, env_vars, paid, hosting);
      return { content: [{ type: "text", text: result }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ error: (e as Error).message }) }] };
    }
  }
);

server.tool(
  "add_tool",
  "Add a new tool to an existing scaffolded TypeScript MCP project. Generates the tool file and test, then injects the import and registration into src/index.ts using sentinel comments.",
  {
    project_dir: z.string().describe("Path to the existing project directory"),
    tool: z.string().describe('JSON tool definition: {"name": "tool_name", "description": "...", "parameters": [...], "returns": "..."}'),
  },
  async ({ project_dir, tool }) => {
    try {
      const result = await addTool(project_dir, tool);
      return { content: [{ type: "text", text: result }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ error: (e as Error).message }) }] };
    }
  }
);

server.tool(
  "build_package",
  "Run 'npm run build' (tsup) in a project directory. Installs dependencies first if node_modules is missing. Returns build output and list of built files.",
  {
    project_dir: z.string().describe("Path to the project directory"),
  },
  async ({ project_dir }) => {
    try {
      const result = await buildPackage(project_dir);
      return { content: [{ type: "text", text: result }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ error: (e as Error).message }) }] };
    }
  }
);

server.tool(
  "publish_package",
  "Run 'npm publish' to publish the package to npm. Requires npm login and a successful build (dist/ must exist).",
  {
    project_dir: z.string().describe("Path to the project directory"),
  },
  async ({ project_dir }) => {
    try {
      const result = await publishPackage(project_dir);
      return { content: [{ type: "text", text: result }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ error: (e as Error).message }) }] };
    }
  }
);

server.tool(
  "setup_github",
  "Initialize a git repo, create a GitHub repository (public or private), and push. Uses the gh CLI.",
  {
    project_dir: z.string().describe("Path to the project directory"),
    repo_name: z.string().describe("GitHub repo name (e.g. 'my-mcp-server')"),
    description: z.string().optional().describe("Repo description"),
    private: z.boolean().optional().describe("Create as private repo (default: public)"),
  },
  async ({ project_dir, repo_name, description, private: isPrivate }) => {
    try {
      const result = await setupGithub(project_dir, repo_name, description, isPrivate);
      return { content: [{ type: "text", text: result }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ error: (e as Error).message }) }] };
    }
  }
);

server.tool(
  "generate_launchguide",
  "Generate a LAUNCHGUIDE.md file for submitting your MCP server to the MCP Marketplace. Includes tagline, description, features, category, and tags.",
  {
    project_dir: z.string().describe("Path to the project directory"),
    package_name: z.string().describe("npm package name"),
    tagline: z.string().describe("Short tagline (max 100 chars)"),
    description: z.string().describe("Full description of the server"),
    category: z.string().describe("Marketplace category (e.g. 'Developer Tools', 'SEO', 'Data')"),
    features: z.string().describe("Bullet-point list of features"),
    tags: z.string().describe("Comma-separated tags (max 30)"),
    setup_requirements: z.string().optional().describe("Setup requirements (env vars, API keys, etc.)"),
    docs_url: z.string().optional().describe("URL to documentation"),
  },
  async ({ project_dir, package_name, tagline, description, category, features, tags, setup_requirements, docs_url }) => {
    try {
      const result = await generateLaunchguide(project_dir, package_name, tagline, description, category, features, tags, setup_requirements, docs_url);
      return { content: [{ type: "text", text: result }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ error: (e as Error).message }) }] };
    }
  }
);

// --- END TOOLS ---

const transport = new StdioServerTransport();
await server.connect(transport);
