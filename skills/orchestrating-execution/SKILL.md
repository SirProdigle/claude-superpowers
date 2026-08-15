---
name: orchestrating-execution
description: Use when the user picks "Orchestrated" at the plan execution handoff - ports the plan into Beads, then writes and launches a Workflow script that implements, reviews, fixes, tests and refactors it.
---

# Orchestrating Execution

**Announce at start:** "I'm using the orchestrating-execution skill to run this plan."

You are the coordinator. You do not implement anything. You do three things: port the plan into
Beads, **write a Workflow script for this specific plan**, and clean up after it returns. Every line
of production code in this run is written by agents that script dispatches.

**You author the script.** There is no `orchestrate.js` to feed. Earlier versions of this skill
handed a rigidly-shaped `args` object to a fixed script, and the run died on the shape far more
often than on the work — a missing tier, an integer where a bead id belonged, a bundle order the
validator disliked. All of that was ceremony in service of a script that could not see the plan.
Now the script is written against the plan in front of you, with the bead ids, the bundles and the
routing baked in as literals. Nothing to marshal, nothing to validate, no arg contract to violate.

**What is still fixed** is the *pipeline*: what runs, in what order, at what tier, and why. That is
the accumulated finding of this flow and it is below. Adapt the script; do not redesign the
pipeline on a whim.

## Pre-flight: is this plan orchestrable?

<HARD-GATE>
Orchestration runs the whole plan inside ONE background Workflow. Its implementer agents are
workflow-dispatched agents, and such an agent's toolset does **not** include `Agent` or `Workflow`
(verified 2026-08-15: a probe agent reported its tools as Artifact, Bash, Edit, ListAgents, Read,
ReportFindings, Skill, SendUserFile, ToolSearch, Write, StructuredOutput — no `Agent`, no
`Workflow`). Two consequences that are absolute, not probabilistic:

- **A workflow cannot nest a workflow** (`workflow()` inside a child throws; the Workflow tool is
  also absent from implementers). So a plan task that launches its own Workflow cannot run here.
- **An implementer agent cannot spawn sub-agents.** No `Agent` tool. So a plan task that fans out
  work across parallel agents (map-reduce over many items, an inference sweep, a judge panel) cannot
  run here either.

**Before Step 1, scan the plan's task steps for either pattern** — any step that says "run X as a
Workflow", invokes the `Workflow`/`Agent` tool, or describes a parallel agent fan-out. If ANY task
needs it, orchestration is the wrong vehicle: STOP and route to `subagent-driven-development`
instead, where the coordinator session (which *does* hold `Agent`/`Workflow`) launches each fan-out
and gates between tasks. Tell your human partner plainly *why* — it is a capability wall, not a
preference — and do not burn a long background run discovering it deep inside a task.

Everything an implementer CAN do it does through `Bash`, `Read`, `Edit`, `Write` (and MCP tools via
`ToolSearch`): build, test, run scripts, commit. A plan whose every task is self-contained code +
shell work is a good fit. A plan that orchestrates *other agents* is not.
</HARD-GATE>

## The Process

