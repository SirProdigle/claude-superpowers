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
  expect(r.stdout).toContain("of agents");
  expect(r.stdout).toContain("% of cost");
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

// --- real-transcript shape: several assistant lines share one message.id ---------------
// agent-ccc.jsonl has 4 assistant lines across 2 message.ids. msg_01 has 3 snapshots whose
// input/cache fields repeat (5 + 95 fresh, 0 cache) while output_tokens grows 5 -> 5 -> 187.
// Counting per line would report turns 4, fresh 310 and out 237.

test("counts one turn per message.id, not per assistant line", async () => {
  const r = await run("tests/wf-cost/fixtures-streamed", "--json");
  expect(r.code).toBe(0);
  const ccc = JSON.parse(r.stdout).agents.find((a) => a.id === "ccc");
  expect(ccc.turns).toBe(2); // not 4
});

test("keeps the last usage snapshot per message.id, never the sum or the first", async () => {
  const r = await run("tests/wf-cost/fixtures-streamed", "--json");
  const ccc = JSON.parse(r.stdout).agents.find((a) => a.id === "ccc");
  expect(ccc.fresh).toBe(110); // (5+95) + (10+0), not 3x100 + 10 = 310
  expect(ccc.cache).toBe(300); // 0 + 300, not repeated per snapshot
  expect(ccc.out).toBe(227); // final 187 + 40, not 5+5+187+40 = 237 and not first-snapshot 5+40
  expect(ccc.cost).toBeCloseTo(227 * 5 + 110 + 30, 5); // 1275
});

test("preserves tool calls split across snapshots of one message.id", async () => {
  const r = await run("tests/wf-cost/fixtures-streamed", "--json");
  const ccc = JSON.parse(r.stdout).agents.find((a) => a.id === "ccc");
  // Snapshots carry different content slices, so the Grep is only in snapshot 2 and the Read
  // only in snapshot 3. Keeping just the last snapshot would drop the Grep; counting every
  // line would double-count. De-duplicating on tool_use.id gives exactly one of each.
  expect(ccc.tools.Grep).toBe(1);
  expect(ccc.tools.Read).toBe(1);
});

test("context growth is measured over deduplicated turns", async () => {
  const r = await run("tests/wf-cost/fixtures-streamed", "--json");
  const ccc = JSON.parse(r.stdout).agents.find((a) => a.id === "ccc");
  expect(ccc.ctxFirst).toBe(100); // 5 + 95 + 0
  expect(ccc.ctxMax).toBe(310); // 10 + 0 + 300
  expect(ccc.growthPerTurn).toBe(210); // (310 - 100) / (2 - 1), not divided by an inflated 3
});

// --- journal labelling ------------------------------------------------------------------

test("labels an agent from journal result.task", async () => {
  const r = await run("tests/wf-cost/fixtures-journal", "--json");
  expect(r.code).toBe(0);
  const ddd = JSON.parse(r.stdout).agents.find((a) => a.id === "ddd");
  // The "started" line for ddd comes first and carries no task, so this also proves a later
  // record is allowed to upgrade a weaker label.
  expect(ddd.label).toBe("Task 7: Wire up the cost report");
});

test("never labels an agent with a v2 cache key", async () => {
  const r = await run("tests/wf-cost/fixtures-journal", "--json");
  const agents = JSON.parse(r.stdout).agents;
  for (const a of agents) expect(a.label.startsWith("v2:")).toBe(false);
  // eee appears in the journal with a key but no result, so it falls back to its filename.
  expect(agents.find((a) => a.id === "eee").label).toBe("eee");
});

// --- totals arithmetic ------------------------------------------------------------------

test("median turns averages the two middle values for an even agent count", async () => {
  const r = await run("tests/wf-cost/fixtures", "--json");
  const d = JSON.parse(r.stdout);
  expect(d.totals.medianTurns).toBe(1.5); // turns are [1, 2]; the upper-element bug gave 2
});

test("reports the share of agents the top slice actually covers", async () => {
  const r = await run("tests/wf-cost/fixtures", "--json");
  const d = JSON.parse(r.stdout);
  // 2 agents -> ceil(2/5) clamps to 1 agent, which is 50% of them, not 20%.
  expect(d.totals.topSliceAgents).toBe(1);
  expect(d.totals.topSlicePctAgents).toBe(50);
  expect(d.totals.top20PctCostShare).toBeCloseTo(75.5, 1); // 4500 / 5960
  const human = await run("tests/wf-cost/fixtures");
  expect(human.stdout).toContain("top 50% of agents (1/2) = 75.5% of cost");
});
