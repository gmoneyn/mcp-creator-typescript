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
| `publish_package` | Run `npm publish` to npm (project directories only) |
| `setup_github` | `git init` + `gh repo create` (always private) + push |
| `generate_launchguide` | Generate LAUNCHGUIDE.md for MCP Marketplace submission |

## How It Works

1. **`check_setup`** — Verify your environment has all required tools
2. **`check_npm_name`** — Find an available npm package name
3. **`scaffold_server`** — Generate a complete project with tool stubs, tests, and config
4. **Implement** — Replace the TODO stubs in `src/tools/` with your real logic
5. **`build_package`** — Build with tsup
6. **`publish_package`** — Publish to npm
7. **`setup_github`** — Create a private GitHub repo (making it public is your own step afterwards)
8. **`generate_launchguide`** — Create LAUNCHGUIDE.md for marketplace submission

## Safety limits

These tools are called by a language model, so the directory they are pointed at, and every argument, is treated as untrusted input.

- `setup_github`, `publish_package`, `build_package` and `add_tool` only run in a project directory: it must contain a `package.json`, and must not be your home directory, a directory above it, or a filesystem root. Directories are compared by identity, so a different spelling of the same directory (letter case, a symlink) is still recognised.
- `setup_github` **never creates a public repository**. `private: false` is accepted and ignored. Making a repository public is your own step: `gh repo edit <owner>/<name> --visibility public --accept-visibility-change-consequences` (a free marketplace listing needs a public repository). It also never pushes to a repository that already exists.
- `setup_github` stages every file in the directory, so it requires a `.gitignore` that is there already and that works: git must ignore `node_modules/` and `.env`. It refuses rather than creating or editing one.
- `setup_github` refuses when a file that looks like a secret would be committed, is already tracked, or is anywhere in the existing git history (a file deleted or ignored later is still in the commits that get pushed). Names treated as secrets: `.env`, `.env.*`, `.envrc`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.p8`, `*.ppk`, `*.keystore`, `*.jks`, `*.kdbx`, `*.tfvars`, `*.tfstate`, `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`, `credentials` and `credentials.{json,ini,csv,yml,yaml,txt,xml}`, `service-account*.json`, `.npmrc`, `.pypirc`, `.netrc`, `.pgpass`, `.htpasswd`, `.git-credentials`, `kubeconfig`, `.aws/credentials`, `.docker/config.json`. Git decides whether a file would be committed (`git check-ignore`). The refusal names the files.
- `setup_github` only acts on the project's own `.git` directory. A linked worktree, a submodule checkout, or a `.git` that is a file or a link is refused, because staging there would change another repository.
- A template of a secret file is allowed by name: any of the names above with `.example`, `.sample`, `.template` or `.dist` in it (`.env.example`, `.env.template`, `service-account.example.json`). Its content is checked instead: a value shaped like a live credential (a private-key block, or a well-known token prefix followed by a long token) is refused, naming the file and line. Placeholders and empty values are fine.
- `publish_package` packs the project once into a temporary directory, refuses if any file in that package looks like a secret (or is a template holding a live-looking credential), and publishes that exact tarball. No lifecycle script runs, so build first with `build_package`.
- `build_package` and `publish_package` refuse when `dist` or `node_modules` is a symbolic link: the build empties its output directory before writing to it.
- No tool writes through a symbolic link or over a file that has a second hard link, and an existing file is replaced by writing a new one and renaming it into place.
- git, gh and npm are started without any `GIT_*` or `npm_config_*` environment variable and without `NODE_OPTIONS`, so a stray `GIT_DIR` or registry setting cannot redirect them. Your saved logins and tokens (`~/.gitconfig`, `gh auth`, `~/.npmrc`, `GH_TOKEN`, `NPM_TOKEN`) are used as usual.
- `scaffold_server`, `add_tool` and `generate_launchguide` only write inside the target project directory. A package name, tool name or symlink that leads outside it is refused, and nothing is written.
- `scaffold_server` never overwrites: it refuses a target directory that already exists and is not empty. To regenerate, scaffold into a new directory. `add_tool` extends an existing project and refuses a tool whose file is already there.
- Descriptions and other free text are written into the generated `README.md` and `LAUNCHGUIDE.md` as text. They cannot add a heading, a code block, a link, raw HTML, or a section of the launch guide.
- Names are checked before anything is generated. Package name: lowercase letters, digits, `-`, `_`, `.`, optional `@scope/`. Tool name: letters, digits, `_`, `-`, starting with a letter, at most 64 characters. Parameter names: plain identifiers. Repository name: letters, digits, `-`, `_`, `.`, no owner prefix.

## Generated Project Stack

- `@modelcontextprotocol/server` (SDK v2, stateless MCP 2026-07-28) + `zod`: MCP server + parameter validation
- Remote servers add `@modelcontextprotocol/express`, `@modelcontextprotocol/node` and `express`, and require `MCP_ALLOWED_HOSTS` to start
- `tsup`: fast TypeScript bundler (ESM, shebang for local servers, node20)
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

Rules for a definition (anything else is refused with a message, before any file is written):

- `name`: letters, digits, `_` and `-`, starting with a letter. `get_weather` and `get-weather` both generate a function called `getWeather`, so a project can hold only one of them.
- `type`: one of `string`, `str`, `integer`, `int`, `number`, `float`, `boolean`, `bool`.
- `required`: `true` or `false`. Omitted means `true`.
- Parameter names are plain identifiers and may not be a name the generated code already uses (for example `result`, `JSON`, `constructor`).
- The generated function takes required parameters first, then optional ones, each group in the order you declared it. The generated call site and test use the same order.
- Remote scaffolds use a Docker image name derived from the package name (`@acme/weather` becomes `acme-weather`).
