/**
 * validate.ts: checks on the names a caller supplies, run BEFORE anything is generated.
 *
 * Names are interpolated into generated source as identifiers, file names and import
 * paths, where escaping is not possible: the only safe treatment is to refuse anything
 * that is not a plain name. Free text (descriptions) is a different case and is escaped
 * at the point of use in codegen.ts.
 *
 * The reserved-name lists below are NOT the authority on what collides with the
 * generated code: the templates are. tests/grid.test.ts harvests every identifier the
 * templates emit, offers each one as a tool name and as a parameter name, and requires
 * that it is either refused here or produces a project that type-checks. A template
 * change that introduces a new collision turns that test red.
 */

import { KNOWN_PARAM_TYPES, isKnownParamType, toolFileName, toolFunctionName, type ToolDef } from "./codegen.js";

export type Validation = { ok: true } | { ok: false; error: string };

const PACKAGE_NAME_MAX = 214; // npm's limit
const TOOL_NAME_MAX = 64;
const PARAM_NAME_MAX = 64;
const TEXT_MAX = 2000;

/** Lowercase letters, digits, "-", "_", ".", optional "@scope/"; each part starts with a letter or digit. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
/** Letters, digits, "_" and "-", starting with a letter. */
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
/** A plain JavaScript identifier. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Words the language itself does not allow as a binding name. */
const JS_RESERVED = new Set([
  "arguments", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "enum", "eval", "export", "extends", "false", "finally", "for", "function",
  "if", "implements", "import", "in", "instanceof", "interface", "let", "new", "null", "package",
  "private", "protected", "public", "return", "static", "super", "switch", "this", "throw", "true",
  "try", "typeof", "undefined", "var", "void", "while", "with", "yield",
]);

/**
 * Names a tool FUNCTION may not have. The function is imported by name into
 * src/index.ts and into tests/test-<tool>.ts, so it must not collide with anything
 * those files import, declare, or use from the global scope.
 */
const TOOL_FUNCTION_RESERVED = new Set([
  // imported by the generated src/index.ts
  "McpServer", "serveStdio", "createMcpHandler", "toNodeHandler", "createMcpExpressApp", "withLicense", "z",
  // declared by the generated src/index.ts
  "server", "handler", "app", "port", "allowedHosts", "nodeHandler", "result",
  // globals the generated src/index.ts and tool module use
  "JSON", "Error", "String", "Boolean", "Promise", "process", "console", "parseInt",
  // imported and declared by the generated tests/test-<tool>.ts
  "describe", "it", "expect", "data",
]);

/**
 * Names a PARAMETER may not have. A parameter is a binding inside the generated tool
 * function and inside its handler, and a key of two object literals there.
 */
const PARAMETER_RESERVED = new Set([
  // declared next to the parameters, or a key the generated stub already writes
  "result", "status",
  // globals the generated handler and stub call
  "JSON", "Error", "String", "Promise",
  // every property of Object.prototype (derived, so it cannot go stale): as an object
  // literal key "__proto__" sets the prototype, and the others shadow inherited members
  ...Object.getOwnPropertyNames(Object.prototype),
  "prototype",
]);

const show = (v: unknown): string => {
  const s = typeof v === "string" ? JSON.stringify(v) : String(JSON.stringify(v));
  return s.length > 80 ? s.slice(0, 80) + "..." : s;
};

const fail = (error: string): Validation => ({ ok: false, error });

export function validatePackageName(name: unknown): Validation {
  if (typeof name !== "string" || name.length === 0) {
    return fail("package_name must be a non-empty string.");
  }
  if (name.length > PACKAGE_NAME_MAX) {
    return fail(`package_name is ${name.length} characters; the limit is ${PACKAGE_NAME_MAX}.`);
  }
  if (!PACKAGE_NAME.test(name)) {
    return fail(
      `package_name ${show(name)} is not a valid package name. Use lowercase letters, digits, "-", "_" and ".", ` +
      `starting with a letter or digit, with an optional "@scope/" prefix (for example "my-weather-mcp").`
    );
  }
  return { ok: true };
}

/** A free-text field: a string, not longer than `max`. Missing is allowed unless `required`. */
export function validateText(value: unknown, what: string, required: boolean, max: number = TEXT_MAX): Validation {
  if (value === undefined || value === null) {
    return required ? fail(`${what} is required and must be a string.`) : { ok: true };
  }
  if (typeof value !== "string") {
    return fail(`${what} must be a string.`);
  }
  if (value.length > max) {
    return fail(`${what} is ${value.length} characters; the limit is ${max}.`);
  }
  return { ok: true };
}

