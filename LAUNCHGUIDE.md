# mcp-creator-typescript

## Tagline
Scaffold, build, and publish TypeScript MCP servers to npm — conversationally

## Description
The TypeScript MCP Creator lets you build and publish MCP servers to npm entirely through conversation with your AI assistant. Check your environment, pick a package name, scaffold a complete project with tool stubs, add tools incrementally, build, publish to npm, create a GitHub repo, and generate a LAUNCHGUIDE.md for marketplace submission — all without leaving your AI editor. The TypeScript companion to mcp-creator-python.

## Setup Requirements
No environment variables required. Needs Node.js 18+, npm, git, and gh CLI installed.

## Category
Developer Tools

## Features
- Check your dev environment (Node.js, npm, git, gh CLI, npm auth) in one command
- Check npm package name availability before committing to a name
- Scaffold a complete TypeScript MCP server project from tool definitions
- Generated projects use @modelcontextprotocol/sdk, zod, tsup, and vitest
- Optionally include @mcp_marketplace/license SDK for paid servers
- Add new tools to existing projects with automatic import and registration injection
- Build packages with tsup (ESM, shebang, node18 target)
- Publish directly to npm
- Create GitHub repos (public or private) and push in one step
- Generate LAUNCHGUIDE.md for MCP Marketplace submission
- Persistent creator profile tracks setup state and project history

## Getting Started
- "Check if my environment is ready to build MCP servers"
- "Is the npm name 'my-weather-mcp' available?"
- "Scaffold a new MCP server called 'my-weather-mcp' with a get_forecast tool"
- "Add a new tool called 'get_alerts' to my project"
- "Build and publish my MCP server to npm"
- "Create a GitHub repo for my project and push it"
- "Generate a LAUNCHGUIDE.md for marketplace submission"
- Tool: check_setup — Verify Node.js, npm, git, gh CLI
- Tool: check_npm_name — Check npm package name availability
- Tool: scaffold_server — Generate complete TypeScript MCP project
- Tool: add_tool — Add a tool to an existing project
- Tool: build_package — Run npm run build (tsup)
- Tool: publish_package — Publish to npm
- Tool: setup_github — Create GitHub repo and push
- Tool: generate_launchguide — Generate LAUNCHGUIDE.md

## Tags
mcp, mcp-creator, scaffold, typescript, npm, cli, developer-tools, code-generation, build-tool, publish, ai-tools, model-context-protocol

## Documentation URL
https://github.com/gmoneyn/mcp-creator-typescript
