# Orchestrated Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use claude-superpowers:subagent-driven-development (recommended) or claude-superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third execution option — Orchestrated (Simple|Full) — that runs an implementation plan through a fixed, versioned Workflow-tool script with Beads as the durable tracker, and remove the Backlog.md epic layer it replaces.

**Architecture:** `writing-plans` keeps producing native tasks and `<plan>.tasks.json`. A new `orchestrating-execution` skill runs a deterministic bundler script over that file to produce a committed `<plan>.bundles.json` manifest, ports the plan into Beads, then launches `scripts/orchestrate.js` with the manifest and tier→model map passed as `args`. The workflow script enforces model routing itself, because `PreToolUse:Agent` hooks do not fire for Workflow `agent()` spawns.

**Tech Stack:** Bash + Python3 hooks (existing), TypeScript/`bun` for tests (existing), Node ESM for the bundler CLI, Claude Code Workflow tool for orchestration, `bd` (Beads) CLI for tracking.

**Global Constraints:**
- Tier names in code are always `mechanical | standard | frontier`. Never hardcode `sonnet`/`opus`/`fable` — those live only in `docs/superpowers/model-routing.json`.
- Workflow scripts have **no filesystem access** and `Date.now()` / `Math.random()` / `new Date()` throw. All file reads happen in the coordinator; the script receives data via `args`.
- `bd link A B` means **B blocks A**. Getting the order backwards silently inverts the dependency graph.
- Agents never run `bd close`. Only the coordinator transitions beads to closed.
- Bundle size cap: 5 tasks or 15 distinct files, whichever binds first.
- Test-fix loop: max 2 rounds, escalating the fixer one tier on round 2.
- `skills/subagent-driven-development/SKILL.md` and `skills/executing-plans/SKILL.md` MUST NOT be modified.

**User decisions (already made):**
- "Hybrid: fixed script + generated manifest" — plugin ships the script, coordinator generates an inspectable manifest.
- "Offer Beads adoption at the handoff" — if `.beads/` is absent, offer `bd init` / continue untracked / cancel.
- "Sequential bundles, notes chained" — implementation is sequential to preserve the `implNotes` chain; parallelism is deliberately given up.
- "Route by owner, then one integration pass" — fixes are routed per bundle, but run sequentially (revised after sequential implementation removed the disjointness guarantee).
- "2 rounds, escalate tier each round, then stop."
- "get rid of all the backlog stuff, we will only use beads from now on."
- "Native at plan time, port to beads at handoff" — keeps `pre-taskcreate-model-tier` enforcement alive.
- Test runs before Refactor, correcting the ordering in the original `epic-pipeline`.

---

### Task 1: Remove the Backlog.md epic layer

**Goal:** Delete the Backlog.md skills, hooks, templates and fixtures, leaving Beads as the only tracker.

**Files:**
- Delete: `skills/adopting-backlog/`, `skills/tracking-with-backlog/`, `skills/planning-an-epic/`, `skills/linking-a-plan/`, `skills/converting-a-design/`
- Delete: `skills/shared/backlog-cli-cheatsheet.md`, `skills/shared/link-convention.md`, `skills/shared/status-mapping.md`
- Delete: `hooks/sync-backlog-status.ts`, `hooks/sync-backlog-status.test.ts`, `hooks/remind-backlog-reconcile.ts`, `hooks/remind-backlog-reconcile.test.ts`
- Delete: `templates/`, `tests/hook-fixtures/`
- Modify: `hooks/hooks.json` — remove the `PostToolUse` block
- Modify: `README.md` — remove the "What this fork adds beyond upstream" epic-layer table

**Acceptance Criteria:**
- [ ] `git grep -il backlog -- skills hooks templates` returns nothing
- [ ] `hooks/hooks.json` contains only `SessionStart` and `PreToolUse`
- [ ] `claude plugin validate .` passes
- [ ] No file in the repo references a deleted path

**Verify:** `claude plugin validate . && ! git grep -qi backlog -- skills hooks && echo OK`

**Steps:**

- [ ] **Step 1: Delete the skills, shared references, hooks and fixtures**

```bash
cd ~/projects/claude-superpowers
git rm -r -q skills/adopting-backlog skills/tracking-with-backlog \
  skills/planning-an-epic skills/linking-a-plan skills/converting-a-design
git rm -q skills/shared/backlog-cli-cheatsheet.md skills/shared/link-convention.md \
  skills/shared/status-mapping.md
git rm -q hooks/sync-backlog-status.ts hooks/sync-backlog-status.test.ts \
  hooks/remind-backlog-reconcile.ts hooks/remind-backlog-reconcile.test.ts
git rm -r -q templates tests/hook-fixtures
```

- [ ] **Step 2: Remove the PostToolUse block from hooks/hooks.json**

```bash
python3 - <<'PY'
import json
p='hooks/hooks.json'
d=json.load(open(p))
d['hooks'].pop('PostToolUse', None)
json.dump(d, open(p,'w'), indent=2)
print(list(d['hooks'].keys()))
PY
```

