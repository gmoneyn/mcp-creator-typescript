/**
 * markdown.ts: putting caller-supplied free text into generated Markdown as TEXT.
 *
 * Two generated files hold free text, and they have different readers, so they get
 * different treatment:
 *
 * README.md is rendered as Markdown (GitHub, npm, and the marketplace's server page).
 *   -> mdText / tableCell: a single line, with every character that could open a
 *      block, a code span, a link or raw HTML escaped. A renderer shows the text
 *      itself; the backslashes are invisible.
 *
 * LAUNCHGUIDE.md is read by the marketplace with a LINE PARSER, not a renderer
 * (mcp-marketplace frontend/src/lib/launchguide.ts): a line matching /^##\s+/ starts
 * a section, a later section replaces an earlier one of the same name, setup
 * requirement lines are matched as "- `NAME` (required): text url", and the values are
 * shown as plain strings. Escaping everything there would put backslashes on the
 * public listing and stop real setup lines and URLs from matching.
 *   -> guideLine / guideBlock: nothing a field contains can start a section or any
 *      other block, or form a link or an HTML tag; ordinary punctuation is left alone,
 *      so ordinary text comes out byte for byte as it went in.
 */

const LINE_BREAKS = /[\r\n\u2028\u2029]+/g;
const LINE_BREAK = /\r\n|\r|\n|\u2028|\u2029/;

/** Text for a single line: no line breaks. */
export function oneLine(text: unknown): string {
  return String(text ?? "").replace(LINE_BREAKS, " ");
}

// ---------------------------------------------------------------- README (rendered)

/**
 * Free text for a single-line slot in a rendered Markdown file. Backslashes are
 * escaped first, so a backslash already in the text cannot cancel one added here.
 */
export function mdText(text: unknown): string {
  let s = oneLine(text).trim();
  s = s.replace(/\\/g, "\\\\");
  // Code spans and fences, links and images, raw HTML and autolinks.
  s = s.replace(/[`~\[\]()<>]/g, "\\$&");
  // Whatever would open a block if it came first: heading, list, quote, rule.
  if (/^[#\-+*>=_]/.test(s)) s = "\\" + s;
  // Numbered list: "1." (a ")" after the digits is already escaped above).
  s = s.replace(/^(\d{1,9})\./, "$1\\.");
  return s;
}

/** Free text for one cell of a Markdown table: mdText, plus the cell separator. */
export function tableCell(text: unknown): string {
  return mdText(text).replace(/\|/g, "\\|");
}

// ---------------------------------------------------------------- LAUNCHGUIDE.md (line-parsed)

/** Would this line, as the first thing in a block, open something other than a paragraph? */
function neutraliseLineStart(line: string, keepListMarkers: boolean): string {
  // Four spaces or a tab of indentation is a code block. A field has no use for it.
  const dedented = line.replace(/^[ \t]+/, (ws) => (ws.includes("\t") || ws.length >= 4 ? "" : ws));
  const lead = /^ {0,3}/.exec(dedented)![0];
  let rest = dedented.slice(lead.length);

  const listItem = /^([-+*]|\d{1,9}[.)])(\s+)(.*)$/.exec(rest);
  if (listItem && keepListMarkers) {
    // The marker is the field's own format. What follows it is a block of its own.
    return `${lead}${listItem[1]} ${neutraliseLineStart(listItem[3], true)}`;
  }

  if (/^(`{3,}|~{3,})/.test(rest)) {
    // A fence: escape every character of the run, or what is left still opens a span.
    rest = rest.replace(/^(`+|~+)/, (run) => run.split("").map((c) => "\\" + c).join(""));
  } else if (
    /^#{1,6}(\s|$)/.test(rest) ||                       // heading (and a marketplace section)
    /^>/.test(rest) ||                                   // block quote
    /^(=+|-+|_{3,}|\*{3,})\s*$/.test(rest) ||            // setext underline, rule
    /^\[[^\]]*\]:/.test(rest) ||                         // link definition
    (/\|/.test(rest) && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(rest)) || // table delimiter row
    (!keepListMarkers && /^[-+*](\s|$)/.test(rest))      // list item in a single-line slot
  ) {
    rest = "\\" + rest;
  } else if (!keepListMarkers) {
    rest = rest.replace(/^(\d{1,9})([.)])(?=\s|$)/, "$1\\$2");
  }
  return lead + rest;
}

/**
 * Break the two things that make a link or raw HTML, and nothing else:
 * "](" / "][" (inline and reference links, images) and "<" before a tag or scheme.
 * A character that already has a backslash in front of it is left as it is.
 */
function neutraliseInline(line: string): string {
  let out = "";
  let escaped = false;
  let afterCloseBracket = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (escaped) { out += c; escaped = false; afterCloseBracket = false; continue; }
    if (c === "\\") { out += c; escaped = true; afterCloseBracket = false; continue; }
    if (c === "<" && /[A-Za-z/!?]/.test(line[i + 1] ?? "")) { out += "\\<"; afterCloseBracket = false; continue; }
    if ((c === "(" || c === "[") && afterCloseBracket) { out += "\\" + c; afterCloseBracket = false; continue; }
    out += c;
    afterCloseBracket = c === "]";
  }
  return out;
}

/** A single-line LAUNCHGUIDE.md field (tagline, category, tags, use cases, URL, name). */
export function guideLine(text: unknown): string {
  return neutraliseInline(neutraliseLineStart(oneLine(text).trim(), false));
}

/**
 * A LAUNCHGUIDE.md field that may hold several lines (description, features, getting
 * started, setup requirements). Lines and list markers are kept, because the
 * marketplace reads these fields line by line; no line can open a block.
 */
export function guideBlock(text: unknown): string {
  return String(text ?? "")
    .split(LINE_BREAK)
    .map((line) => neutraliseInline(neutraliseLineStart(line.replace(/\s+$/, ""), true)))
    .join("\n");
}