```dot
digraph process {
    rankdir=TB;
    "Resolve mode (simple | full)" [shape=box];
    "bd on PATH?" [shape=diamond];
    "STOP — bd not installed, hand back to your human partner" [shape=box style=filled fillcolor=lightpink];
    ".beads/ present?" [shape=diamond];
    "Run bd init" [shape=box];
    "Bundle the tasks (judgment, rules below)" [shape=box];
    "Show the bundling to your human partner" [shape=box];
    "Port plan to Beads (epic + children + links)" [shape=box];
    "Read model-routing.json" [shape=box];
    "Write the workflow script" [shape=box style=filled fillcolor=lightyellow];
    "Claim member beads" [shape=box];
    "Launch Workflow (inline script)" [shape=box];
    "Script threw before dispatching?" [shape=diamond];
    "Edit the persisted script, resume from runId" [shape=box];
    "Close completed beads, report epic id" [shape=box];
    "Suggest /complete-epic <epic-id>" [shape=box style=filled fillcolor=lightgreen];

    "Resolve mode (simple | full)" -> "bd on PATH?";
    "bd on PATH?" -> "STOP — bd not installed, hand back to your human partner" [label="no"];
    "bd on PATH?" -> ".beads/ present?" [label="yes"];
    ".beads/ present?" -> "Bundle the tasks (judgment, rules below)" [label="yes"];
    ".beads/ present?" -> "Run bd init" [label="no"];
    "Run bd init" -> "Bundle the tasks (judgment, rules below)";
    "Bundle the tasks (judgment, rules below)" -> "Show the bundling to your human partner";
    "Show the bundling to your human partner" -> "Port plan to Beads (epic + children + links)";
    "Port plan to Beads (epic + children + links)" -> "Read model-routing.json";
    "Read model-routing.json" -> "Write the workflow script";
    "Write the workflow script" -> "Claim member beads";
    "Claim member beads" -> "Launch Workflow (inline script)";
    "Launch Workflow (inline script)" -> "Script threw before dispatching?";
    "Script threw before dispatching?" -> "Edit the persisted script, resume from runId" [label="yes"];
    "Edit the persisted script, resume from runId" -> "Launch Workflow (inline script)";
    "Script threw before dispatching?" -> "Close completed beads, report epic id" [label="no"];
    "Close completed beads, report epic id" -> "Suggest /complete-epic <epic-id>";
}
```

## Step 1: Resolve the mode

Your human partner already chose at the handoff:

| Handoff option | Pipeline |
|---|---|
| Orchestrated — Simple | Implement → one combined review-and-fix pass → test loop |
| Orchestrated — Full | Implement → per-bundle + whole-plan review → routed fixes → test loop → refactor → test loop |

Do not ask which mode; it was chosen. The mode decides which phases you write into the script — in
Simple mode you simply omit the Review and Refactor blocks rather than branching on a variable.

You also need the plan document and its task file. They are co-located:
`docs/superpowers/plans/<name>.md` and `docs/superpowers/plans/<name>.md.tasks.json`. If the
`.tasks.json` is missing, STOP — there is nothing to bundle, and `writing-plans` should have written
it.

**Workspace:** the workflow's agents commit as they go, and the test loop deliberately leaves the
branch intact when it gives up. If you are on `main`/`master`, use
`claude-superpowers:using-git-worktrees` first, or get your human partner's explicit consent to run
here. Do not silently orchestrate a dozen agent commits onto a shared branch.

## Step 2: Beads check

```bash
command -v bd && test -d .beads && echo BEADS_OK
```

Both must hold. Beads is the durable record for the whole run: implementer prompts tell agents to
run `bd show <id>` for their task detail, Implement-phase commits are prefixed with the task id, and
the fix, test and refactor commits are prefixed with the epic id.

**No `.beads/` directory, but `bd` is on PATH — initialise it, do not ask.**

```bash
bd init
```

A missing tracker in a repo that has `bd` available is a setup gap, not a decision. `bd init` is
cheap, local, reversible (`rm -rf .beads`), and creates nothing outside the repo except the hooks it
installs deliberately. Announce that you ran it — "no `.beads/` here, ran `bd init`" — and continue.
If `bd init` itself fails, treat it as the `bd`-missing case below.

**No `bd` on PATH — STOP.** You cannot install it and must not guess a package manager. Tell your
human partner that orchestrated execution needs the `bd` binary, show what `command -v bd` returned,
and hand the decision back. Offer the alternative plainly: subagent-driven execution needs no
tracker.

**Untracked mode** is not offered as a routine choice — it exists only if your human partner asks
for it after being told there is no durable record and `/complete-epic` is unavailable afterwards.
It is now mechanically trivial (see the note at the end of Step 6), but that does not make it
equivalent. `bd init` is the answer whenever `bd` exists.

If you do need to ask your human partner anything at this point, the literal token `CLARIFICATION`
must appear in the question text. The `pre-askuser-handoff-guard` hook is still armed here
(writing-plans ran, tasks were created), and that token is its escape hatch. Without it the hook
blocks the call and teaches you to re-issue the execution handoff menu, which would loop you back
into this skill.