Expected output: `['SessionStart', 'PreToolUse']`

- [ ] **Step 3: Remove the epic-layer section from README.md**

Delete the block that begins with `## What this fork adds beyond upstream` and ends immediately before the `---` that precedes `**Local changes** live on top of upstream`. Leave the fork-lineage header and the rebrand/merge instructions intact.

- [ ] **Step 4: Verify no dangling references remain**

Run: `git grep -in 'backlog' -- . ':!docs/superpowers/specs' ':!docs/superpowers/plans' || echo CLEAN`
Expected: `CLEAN` (spec and plan documents legitimately discuss the removal)

- [ ] **Step 5: Validate the plugin still loads**

Run: `claude plugin validate .`
Expected: `✔ Validation passed`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: remove Backlog.md epic layer in favour of Beads

bd init writes the agent-instructions snippet and installs hooks that
auto-inject bd prime, so Beads covers onboarding and always-on context
without a skill layer — and bd prime is dynamic where a skill is static."
```

---

### Task 2: Deterministic bundler script

**Goal:** `scripts/bundle-plan.mjs` reads a `.tasks.json` and writes a `.bundles.json` manifest, partitioning by tier and merging on coupling.

**Files:**
- Create: `scripts/bundle-plan.mjs`
- Create: `tests/bundle-plan/bundle-plan.test.ts`
- Create: `tests/bundle-plan/fixtures/simple.tasks.json`
- Create: `tests/bundle-plan/fixtures/oversized.tasks.json`
- Create: `tests/bundle-plan/fixtures/missing-tier.tasks.json`

**Acceptance Criteria:**
- [ ] Tasks of different `modelTier` are never placed in the same bundle
- [ ] Tasks sharing a file, or joined by a direct `blockedBy` edge, land in the same bundle
- [ ] Bundles are emitted in an order where every bundle's dependencies precede it
- [ ] A task with no `modelTier` causes exit code 1 and a message naming the task id
- [ ] A bundle exceeding 5 tasks or 15 files causes exit code 1 naming the tasks and the shared files
- [ ] `--max-tasks` / `--max-files` override the caps

**Verify:** `bun test tests/bundle-plan/` → all pass

**Steps:**

- [ ] **Step 1: Write the fixtures**

`tests/bundle-plan/fixtures/simple.tasks.json`:

```json
{
  "planPath": "docs/superpowers/plans/x.md",
  "tasks": [
    {"id": 0, "subject": "A", "status": "pending", "metadata": {"files": ["src/a.ts"], "modelTier": "mechanical"}},
    {"id": 1, "subject": "B", "status": "pending", "metadata": {"files": ["src/a.ts", "src/b.ts"], "modelTier": "mechanical"}},
    {"id": 2, "subject": "C", "status": "pending", "blockedBy": [1], "metadata": {"files": ["src/c.ts"], "modelTier": "standard"}},
    {"id": 3, "subject": "D", "status": "pending", "blockedBy": [2], "metadata": {"files": ["src/c.ts"], "modelTier": "standard"}},
    {"id": 4, "subject": "E", "status": "pending", "metadata": {"files": ["src/e.ts"], "modelTier": "frontier"}}
  ],
  "lastUpdated": "2026-08-13T00:00:00Z"
}
```

Expected bundling: tasks 0+1 merge (shared `src/a.ts`, both mechanical); tasks 2+3 merge (shared `src/c.ts` and a `blockedBy` edge, both standard); task 4 alone (frontier). Three bundles.

`tests/bundle-plan/fixtures/missing-tier.tasks.json`: copy `simple.tasks.json` and delete `modelTier` from task 2's metadata.

`tests/bundle-plan/fixtures/oversized.tasks.json`: six `standard` tasks that all list `src/index.ts` in `files`, forcing a single 6-task bundle.

- [ ] **Step 2: Write the failing tests**

`tests/bundle-plan/bundle-plan.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test tests/bundle-plan/`
Expected: FAIL — `scripts/bundle-plan.mjs` does not exist

- [ ] **Step 4: Implement the bundler**

`scripts/bundle-plan.mjs`:

```js
#!/usr/bin/env node
// Deterministic plan bundler. Reads a superpowers <plan>.tasks.json and emits a
// bundle manifest: tasks grouped by modelTier, merged on coupling signals.
//
// Bundling is set arithmetic, not judgment — a model doing it by eye is
// inconsistent and the failure is silent. Keep this deterministic.

import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const input = argv.find((a) => !a.startsWith("--"));
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? def : Number(argv[i + 1]);
};
const toStdout = argv.includes("--stdout");
const MAX_TASKS = flag("max-tasks", 5);
const MAX_FILES = flag("max-files", 15);

if (!input) {
  console.error("usage: bundle-plan.mjs <plan>.tasks.json [--stdout] [--max-tasks N] [--max-files N]");
  process.exit(2);
}

