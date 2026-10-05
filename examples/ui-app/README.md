# ui-app — reference MCP App fixture

A hand-written MCP App (a tool that renders UI in the host through a `ui://` resource, per the
MCP Apps extension, `io.modelcontextprotocol/ui`). It is a **fixture** for templating into the
ts-mcp-creator generator. It is not a product and is not published: `examples/` is outside the
package's `files` list.

## What it does

| Piece | Name | Notes |
|---|---|---|
| Model-visible tool | `show_harvest` | Filters a fixed in-memory dataset by `category`. Returns text `content` **and** `structuredContent`. Linked to the UI through `_meta.ui.resourceUri`. |
| App-only tool | `filter_harvest` | `_meta.ui.visibility: ["app"]`. The UI calls it to re-filter. Its input is still validated server-side by a `.strict()` zod schema. |
| UI resource | `ui://harvest/mcp-app.html` | A single-file HTML bundle, served with `RESOURCE_MIME_TYPE` (`text/html;profile=mcp-app`) and an empty CSP domain allowlist. |

It is read-only and deterministic, with no network access and no clock.

## Layout

```
src/data.ts     dataset, zod schemas, pure filter, text fallback
src/server.ts   createServer() factory: registerAppTool x2 + registerAppResource
src/index.ts    Streamable HTTP (stateless, createMcpHandler); same shape as codegen renderRemoteIndex
src/stdio.ts    stdio entry (serveStdio, same factory)
ui/             vanilla TS UI (vite + vite-plugin-singlefile)
tests/          in-process protocol tests (raw 2026-07-28 JSON-RPC against createMcpHandler)
scripts/        smoke.sh (curl against a running server), basic-host-e2e.mjs (Playwright)
```

**Build output:** the server goes to `dist/`, which tsup's `clean: true` wipes on every build. The
UI goes to `dist-ui/`, a sibling that the server build never touches. The server resolves the
UI file at `../dist-ui/mcp-app.html` relative to its own module. If the file is missing,
`resources/read` returns a JSON-RPC error saying `UI bundle not built (run npm run build:ui)`.
The full path is logged on the server only.

## Build / run / test

Every block below names its working directory. `FIXTURE` is this directory
(`.../ts-mcp-creator/examples/ui-app`); `WORK` is any scratch directory outside the repo.

```bash
# Terminal 1 — cwd: $FIXTURE
cd "$FIXTURE"
npm ci
npm run build     # typecheck (server + ui) -> vite build (dist-ui/) -> tsup (dist/). Does NOT run tests.
npm test          # vitest, incl. the no-HTML-sink check on ui/mcp-app.ts. Needs dist-ui/ (build first).

# HTTP. Binds 0.0.0.0. It refuses to start without MCP_ALLOWED_HOSTS (fail closed, same as the generator).
PORT=3001 MCP_ALLOWED_HOSTS=localhost,127.0.0.1 npm start

# Terminal 2 — cwd: $FIXTURE. Contract check; exits non-zero on any mismatch.
cd "$FIXTURE" && scripts/smoke.sh http://localhost:3001/mcp

# stdio instead of HTTP — cwd: $FIXTURE
cd "$FIXTURE" && npm run start:stdio
```

`MCP_CORS_ORIGINS`: an optional comma-separated list of exact origins. It is only needed when a
**browser-based** host calls the server cross-origin (for example ext-apps basic-host on
`http://localhost:8080`). When it is unset, the server sends no CORS headers. It never sends a
wildcard.

### In a real MCP Apps host (ext-apps basic-host, tag v2.0.3)

Three terminals. Ports: 3001 (this server), 8080 + 8081 (basic-host), 3999 (the e2e script's own CSP
probe target; override with `PROBE_PORT`).

```bash
# Terminal A — cwd: $WORK. One-time setup, then run basic-host.
cd "$WORK"
git clone --branch v2.0.3 --depth 1 https://github.com/modelcontextprotocol/ext-apps.git
cp -R ext-apps/examples/basic-host "$WORK/basic-host"
cd "$WORK/basic-host"
# Outside the monorepo workspace these are no longer hoisted from the root:
npm pkg set dependencies.@modelcontextprotocol/ext-apps=2.0.3
npm install && npm install -D @types/cors cross-env tsx
NODE_ENV=development npm run build
SERVERS='["http://localhost:3001/mcp"]' node --import tsx serve.ts   # :8080 host, :8081 sandbox

# Terminal B — cwd: $FIXTURE. The server, with CORS for the host page.
cd "$FIXTURE"
npm run build
PORT=3001 MCP_ALLOWED_HOSTS=localhost,127.0.0.1 MCP_CORS_ORIGINS=http://localhost:8080 npm start

# Terminal C — cwd: $FIXTURE. e2e (needs Google Chrome installed). Exits 1 if any check fails.
cd "$FIXTURE"
npm i --no-save playwright
mkdir -p shots && node scripts/basic-host-e2e.mjs ./shots
```