## Step 3: Bundle the tasks

A bundle is a set of tasks handed to ONE implementer agent in ONE dispatch. Read the
`.tasks.json` — each task carries `blockedBy` and a `json:metadata` fence with `files[]` and
`modelTier`.

**The default is one task per bundle.** Measurement of 240 workflow agents found cost is the
integral of context over turns, so it grows superlinearly with agent lifetime: the worst observed
agent ran 443 turns and moved 208M tokens, 20% of its entire run. A fresh agent's floor is ~26k
tokens. Merging tasks builds long agents; splitting them is close to free.

| Rule | Force | Why |
|---|---|---|
| One task = one bundle | **Default** | Agent lifetime is the dominant cost term. The floor for an extra agent is ~26k tokens; the marginal turn of a long agent costs 300-700k. |
| Never merge tasks of different `modelTier` | Absolute | The bundle is one dispatch at one model. Mixing tiers means paying frontier for mechanical work, or worse, the reverse. |
| Merge two tasks ONLY when all three hold: both trivially small, they share a file in `files[]`, AND they are joined by a direct `blockedBy` edge | Rare exception | All three together mean the second agent would otherwise re-derive the first's work immediately. Any one or two of them is not enough. |
| Never merge more than 2 tasks into one bundle | Absolute | Three merged tasks is the shape that produced the 443-turn agent. |
| A shared file creates a **notes-chain obligation**, not a merge | Mandatory | Implementation is sequential, so two agents never write one file concurrently. The real risk is the second agent not knowing the interface moved — which the notes chain fixes, at no cost in agent lifetime. |

"Trivially small" is mechanical, not a judgment call: a task whose `files[]` has at most 2 entries
AND whose `estimatedScope` is `"small"` (or absent). If either condition fails, the task stands
alone. This keeps the exception from re-growing into the rule it replaced.

**Why the old rule is gone.** Until 2026-08-15 this skill said tasks sharing a file MUST merge,
because "two agents writing one file clobber each other". That hazard does not exist here —
implementation is sequential and there are never two concurrent writers. The rule's only real
effect was building long-lived agents.

**Vocabulary:** the reference script in §6b calls these `UNITS` rather than bundles, because under
the default rule a bundle is usually exactly one task. "Bundle" and "unit" mean the same thing.

Then order:

- **Within a bundle** (only ever 2 tasks), list the blocking task first. Never numerically.
- **Across bundles**, emit them in an order where every bundle's dependencies appear earlier. The
  script implements bundles in array order and trusts it.

**If you cannot produce an acyclic bundle order**, do not force it. The usual cause is real: two
same-tier tasks share a file while a task of a *different* tier sits between them in the dependency
chain, so the mandatory merge creates a cycle at bundle level that does not exist between the tasks.
Say exactly that to your human partner and name the tasks and the shared file. The remedy is a plan
change — split the file's usage so one task owns it, or retier the chain — and it is their call, not
yours.

## Step 4: Show the bundling

Print it before you write a line of script — this is the cheapest moment in the run to catch a
bundling mistake. A short table: bundle id, tier, task ids, and — for any bundle holding 2 tasks —
which of the three merge conditions justified it. Say plainly that implementation runs bundles in
that order, that the default is one task per bundle, and that any merge you made must name all
three conditions.

## Step 5: Port the plan into Beads

Create the epic:

```bash
EPIC=$(bd create "<plan title>" -t epic -p 1 --external-ref "docs/superpowers/plans/<name>.md" --json | jq -r '.id')
```

Then one child per task in `.tasks.json`, in plan order. Write each task's body to a temp file
first — descriptions contain backticks, quotes and newlines, and quoting them inline is where this
step breaks:

```bash
# $BODY and $ACC are paths to temp files holding the task's Goal/Files/Steps text and its
# Acceptance Criteria block. There is no --acceptance-file, hence the cat.
bd create "<task subject>" --parent "$EPIC" -t task -p 2 \
   --body-file "$BODY" --acceptance "$(cat "$ACC")" \
   --external-ref "docs/superpowers/plans/<name>.md#task-<planTaskId>" --json | jq -r '.id'
```

