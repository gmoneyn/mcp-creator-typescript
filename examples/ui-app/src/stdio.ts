/** ui-app-fixture — stdio entry. Same factory as the HTTP server. */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.js";

serveStdio(createServer);
