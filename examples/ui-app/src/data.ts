/**
 * Fixed, deterministic dataset + pure filter. No I/O, no network, no clock.
 * FIXTURE DATA — illustrative numbers, not real statistics.
 */
import { z } from "zod";

export const CATEGORIES = ["fruit", "vegetable", "grain"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Filter value accepted by both tools: one category, or "all". */
export const CategoryFilter = z.enum(["all", ...CATEGORIES]);
export type CategoryFilter = z.infer<typeof CategoryFilter>;

export interface HarvestRow {
  name: string;
  category: Category;
  crates: number;
}

const HARVEST: readonly HarvestRow[] = Object.freeze([
  { name: "Apples", category: "fruit", crates: 420 },
  { name: "Pears", category: "fruit", crates: 180 },
  { name: "Cherries", category: "fruit", crates: 95 },
  { name: "Carrots", category: "vegetable", crates: 310 },
  { name: "Kale", category: "vegetable", crates: 60 },
  { name: "Squash", category: "vegetable", crates: 240 },
  { name: "Wheat", category: "grain", crates: 510 },
  { name: "Oats", category: "grain", crates: 150 },
]);

/** Shape of `structuredContent` for BOTH tools — the UI renders exactly this. */
export const HarvestResult = z.object({
  category: CategoryFilter,
  minCrates: z.number().int().min(0),
  rows: z.array(
    z.object({
      name: z.string(),
      category: z.enum(CATEGORIES),
      crates: z.number().int(),
    }),
  ),
  totalCrates: z.number().int(),
});
export type HarvestResult = z.infer<typeof HarvestResult>;

export function filterHarvest(category: CategoryFilter, minCrates = 0): HarvestResult {
  const rows = HARVEST.filter(
    (r) => (category === "all" || r.category === category) && r.crates >= minCrates,
  )
    .map((r) => ({ ...r }))
    .sort((a, b) => b.crates - a.crates || a.name.localeCompare(b.name));
  return {
    category,
    minCrates,
    rows,
    totalCrates: rows.reduce((sum, r) => sum + r.crates, 0),
  };
}

/**
 * Text fallback for hosts that do not render MCP Apps UI. This is the
 * degradation path: the model always gets a complete, useful answer here.
 */
export function harvestToText(r: HarvestResult): string {
  const header = `Harvest (fixture data) — category: ${r.category}, min crates: ${r.minCrates}`;
  if (r.rows.length === 0) return `${header}\nNo rows match.`;
  const lines = r.rows.map((row) => `- ${row.name} (${row.category}): ${row.crates} crates`);
  return [header, ...lines, `Total: ${r.totalCrates} crates across ${r.rows.length} rows.`].join("\n");
}
