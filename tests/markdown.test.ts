/**
 * Caller-supplied free text in generated Markdown is TEXT: it cannot add a heading, a
 * code block, a quote, a link or HTML to README.md, and it cannot add or replace a
 * section of LAUNCHGUIDE.md.
 *
 * The repo has no Markdown parser, so structure is compared with
 * tests/helpers/markdown-structure.ts: the lines that start a block and the constructs
 * that form a link, for a document generated from hostile text against the same
 * document generated from plain text. Each test names the future change that would
 * turn it red.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderLaunchguide, renderReadme, type ToolDef } from "../src/services/codegen.js";
import { guideBlock, guideLine, mdText } from "../src/services/markdown.js";
import { generateLaunchguide } from "../src/tools/generate-launchguide.js";
import {
  HOSTILE_EVERYTHING,
  HOSTILE_INSTALL,
  MARKETPLACE_SETUP_LINE,
  MARKETPLACE_URL,
  NON_LIST_KINDS,
  blockStarts,
  blockStartsOfKind,
  links,
  marketplaceSections,
  rendered,
} from "./helpers/markdown-structure.js";

const HOSTILES = { install: HOSTILE_INSTALL, everything: HOSTILE_EVERYTHING };

const TOOL = (description: string): ToolDef => ({ name: "get_weather", description, parameters: [], returns: "r" });
const VARIANTS = [
  { paid: false, hosting: "local" },
  { paid: false, hosting: "remote" },
  { paid: true, hosting: "local" },
  { paid: true, hosting: "remote" },
];

describe("README.md: free text is one line of text", () => {
  // Red when: the server description is written into the README without mdText (it was
  // raw), or mdText stops escaping something that opens a block or a link.
  it.each(Object.entries(HOSTILES))("a hostile server description (%s) changes no block and adds no link", (_, hostile) => {
    for (const opts of VARIANTS) {
      const plain = renderReadme("my-mcp", "PLAIN", [TOOL("PLAIN")], opts);
      const attacked = renderReadme("my-mcp", hostile, [TOOL("PLAIN")], opts);
      expect(blockStarts(attacked)).toEqual(blockStarts(plain));
      expect(links(attacked)).toEqual(links(plain));
    }
  });

  // Red when: a tool description in the table is escaped for the cell separator only
  // (as before this change), so a link or HTML in it stays live.
  it.each(Object.entries(HOSTILES))("a hostile tool description (%s) changes no block and adds no link", (_, hostile) => {
    for (const opts of VARIANTS) {
      const plain = renderReadme("my-mcp", "PLAIN", [TOOL("PLAIN")], opts);
      const attacked = renderReadme("my-mcp", "PLAIN", [TOOL(hostile)], opts);
      expect(blockStarts(attacked)).toEqual(blockStarts(plain));
      expect(links(attacked)).toEqual(links(plain));
      expect(attacked.split("\n").filter((l) => l.startsWith("| `get_weather` |")).length).toBe(1);
    }
  });

  // Red when: the comparison above stops being able to see an injection (a helper that
  // returns nothing would make every equality pass).
  it("the structure check sees the injection when the text is NOT escaped", () => {
    const raw = `# my-mcp\n\n${HOSTILE_INSTALL}\n\n## Tools\n`;
    expect(blockStarts(raw)).toContain("heading: ## Install");
    expect(blockStarts(raw)).toContain("fence: ```bash");
    expect(links(`x [click](https://evil.example) <script>y</script>`).length).toBe(3);
    expect(blockStarts(`# my-mcp\n\n${mdText(HOSTILE_INSTALL)}\n\n## Tools\n`)).toEqual(["heading: # my-mcp", "heading: ## Tools"]);
  });

  // Red when: escaping loses or changes characters. What a renderer shows (escapes
  // removed) must be the input with its line breaks turned into spaces.
  it("the text itself survives: rendered, it reads as the input on one line", () => {
    for (const hostile of [...Object.values(HOSTILES), "plain text (with parentheses) and a # hash", "1. numbered", "- dash", "C:\\Users\\me"]) {
      const expected = hostile.replace(/[\r\n]+/g, " ").trim();
      expect(rendered(mdText(hostile))).toBe(expected);
    }
    expect(mdText("Get current weather for a city")).toBe("Get current weather for a city");
  });
});

const PLAIN_GUIDE = {
  packageName: "my-mcp",
  tagline: "Scaffold, build and publish servers (conversationally)",
  description: "Builds things.\n\nSecond paragraph (with parentheses), a `code` word and https://example.com/docs.",
  category: "Developer Tools",
  features: "- Check your environment (Node.js, npm, git) in one command\n- Build with tsup (ESM, shebang)",
  tags: "mcp, scaffold, c++, c#",
  setupRequirements: "- `API_KEY` (required): Your key. https://example.com/keys\n- `REGION` (optional): Defaults to us-east-1.",
  docsUrl: "https://github.com/someone/my-mcp",
  useCases: "Testing, Prototyping, CI/CD",
  gettingStarted: "- \"Check if my environment is ready\"\n- Tool: check_setup - Verify Node.js",
};
type Field = keyof typeof PLAIN_GUIDE;
const SINGLE_LINE: Field[] = ["packageName", "tagline", "category", "tags", "docsUrl", "useCases"];
const MULTI_LINE: Field[] = ["description", "features", "setupRequirements", "gettingStarted"];
const SECTIONS = ["tagline", "description", "setup requirements", "category", "use cases", "features", "getting started", "tags", "documentation url"];

describe("LAUNCHGUIDE.md: a field cannot add or replace a section, or open a block or a link", () => {
  // Red when: escaping starts changing ordinary text. The marketplace shows these values
  // as plain strings and matches setup lines and URLs literally, so a backslash added
  // to normal punctuation would appear on the public listing or break the match.
  it("ordinary text comes out byte for byte as it went in", () => {
    const g = PLAIN_GUIDE;
    expect(renderLaunchguide(g)).toBe(
      `# ${g.packageName}\n\n## Tagline\n${g.tagline}\n\n## Description\n${g.description}\n\n## Setup Requirements\n${g.setupRequirements}\n\n` +
      `## Category\n${g.category}\n\n## Use Cases\n${g.useCases}\n\n## Features\n${g.features}\n\n## Getting Started\n${g.gettingStarted}\n\n` +
      `## Tags\n${g.tags}\n\n## Documentation URL\n${g.docsUrl}\n`
    );
    // ... and the marketplace's own patterns still read it.
    const sections = marketplaceSections(renderLaunchguide(g));
    expect(Object.keys(sections)).toEqual(SECTIONS);
    expect(sections["setup requirements"].split("\n").filter((l) => MARKETPLACE_SETUP_LINE.test(l)).length).toBe(2);
    expect(MARKETPLACE_URL.exec(sections["documentation url"])![1]).toBe(g.docsUrl);
  });

  // Red when: any field is written into the guide raw again (every one was), or a line
  // start that opens a section or block stops being neutralised.
  it.each(Object.entries(HOSTILES))("hostile text (%s) in ANY one field: same sections, same blocks, no new link", (_, hostile) => {
    const plain = renderLaunchguide(PLAIN_GUIDE);
    for (const field of [...SINGLE_LINE, ...MULTI_LINE]) {
      const attacked = renderLaunchguide({ ...PLAIN_GUIDE, [field]: PLAIN_GUIDE[field] + hostile });
      const where = `field ${field}`;

      // The marketplace's rule: same section names, in the same order.
      const sections = marketplaceSections(attacked);
      expect(Object.keys(sections), where).toEqual(SECTIONS);
      // Fields the attacker did not write keep their value.
      for (const [name, other] of [["tagline", "tagline"], ["documentation url", "docsUrl"], ["category", "category"]] as const) {
        if (other !== field) expect(sections[name].trim(), `${where} -> ${name}`).toBe(PLAIN_GUIDE[other]);
      }

      // A Markdown renderer's view: no new heading, fence, quote, rule, code block, HTML or table.
      // (The title line legitimately carries the name field's own text, so for that
      // field the comparison is on the kind of each block, not on its text.)
      const view = (blocks: string[]) => (field === "packageName" ? blocks.map((b) => b.slice(0, b.indexOf(":"))) : blocks);
      expect(view(blockStartsOfKind(attacked, NON_LIST_KINDS)), where).toEqual(view(blockStartsOfKind(plain, NON_LIST_KINDS)));
      expect(links(attacked), where).toEqual(links(plain));
      // A single-line field cannot add a list item either.
      if (SINGLE_LINE.includes(field)) expect(view(blockStarts(attacked)), where).toEqual(view(blockStarts(plain)));
    }
  });

  // Red when: a single-line field keeps a line break (the text after it would be read as
  // the start of the next thing), or a multi-line field loses its lines.
  it("single-line fields are one line; multi-line fields keep their lines", () => {
    expect(guideLine("one\ntwo\r\nthree")).toBe("one two three");
    expect(guideLine("## Tagline")).toBe("\\## Tagline");
    expect(guideBlock("- one\n- two")).toBe("- one\n- two");
    expect(guideBlock("para one\n\npara two")).toBe("para one\n\npara two");
    expect(guideBlock("- # heading in an item\n- ```fence in an item")).toBe("- \\# heading in an item\n- \\`\\`\\`fence in an item");
  });

  // Red when: generate_launchguide (the tool) stops going through the same template, or
  // stops refusing a field that is not a string or is far too long.
  it("the generate_launchguide tool writes the same safe file and refuses oversized or non-string fields", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-mcp-creator-guide-"));
    try {
      const ok = JSON.parse(await generateLaunchguide(dir, "my-mcp", "tagline" + HOSTILE_INSTALL, "description" + HOSTILE_EVERYTHING, "Data", "- f" + HOSTILE_INSTALL, "tag", undefined, undefined, "a, b" + HOSTILE_INSTALL, "- g" + HOSTILE_EVERYTHING));
      expect(ok.success).toBe(true);
      const written = readFileSync(join(dir, "LAUNCHGUIDE.md"), "utf-8");
      expect(Object.keys(marketplaceSections(written))).toEqual(SECTIONS.filter((s) => s !== "documentation url"));
      expect(blockStartsOfKind(written, ["heading"]).length).toBe(9); // the title and the eight sections
      expect(blockStartsOfKind(written, ["fence", "indented-code", "html", "quote", "link-definition"])).toEqual([]);
      expect(links(written)).toEqual([]);

      const tooLong = JSON.parse(await generateLaunchguide(dir, "my-mcp", "t".repeat(501), "d", "Data", "- f", "tag"));
      expect(tooLong.success).toBe(false);
      expect(tooLong.error).toContain("tagline is 501 characters; the limit is 500");
      const notText = JSON.parse(await generateLaunchguide(dir, "my-mcp", "t", { toString: () => "## Tagline" } as unknown as string, "Data", "- f", "tag"));
      expect(notText.success).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