const doc = JSON.parse(readFileSync(input, "utf8"));
const tasks = doc.tasks || [];

// --- validate: every task must carry a tier. No defaulting. A silent default
// here is an expensive silent default at dispatch time.
const VALID = new Set(["mechanical", "standard", "frontier"]);
for (const t of tasks) {
  const tier = t.metadata?.modelTier;
  if (!VALID.has(tier)) {
    console.error(
      `bundle-plan: task ${t.id} ("${t.subject}") has modelTier=${JSON.stringify(tier)}; ` +
      `expected one of ${[...VALID].join(", ")}. Assign a tier in the plan before bundling.`
    );
    process.exit(1);
  }
}

const filesOf = (t) => new Set(t.metadata?.files || []);
const tierOf = (t) => t.metadata.modelTier;

// --- union-find over tasks, constrained to same-tier merges
const parent = new Map(tasks.map((t) => [t.id, t.id]));
const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

const overlaps = (a, b) => [...filesOf(a)].some((f) => filesOf(b).has(f));
const directEdge = (a, b) =>
  (a.blockedBy || []).includes(b.id) || (b.blockedBy || []).includes(a.id);

for (let i = 0; i < tasks.length; i++) {
  for (let j = i + 1; j < tasks.length; j++) {
    const a = tasks[i], b = tasks[j];
    if (tierOf(a) !== tierOf(b)) continue;          // never merge across tiers
    if (overlaps(a, b) || directEdge(a, b)) union(a.id, b.id);
  }
}

// --- pack leftover small singletons into same-tier bundles under cap
const groups = new Map();
for (const t of tasks) {
  const r = find(t.id);
  if (!groups.has(r)) groups.set(r, []);
  groups.get(r).push(t);
}
const isSmall = (t) => filesOf(t).size <= 2;
for (const [root, members] of [...groups]) {
  if (members.length !== 1 || !isSmall(members[0])) continue;
  const solo = members[0];
  const target = [...groups.entries()].find(([r, ms]) =>
    r !== root &&
    tierOf(ms[0]) === tierOf(solo) &&
    ms.length + 1 <= MAX_TASKS &&
    new Set([...ms.flatMap((m) => [...filesOf(m)]), ...filesOf(solo)]).size <= MAX_FILES
  );
  if (target) { target[1].push(solo); groups.delete(root); }
}

// --- build bundles, then order them by dependency
let bundles = [...groups.values()].map((members, i) => {
  const taskIds = members.map((m) => m.id).sort((a, b) => a - b);
  const files = [...new Set(members.flatMap((m) => [...filesOf(m)]))].sort();
  return { id: `b${i + 1}`, tier: tierOf(members[0]), taskIds, files, blockedByBundles: [] };
});

const bundleOfTask = new Map();
for (const b of bundles) for (const id of b.taskIds) bundleOfTask.set(id, b.id);
for (const t of tasks)
  for (const dep of t.blockedBy || []) {
    const from = bundleOfTask.get(t.id), to = bundleOfTask.get(dep);
    if (from && to && from !== to && !bundles.find((b) => b.id === from).blockedByBundles.includes(to))
      bundles.find((b) => b.id === from).blockedByBundles.push(to);
  }

// topological sort — stable, deterministic
const ordered = [];
const remaining = new Map(bundles.map((b) => [b.id, b]));
while (remaining.size) {
  const ready = [...remaining.values()]
    .filter((b) => b.blockedByBundles.every((d) => !remaining.has(d)))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!ready.length) {
    console.error(`bundle-plan: dependency cycle among bundles ${[...remaining.keys()].join(", ")}`);
    process.exit(1);
  }
  for (const b of ready) { ordered.push(b); remaining.delete(b.id); }
}
bundles = ordered;

// --- enforce caps last, so the message can name the real culprit
for (const b of bundles) {
  if (b.taskIds.length > MAX_TASKS || b.files.length > MAX_FILES) {
    const shared = b.files.filter((f) =>
      b.taskIds.filter((id) => filesOf(tasks.find((t) => t.id === id)).has(f)).length > 1);
    console.error(
      `bundle-plan: bundle ${b.id} has ${b.taskIds.length} tasks / ${b.files.length} files ` +
      `(cap ${MAX_TASKS}/${MAX_FILES}). Tasks: ${b.taskIds.join(", ")}. ` +
      `Shared files forcing the merge: ${shared.join(", ") || "(none — raise --max-tasks)"}. ` +
      `Restructure the plan so each shared file is touched by one task.`
    );
    process.exit(1);
  }
}

const manifest = {
  planPath: doc.planPath,
  generatedFrom: input,
  maxTasks: MAX_TASKS,
  maxFiles: MAX_FILES,
  taskTiers: Object.fromEntries(tasks.map((t) => [t.id, tierOf(t)])),
  bundles,
};

