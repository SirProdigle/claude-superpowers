import { test, expect } from "bun:test";
import { $ } from "bun";

const run = async (...args) => {
  const out = await $`node scripts/wf-cost.mjs ${args}`.quiet().nothrow();
  return { code: out.exitCode, stdout: out.stdout.toString(), stderr: out.stderr.toString() };
};

test("reports both agents and totals as JSON", async () => {
  const r = await run("tests/wf-cost/fixtures", "--json");
  expect(r.code).toBe(0);
  const d = JSON.parse(r.stdout);
  expect(d.agents.length).toBe(2);
  expect(d.totals.agents).toBe(2);
  expect(d.totals.turns).toBe(3);
});

test("skips malformed lines instead of failing", async () => {
  const r = await run("tests/wf-cost/fixtures", "--json");
  const aaa = JSON.parse(r.stdout).agents.find((a) => a.id === "aaa");
  expect(aaa.turns).toBe(2);
});

test("cost index weights output 5x, fresh 1x, cache 0.1x", async () => {
  const r = await run("tests/wf-cost/fixtures", "--json");
  const aaa = JSON.parse(r.stdout).agents.find((a) => a.id === "aaa");
  // fresh 1010, cache 1000, out 70  ->  70*5 + 1010 + 100 = 1460
  expect(aaa.fresh).toBe(1010);
  expect(aaa.cache).toBe(1000);
  expect(aaa.out).toBe(70);
  expect(aaa.cost).toBeCloseTo(1460, 5);
});

test("tracks context growth and tool mix", async () => {
  const r = await run("tests/wf-cost/fixtures", "--json");
  const aaa = JSON.parse(r.stdout).agents.find((a) => a.id === "aaa");
  expect(aaa.ctxFirst).toBe(1000);
  expect(aaa.ctxMax).toBe(1010);
  expect(aaa.tools.Bash).toBe(1);
});

test("sorts agents by descending cost", async () => {
  const r = await run("tests/wf-cost/fixtures", "--json");
  const ids = JSON.parse(r.stdout).agents.map((a) => a.id);
  expect(ids[0]).toBe("bbb"); // 400*5 + 2000 + 500 = 4500 > 1460
});

test("human-readable output has a totals line", async () => {
  const r = await run("tests/wf-cost/fixtures");
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("cost index");
  expect(r.stdout).toContain("top 20% of agents");
});

test("exits 2 on a directory with no transcripts", async () => {
  const r = await run("tests/wf-cost");
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("no agent-");
});

test("exits 2 with usage when no directory is given", async () => {
  const r = await run();
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("usage:");
});
