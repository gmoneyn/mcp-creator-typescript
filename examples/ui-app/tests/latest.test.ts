/**
 * Out-of-order responses: the older request resolves LAST and must not win.
 * Drives the same guard ui/mcp-app.ts uses, with the same take-ticket /
 * check-on-arrival pattern as its submit handler.
 */
import { describe, expect, it } from "vitest";
import { createLatestGuard } from "../ui/latest.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("latest-wins guard", () => {
  it("drops a superseded response that arrives after a newer one (grain -> fruit)", async () => {
    const latest = createLatestGuard();
    const shown: string[] = [];
    const submit = async (call: Promise<string>) => {
      const ticket = latest.next();
      const value = await call;
      if (latest.isCurrent(ticket)) shown.push(value);
    };
    const grain = deferred<string>();
    const fruit = deferred<string>();
    const a = submit(grain.promise); // older
    const b = submit(fruit.promise); // newer
    fruit.resolve("fruit");
    await b;
    grain.resolve("grain"); // older lands last
    await a;
    expect(shown).toEqual(["fruit"]);
  });

  it("applies a response when nothing newer was issued", () => {
    const latest = createLatestGuard();
    const t = latest.next();
    expect(latest.isCurrent(t)).toBe(true);
    latest.next();
    expect(latest.isCurrent(t)).toBe(false);
  });
});
