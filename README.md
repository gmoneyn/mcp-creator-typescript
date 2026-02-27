# mcp-creator-typescript

Scaffold, build, and publish TypeScript MCP servers to npm. The TypeScript companion to [mcp-creator-python](https://pypi.org/project/mcp-creator-python/).

## Installation

```json
{
  "mcpServers": {
    "mcp-creator-typescript": {
      "command": "npx",
      "args": ["-y", "mcp-creator-typescript"]
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `get_creator_profile` | Load persistent profile (setup state, npm username, project history) |
| `update_creator_profile` | Save profile updates (npm/GitHub username, add project) |
| `check_setup` | Verify Node.js ≥ 18, npm, git, gh CLI, npm auth |
| `check_npm_name` | Check npm package name availability |
| `scaffold_server` | Generate complete TypeScript MCP server project from tool definitions |
| `add_tool` | Add a new tool to an existing scaffolded project |
| `build_package` | Run `npm run build` (tsup) |
| `publish_package` | Run `npm publish` to npm |
| `setup_github` | `git init` + `gh repo create` + push |
| `generate_launchguide` | Generate LAUNCHGUIDE.md for MCP Marketplace submission |

## How It Works

1. **`check_setup`** — Verify your environment has all required tools
2. **`check_npm_name`** — Find an available npm package name
3. **`scaffold_server`** — Generate a complete project with tool stubs, tests, and config
4. **Implement** — Replace the TODO stubs in `src/tools/` with your real logic
5. **`build_package`** — Build with tsup
6. **`publish_package`** — Publish to npm
7. **`setup_github`** — Create a GitHub repo
8. **`generate_launchguide`** — Create LAUNCHGUIDE.md for marketplace submission

## Generated Project Stack

- `@modelcontextprotocol/sdk` + `zod` — MCP server + parameter validation
- `tsup` — Fast TypeScript bundler (ESM, shebang, node18)
- `vitest` — Test runner
- Optional: `@mcp_marketplace/license` — License SDK for paid servers

## Tool Definition Format

```json
[
  {
    "name": "get_weather",
    "description": "Get current weather for a city",
    "parameters": [
      { "name": "city", "type": "string", "required": true, "description": "City name" },
      { "name": "units", "type": "string", "required": false, "description": "Temperature units (C or F)" }
    ],
    "returns": "JSON weather data"
  }
]
```
