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

// --- metadata can live in two places depending on plan vintage:
// older plans carry a structured top-level `metadata: {files[], modelTier}`;
// plans generated today carry that data only as a ```json:metadata fenced
// block at the end of `description` (see skills/shared/task-format-reference.md).
// Accept both, transparently, everywhere metadata is read.
const FENCE_RE = /```json:metadata\s*([\s\S]*?)```/g;
function readMeta(t) {
  if (t.metadata && typeof t.metadata === "object" && "modelTier" in t.metadata) {
    return t.metadata;
  }
  const desc = t.description || "";
  FENCE_RE.lastIndex = 0;
  let match, last;
  while ((match = FENCE_RE.exec(desc)) !== null) last = match;
  if (last) {
    try {
      return JSON.parse(last[1]);
    } catch (e) {
      console.error(
        `bundle-plan: task ${t.id} ("${t.subject}") has a malformed json:metadata fence in its ` +
        `description (${e.message}). Fix the fence's JSON before bundling.`
      );
      process.exit(1);
    }
  }
  return {};
}

// --- validate: every task must carry a tier. No defaulting. A silent default
// here is an expensive silent default at dispatch time.
const VALID = new Set(["mechanical", "standard", "frontier"]);
for (const t of tasks) {
  const tier = readMeta(t).modelTier;
  if (!VALID.has(tier)) {
    console.error(
      `bundle-plan: task ${t.id} ("${t.subject}") has modelTier=${JSON.stringify(tier)}; ` +
      `expected one of ${[...VALID].join(", ")}. Assign a tier in the plan before bundling.`
    );
    process.exit(1);
  }
}

const filesOf = (t) => new Set(readMeta(t).files || []);
const tierOf = (t) => readMeta(t).modelTier;

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