- The body is the task's full **Goal / Files / Steps**, not a summary. The implementing agent reads
  this via `bd show` and nothing else — a one-line description makes it improvise. `-d "<text>"` is
  the shortcut for a genuinely short, quote-free body; `--body-file` (or `--stdin`) is the default.
- `--acceptance` gets the Acceptance Criteria block.
- Priority: `-p 2` for every child unless the plan says otherwise. Execution order comes from your
  bundling and the dependency links, never from priority.

<HARD-GATE>
**The `#task-<planTaskId>` fragment on `--external-ref` is mandatory, not decoration.** It is the
plan-task-id → bead-id map, written into durable storage at the moment the pairing is known.
`.tasks.json` ids are integers (`10`, `11`, …); bead ids look like `myproj-9rm.1`. You need that map
to turn your bundles into script literals, and there is no other way to recover it: creation order
is not queryable, and a coordinator that batches the creates, compacts, or resumes after an
interruption has nothing left to correlate.
</HARD-GATE>

Rebuild the map at any later point — always do this rather than trusting memory:

```bash
bd list --parent "$EPIC" --json | jq -r '.[] | [(.external_ref | split("#task-")[1]), .id, .title] | @tsv'
# 13   myproj-9rm.1   Task 4: The orchestrating-execution skill
```

Replay each task's `blockedBy`:

```bash
bd link <blocked-bead-id> <blocker-bead-id>
```

<HARD-GATE>
**`bd link A B` means B blocks A.** The blocked task comes FIRST. Reversing the arguments inverts
the dependency graph silently — `bd` prints a cheerful success line either way. Before you run each
link, say the sentence out loud in your head: "A is blocked by B." If the plan says task 13 is
blocked by task 11, the command is `bd link <bead-for-13> <bead-for-11>`.
</HARD-GATE>

Bundles are never modelled in Beads. The bundling lives only in the script you are about to write.

**Agents never close beads.** Not implementers, not fixers, not reviewers. Only this skill
transitions a bead to closed, and only in Step 8. That rule is carried into every agent prompt by
the `CTX` block below.

## Step 6: Write the workflow script

### 6a. Read the routing map

```bash
cat docs/superpowers/model-routing.json 2>/dev/null || cat ~/.claude/superpowers/model-routing.json
```

Project file first, then the user-level file. First one found wins entirely — no merging.

<HARD-GATE>
If neither file exists, STOP. Do not invent a mapping and do not name a model from memory. Tell your
human partner that orchestrated execution needs `docs/superpowers/model-routing.json` and that
`/onboard` writes it. Model ids live in that file and nowhere else — not in this skill, not in your
head. Copy the strings out of the file into the script; never type one.
</HARD-GATE>

A tier mapped to `"inherit"` means *omit the `model` option on that dispatch* so it runs at session
level. The file may also carry an `effort` map (`{"mechanical":"low","standard":"medium"}`) — apply
it per dispatch via `agent()`'s `effort` option. Capability and effort are independent dials: if a
task outgrows its tier, escalate the tier, never the effort.

### 6b. The reference script

This is the pipeline, in full, for Full mode. Adapt it — bake in your bundles, your bead ids, your
routing, your `CTX`; delete the Review and Refactor blocks for Simple mode and add the combined
review-and-fix pass in their place (shown at the end). Do not restructure the phase order.

