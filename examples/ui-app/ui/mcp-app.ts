/**
 * Harvest UI — vanilla TS MCP App.
 *
 * SECURITY: every piece of tool data is written with textContent / DOM APIs
 * (createElement, replaceChildren). No HTML-string sink is used anywhere in
 * this file, so a crop name like "<img src=x onerror=...>" renders as literal
 * text. `npm test` (tests/server.test.ts) fails if a sink appears; `npm run
 * build` does NOT run that check.
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import { createLatestGuard } from "./latest.js";
import "./mcp-app.css";

type Category = "fruit" | "vegetable" | "grain";
interface Row { name: string; category: Category; crates: number }
interface HarvestResult { category: string; minCrates: number; rows: Row[]; totalCrates: number }

const CATEGORY_CLASSES: ReadonlySet<string> = new Set(["fruit", "vegetable", "grain"]);

/** Defensive shape check: structuredContent is untrusted input to the UI. */
function asHarvest(v: unknown): HarvestResult | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.rows) || typeof o.totalCrates !== "number") return null;
  const rows: Row[] = [];
  for (const r of o.rows) {
    if (!r || typeof r !== "object") return null;
    const x = r as Record<string, unknown>;
    if (typeof x.name !== "string" || typeof x.crates !== "number" || typeof x.category !== "string") return null;
    if (!CATEGORY_CLASSES.has(x.category)) return null;
    rows.push({ name: x.name, category: x.category as Category, crates: x.crates });
  }
  return {
    category: String(o.category),
    minCrates: typeof o.minCrates === "number" ? o.minCrates : 0,
    rows,
    totalCrates: o.totalCrates,
  };
}

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const mainEl = el<HTMLElement>("root");
const statusEl = el<HTMLElement>("status");
const chartEl = el<HTMLElement>("chart");
const rowsEl = el<HTMLTableSectionElement>("rows");
const totalEl = el<HTMLElement>("total");
const categoryEl = el<HTMLSelectElement>("category");
const minEl = el<HTMLInputElement>("min-crates");
const formEl = el<HTMLFormElement>("filter-form");

function render(data: HarvestResult, source: string): void {
  const max = Math.max(1, ...data.rows.map((r) => r.crates));
  chartEl.replaceChildren(
    ...data.rows.map((r) => {
      const row = document.createElement("div");
      row.className = "bar-row";
      const label = document.createElement("span");
      label.textContent = r.name;
      const track = document.createElement("div");
      const bar = document.createElement("div");
      bar.className = `bar ${r.category}`; // category is allowlisted in asHarvest
      bar.style.width = `${Math.round((r.crates / max) * 100)}%`;
      track.append(bar);
      const value = document.createElement("span");
      value.className = "num";
      value.textContent = String(r.crates);
      row.append(label, track, value);
      return row;
    }),
  );
  rowsEl.replaceChildren(
    ...data.rows.map((r) => {
      const tr = document.createElement("tr");
      for (const [text, cls] of [[r.name, ""], [r.category, ""], [String(r.crates), "num"]] as const) {
        const td = document.createElement("td");
        td.textContent = text;
        if (cls) td.className = cls;
        tr.append(td);
      }
      return tr;
    }),
  );
  totalEl.textContent = String(data.totalCrates);
  if (CATEGORY_CLASSES.has(data.category) || data.category === "all") categoryEl.value = data.category;
  minEl.value = String(data.minCrates);
  statusEl.textContent = `${data.rows.length} rows · source: ${source}`;
  mainEl.dataset.source = source; // test hook for the Playwright proof
}

function handleHostContext(ctx: McpUiHostContext): void {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  if (ctx.safeAreaInsets) {
    const { top, right, bottom, left } = ctx.safeAreaInsets;
    mainEl.style.padding = `${top}px ${right}px ${bottom}px ${left}px`;
  }
}

const app = new App({ name: "Harvest", version: "1.0.0" });

// Every render source (host-pushed tool result or a UI filter call) takes a
// ticket; a response renders only if nothing newer started after it.
const latest = createLatestGuard();

// Register ALL handlers before connect().
app.ontoolresult = (result) => {
  latest.next(); // a newer host result supersedes any in-flight filter call
  const data = asHarvest(result.structuredContent);
  if (data) render(data, "show_harvest");
  else statusEl.textContent = "Tool result had no usable structuredContent.";
};
app.onhostcontextchanged = handleHostContext;
app.onteardown = async () => ({});
app.onerror = (e) => console.error(e);

formEl.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const ticket = latest.next();
  statusEl.textContent = "Calling filter_harvest…";
  try {
    const result = await app.callServerTool({
      name: "filter_harvest",
      arguments: { category: categoryEl.value, minCrates: Number(minEl.value) },
    });
    if (!latest.isCurrent(ticket)) return; // superseded: a newer request owns the view
    const data = result.isError ? null : asHarvest(result.structuredContent);
    if (data) render(data, "filter_harvest");
    else {
      const first = result.content?.[0];
      statusEl.textContent = `filter_harvest rejected: ${first && first.type === "text" ? first.text : "no detail"}`;
    }
  } catch (e) {
    if (!latest.isCurrent(ticket)) return;
    statusEl.textContent = `filter_harvest failed: ${e instanceof Error ? e.message : String(e)}`;
  }
});

app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) handleHostContext(ctx);
});
