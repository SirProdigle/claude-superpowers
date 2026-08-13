import { test, expect } from "bun:test";
import { $ } from "bun";

const run = async (fixture: string, ...extra: string[]) => {
  const out = await $`node scripts/bundle-plan.mjs tests/bundle-plan/fixtures/${fixture} --stdout ${extra}`
    .quiet().nothrow();
  return { code: out.exitCode, stdout: out.stdout.toString(), stderr: out.stderr.toString() };
};

// For cases where argument order or the presence/absence of --stdout itself
// is under test, and `run`'s fixed argument shape would hide the bug.
const runRaw = async (args: string[]) => {
  const out = await $`node scripts/bundle-plan.mjs ${args}`.quiet().nothrow();
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

// --- fix round 2 regressions ---

test("CRITICAL 1: refuses to write the manifest over its own input", async () => {
  const path = "tests/bundle-plan/fixtures/no-suffix.json";
  const before = await Bun.file(path).text();
  const r = await runRaw([path]); // no --stdout, and the filename doesn't end in .tasks.json
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("no-suffix.json");
  const after = await Bun.file(path).text();
  expect(after).toBe(before); // input must be byte-identical — never overwritten
});

test("CRITICAL 2: packing a same-tier pair across an intermediate-tier dependency does not manufacture a cycle", async () => {
  // A(mechanical) -> B(standard) -> C(mechanical), zero file/edge coupling
  // between A and C directly. Old code packed A+C (same tier, both small)
  // ignoring the transitive A->B->C precedence path, producing a bundle
  // that had to both precede and follow B's bundle — a fake cycle on a
  // perfectly valid plan.
  const r = await run("tier-chain.tasks.json");
  expect(r.code).toBe(0);
  const m = JSON.parse(r.stdout);
  expect(m.bundles.length).toBe(3); // A, B, C must stay separate
  const pos = new Map(m.bundles.map((b: any, i: number) => [b.id, i]));
  for (const b of m.bundles)
    for (const dep of b.blockedByBundles)
      expect(pos.get(dep)).toBeLessThan(pos.get(b.id));
});

test("CRITICAL 3: rejects a malformed --max-tasks value instead of silently disabling the cap", async () => {
  const r = await run("oversized.tasks.json", "--max-tasks", "abc");
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("--max-tasks");
});

test("CRITICAL 3: rejects a malformed --max-files value instead of silently disabling the cap", async () => {
  const r = await run("oversized-files.tasks.json", "--max-files", "-5");
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("--max-files");
});

test("IMPORTANT 4: does not mistake a flag's value for the input path", async () => {
  // --max-tasks's value ("10") precedes the real input path here.
  const r = await runRaw(["--max-tasks", "10", "tests/bundle-plan/fixtures/oversized.tasks.json", "--stdout"]);
  expect(r.code).toBe(0);
  const m = JSON.parse(r.stdout);
  expect(m.bundles.length).toBe(1);
  expect(m.maxTasks).toBe(10);
});

test("IMPORTANT 4: a missing/unreadable input file reports the path, not a raw stack trace", async () => {
  const r = await runRaw(["tests/bundle-plan/fixtures/does-not-exist.tasks.json", "--stdout"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("does-not-exist.tasks.json");
  expect(r.stderr).not.toContain("at Object");
});

test("IMPORTANT 5 / MINOR: rejects an oversized bundle on the file cap and names the real cause", async () => {
  const r = await run("oversized-files.tasks.json");
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("file cap");
  expect(r.stderr).toContain("blockedBy edge");
  expect(r.stderr).not.toContain("task cap");
});

test("MINOR: --max-files raises the cap", async () => {
  const r = await run("oversized-files.tasks.json", "--max-files", "20");
  expect(r.code).toBe(0);
});

test("PLAN-MANDATED 6: sorts taskIds topologically within a bundle, not by ascending id", async () => {
  const r = await run("reverse-id-order.tasks.json");
  expect(r.code).toBe(0);
  const m = JSON.parse(r.stdout);
  expect(m.bundles.length).toBe(1);
  // task 5 blocks task 2, so 5 must be listed first despite the lower id.
  expect(m.bundles[0].taskIds).toEqual([5, 2]);
});

test("MINOR: a null json:metadata fence falls back to the standard missing-tier error, not a crash", async () => {
  const r = await run("null-fence.tasks.json");
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("modelTier");
  expect(r.stderr).toContain("task 0");
  expect(r.stderr).not.toContain("TypeError");
});