const out = JSON.stringify(manifest, null, 2);
if (toStdout) process.stdout.write(out);
else {
  const path = input.replace(/\.tasks\.json$/, ".bundles.json");
  writeFileSync(path, out + "\n");
  console.log(`wrote ${path} — ${bundles.length} bundle(s) from ${tasks.length} task(s)`);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/bundle-plan/`
Expected: 6 pass, 0 fail

- [ ] **Step 6: Commit**

```bash
git add scripts/bundle-plan.mjs tests/bundle-plan/
git commit -m "feat: deterministic plan bundler

Partitions plan tasks by modelTier, merges on coupling signals (shared files,
direct blockedBy edges, small singletons), orders by dependency, and refuses
oversized bundles or tasks with no tier."
```

---

### Task 3: Workflow orchestration script

**Goal:** `scripts/orchestrate.js` runs the Simple and Full pipelines, resolving tier→model itself.

**Files:**
- Create: `scripts/orchestrate.js`
- Create: `tests/orchestrate/resolve.test.ts`

**Acceptance Criteria:**
- [ ] `resolveModel(tier, routing)` returns the mapped model, and throws naming the tier when unmapped
- [ ] `validateArgs` throws when any bundle lacks a tier, when `mode` is not `simple`/`full`, or when `bundles` is empty
- [ ] Simple runs Implement → Review&Fix → Test; Full runs Implement → Review → Fixes → Test → Refactor → Test
- [ ] Implementation is sequential and each dispatch receives all prior bundles' notes
- [ ] Every dispatch is logged with its bundle id, tier and resolved model
- [ ] The test loop runs at most 2 fix rounds, escalating one tier on round 2

**Verify:** `bun test tests/orchestrate/` → all pass

**Steps:**

- [ ] **Step 1: Write the failing tests for the pure helpers**

`tests/orchestrate/resolve.test.ts`:

```ts
import { test, expect } from "bun:test";
import { resolveModel, escalate, validateArgs } from "../../scripts/orchestrate.js";

const ROUTING = { mechanical: "sonnet", standard: "opus", frontier: "fable" };

test("resolves tier to model", () => {
  expect(resolveModel("standard", ROUTING)).toBe("opus");
});

test("throws naming the tier when unmapped", () => {
  expect(() => resolveModel("frontier", { mechanical: "sonnet" })).toThrow(/frontier/);
});

test("escalates one tier and stops at frontier", () => {
  expect(escalate("mechanical")).toBe("standard");
  expect(escalate("standard")).toBe("frontier");
  expect(escalate("frontier")).toBe("frontier");
});

test("rejects a bundle with no tier", () => {
  expect(() => validateArgs({ mode: "full", routing: ROUTING,
    bundles: [{ id: "b1", taskIds: [1] }] })).toThrow(/tier/);
});

test("rejects an unknown mode", () => {
  expect(() => validateArgs({ mode: "turbo", routing: ROUTING,
    bundles: [{ id: "b1", tier: "standard", taskIds: [1] }] })).toThrow(/mode/);
});

test("accepts a well-formed args object", () => {
  expect(() => validateArgs({ mode: "simple", routing: ROUTING,
    bundles: [{ id: "b1", tier: "standard", taskIds: [1] }] })).not.toThrow();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/orchestrate/`
Expected: FAIL — cannot resolve `scripts/orchestrate.js`

- [ ] **Step 3: Implement the script**

`scripts/orchestrate.js` — note the exported helpers at the top are what the tests import; the workflow body below them runs only under the Workflow tool.

```js
// Orchestrated execution pipeline.
//
// Routing is enforced HERE, not by a hook: PreToolUse:Agent does not fire for
// Workflow agent() spawns (measured 2026-08-13, see the design doc). Every
// dispatch resolves its model from the tier map and is logged, because that log
// is the only routing audit trail that exists inside a workflow.

export const TIERS = ["mechanical", "standard", "frontier"];

export function resolveModel(tier, routing) {
  const m = routing?.[tier];
  if (!m) throw new Error(`orchestrate: no model mapped for tier "${tier}" in model-routing.json`);
  return m;
}

export function escalate(tier) {
  const i = TIERS.indexOf(tier);
  return i === -1 || i === TIERS.length - 1 ? TIERS[TIERS.length - 1] : TIERS[i + 1];
}

export function validateArgs(a) {
  if (!a || typeof a !== "object") throw new Error("orchestrate: args missing");
  if (a.mode !== "simple" && a.mode !== "full")
    throw new Error(`orchestrate: mode must be "simple" or "full", got ${JSON.stringify(a.mode)}`);
  if (!Array.isArray(a.bundles) || a.bundles.length === 0)
    throw new Error("orchestrate: bundles must be a non-empty array");
  for (const b of a.bundles) {
    if (!TIERS.includes(b.tier))
      throw new Error(`orchestrate: bundle ${b.id} has no valid tier (got ${JSON.stringify(b.tier)})`);
    resolveModel(b.tier, a.routing);
  }
  return true;
}

export const meta = {
  name: "orchestrated-execution",
  description: "Run an implementation plan: bundled sequential implementation, layered review, routed fixes, refactor, bounded test loop",
  phases: [
    { title: "Implement", detail: "sequential bundles, notes chained" },
    { title: "Review", detail: "per-bundle reviews plus a whole-epic review" },
    { title: "Fixes", detail: "routed by owning bundle, sequential" },
    { title: "Test", detail: "run then bounded fix loop" },
    { title: "Refactor", detail: "plan then execute (full mode only)" },
  ],
};

const FINDINGS = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          issue: { type: "string" },
          severity: { type: "string", enum: ["critical", "major", "minor"] },
          bundleId: { type: "string" },
        },
        required: ["file", "issue", "severity"],
      },
    },
  },
  required: ["findings"],
};