```js
export const meta = {
  name: "orchestrated-execution",
  description: "Implement <plan title> in bundles: implement, review, fix, test, refactor",
  phases: [
    { title: "Implement", detail: "sequential bundles, notes chained" },
    { title: "Review",    detail: "per-bundle plus one whole-plan pass" },
    { title: "Fixes",     detail: "routed to the owning bundle" },
    { title: "Test",      detail: "verify, then a bounded fix loop" },
    { title: "Refactor",  detail: "plan then execute" },
  ],
};

// ---- Baked in at authoring time. No args, no filesystem: self-contained.
const EPIC = "myproj-9rm";
const MODEL  = { mechanical: "<from routing file>", standard: "<…>", frontier: "<…>" };
const EFFORT = { mechanical: "low", standard: "medium" };   // omit a tier to inherit

const CTX = `Project conventions:
- <the binding rules from CLAUDE.md: language, test command, commit style, house patterns>
- <the plan's Global Constraints, verbatim>
- Work on the current branch. Commit as you go. Never force-push, never rebase shared history.
- Claim nothing and close nothing in the tracker; the coordinator owns bead status.
Do NOT run bd close.`;

const BUNDLES = [
  { id: "b1", tier: "mechanical", beads: ["myproj-9rm.1", "myproj-9rm.2"] },
  { id: "b2", tier: "standard",   beads: ["myproj-9rm.3"] },
];

const FINDINGS = {
  type: "object",
  properties: { findings: { type: "array", items: {
    type: "object",
    properties: {
      file:     { type: "string" },
      issue:    { type: "string" },
      severity: { type: "string", enum: ["critical", "major", "minor"] },
      bundleId: { type: "string" },
    },
    required: ["file", "issue", "severity"],
  } } },
  required: ["findings"],
};
const TESTRES = {
  type: "object",
  properties: { pass: { type: "boolean" }, summary: { type: "string" } },
  required: ["pass", "summary"],
};

// tier `null` = no model override, i.e. session level (used for the whole-plan review).
const dispatch = (prompt, { tier, label, phase: ph, schema }) => {
  const model = tier ? MODEL[tier] : null;
  const effort = tier ? EFFORT[tier] : null;
  log(`dispatch ${label} — tier=${tier ?? "session"} model=${model ?? "inherit"}`);
  return agent(`${CTX}\n\n${prompt}`, {
    label, phase: ph,
    ...(model && model !== "inherit" ? { model } : {}),
    ...(effort && effort !== "inherit" ? { effort } : {}),
    ...(schema ? { schema } : {}),
  });
};

// ---- Implement: sequential, notes chained forward.
phase("Implement");
const notes = [];
for (const b of BUNDLES) {
  const r = await dispatch(
    `Implement beads tasks ${b.beads.join(", ")} (bundle ${b.id}, epic ${EPIC}).
For each task: run \`bd show <id>\` for the full description and acceptance criteria, read the
code you are extending, implement completely including the tests named in acceptance criteria,
run the suite, and commit with the task id as the message prefix.
Notes from previously implemented bundles:
${notes.length ? notes.join("\n") : "(none — you are first)"}

Return a SHORT summary (5-10 lines): what you built, key files, deviations, and anything later
bundles must know.`,
    { tier: b.tier, label: `impl:${b.id}`, phase: "Implement" }
  );
  notes.push(`${b.id} (${b.beads.join(",")}): ${r || "(agent returned nothing)"}`);
}

// ---- Review: per-bundle in parallel, then one whole-plan pass.
phase("Review");
const perBundle = await parallel(BUNDLES.map((b) => () =>
  dispatch(
    `Review the commits for beads tasks ${b.beads.join(", ")} (bundle ${b.id}). Read each task,
find its commits, read the touched code in full. Report REAL defects only: logic errors,
acceptance criteria not met, broken or missing tests, type unsafety. No style nits, no praise.
Set bundleId="${b.id}" on every finding.`,
    { tier: "standard", label: `review:${b.id}`, phase: "Review", schema: FINDINGS }
  )
));
const epicReview = await dispatch(
  `Whole-plan review of epic ${EPIC}. Read the codebase and the full git log for this plan.
Focus on what per-bundle review structurally cannot see: cross-bundle integration bugs,
architecture drift, duplicated logic between bundles, invariants broken in aggregate.
Leave bundleId unset on findings that span bundles or belong to none.`,
  { tier: null, label: "review:plan", phase: "Review", schema: FINDINGS }
);
const findings = [
  ...perBundle.filter(Boolean).flatMap((r) => r.findings || []),
  ...((epicReview && epicReview.findings) || []),
];
log(`${findings.length} review findings`);