## Pinned versions

| Package | Range | Resolved in lockfile |
|---|---|---|
| `@modelcontextprotocol/ext-apps` | **2.0.3 exact** | 2.0.3 |
| `@modelcontextprotocol/server` | ^2.0.0 (as the generator emits) | 2.2.0 |
| `@modelcontextprotocol/node` / `express` | ^2.0.0 | 2.1.0 / 2.0.1 |
| `@modelcontextprotocol/client` / `core` | ^2.0.0 (required peers of ext-apps) | 2.2.0 / 2.2.0 |
| `zod` | ^4.2.0 (ext-apps peer floor; the generator emits ^4.0.0) | 4.6.5 |
| `vite` / `vite-plugin-singlefile` | ^6.0.0 / ^2.3.0 | 6.4.3 / 2.3.3 |

SDK v2 only. There is no `@modelcontextprotocol/sdk` (v1) anywhere.

## Security properties (each is visible in code)

- The UI writes tool data only with `textContent`, `createElement` and `replaceChildren`. No
  HTML-string sink is used. **`npm test`** (not `npm run build`) fails if `innerHTML`, `outerHTML`,
  `insertAdjacentHTML`, `document.write`, `eval(` or `new Function(` appears in `ui/mcp-app.ts`.
  The UI also shape-checks `structuredContent` and allowlists `category` before using it as a
  class name.
- `visibility: ["app"]` hides a tool from the model. It is **not** access control. `filter_harvest`
  rejects bad input server-side with zod: wrong enum, negative, non-integer, >10000, missing field
  or unknown key. The UI form uses `novalidate` on purpose, so that out-of-range input reaches the
  server and the user sees the server's rejection.
- No network. The resource declares `csp: { connectDomains: [], resourceDomains: [] }`, and the HTML
  also carries its own `connect-src 'none'` meta CSP.
- Degradation: every tool result has a complete text `content` answer, so a host that ignores UI
  still works. There is no `oninitialized` or `getClientCapabilities` branching, because the server
  follows the stateless per-request model.

## What is proven vs not

Proven. Evidence is in the Workforce dev-docs worker report `ui-app-fixture-builder.md`.

- `npm ci && npm run build` succeeds from a clean copy. `dist-ui/mcp-app.html` survives a tsup clean
  rebuild.
- Over curl on the **2026-07-28 modern path**: `tools/list` carries `_meta.ui.resourceUri`,
  `resources/read` returns the MCP Apps mime type, `tools/call` returns text and
  `structuredContent`, and invalid app-only input is rejected.
- basic-host v2.0.3 renders the UI. basic-host hides `filter_harvest` from its tool list. The UI
  calls `filter_harvest` and re-renders, and it shows the server's rejection of `minCrates: -5`.
- Overlapping filter calls: when an older request resolves after a newer one, the older response
  is dropped (`ui/latest.ts`). The e2e script delays the older call to force this ordering, and it
  failed when the guard was removed.
- CSP: from inside the app frame, a `fetch` and an `<img>` load to a target that is reachable and
  CORS-open are both blocked. The e2e script confirms this with `securitypolicyviolation` events
  (`connect-src`, `img-src`). The null-tests showed three things:
  - With both CSP layers loosened, both loads succeed and the e2e fails.
  - The host policy alone still blocks both.
  - Our meta CSP alone still blocks both.
- `scripts/smoke.sh` asserts the response contracts and exits non-zero on a mismatch. It failed
  on a deliberately wrong expectation, on a server without the `min(0)` input check, and on a dead
  port.
- 13 vitest cases. Every hand mutation turned at least one case red.

Proven in Claude Desktop (2026-10-01, stdio via `claude_desktop_config.json`):

- Claude Desktop fetched the UI (`resources/read`), called `show_harvest`, and rendered the chart,
  table and filter controls inline in the chat (Grant's screenshot).
- The in-chat filter (category=vegetable) called the app-only `filter_harvest` back on the server
  and re-rendered with `source: filter_harvest` — a full App -> server round trip in a production host.
- Receipt: `~/Library/Logs/Claude/mcp-server-ui-app-fixture.log` — `resources/read` id=3 + `tools/call`
  id=4 at 15:56:33Z, second `tools/call` id=5 at 15:58:53Z (the filter), all `result`.
- Protocol: Claude Desktop's stdio client used the 2025-11-25 handshake, so this is again the legacy path.

Not proven:

- **basic-host speaks the LEGACY 2025-11-25 protocol** (an `initialize` handshake) with client
  2.0.0 and also with client 2.2.0. The in-host render therefore went through createMcpHandler's
  stateless legacy fallback. The modern 2026-07-28 path is proven only by curl and vitest, not by
  a rendering host.
- ChatGPT or any production host other than Claude Desktop (see "Proven in Claude Desktop" below).
- Host theming and fonts (`applyHostStyleVariables` and related) were wired but not checked
  visually against a themed host.
- Remote deployment: the server was only run on localhost.
