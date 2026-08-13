import { test, expect } from "bun:test";
import { $ } from "bun";

const run = async (fixture: string, ...extra: string[]) => {
  const out = await $`node scripts/bundle-plan.mjs tests/bundle-plan/fixtures/${fixture} --stdout ${extra}`
    .quiet().nothrow();
  return { code: out.exitCode, stdout: out.stdout.toString(), stderr: out.stderr.toString() };
};

test("partitions by tier and merges on coupling", async () => {
  const r = await run("simple.tasks.json");
  expect(r.code).toBe(0);
  const m = JSON.parse(r.stdout);
  expect(m.bundles.length).toBe(3);
  const byTier = Object.fromEntries(m.bundles.map((b: any) => [b.id, b.tier]));
  expect(new Set(Object.values(byTier)).size).toBe(3);
  const merged = m.bundles.find((b: any) => b.taskIds.includes(0));
  expect(merged.taskIds).toEqual([0, 1]);
});

test("never merges across tiers", async () => {
  const r = await run("simple.tasks.json");
  const m = JSON.parse(r.stdout);
  for (const b of m.bundles) {
    expect(new Set(b.taskIds.map((id: number) =>
      m.taskTiers[id])).size).toBe(1);
  }
});

test("orders bundles so dependencies precede dependents", async () => {
  const r = await run("simple.tasks.json");
  const m = JSON.parse(r.stdout);
  const pos = new Map(m.bundles.map((b: any, i: number) => [b.id, i]));
  for (const b of m.bundles)
    for (const dep of b.blockedByBundles)
      expect(pos.get(dep)).toBeLessThan(pos.get(b.id));
});

test("rejects a task with no modelTier", async () => {
  const r = await run("missing-tier.tasks.json");
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("modelTier");
  expect(r.stderr).toContain("task 2");
});

test("rejects an oversized bundle and names the shared file", async () => {
  const r = await run("oversized.tasks.json");
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("src/index.ts");
});

test("--max-tasks raises the cap", async () => {
  const r = await run("oversized.tasks.json", "--max-tasks", "10");
  expect(r.code).toBe(0);
});

test("fenced json:metadata description produces identical bundles to top-level metadata", async () => {
  const a = await run("simple.tasks.json");
  const b = await run("fenced.tasks.json");
  expect(a.code).toBe(0);
  expect(b.code).toBe(0);
  // generatedFrom legitimately differs (it records which input file was read);
  // everything else — bundles, taskTiers, caps, planPath — must match exactly.
  const strip = ({ generatedFrom, ...rest }: any) => rest;
  expect(strip(JSON.parse(b.stdout))).toEqual(strip(JSON.parse(a.stdout)));
});

test("rejects a task with a malformed json:metadata fence", async () => {
  const r = await run("malformed-fence.tasks.json");
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("task 2");
  expect(r.stderr).toContain("fence");
});