// ---- Fixes: routed to the bundle that owns them, sequential.
phase("Fixes");
const fmt = (f) => `- [${f.severity}] ${f.file}: ${f.issue}`;
for (const b of BUNDLES) {
  const own = findings.filter((f) => f.bundleId === b.id);
  if (!own.length) continue;
  await dispatch(
    `Apply these review findings for bundle ${b.id}. Verify each against the code first — skip any
that are wrong. Run the suite until green, commit as "${EPIC}: fixes ${b.id}".
${own.map(fmt).join("\n")}

Return which findings you fixed and which you rejected, with reasons.`,
    { tier: "standard", label: `fix:${b.id}`, phase: "Fixes" }
  );
}
const cross = findings.filter((f) => !f.bundleId || !BUNDLES.some((b) => b.id === f.bundleId));
if (cross.length) {
  await dispatch(
    `Apply these cross-cutting review findings for epic ${EPIC} — they span bundles or belong to
none. Verify each first. Run the suite until green, commit as "${EPIC}: cross-cutting fixes".
${cross.map(fmt).join("\n")}`,
    { tier: "standard", label: "fix:cross-cutting", phase: "Fixes" }
  );
}

// ---- Test loop: verify at mechanical, fix at standard, escalate once, max 2 fix rounds.
const TIERS = ["mechanical", "standard", "frontier"];
let lastTestSummary = null;
const testLoop = async (round) => {
  phase("Test");
  const verify = (label) => dispatch(
    `Run the FULL verification for this project: the test suite plus typecheck. pass=true ONLY if
everything passes. Quote exact failing test names and errors in the summary. Do not fix anything.`,
    { tier: "mechanical", label, phase: "Test", schema: TESTRES }
  );
  let tier = "standard";
  for (let i = 0; i < 2; i++) {
    const res = await verify(`test:${round}:${i}`);
    if (res && res.pass) { lastTestSummary = null; return true; }
    await dispatch(
      `Fix these test/typecheck failures. Fix code or tests, whichever is wrong. Run until green,
commit as "${EPIC}: test fixes".
${res ? res.summary : "test agent returned nothing — run the suite yourself and fix what you find"}`,
      { tier, label: `testfix:${round}:${i}`, phase: "Test" }
    );
    tier = TIERS[Math.min(TIERS.indexOf(tier) + 1, TIERS.length - 1)];
  }
  // The second fix ran at the escalated tier and was never re-verified. Without this a tree that
  // IS green gets reported red, which silently cancels Refactor. One extra verification, not a
  // third fix round.
  const final = await verify(`test:${round}:final`);
  if (final && final.pass) { lastTestSummary = null; return true; }
  lastTestSummary = (final && final.summary) || "(test agent returned no summary)";
  log(`test loop exhausted after 2 fix rounds (${round}) — stopping, branch left intact`);
  return false;
};

const greenAfterImpl = await testLoop("post-fixes");

// ---- Refactor: only after the tree is green, then re-test.
let greenAfterRefactor = null;
if (greenAfterImpl) {
  phase("Refactor");
  const plan = await dispatch(
    `Refactor planning for epic ${EPIC}. Read the codebase. Do NOT change any code.
Goals: DRY, clear module boundaries, no magic values in logic, better abstractions where the code
will grow. Produce a concrete ORDERED plan with file-level instructions an implementer can execute
without judgment calls. If the code is already clean, say so and return a minimal plan.`,
    { tier: "frontier", label: "refactor:plan", phase: "Refactor" }
  );
  await dispatch(
    `Execute this refactor plan EXACTLY. Keep the suite green — run it after each major step.
Commit each step as "${EPIC}: refactor — <step>".
${plan}`,
    { tier: "standard", label: "refactor:exec", phase: "Refactor" }
  );
  greenAfterRefactor = await testLoop("post-refactor");
}

