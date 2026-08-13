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

test("a three-tier dependency chain bundles without a false cycle", async () => {
  // A(mechanical) -> B(standard) -> C(mechanical), zero file/edge coupling
  // between A and C directly. This fixture originally caught a Critical
  // defect in a since-removed singleton-packing pass, which packed A+C
  // (same tier, both small) ignoring the transitive A->B->C precedence
  // path, producing a bundle that had to both precede and follow B's
  // bundle — a fake cycle on a perfectly valid plan. Packing is gone now
  // (see CRITICAL-2-ROUND-3 below for why), so this is a plain "a valid
  // chain bundles and orders correctly" regression.
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

// --- fix round 3 regressions ---
//
// The re-review proved the round-2 CRITICAL-2 fix (a task-level-only
// reachability check) was still unsound: bundle-level precedence is a
// strict superset of task-level precedence, because a merged bundle can
// itself act as a bridge with no direct task-level edge spanning it. Two
// counterexamples were reproduced, both exiting 1 ("dependency cycle") on
// a valid DAG against the round-2 code. The fix is the escape hatch the
// round-2 brief always allowed: drop singleton packing entirely. These two
// fixtures are what packing would previously have miscategorised as safe
// to merge; without packing they must bundle cleanly at exit 0.

test("independent solo task is not bridged into a cycle by a coupled standard pair (forward edges)", async () => {
  // 0(mechanical) -/-> {3,4}(mechanical) have no coupling and no task-level
  // path between them. But {1,2}(standard) is a real coupled pair (shared
  // file) that 0 points into (0 blocks 1) and that itself points into
  // {3,4} (2 blocks 3) — a bundle-level bridge invisible to a task-level
  // check. Packing used to merge 0 with {3,4} here, which then had to both
  // precede and follow {1,2}. With packing removed, 0 stays its own bundle.
  const r = await run("bridged-pair-forward.tasks.json");
  expect(r.code).toBe(0);
  const m = JSON.parse(r.stdout);
  expect(m.bundles.length).toBe(3); // {0}, {1,2}, {3,4}
  const pos = new Map(m.bundles.map((b: any, i: number) => [b.id, i]));
  for (const b of m.bundles)
    for (const dep of b.blockedByBundles)
      expect(pos.get(dep)).toBeLessThan(pos.get(b.id));
});

test("independent solo task is not bridged into a cycle by a coupled standard pair (reverse edges)", async () => {
  // Mirror of the forward case with both blockedBy edges reversed: {3,4}
  // precedes {1,2} precedes 0. Same bridge structure, opposite direction.
  const r = await run("bridged-pair-reverse.tasks.json");
  expect(r.code).toBe(0);
  const m = JSON.parse(r.stdout);
  expect(m.bundles.length).toBe(3); // {3,4}, {1,2}, {0}
  const pos = new Map(m.bundles.map((b: any, i: number) => [b.id, i]));
  for (const b of m.bundles)
    for (const dep of b.blockedByBundles)
      expect(pos.get(dep)).toBeLessThan(pos.get(b.id));
});

test("MINOR: the restructure hint is omitted when the breach has no shared file to restructure", async () => {
  const r = await run("oversized-files.tasks.json"); // breaches on a blockedBy edge, zero shared files
  expect(r.code).toBe(1);
  expect(r.stderr).not.toContain("Restructure the plan");
});

test("MINOR: the restructure hint is present when the breach does have a shared file", async () => {
  const r = await run("oversized.tasks.json"); // breaches on a shared file
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("Restructure the plan");
});

// --- final review regressions ---

test("the bundle-cycle error names members, files, and the acyclic-plan explanation", async () => {
  // A(standard, src/f.ts) -> C(mechanical) -> B(standard, src/f.ts). The task
  // graph is a clean DAG, but A and B share a file at the same tier so they
  // are merged unconditionally, and the merged bundle then has to both precede
  // and follow C's bundle. The old message ("dependency cycle among bundles
  // b1, b2") told the user their DAG was cyclic, which it isn't, and named
  // neither the member tasks nor the shared file that forced the merge.
  const r = await run("forced-merge-cycle.tasks.json");
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("dependency cycle");
  // every bundle in the cycle is named with its members and its files
  expect(r.stderr).toContain("tasks 1, 3");
  expect(r.stderr).toContain("tasks 2");
  expect(r.stderr).toContain("src/f.ts");
  expect(r.stderr).toContain("src/c.ts");
  // and the message says this can happen on a valid plan, with the remedy
  expect(r.stderr).toContain("genuinely acyclic plan");
  expect(r.stderr).toContain("share a file");
  expect(r.stderr).toMatch(/split the shared file's usage/);
  expect(r.stderr).toMatch(/retier/);
});

test("MINOR: a repeated cap flag honours its last occurrence", async () => {
  // oversized.tasks.json is a 6-task bundle; --max-tasks 3 would still
  // reject it, but the later --max-tasks 99 must win.
  const r = await run("oversized.tasks.json", "--max-tasks", "3", "--max-tasks", "99");
  expect(r.code).toBe(0);
});
