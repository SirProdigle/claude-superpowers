#!/usr/bin/env node
// Deterministic plan bundler. Reads a superpowers <plan>.tasks.json and emits a
// bundle manifest: tasks grouped by modelTier, merged on coupling signals.
//
// Bundling is set arithmetic, not judgment — a model doing it by eye is
// inconsistent and the failure is silent. Keep this deterministic.

import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);

// --- find the input path, being careful not to mistake a value-taking
// flag's argument (e.g. the "10" in `--max-tasks 10`) for the input path.
const VALUE_FLAGS = new Set(["--max-tasks", "--max-files"]);
let input;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VALUE_FLAGS.has(a)) { i++; continue; } // skip this flag's value token
  if (a.startsWith("--")) continue;          // boolean flag, e.g. --stdout
  if (input === undefined) input = a;
}

const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const raw = argv[i + 1];
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`bundle-plan: --${name} expects a positive integer, got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return n;
};
const toStdout = argv.includes("--stdout");
const MAX_TASKS = flag("max-tasks", 5);
const MAX_FILES = flag("max-files", 15);

if (!input) {
  console.error("usage: bundle-plan.mjs <plan>.tasks.json [--stdout] [--max-tasks N] [--max-files N]");
  process.exit(2);
}

// --- resolve the output path up front, and refuse to proceed if it would
// collide with the input. Without --stdout the input MUST end in
// `.tasks.json` — otherwise the `.tasks.json` -> `.bundles.json` swap is a
// no-op and writeFileSync would silently overwrite (destroy) the plan.
let outPath = null;
if (!toStdout) {
  if (!input.endsWith(".tasks.json")) {
    console.error(
      `bundle-plan: input file must end in .tasks.json so the output path ` +
      `(<plan>.bundles.json) cannot collide with it (got ${JSON.stringify(input)}). ` +
      `Pass --stdout, or rename the input.`
    );
    process.exit(2);
  }
  outPath = input.replace(/\.tasks\.json$/, ".bundles.json");
  if (outPath === input) {
    console.error(`bundle-plan: refusing to write the manifest over its own input (${input}).`);
    process.exit(2);
  }
}

let doc;
try {
  doc = JSON.parse(readFileSync(input, "utf8"));
} catch (e) {
  console.error(`bundle-plan: failed to read/parse ${input}: ${e.message}`);
  process.exit(2);
}
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
      const parsed = JSON.parse(last[1]);
      // A well-formed but non-object fence (e.g. `null`, a bare number) must
      // not crash downstream property reads — fall back to "no metadata",
      // which the validation loop below reports through its normal path.
      return (parsed && typeof parsed === "object") ? parsed : {};
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

// --- task-level precedence graph (fixed for the whole run — merging groups
// doesn't change which task blocks which). Used below so the packing pass
// can refuse a merge that would force a bundle to both precede and follow
// itself transitively through some other, unrelated bundle.
const dependentsOf = new Map();
for (const t of tasks) {
  for (const dep of t.blockedBy || []) {
    if (!dependentsOf.has(dep)) dependentsOf.set(dep, []);
    dependentsOf.get(dep).push(t.id);
  }
}
const reachableFrom = (startIds) => {
  const seen = new Set(startIds);
  const stack = [...startIds];
  while (stack.length) {
    const cur = stack.pop();
    for (const nxt of dependentsOf.get(cur) || []) {
      if (!seen.has(nxt)) { seen.add(nxt); stack.push(nxt); }
    }
  }
  return seen;
};
// true if any task in idsA must (transitively) precede any task in idsB,
// or vice versa — i.e. merging the two groups would create a cycle.
const hasPrecedencePath = (idsA, idsB) => {
  const fromA = reachableFrom(idsA);
  if (idsB.some((id) => fromA.has(id))) return true;
  const fromB = reachableFrom(idsB);
  return idsA.some((id) => fromB.has(id));
};

// --- pack leftover small singletons into same-tier bundles under cap.
// Zero-coupling packing is the weakest justification in the algorithm, so
// it must yield to correctness: never pack across an existing (even
// indirect, multi-hop) dependency path — doing so can force a bundle to
// both precede and follow another bundle, which is an unsatisfiable cycle.
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
    new Set([...ms.flatMap((m) => [...filesOf(m)]), ...filesOf(solo)]).size <= MAX_FILES &&
    !hasPrecedencePath([solo.id], ms.map((m) => m.id))
  );
  if (target) { target[1].push(solo); groups.delete(root); }
}

// --- order a bundle's own taskIds by internal blockedBy precedence (ties
// broken by ascending id), not by raw numeric id — a bundle can otherwise
// list a dependent task before the task that blocks it.
function topoOrderIds(members) {
  const ids = members.map((m) => m.id);
  const idSet = new Set(ids);
  const byId = new Map(members.map((m) => [m.id, m]));
  const indegree = new Map(ids.map((id) => [id, 0]));
  const forward = new Map(ids.map((id) => [id, []]));
  for (const id of ids) {
    for (const dep of byId.get(id).blockedBy || []) {
      if (idSet.has(dep)) {
        forward.get(dep).push(id);
        indegree.set(id, indegree.get(id) + 1);
      }
    }
  }
  const order = [];
  const ready = ids.filter((id) => indegree.get(id) === 0).sort((a, b) => a - b);
  while (ready.length) {
    ready.sort((a, b) => a - b);
    const id = ready.shift();
    order.push(id);
    for (const nxt of forward.get(id)) {
      indegree.set(nxt, indegree.get(nxt) - 1);
      if (indegree.get(nxt) === 0) ready.push(nxt);
    }
  }
  // Defensive only: a cyclic blockedBy within one bundle shouldn't occur for
  // a valid plan. Never hang or silently drop a task if it does — append
  // whatever didn't get ordered, ascending by id.
  if (order.length < ids.length) {
    const done = new Set(order);
    for (const id of [...ids].sort((a, b) => a - b)) if (!done.has(id)) order.push(id);
  }
  return order;
}

// --- build bundles, then order them by dependency
let bundles = [...groups.values()].map((members, i) => {
  const taskIds = topoOrderIds(members);
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
  const taskBreach = b.taskIds.length > MAX_TASKS;
  const fileBreach = b.files.length > MAX_FILES;
  if (!taskBreach && !fileBreach) continue;

  const shared = b.files.filter((f) =>
    b.taskIds.filter((id) => filesOf(tasks.find((t) => t.id === id)).has(f)).length > 1);

  let cause;
  if (shared.length) {
    cause = `Shared files forcing the merge: ${shared.join(", ")}.`;
  } else {
    // No shared file overlap — the merge came from a blockedBy edge, or
    // from same-tier singleton packing. Name whichever actually applies
    // instead of a generic, potentially misleading fallback.
    const edgeTasks = b.taskIds.filter((id) => {
      const t = tasks.find((x) => x.id === id);
      return (t.blockedBy || []).some((dep) => b.taskIds.includes(dep));
    });
    cause = edgeTasks.length
      ? `No shared files; merged via a blockedBy edge (tasks ${edgeTasks.join(", ")}).`
      : `No shared files or blockedBy edge; merged by same-tier singleton packing.`;
  }

  const capNote = taskBreach && fileBreach
    ? `both the task cap and the file cap (raise --max-tasks and/or --max-files)`
    : taskBreach
      ? `the task cap (raise --max-tasks)`
      : `the file cap (raise --max-files)`;

  console.error(
    `bundle-plan: bundle ${b.id} has ${b.taskIds.length} tasks / ${b.files.length} files ` +
    `(cap ${MAX_TASKS}/${MAX_FILES}), breaching ${capNote}. Tasks: ${b.taskIds.join(", ")}. ` +
    `${cause} Restructure the plan so each shared file is touched by one task.`
  );
  process.exit(1);
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
if (toStdout) {
  process.stdout.write(out);
} else {
  // Belt-and-suspenders: outPath was already checked to differ from input
  // above, but never write over the input regardless.
  if (outPath === input) {
    console.error(`bundle-plan: refusing to write the manifest over its own input (${input}).`);
    process.exit(2);
  }
  writeFileSync(outPath, out + "\n");
  console.log(`wrote ${outPath} — ${bundles.length} bundle(s) from ${tasks.length} task(s)`);
}