return {
  epicId: EPIC, bundles: BUNDLES.length, findings: findings.length,
  greenAfterImpl, greenAfterRefactor, lastTestSummary, notes,
};
```

**Simple mode** deletes the Review and Refactor blocks (and `findings`, `fmt`, `cross`) and replaces
the whole Fixes phase with one pass:

```js
phase("Fixes");
await dispatch(
  `Review every commit made for epic ${EPIC}, then fix what you find in the same pass.
Report REAL defects only. Verify each against the code before changing it. Run the suite until
green and commit as "${EPIC}: review fixes".`,
  { tier: "standard", label: "review-and-fix", phase: "Fixes" }
);
```

### 6c. Why the pipeline is shaped this way

Change the script freely; change these only with a reason you can say out loud.

| Decision | Reason |
|---|---|
| Implementation is **sequential**, not parallel | Notes chain forward, which is what keeps conventions consistent across the plan. The cost is wall-clock; it has been paid deliberately. |
| Review is a **separate phase** from fixing (Full) | A reviewer that can also edit stops reviewing and starts fixing the first thing it sees. Findings first, then routed repair. |
| Per-bundle review at `standard`, whole-plan at **session level** | Diff-anchored review is mid-tier work and review output is the expensive direction. The whole-plan pass is the one frontier judgment per plan — omit `model` so it inherits the session model. |
| Fixes routed **by owning bundle** | The bundle's agent context is the only place the intent behind the code exists. A generic fixer re-derives it badly. |
| Test loop is **bounded** (2 fix rounds + a final verify) then stops | An unbounded loop burns a night on an unfixable failure. Stopping leaves the branch intact for a human. |
| Refactor runs **after** the first green, never before | Refactoring unverified code makes an implementation bug indistinguishable from a refactor bug. |
| Routing is resolved **in the script**, not by a hook | `PreToolUse:Agent` hooks do not fire for Workflow `agent()` spawns (measured 2026-08-13). Inside a workflow the dispatch gate is blind, so the script's own `MODEL[tier]` lookup and its `log()` line are the entire routing audit trail. |

### 6d. Workflow-script constraints that bite

- **No filesystem, no network.** The script cannot read the plan, the manifest or the routing file.
  Anything the pipeline needs is a literal in the script text (that is why you author it).
- **`export const meta` must be the first statement**, a pure literal — no variables, no
  interpolation. Any other `export` is a SyntaxError inside the wrapped function body.
- **Top-level `return` is required** to surface the result; that is why the file is not importable.
- **`Date.now()`, `new Date()` and `Math.random()` throw.** They would break resume.
- `parallel()` resolves a failed thunk to `null` — `.filter(Boolean)` before using results.
- Concurrency is capped (~10-16 at a time); `parallel()` over every bundle is fine regardless.

### 6e. Untracked mode

If your human partner insisted on running without Beads, the mechanics are now trivial: there is no
`bd` in the script unless you put it there. Drop Step 5 and Step 8's bead half, set
`EPIC = "untracked-<plan slug>"`, and replace `bd show <id>` in the implementer prompt with the
task's Goal/Files/Steps **inlined verbatim into the prompt string**. Do not send agents hunting for
`### Task N:` headings by number — plan-document numbering and `.tasks.json` ids are unrelated
schemes and they do not line up.

## Step 7: Claim, then launch

```bash
bd update <bead-id> --claim
```

for every bead in the script, immediately before launching. `--claim` is atomic and idempotent —
claiming an already-claimed bead exits 0 and changes nothing — so re-running a partially-completed
orchestration is safe. `--claim` takes no guard: `bd update --help` states `--if-status` "requires a
field update; cannot combine with `--claim`". Guarded transitions belong in Step 8.

Then call the Workflow tool with the script **inline** in the `script` parameter. Do not Write it to
a file first; the tool persists it for you and returns the path, plus a `runId`.

**When it breaks:** a script that throws at launch (a typo, a bad schema) costs nothing — nothing
was dispatched. Edit the persisted script file and relaunch with `{scriptPath, resumeFromRunId}`:
the longest unchanged prefix of `agent()` calls returns cached results instantly, so a fix to the
Refactor block does not re-run implementation. Before diagnosing why a completed run returned
something odd, read `<transcriptDir>/journal.jsonl` — it records each agent's actual return value.
Use `/workflows` to watch live progress.