/** One tool definition: its name, its text fields and its parameters. */
export function validateToolDef(tool: unknown): Validation {
  if (typeof tool !== "object" || tool === null || Array.isArray(tool)) {
    return fail("Each tool must be an object: { name, description, parameters, returns }.");
  }
  const t = tool as Record<string, unknown>;

  if (typeof t.name !== "string" || t.name.length === 0) {
    return fail("Each tool needs a name (a non-empty string).");
  }
  if (t.name.length > TOOL_NAME_MAX) {
    return fail(`Tool name ${show(t.name)} is ${t.name.length} characters; the limit is ${TOOL_NAME_MAX}.`);
  }
  if (!TOOL_NAME.test(t.name)) {
    return fail(
      `Tool name ${show(t.name)} is not valid. Use letters, digits, "_" and "-", starting with a letter (for example "get_weather").`
    );
  }
  const fn = toolFunctionName(t.name);
  if (JS_RESERVED.has(fn) || TOOL_FUNCTION_RESERVED.has(fn)) {
    return fail(
      `Tool name ${show(t.name)} would generate a function called "${fn}", which is a reserved word or a name the generated code already uses. Choose another name.`
    );
  }

  for (const [field, required] of [["description", true], ["returns", false]] as const) {
    const text = validateText(t[field], `Tool "${t.name}" ${field}`, required);
    if (!text.ok) return text;
  }

  if (!Array.isArray(t.parameters)) {
    return fail(`Tool "${t.name}" needs a parameters array (it may be empty).`);
  }
  const seen = new Set<string>();
  for (const param of t.parameters as unknown[]) {
    if (typeof param !== "object" || param === null || Array.isArray(param)) {
      return fail(`Tool "${t.name}": each parameter must be an object: { name, type, required, description }.`);
    }
    const p = param as Record<string, unknown>;
    if (typeof p.name !== "string" || !IDENTIFIER.test(p.name) || p.name.length > PARAM_NAME_MAX) {
      return fail(
        `Tool "${t.name}": parameter name ${show(p.name)} is not valid. Use letters, digits and "_", not starting with a digit, at most ${PARAM_NAME_MAX} characters.`
      );
    }
    if (JS_RESERVED.has(p.name) || PARAMETER_RESERVED.has(p.name) || p.name === fn) {
      return fail(
        `Tool "${t.name}": parameter name "${p.name}" is a reserved word or a name the generated code already uses. Choose another name.`
      );
    }
    if (seen.has(p.name)) {
      return fail(`Tool "${t.name}": parameter name "${p.name}" is used twice.`);
    }
    seen.add(p.name);
    if (!isKnownParamType(p.type)) {
      return fail(
        `Tool "${t.name}": parameter "${p.name}" has type ${show(p.type)}. Use one of: ${KNOWN_PARAM_TYPES.join(", ")}.`
      );
    }
    if (p.required !== undefined && typeof p.required !== "boolean") {
      return fail(
        `Tool "${t.name}": parameter "${p.name}" has required=${show(p.required)}. Use true or false (omitted means true).`
      );
    }
    const text = validateText(p.description, `Tool "${t.name}" parameter "${p.name}" description`, true);
    if (!text.ok) return text;
  }

  return { ok: true };
}

/** A whole tool list: every tool valid, and no two tools sharing a name, a file or a function. */
export function validateToolDefs(tools: unknown): Validation {
  if (!Array.isArray(tools) || tools.length === 0) {
    return fail("tools must be a non-empty JSON array of tool definitions.");
  }
  const files = new Map<string, string>();
  const functions = new Map<string, string>();
  for (const tool of tools) {
    const one = validateToolDef(tool);
    if (!one.ok) return one;
    const name = (tool as ToolDef).name;
    // Lowercased: two files that differ only by case are one file on macOS and Windows.
    const file = toolFileName(name).toLowerCase();
    const fn = toolFunctionName(name);
    const clash = files.get(file) ?? functions.get(fn);
    if (clash !== undefined) {
      return fail(`Tools "${clash}" and "${name}" would generate the same file or function name. Rename one of them.`);
    }
    files.set(file, name);
    functions.set(fn, name);
  }
  return { ok: true };
}

/**
 * Every name bound by an import statement in a source file: default imports,
 * `{ a, b as c }` (gives a and c) and `* as ns`. Used by add_tool to see which
 * function names an existing src/index.ts already holds.
 */
export function importedBindings(source: string): Set<string> {
  const names = new Set<string>();
  const statement = /\bimport\s+(?:type\s+)?([^;"']*?)\s+from\s*["']/g;
  for (const match of source.matchAll(statement)) {
    const clause = match[1];
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) {
      for (const part of braces[1].split(",")) {
        const local = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
        if (local) names.add(local);
      }
    }
    const outside = clause.replace(/\{[^}]*\}/, "");
    const namespace = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(outside);
    if (namespace) names.add(namespace[1]);
    const dflt = /^\s*([A-Za-z_$][\w$]*)/.exec(outside.replace(/\*\s*as\s+[A-Za-z_$][\w$]*/, ""));
    if (dflt) names.add(dflt[1]);
  }
  return names;
}

/** Environment variable entries for .env.example. */
export function validateEnvVars(envVars: unknown): Validation {
  if (!Array.isArray(envVars)) {
    return fail("envVars must be a JSON array of { name, description, required? }.");
  }
  for (const entry of envVars) {
    if (typeof entry !== "object" || entry === null) {
      return fail("Each env var must be an object: { name, description, required? }.");
    }
    const v = entry as Record<string, unknown>;
    if (typeof v.name !== "string" || !ENV_VAR_NAME.test(v.name) || v.name.length > 128) {
      return fail(`Env var name ${show(v.name)} is not valid. Use letters, digits and "_", not starting with a digit.`);
    }
    const text = validateText(v.description, `Env var "${v.name}" description`, true);
    if (!text.ok) return text;
  }
  return { ok: true };
}