const TESTRES = {
  type: "object",
  properties: { pass: { type: "boolean" }, summary: { type: "string" } },
  required: ["pass", "summary"],
};

// Workflow body — only runs under the Workflow tool, where `agent`, `phase`,
// `log` and `args` are globals. Guarded so `bun test` can import the helpers.
if (typeof agent === "function") {
  const A = typeof args === "string" ? JSON.parse(args) : args;
  validateArgs(A);
  const { mode, routing, bundles, ctx, epicId } = A;
  const M = (tier) => resolveModel(tier, routing);

  const dispatch = (prompt, { tier, label, phase: ph, schema }) => {
    const model = M(tier);
    log(`dispatch ${label} — tier=${tier} model=${model}`);
    return agent(`${ctx}\n\n${prompt}`, { model, label, phase: ph, ...(schema ? { schema } : {}) });
  };

  // ---- Implement: sequential, notes chained.
  phase("Implement");
  const notes = [];
  for (const b of bundles) {
    const r = await dispatch(
      `Implement beads tasks ${b.taskIds.join(", ")} (bundle ${b.id}, epic ${epicId}).
For each task: run \`bd show <id>\` for the full description and acceptance criteria, read the
code you are extending, implement completely including the tests named in acceptance criteria,
run the suite, and commit with the task id as the message prefix.
Notes from previously implemented bundles:
${notes.length ? notes.join("\n") : "(none — you are first)"}

Return a SHORT summary (5-10 lines): what you built, key files, deviations, and anything later
bundles must know.`,
      { tier: b.tier, label: `impl:${b.id}`, phase: "Implement" }
    );
    notes.push(`${b.id} (tasks ${b.taskIds.join(",")}): ${r}`);
    log(`implemented ${b.id}`);
  }

  // ---- Review
  phase("Review");
  let findings = [];
  if (mode === "full") {
    const perBundle = await parallel(bundles.map((b) => () =>
      dispatch(
        `Review the commits for beads tasks ${b.taskIds.join(", ")} (bundle ${b.id}). Read each
task, find its commits, read the touched code in full. Report REAL defects only: logic errors,
acceptance criteria not met, broken or missing tests, type unsafety. No style nits, no praise.
Set bundleId="${b.id}" on every finding.`,
        { tier: "mechanical", label: `review:${b.id}`, phase: "Review", schema: FINDINGS }
      )
    ));
    const epicReview = await dispatch(
      `Whole-plan review of epic ${epicId}. Read the codebase and the full git log for this plan.
Focus on what per-bundle review structurally cannot see: cross-bundle integration bugs,
architecture drift, duplicated logic between bundles, invariants broken in aggregate.
Leave bundleId unset on findings that span bundles or belong to none.`,
      { tier: "frontier", label: "review:plan", phase: "Review", schema: FINDINGS }
    );
    findings = [
      ...perBundle.filter(Boolean).flatMap((r) => r.findings || []),
      ...((epicReview && epicReview.findings) || []),
    ];
    log(`${findings.length} review findings`);
  }

  // ---- Fixes: routed by owning bundle, sequential (no disjointness guarantee).
  phase("Fixes");
  if (mode === "simple") {
    await dispatch(
      `Review every commit made for epic ${epicId}, then fix what you find in the same pass.
Report REAL defects only. Verify each against the code before changing it. Run the suite until
green and commit as "${epicId}: review fixes".`,
      { tier: "standard", label: "review-and-fix", phase: "Fixes" }
    );
  } else if (findings.length) {
    const fmt = (f) => `- [${f.severity}] ${f.file}: ${f.issue}`;
    for (const b of bundles) {
      const own = findings.filter((f) => f.bundleId === b.id);
      if (!own.length) continue;
      await dispatch(
        `Apply these review findings for bundle ${b.id}. Verify each against the code first — skip
any that are wrong. Run the suite until green, commit as "${epicId}: fixes ${b.id}".
${own.map(fmt).join("\n")}

Return which findings you fixed and which you rejected, with reasons.`,
        { tier: "standard", label: `fix:${b.id}`, phase: "Fixes" }
      );
    }
    const cross = findings.filter((f) => !f.bundleId || !bundles.some((b) => b.id === f.bundleId));
    if (cross.length) {
      await dispatch(
        `Apply these cross-cutting review findings for epic ${epicId} — they span bundles or belong
to none. Verify each first. Run the suite until green, commit as "${epicId}: cross-cutting fixes".
${cross.map(fmt).join("\n")}`,
        { tier: "standard", label: "fix:cross-cutting", phase: "Fixes" }
      );
    }
  }

  // ---- Test loop: run at mechanical, fix at standard, escalate once.
  const testLoop = async (round) => {
    phase("Test");
    let tier = "standard";
    for (let i = 0; i < 2; i++) {
      const res = await dispatch(
        `Run the FULL verification for this project: the test suite plus typecheck. pass=true ONLY
if everything passes. Quote exact failing test names and errors in the summary.
Do not fix anything.`,
        { tier: "mechanical", label: `test:${round}:${i}`, phase: "Test", schema: TESTRES }
      );
      if (res && res.pass) { log(`tests green (${round}, round ${i})`); return true; }
      await dispatch(
        `Fix these test/typecheck failures. Fix code or tests, whichever is wrong. Run until green,
commit as "${epicId}: test fixes".
${res ? res.summary : "test agent returned nothing — run the suite yourself and fix what you find"}`,
        { tier, label: `testfix:${round}:${i}`, phase: "Test" }
      );
      tier = escalate(tier);
    }
    log(`test loop exhausted after 2 rounds (${round}) — stopping, branch left intact`);
    return false;
  };

  const greenAfterImpl = await testLoop("post-fixes");

  // ---- Refactor (full only), then re-test.
  let greenAfterRefactor = null;
  if (mode === "full" && greenAfterImpl) {
    phase("Refactor");
    const plan = await dispatch(
      `Refactor planning for epic ${epicId}. Read the codebase. Do NOT change any code.
Goals: DRY, clear module boundaries, no magic values in logic, better abstractions where the code
will grow. Produce a concrete ORDERED plan with file-level instructions an implementer can execute
without judgment calls. If the code is already clean, say so and return a minimal plan.`,
      { tier: "frontier", label: "refactor:plan", phase: "Refactor" }
    );
    await dispatch(
      `Execute this refactor plan EXACTLY. Keep the suite green — run it after each major step.
Commit each step as "${epicId}: refactor — <step>".
${plan}`,
      { tier: "standard", label: "refactor:exec", phase: "Refactor" }
    );
    greenAfterRefactor = await testLoop("post-refactor");
  }

  return {
    epicId,
    mode,
    bundles: bundles.length,
    findings: findings.length,
    greenAfterImpl,
    greenAfterRefactor,
    notes,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/orchestrate/`
Expected: 6 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add scripts/orchestrate.js tests/orchestrate/
git commit -m "feat: orchestration workflow script

Simple and Full pipelines with sequential bundled implementation, chained
implementation notes, layered review, routed sequential fixes, and a bounded
test loop. Resolves tier to model itself and logs every dispatch, because
PreToolUse:Agent does not fire inside workflows."
```

---

### Task 4: The orchestrating-execution skill

**Goal:** A skill that takes a finished plan, offers Beads adoption if needed, generates the manifest, ports the plan into Beads, and launches the workflow.

**Files:**
- Create: `skills/orchestrating-execution/SKILL.md`

**Acceptance Criteria:**
- [ ] Describes the Beads-absent branch: offer `bd init`, continue untracked, or cancel
- [ ] Runs `scripts/bundle-plan.mjs` and stops on non-zero exit, surfacing the message verbatim
- [ ] Specifies the exact `bd create` invocations for the epic and children, including `--external-ref`
- [ ] States the `bd link A B` argument-order warning
- [ ] States that agents never run `bd close`
- [ ] Specifies that the coordinator reads the manifest and `model-routing.json` and passes both via `args`
- [ ] Ends by suggesting `/complete-epic`

**Verify:** `head -4 skills/orchestrating-execution/SKILL.md` shows valid frontmatter, and `claude plugin validate .` passes

**Steps:**

- [ ] **Step 1: Write the skill**

Create `skills/orchestrating-execution/SKILL.md` with frontmatter:

```markdown
---
name: orchestrating-execution
description: Use when the user picks "Orchestrated" at the plan execution handoff - bundles the plan, ports it into Beads, and runs it through the orchestration workflow script.
---
```

Body must cover, in order:

1. **Announce:** "I'm using the orchestrating-execution skill to run this plan."
2. **Resolve mode** from the chosen option — Simple or Full.
3. **Beads check.** `command -v bd` and `test -d .beads`. If absent, `AskUserQuestion` with exactly three options: initialise now (`bd init`), continue untracked, cancel. Include the literal token `CLARIFICATION` in the question text so the handoff guard's escape hatch permits it.
4. **Generate the manifest.** `node "${CLAUDE_PLUGIN_ROOT}/scripts/bundle-plan.mjs" <plan>.tasks.json`. On non-zero exit, STOP and show the script's stderr verbatim — it names the tasks and files to restructure. Do not attempt to bundle by hand.
5. **Show the manifest** to the user before launching, and commit it alongside the plan.
6. **Port to Beads** (skip entirely when untracked):

```bash
EPIC=$(bd create "<plan title>" -t epic -p 1 --external-ref "<planPath>" --json | jq -r '.id')
bd create "<task subject>" --parent "$EPIC" -t task -p <n> \
   -d "<Goal + Files + Steps>" --acceptance "<AC block>" --external-ref "<planPath>"
```

   Replay `blockedBy` with `bd link <blocked> <blocker>` — **`bd link A B` means B blocks A.**

7. **Launch.** Read `docs/superpowers/model-routing.json` (project first, then `~/.claude/superpowers/`) and the manifest, then call the Workflow tool with `scriptPath` pointing at `${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate.js` and `args` carrying `{mode, routing, bundles, ctx, epicId}`. `ctx` is a conventions block assembled from the repo's CLAUDE.md and the plan's Global Constraints, and MUST end with "Do NOT run bd close."
8. **On completion:** claim/close member beads with `bd update <id> --claim` at start and `bd close` only from this skill; report the epic id; suggest `/complete-epic <epic-id>`.
9. **Anti-patterns table:** bundling by hand when the script fails; letting agents close beads; passing a file path to the workflow instead of parsed data; defaulting a missing tier.

- [ ] **Step 2: Verify frontmatter and plugin validity**

Run: `head -4 skills/orchestrating-execution/SKILL.md && claude plugin validate .`
Expected: valid `name:` and `description:` lines, then `✔ Validation passed`

- [ ] **Step 3: Commit**

```bash
git add skills/orchestrating-execution/
git commit -m "feat: orchestrating-execution skill

Coordinator for the Orchestrated handoff option: Beads adoption prompt,
manifest generation, plan-to-Beads port, and workflow launch."
```

---

### Task 5: Wire the handoff

**Goal:** Add the two Orchestrated options to the execution handoff and teach the guard about the new skill.

**Files:**
- Modify: `skills/writing-plans/SKILL.md` — the `AskUserQuestion` block and both HARD-GATE routing branches
- Modify: `hooks/pre-askuser-handoff-guard` — disarm list (two places) and the teach message
- Modify: `tests/claude-code/test-handoff-guard.sh` — new cases

**Acceptance Criteria:**
- [ ] The handoff offers four options; both original labels are unchanged
- [ ] A four-option menu containing both required labels passes the guard (exit 0)
- [ ] A `Skill` call to `claude-superpowers:orchestrating-execution` disarms the guard
- [ ] The block message no longer claims exactly two options are permitted
- [ ] `writing-plans` routes each Orchestrated option to `claude-superpowers:orchestrating-execution`

**Verify:** `bash tests/claude-code/test-handoff-guard.sh` → all assertions pass

**Steps:**

- [ ] **Step 1: Write the failing guard tests**

First add a fixture transcript next to the existing ones (after the `disarmed-by-execution.jsonl`
block, around line 105):

```bash
# Transcript: armed, then disarmed by the orchestrating-execution skill.
cat > "$WORK/disarmed-by-orchestrated.jsonl" <<'EOF'
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"claude-superpowers:writing-plans"}}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"TaskCreate","input":{"subject":"Task 1","description":"goal"}}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"claude-superpowers:orchestrating-execution"}}]}}
EOF
```

Then add an input builder alongside `make_compliant_input` (around line 178):

```bash
# Four-option handoff: both required labels plus the two Orchestrated options.
make_four_option_input() {
    local transcript="$1" cwd="${2:-$WORK/project}"
    python3 -c "
import json, sys
inp = {
    'tool_name': 'AskUserQuestion',
    'tool_input': {
        'questions': [{
            'question': 'Plan complete and saved to docs/superpowers/plans/2026-06-10-foo.md. How would you like to execute it?',
            'header': 'Execution',
            'options': [
                {'label': 'Subagent-Driven (this session)', 'description': 'per-task subagents'},
                {'label': 'Parallel Session (separate)', 'description': 'separate session in a worktree'},
                {'label': 'Orchestrated — Simple', 'description': 'bundled, one review-and-fix pass, tests'},
                {'label': 'Orchestrated — Full', 'description': 'bundled, layered review, fixes, tests, refactor, tests'}
            ]
        }]
    },
    'transcript_path': sys.argv[1],
    'cwd': sys.argv[2]
}
print(json.dumps(inp))
" "$transcript" "$cwd"
}
```

Then append the two test cases at the end of the Tests section, following the existing numbering:

```bash
echo "Test N: four-option handoff incl. Orchestrated → allow"
INPUT=$(make_four_option_input "$WORK/armed-via-skill.jsonl")
rc=$(run_hook "$INPUT")
assert "exit code" "0" "$rc"
echo ""

echo "Test N+1: disarmed by orchestrating-execution → allow"
INPUT=$(make_wrong_options_input "$WORK/disarmed-by-orchestrated.jsonl")
rc=$(run_hook "$INPUT")
assert "exit code" "0" "$rc"
echo ""
```

Replace `N` and `N+1` with the next free numbers in the file.

- [ ] **Step 2: Run to verify failure**

Run: `bash tests/claude-code/test-handoff-guard.sh`
Expected: the disarm test FAILS (exit 2) — the guard does not yet know the skill

- [ ] **Step 3: Add the skill to both disarm paths in the guard**

In `hooks/pre-askuser-handoff-guard`, the tool_use branch:

```python
                    if (skill_val in ("subagent-driven-development", "executing-plans",
                                      "execute-plan", "orchestrating-execution")
                            or skill_val.endswith(":subagent-driven-development")
                            or skill_val.endswith(":executing-plans")
                            or skill_val.endswith(":execute-plan")
                            or skill_val.endswith(":orchestrating-execution")):
```

And the user-message branch:

```python
            if ("claude-superpowers:subagent-driven-development" in text
                    or "claude-superpowers:executing-plans" in text
                    or "claude-superpowers:orchestrating-execution" in text):
```

- [ ] **Step 4: Correct the teach message**

In the block message, replace "The skill's HARD-GATE permits exactly one structure here." with wording that states the two required labels must be present and that additional Orchestrated options are permitted. Add the two Orchestrated labels to the printed required YAML.

- [ ] **Step 5: Update the handoff in writing-plans**

In `skills/writing-plans/SKILL.md`, extend the `AskUserQuestion` block:

```yaml
    - label: "Orchestrated — Simple"
      description: "Bundled sequential implementation, one review-and-fix pass, then tests. Tracked in Beads."
    - label: "Orchestrated — Full"
      description: "Bundled implementation, layered review, routed fixes, tests, refactor, tests. Tracked in Beads."
```

Then add to the post-choice HARD-GATE:

```markdown
**If either Orchestrated option chosen:**
Invoke the Skill tool: `claude-superpowers:orchestrating-execution`
- Pass the chosen mode (Simple or Full) to the skill
- The skill handles bundling, Beads, and launching the workflow
- Do NOT implement tasks yourself
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bash tests/claude-code/test-handoff-guard.sh`
Expected: all assertions pass, including the two new cases

- [ ] **Step 7: Verify the plugin still loads**

Run: `claude plugin validate .`
Expected: `✔ Validation passed`

- [ ] **Step 8: Commit**

```bash
git add skills/writing-plans/SKILL.md hooks/pre-askuser-handoff-guard tests/claude-code/test-handoff-guard.sh
git commit -m "feat: offer Orchestrated execution at the plan handoff

Four-option handoff. The guard already tolerated extra options — it checks the
two required labels are present, not that they are the only ones — so this adds
the new skill to the disarm list and corrects the teach message, which wrongly
claimed exactly one structure was permitted."
```

---

### Task 6: Document the new option

**Goal:** README covers Orchestrated execution and the Beads-only tracking model.

**Files:**
- Modify: `README.md`

**Acceptance Criteria:**
- [ ] A section describes both pipelines and when to pick each
- [ ] States that routing is enforced in the script because `PreToolUse:Agent` does not fire in workflows
- [ ] States the Beads requirement and the `bd init` fallback
- [ ] Links to the design doc

**Verify:** `grep -c 'Orchestrated' README.md` returns ≥ 3

**Steps:**

- [ ] **Step 1: Add the section**

Insert after the fork-lineage header, replacing the removed epic-layer section from Task 1. Cover: the four handoff options; the Simple and Full pipeline diagrams from the design doc; the bundling rule in two sentences; the tier→model mapping via `model-routing.json`; that Beads is the tracker with `bd init` offered when absent; and a link to `docs/superpowers/specs/2026-08-13-orchestrated-execution-design.md`.

- [ ] **Step 2: Verify**

Run: `grep -c 'Orchestrated' README.md`
Expected: 3 or more

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document Orchestrated execution in the README"
```

---

## Implementation deviations (recorded during execution)

**Task 2 — the small-singleton packing pass was removed.** The bundling rule above lists
"both tasks being small" as a merge signal. In review it produced two Critical defects: merging
zero-coupling same-tier tasks fabricates dependency cycles in the bundle graph, and the obvious
guard (task-level `blockedBy` reachability) is unsound because bundle-level precedence is a strict
superset of task-level precedence. Bundles now merge only on real coupling — shared files or a
direct `blockedBy` edge.

**Task 2 — `taskIds` is sorted topologically, not numerically.** The code in Task 2 Step 4 sorts
numerically, which can list a dependent before its blocker. Ruled by the human during execution:
correctness governs. Sorted by the intra-bundle `blockedBy` graph, tie-breaking by ascending id.