## Step 8: On completion

1. **Read the returned summary.** `greenAfterImpl: false` means the test loop exhausted its rounds
   and stopped with the branch intact — report `lastTestSummary` verbatim rather than digging
   through the run log, and do not close beads for work that is not green.
2. **Close the beads for completed bundles** — `bd close <id>` — from this skill and nowhere else.
   Leave anything unfinished `in_progress` so a resume can pick it up. When unsure whether a bead is
   still in the state you left it in, guard the transition:
   `bd update <id> --if-status in_progress --status closed` writes nothing and exits **13** on a
   mismatch, so it cannot double-apply.
3. **Report the epic id** and a short outcome: bundles run, findings count, test state.
4. **Suggest `/complete-epic <epic-id>`** and stop there. That command already owns evidence
   gathering, follow-up filing, the retrospective and epic closure. Do not write a completion
   report, do not file follow-ups, do not close the epic yourself.

   **Untracked runs skip 2 and 4** — there is no epic to complete. Report the outcome, name the plan
   document, and stop.

## Anti-Patterns

| Anti-pattern | Reality |
|---|---|
| Redesigning the pipeline because you are writing the script anyway | You author the script so it fits *this plan*, not so you can reorder the phases. The order in 6b is the accumulated finding; 6c says why each part is there. |
| Parallelising the Implement loop for speed | The notes chain is the mechanism that keeps conventions consistent. Parallel bundles get you an inconsistent codebase faster. |
| Merging tasks to "save a dispatch" | A dispatch costs ~26k tokens. A merged agent's extra turns cost 300-700k each. You are trading a cheap thing for an expensive one. |
| Merging because two tasks share a file | Sequential implementation means there are no concurrent writers. Record the interface change in the notes chain instead. |
| Merging across tiers | The bundle is one dispatch at one model. There is no way to run half of it cheaply. |
| Letting agents close beads | Agents close on optimism, mid-run, before review and tests have spoken. The coordinator holds the only close. `Do NOT run bd close.` stays in `CTX` verbatim. |
| Writing a model id from memory into the script | Copy the strings out of `model-routing.json`. Model lineups change; that file is the single place a tier becomes a model. |
| Passing the plan path or the routing file path into the script | Workflow scripts have no filesystem access. Everything is a literal in the script text. |
| Keeping the plan-id → bead-id map in your head instead of the external refs | Creation order is not queryable and your context does not survive compaction. Write `#task-<planTaskId>` into `--external-ref` and rebuild the map from `bd list` every time. |
| Relaunching from scratch after a mid-run failure | Edit the persisted script and resume with `resumeFromRunId`. A fresh launch re-dispatches — and re-pays for — every bundle that already succeeded. |
| Implementing a task yourself "since it's small" | You are the coordinator. Work happens inside the workflow, where routing is resolved and each dispatch is logged. Your edits are neither. |
| Writing your own completion report at the end | `/complete-epic` owns that, with evidence. Duplicating it produces two accounts of the same run that will disagree. |

## Red Flags — STOP

- You are typing a model id you did not just read out of `model-routing.json`.
- Your bundle order is not one where every dependency appears earlier, and you are proceeding anyway.
- You put two tasks of different `modelTier` in one bundle.
- You put more than 2 tasks in one bundle.
- You merged two tasks without being able to name all three merge conditions out loud.
- You are about to run `bd link` without having said "A is blocked by B" to yourself first.
- You are about to run `bd create` for a child without `#task-<planTaskId>` on its `--external-ref`.
- You are recalling a bead id from memory instead of reading it back out of `bd list`.
- You are combining `--claim` with `--if-status`.
- Your `CTX` string does not end with `Do NOT run bd close.`
- Your script calls `Date.now()`, `new Date()` or `Math.random()`, or tries to read a file.
- A plan task's steps say "run as a Workflow" or fan out across agents, and you are proceeding
  anyway — implementers have no `Agent`/`Workflow` tool; route to `subagent-driven-development`.
