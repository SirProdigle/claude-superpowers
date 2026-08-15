# Orchestration Cost Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use claude-superpowers:subagent-driven-development (recommended) or claude-superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut orchestrated-execution token cost and wall-clock by shortening agent lifetimes, without regressing output quality.

**Architecture:** Four independent changes to plugin content plus one new script. The bundling rules in `orchestrating-execution` invert from "merge on shared files" to "one task per agent". The §6b reference script gains turn discipline, a deterministic pre-review gate, overlapped review, and a conditional refactor keyed off a new `structural` boolean on the FINDINGS schema. `writing-plans` gains capped per-area code briefs, consumed by both execution paths. A new `scripts/wf-cost.mjs` reads a run's agent transcripts and reports cost, wired into Step 8.

**Tech Stack:** Markdown skill content; Node ESM (`.mjs`, zero dependencies); `bun:test` for the script test; bash for repo test conventions.

**Global Constraints:**
- **Zero third-party dependencies.** `scripts/wf-cost.mjs` uses only `node:fs` / `node:path`. No packages, no `package.json` additions.
- **Never write a model id into skill text.** Model ids live only in `model-routing.json`. Placeholders in the reference script stay as `"<from routing file>"`.
- **`CTX` must still end with the literal line `Do NOT run bd close.`** — this is checked by a Red Flag in the skill.
- **Workflow-script constraints hold:** `export const meta` first and a pure literal; top-level `return`; no `Date.now()`, `new Date()`, `Math.random()`; no filesystem access from the script.
- **Do not modify** `skills/executing-plans/SKILL.md`, any hook, or `hooks/hooks.json`. The only upstream-churny files touched are `skills/writing-plans/SKILL.md` and `skills/subagent-driven-development/implementer-prompt.md`, and only in the ways Tasks 3 and 4 specify.
- **Repo is on `main` with unrelated WIP already staged/modified** (`README.md`, `commands/onboard.md`, deleted `scripts/bundle-plan.mjs` etc.). Every commit in this plan MUST name its own paths explicitly — never `git commit -a`, never `git add .`.
- Commit strategy is per-task (no `docs/superpowers/workflow.json` present).

**User decisions (already made):**
- Scope is "all execution paths" — orchestration, `writing-plans`, and `subagent-driven-development` all change.
- Drop the mandatory shared-file bundling merge; user confirmed after being shown it reverses a rule the skill states absolutely.
- Approach 2 plus the logging half of approach 3: structural change now, cost instrumentation now, budget-adaptive branching deferred.
- The area brief is kept because it makes short agents safe, not because it saves exploration tokens.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `skills/orchestrating-execution/SKILL.md` §3-§4, Anti-Patterns, Red Flags | Bundling rules | 1 |
| `skills/orchestrating-execution/SKILL.md` §6b-§6c | Reference pipeline script | 2 |
| `skills/writing-plans/SKILL.md` | Produces area briefs at plan time | 3 |
| `skills/orchestrating-execution/SKILL.md` §6b `AREA`/dispatch + `skills/subagent-driven-development/implementer-prompt.md` | Consumes area briefs | 4 |
| `scripts/wf-cost.mjs` + `tests/wf-cost/` | Post-run cost report | 5 |
| `skills/orchestrating-execution/SKILL.md` Step 8 | Wires the cost report in | 6 |
| `README.md`, `docs/superpowers/specs/2026-08-13-orchestrated-execution-design.md` | Docs sync | 7 |

`skills/orchestrating-execution/SKILL.md` is touched by Tasks 1, 2, 4 and 6. Under the new rules this is a **notes-chain obligation, not a merge** — each task edits a disjoint section and must report what it changed. Tasks 1 → 2 → 4 → 6 are strictly ordered for that reason.

---

### Task 1: Invert the bundling rules

**Goal:** Replace the mandatory shared-file merge with one-task-per-agent, and update every place in the skill that restates the old rule.

**Files:**
- Modify: `skills/orchestrating-execution/SKILL.md` (§3 "Bundle the tasks", §4 "Show the bundling", "Anti-Patterns" table, "Red Flags" list)

**Acceptance Criteria:**
- [ ] The §3 rules table matches the replacement below exactly, including the "trivially small" definition paragraph
- [ ] The string `Two agents writing one file clobber each other` no longer appears anywhere in the file
- [ ] The Anti-Patterns row about merging small tasks is replaced by one about over-merging
- [ ] A Red Flag exists for bundling more than 2 tasks
- [ ] §4's table description mentions unit count and tier rather than "the files that forced each merge"

**Verify:** `grep -c 'notes-chain obligation' skills/orchestrating-execution/SKILL.md` → `1` or more, and `! grep -q 'clobber each other' skills/orchestrating-execution/SKILL.md`

**Steps:**

- [ ] **Step 1: Replace the §3 rules table**

Find the table under `## Step 3: Bundle the tasks` and replace the whole table plus its preamble sentence with:

```markdown
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
```

- [ ] **Step 2: Update the ordering guidance below the table**

Immediately after the new table's explanatory paragraphs, the existing `Then order:` block stays, but replace its first bullet with:

```markdown
- **Within a bundle** (only ever 2 tasks), list the blocking task first. Never numerically.
```

Leave the "Across bundles" bullet and the "If you cannot produce an acyclic bundle order" paragraph unchanged.

- [ ] **Step 3: Update §4**

In `## Step 4: Show the bundling`, replace the sentence beginning `A short table:` with:

```markdown
A short table: bundle id, tier, task ids, and — for any bundle holding 2 tasks — which of the three
merge conditions justified it. Say plainly that implementation runs bundles in that order, that the
default is one task per bundle, and that any merge you made must name all three conditions.
```

- [ ] **Step 4: Update the Anti-Patterns table**

Delete the row whose first cell is `Merging two uncoupled tasks into one bundle because both are small` (the row beginning "That exact rule existed, fabricated dependency cycles..."). Replace it with these two rows:

```markdown
| Merging tasks to "save a dispatch" | A dispatch costs ~26k tokens. A merged agent's extra turns cost 300-700k each. You are trading a cheap thing for an expensive one. |
| Merging because two tasks share a file | Sequential implementation means there are no concurrent writers. Record the interface change in the notes chain instead. |
```

- [ ] **Step 5: Update the Red Flags list**

Replace the bullet `- You put two tasks of different \`modelTier\` in one bundle.` with these three:

```markdown
- You put two tasks of different `modelTier` in one bundle.
- You put more than 2 tasks in one bundle.
- You merged two tasks without being able to name all three merge conditions out loud.
```

- [ ] **Step 6: Verify**

Run:

```bash
cd ~/projects/claude-superpowers
grep -q 'notes-chain obligation' skills/orchestrating-execution/SKILL.md \
  && ! grep -q 'clobber each other' skills/orchestrating-execution/SKILL.md \
  && grep -q 'more than 2 tasks in one bundle' skills/orchestrating-execution/SKILL.md \
  && echo TASK1_OK
```

Expected: `TASK1_OK`

- [ ] **Step 7: Commit**

```bash
git add skills/orchestrating-execution/SKILL.md
git commit -m "orchestrating-execution: one task per agent, drop the shared-file merge"
```

```json:metadata
{"files": ["skills/orchestrating-execution/SKILL.md"], "verifyCommand": "grep -q 'notes-chain obligation' skills/orchestrating-execution/SKILL.md && ! grep -q 'clobber each other' skills/orchestrating-execution/SKILL.md && echo TASK1_OK", "acceptanceCriteria": ["§3 rules table replaced with one-task-per-bundle default", "string 'Two agents writing one file clobber each other' absent", "Anti-Patterns row replaced with over-merging rows", "Red Flag for >2 tasks per bundle exists", "§4 mentions the three merge conditions"], "modelTier": "mechanical", "estimatedScope": "small"}
```

---

### Task 2: Restructure the reference pipeline script

**Goal:** Rewrite §6b so the pipeline enforces turn discipline, runs a deterministic gate before LLM review, overlaps review with implementation, and only refactors on structural findings.

**Files:**
- Modify: `skills/orchestrating-execution/SKILL.md` (§6b reference script, §6c rationale table, the Simple-mode block, and the §6d constraints list)

**Acceptance Criteria:**
- [ ] `CTX` contains a "Turn discipline" block and still ends with `Do NOT run bd close.`
- [ ] The `FINDINGS` schema has a `structural` boolean property
- [ ] Implementers are instructed to run only their own narrow test, never the full suite
- [ ] A `Gate` phase runs typecheck+lint at mechanical tier before the Review phase
- [ ] Review dispatches are started inside the implement loop and awaited after it
- [ ] Refactor is wrapped in a condition on structural findings and logs a reason when skipped
- [ ] Every `dispatch()` call passes `effort` from the `EFFORT` map
- [ ] No `Date.now()`, `new Date()` or `Math.random()` appears in the script block

**Verify:** `node -e "const s=require('fs').readFileSync('skills/orchestrating-execution/SKILL.md','utf8'); if(!/structural/.test(s)||!/Turn discipline/.test(s)||/Date\.now\(\)/.test(s.split('### 6b')[1].split('### 6c')[0])) process.exit(1); console.log('TASK2_OK')"`

**Steps:**

- [ ] **Step 1: Replace the whole §6b code block**

Replace everything between the opening ```` ```js ```` and closing ```` ``` ```` under `### 6b. The reference script` with:

```js
export const meta = {
  name: "orchestrated-execution",
  description: "Implement <plan title>: implement, gate, review, fix, test, conditional refactor",
  phases: [
    { title: "Implement", detail: "one agent per task, notes chained, reviews started inline" },
    { title: "Gate",      detail: "typecheck + lint, deterministic, before any LLM review" },
    { title: "Review",    detail: "design and correctness only" },
    { title: "Fixes",     detail: "routed to the owning unit, sequential" },
    { title: "Test",      detail: "verify, then a bounded fix loop" },
    { title: "Refactor",  detail: "only when review found something structural" },
  ],
};

// ---- Baked in at authoring time. No args, no filesystem: self-contained.
const EPIC   = "myproj-9rm";
const MODEL  = { mechanical: "<from routing file>", standard: "<…>", frontier: "<…>" };
const EFFORT = { mechanical: "low", standard: "medium", frontier: "inherit" };

// Area briefs from the plan's Code Areas section. Cap each at ~1500 tokens.
const AREA = {
  "sim-core": `<the plan's brief for this area, verbatim>`,
};

const CTX = `Project conventions:
- <the binding rules from CLAUDE.md: language, test command, commit style, house patterns>
- <the plan's Global Constraints, verbatim>
- Work on the current branch. Commit as you go. Never force-push, never rebase shared history.
- Claim nothing and close nothing in the tracker; the coordinator owns bead status.

Turn discipline — this is a hard cost constraint, not a style note. Every tool call is a turn, and
a turn re-reads your whole accumulated context. Late turns cost 300-700k tokens each.
- Batch shell work. Combine independent commands into ONE Bash call with && or ;.
- Do NOT run the full test suite. Run ONLY the narrow test for your own task. Full verification is
  a separate agent's job and it will happen.
- Never re-run a command to "check progress". Run it once, read the result.
- Prefer one Read of a whole file over several greps around it.
Do NOT run bd close.`;

// One entry per task. Merging is the rare exception, not the default.
const UNITS = [
  { id: "t1", tier: "mechanical", beads: ["myproj-9rm.1"], areas: ["sim-core"] },
  { id: "t2", tier: "standard",   beads: ["myproj-9rm.2"], areas: ["sim-core", "ui"] },
];

const FINDINGS = {
  type: "object",
  properties: { findings: { type: "array", items: {
    type: "object",
    properties: {
      file:     { type: "string" },
      issue:    { type: "string" },
      severity: { type: "string", enum: ["critical", "major", "minor"] },
      unitId:   { type: "string" },
      structural: {
        type: "boolean",
        description: "true only if fixing this requires moving a boundary, removing duplication " +
                     "across units, or replacing an abstraction. Behavioural bugs are false.",
      },
    },
    required: ["file", "issue", "severity", "structural"],
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
  const model  = tier ? MODEL[tier]  : null;
  const effort = tier ? EFFORT[tier] : null;
  log(`dispatch ${label} — tier=${tier ?? "session"} model=${model ?? "inherit"} ` +
      `effort=${effort ?? "inherit"} spent=${budget.spent()}`);
  return agent(`${CTX}\n\n${prompt}`, {
    label, phase: ph,
    ...(model  && model  !== "inherit" ? { model }  : {}),
    ...(effort && effort !== "inherit" ? { effort } : {}),
    ...(schema ? { schema } : {}),
  });
};

const briefFor = (u) => u.areas.map((a) => `### Area: ${a}\n${AREA[a] || "(no brief)"}`).join("\n\n");

// ---- Implement: sequential (the notes chain needs it), but each unit's review is
// started immediately and left running while the next unit implements. That removes
// the Implement->Review barrier without letting two agents write concurrently.
phase("Implement");
const notes = [];
const reviewPromises = [];
for (const u of UNITS) {
  const r = await dispatch(
    `Implement beads task(s) ${u.beads.join(", ")} (unit ${u.id}, epic ${EPIC}).
Run \`bd show <id>\` for the full description and acceptance criteria. Implement completely,
including the tests named in acceptance criteria. Run ONLY those tests — not the full suite.
Commit with the task id as the message prefix.

Code areas you are working in:
${briefFor(u)}

Notes from previously implemented units:
${notes.length ? notes.join("\n") : "(none — you are first)"}

Return a SHORT summary (5-10 lines): what you built, key files, deviations, and — mandatory — any
interface named in your area brief that you CHANGED, so later units are not working from a stale
brief.`,
    { tier: u.tier, label: `impl:${u.id}`, phase: "Implement" }
  );
  notes.push(`${u.id} (${u.beads.join(",")}): ${r || "(agent returned nothing)"}`);

  // Not awaited: this review runs while the next unit implements.
  reviewPromises.push(dispatch(
    `Review the commits for beads task(s) ${u.beads.join(", ")} (unit ${u.id}). Read each task,
find its commits, read the touched code in full.

Report REAL defects of DESIGN and CORRECTNESS only: logic errors, acceptance criteria not met,
broken or missing tests, unsafe assumptions, duplicated logic.
Do NOT report anything a typechecker or linter catches — unused imports, formatting, missing type
annotations, obvious null checks. A separate deterministic gate already handled those. Reporting
them wastes a fix agent.

Set unitId="${u.id}" on every finding. Set structural=true ONLY when the fix requires moving a
boundary, removing cross-unit duplication, or replacing an abstraction.`,
    { tier: "standard", label: `review:${u.id}`, phase: "Review", schema: FINDINGS }
  ));
}

// ---- Gate: deterministic checks, once, at the cheapest tier. Runs before we read
// any LLM review so that lint-class noise never becomes a routed fix.
phase("Gate");
const gate = await dispatch(
  `Run this project's typecheck and linter across the whole repo — NOT the test suite.
Fix everything they report. These are mechanical fixes; do not redesign anything.
Run the checks once more to confirm clean, then commit as "${EPIC}: gate fixes".
If both were already clean, change nothing and say so.`,
  { tier: "mechanical", label: "gate:typecheck-lint", phase: "Gate" }
);
log(`gate: ${gate ? "done" : "agent returned nothing"}`);

// ---- Review: collect the overlapped per-unit reviews, then one whole-plan pass.
phase("Review");
const perUnit = await Promise.all(reviewPromises);
const epicReview = await dispatch(
  `Whole-plan review of epic ${EPIC}. Read the codebase and the full git log for this plan.
Focus on what per-unit review structurally cannot see: cross-unit integration bugs, architecture
drift, duplicated logic between units, invariants broken in aggregate.
Do NOT report anything a typechecker or linter catches.
Leave unitId unset on findings that span units or belong to none. Set structural=true only per the
schema's definition.`,
  { tier: null, label: "review:plan", phase: "Review", schema: FINDINGS }
);
const findings = [
  ...perUnit.filter(Boolean).flatMap((r) => r.findings || []),
  ...((epicReview && epicReview.findings) || []),
];
log(`${findings.length} review findings (${findings.filter((f) => f.structural).length} structural)`);

// ---- Fixes: routed to the unit that owns them, sequential. Sequential because two
// fixers could otherwise write the same file — unlike review, fixing is not read-only.
phase("Fixes");
const fmt = (f) => `- [${f.severity}] ${f.file}: ${f.issue}`;
for (const u of UNITS) {
  const own = findings.filter((f) => f.unitId === u.id);
  if (!own.length) continue;
  await dispatch(
    `Apply these review findings for unit ${u.id}. Verify each against the code first — skip any
that are wrong. Run only the tests covering what you touched, then commit as
"${EPIC}: fixes ${u.id}".
${own.map(fmt).join("\n")}

Return which findings you fixed and which you rejected, with reasons.`,
    { tier: "standard", label: `fix:${u.id}`, phase: "Fixes" }
  );
}
const cross = findings.filter((f) => !f.unitId || !UNITS.some((u) => u.id === f.unitId));
if (cross.length) {
  await dispatch(
    `Apply these cross-cutting review findings for epic ${EPIC} — they span units or belong to
none. Verify each first. Run only the tests covering what you touched, then commit as
"${EPIC}: cross-cutting fixes".
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
      `Fix these test/typecheck failures. Fix code or tests, whichever is wrong. Run the failing
tests until green — the full suite is verified separately. Commit as "${EPIC}: test fixes".
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

// ---- Refactor: only when review actually found something structural, and only on green.
const structural = findings.filter(
  (f) => f.structural && (f.severity === "critical" || f.severity === "major")
);
let greenAfterRefactor = null;
let refactorSkipped = null;
if (!greenAfterImpl) {
  refactorSkipped = "tree not green";
} else if (!structural.length) {
  refactorSkipped = "no major/critical structural findings";
} else {
  phase("Refactor");
  const plan = await dispatch(
    `Refactor planning for epic ${EPIC}. Do NOT change any code. Address EXACTLY these structural
findings and nothing else — this is not a general cleanup pass:
${structural.map(fmt).join("\n")}

Read the code around them, then produce a concrete ORDERED plan with file-level instructions an
implementer can execute without judgment calls.`,
    { tier: "frontier", label: "refactor:plan", phase: "Refactor" }
  );
  await dispatch(
    `Execute this refactor plan EXACTLY. Run the tests covering each file you touch as you go; the
full suite is verified separately afterwards. Commit each step as "${EPIC}: refactor — <step>".
${plan}`,
    { tier: "standard", label: "refactor:exec", phase: "Refactor" }
  );
  greenAfterRefactor = await testLoop("post-refactor");
}
if (refactorSkipped) log(`refactor skipped: ${refactorSkipped}`);

return {
  epicId: EPIC, units: UNITS.length, findings: findings.length,
  structuralFindings: structural.length, refactorSkipped,
  greenAfterImpl, greenAfterRefactor, lastTestSummary, notes,
  outputTokens: budget.spent(),
};
```

- [ ] **Step 2: Replace the Simple-mode block**

Replace the `**Simple mode** deletes the Review and Refactor blocks...` paragraph and its code block with:

````markdown
**Simple mode** keeps Implement, Gate and Test. It deletes the Review and Refactor blocks (and
`reviewPromises`, `findings`, `fmt`, `cross`, `structural`) and replaces the whole Fixes phase with
one pass. The Gate phase stays — it is the cheapest quality step in the pipeline and it is what
lets the combined pass concentrate on design.

```js
phase("Fixes");
await dispatch(
  `Review every commit made for epic ${EPIC}, then fix what you find in the same pass.
Report and fix REAL defects of design and correctness only — a typecheck/lint gate has already
run, so ignore anything those would catch. Verify each against the code before changing it.
Run only the tests covering what you touched, then commit as "${EPIC}: review fixes".`,
  { tier: "standard", label: "review-and-fix", phase: "Fixes" }
);
```
````

- [ ] **Step 3: Update the §6c rationale table**

Replace the rows for the pipeline decisions with this full table:

```markdown
| Decision | Reason |
|---|---|
| Implementation is **sequential**, not parallel | Notes chain forward, which is what keeps conventions consistent across the plan. |
| Each unit's review is **started inside the implement loop** and awaited after it | Removes the Implement→Review barrier — unit 1 reviews while unit 3 implements — without letting two agents write concurrently. Review is read-only; that is what makes overlapping it safe. |
| **Fixes stay sequential** | Unlike review, fixing writes files. Two fixers can collide on one file, and nothing in the plan guarantees disjointness. |
| A deterministic **Gate** runs before any LLM review | A typechecker finds unused imports instantly and free. Letting an LLM find them instead costs a review slot, a routed fix agent and a re-verify. |
| Review is a **separate phase** from fixing (Full) | A reviewer that can also edit stops reviewing and starts fixing the first thing it sees. |
| Per-unit review at `standard`, whole-plan at **session level** | Diff-anchored review is mid-tier work. The whole-plan pass is the one frontier judgment per plan. |
| Fixes routed **by owning unit** | The unit's agent context is the only place the intent behind the code exists. |
| Implementers run **only their own narrow tests** | Measured: Bash is 78% of tool calls, dominated by repeated suite runs. Each is a turn costing 300-700k late in an agent's life. Full verification is one fresh cheap agent instead. |
| Test loop is **bounded** (2 fix rounds + a final verify) then stops | An unbounded loop burns a night on an unfixable failure. |
| Refactor runs **only on major/critical structural findings**, after green | Refactoring code that just passed review and tests pays a long-lived writing agent plus a second test loop to rediscover a design that already worked. The `structural` flag makes the trigger mechanical rather than a re-judgment. |
| `effort` is passed on **every** dispatch | An agent's own output is 50-75% of its context growth, and thinking tokens are output. Effort compounds into context, not just per-turn price. |
| Routing is resolved **in the script**, not by a hook | `PreToolUse:Agent` hooks do not fire for Workflow `agent()` spawns (measured 2026-08-13). |
```

- [ ] **Step 4: Add two bullets to §6d**

Append to the `### 6d. Workflow-script constraints that bite` list:

```markdown
- **`Promise.all` is fine**; `Date.now()`/`new Date()`/`Math.random()` are not. The overlapped-review
  pattern relies on holding un-awaited promises across loop iterations, which is supported.
- **`budget.spent()` returns output tokens only** — roughly 5% of real cost. It is a progress
  signal, not a bill. Use `scripts/wf-cost.mjs` after the run for the real number.
```

- [ ] **Step 5: Verify**

```bash
cd ~/projects/claude-superpowers
SEC=$(awk '/^### 6b\./,/^### 6c\./' skills/orchestrating-execution/SKILL.md)
echo "$SEC" | grep -q 'Turn discipline' \
  && echo "$SEC" | grep -q 'structural' \
  && echo "$SEC" | grep -q 'reviewPromises' \
  && echo "$SEC" | grep -q 'refactorSkipped' \
  && echo "$SEC" | grep -q 'Do NOT run bd close.' \
  && ! echo "$SEC" | grep -qE 'Date\.now\(\)|Math\.random\(\)|new Date\(\)' \
  && echo TASK2_OK
```

Expected: `TASK2_OK`

- [ ] **Step 6: Commit**

```bash
git add skills/orchestrating-execution/SKILL.md
git commit -m "orchestrating-execution: turn discipline, pre-review gate, conditional refactor"
```

```json:metadata
{"files": ["skills/orchestrating-execution/SKILL.md"], "verifyCommand": "cd ~/projects/claude-superpowers && SEC=$(awk '/^### 6b\\./,/^### 6c\\./' skills/orchestrating-execution/SKILL.md); echo \"$SEC\" | grep -q 'Turn discipline' && echo \"$SEC\" | grep -q 'structural' && echo \"$SEC\" | grep -q 'reviewPromises' && echo \"$SEC\" | grep -q 'Do NOT run bd close.' && ! echo \"$SEC\" | grep -qE 'Date\\.now\\(\\)|Math\\.random\\(\\)' && echo TASK2_OK", "acceptanceCriteria": ["CTX has a Turn discipline block and still ends with 'Do NOT run bd close.'", "FINDINGS schema has a structural boolean", "implementers run only their own narrow tests", "Gate phase runs typecheck+lint at mechanical tier before Review", "review dispatches started in the implement loop, awaited after", "refactor conditional on structural findings, logs skip reason", "every dispatch passes effort", "no Date.now/new Date/Math.random in the script"], "modelTier": "standard", "estimatedScope": "medium"}
```

---

### Task 3: Produce area briefs at plan time

**Goal:** Make `writing-plans` cluster a plan's touched files into 2-5 code areas and write a capped brief for each, so execution agents can be short without being ignorant.

**Files:**
- Modify: `skills/writing-plans/SKILL.md` (add a `## Code Areas` section after `## File Structure`; add one header field to the Plan Document Header template)

**Acceptance Criteria:**
- [ ] A `## Code Areas` section exists, placed between `## File Structure` and `## REQUIRED FIRST STEP`
- [ ] It caps each brief at ~1500 tokens and states why the cap exists
- [ ] It specifies the four content bullets and the explicit exclusions
- [ ] The Plan Document Header template gains a `**Code Areas:**` field
- [ ] It instructs writing the briefs into the plan document under `## Code Areas`, one `### Area: <name>` per area

**Verify:** `grep -q '^## Code Areas' skills/writing-plans/SKILL.md && grep -q 'Code Areas:' skills/writing-plans/SKILL.md && echo TASK3_OK`

**Steps:**

- [ ] **Step 1: Insert the `## Code Areas` section**

Immediately after the `## File Structure` section (before `## REQUIRED FIRST STEP: Initialize Task Tracking`), insert:

````markdown
## Code Areas

Execution agents are deliberately short-lived — cost grows superlinearly with an agent's lifetime,
so an implementer gets one task and is discarded. A short agent that has to rediscover the codebase
is both expensive and error-prone. The plan closes that gap: you already hold this understanding
from brainstorming, so write it down once, here, instead of having every implementer re-derive it.

**Produce them like this:**

1. Take the union of `files[]` across every task in this plan.
2. Cluster those paths into **2-5 code areas** — a package, a module, a layer. Name each area with
   a short slug (`sim-core`, `ui`, `hooks`).
3. Write one brief per area. If you have not actually read an area, dispatch one Explore subagent
   to read it and write the brief from what it reports — do not guess.

**Cap each brief at ~1500 tokens.** This is a real constraint, not a style preference: the brief is
inlined into every dispatch prompt for agents working in that area, so it is re-read on every turn
of those agents. Measured, an 8000-token brief adds 2.5-10% to a run's cache-read volume. A tight
brief pays for itself; a bloated one is a permanent tax.

**Each brief contains exactly:**

- the 5-8 files that matter in this area, one line each on what that file owns
- the interfaces and contracts that must not change
- invariants that hold across the area
- where this area's tests live

**And never contains:** code dumps, exhaustive API listings, anything an agent could cheaply grep
for, or restatement of the tasks.

**Write them into the plan document** under a top-level `## Code Areas` section, one `### Area:
<slug>` subsection each, placed after the task list. Then list the slugs in the header's
**Code Areas:** field.

**Assign areas to tasks.** Every task's `json:metadata` fence gains an `"areas"` key listing the
slugs that task touches — usually one, occasionally two. Execution controllers use it to decide
which briefs to hand each agent.

**Staleness is handled by the notes chain, not by you.** The brief describes structure as of plan
time; earlier tasks will change some of it. That is expected and safe because every implementer is
required to report any interface it changed. Do not try to predict the end state — describe what is
there now.
````

- [ ] **Step 2: Add the header field**

In the `## Plan Document Header` code block, insert a new line immediately after the `**Tech Stack:**` line:

```markdown
**Code Areas:** [Comma-separated area slugs, defined in the `## Code Areas` section below. "none" for single-file plans.]
```

- [ ] **Step 3: Add `areas` to the metadata example**

In the `### Creating Native Tasks` YAML example, change the `json:metadata` line to include the key:

```json
{"files": ["path/to/file1.py"], "verifyCommand": "pytest tests/path/ -v", "acceptanceCriteria": ["criterion 1", "criterion 2"], "modelTier": "mechanical", "areas": ["area-slug"]}
```

- [ ] **Step 4: Verify**

```bash
cd ~/projects/claude-superpowers
grep -q '^## Code Areas' skills/writing-plans/SKILL.md \
  && grep -q '\*\*Code Areas:\*\*' skills/writing-plans/SKILL.md \
  && grep -q '"areas"' skills/writing-plans/SKILL.md \
  && awk '/^## File Structure/{f=1} /^## Code Areas/{if(f)c=1} /^## REQUIRED FIRST STEP/{if(c)print "ORDER_OK"; exit}' \
       skills/writing-plans/SKILL.md | grep -q ORDER_OK \
  && echo TASK3_OK
```

Expected: `TASK3_OK` (the awk pipeline is silent on success; it fails the chain if the section
landed in the wrong place)

- [ ] **Step 5: Commit**

```bash
git add skills/writing-plans/SKILL.md
git commit -m "writing-plans: produce capped per-area code briefs at plan time"
```

```json:metadata
{"files": ["skills/writing-plans/SKILL.md"], "verifyCommand": "cd ~/projects/claude-superpowers && grep -q '^## Code Areas' skills/writing-plans/SKILL.md && grep -q '\\*\\*Code Areas:\\*\\*' skills/writing-plans/SKILL.md && grep -q '\"areas\"' skills/writing-plans/SKILL.md && echo TASK3_OK", "acceptanceCriteria": ["## Code Areas section exists between File Structure and REQUIRED FIRST STEP", "caps briefs at ~1500 tokens with stated rationale", "specifies four content bullets and exclusions", "header template gains Code Areas field", "task metadata example includes areas key"], "modelTier": "standard", "estimatedScope": "small"}
```

---

### Task 4: Consume area briefs in both execution paths

**Goal:** Wire the plan's area briefs into `orchestrating-execution`'s script-authoring instructions and into the `subagent-driven-development` implementer prompt.

**Files:**
- Modify: `skills/orchestrating-execution/SKILL.md` (§6a, immediately before `### 6b`)
- Modify: `skills/subagent-driven-development/implementer-prompt.md` (the `## Context` slot)

**Acceptance Criteria:**
- [ ] `orchestrating-execution` §6a tells the coordinator to copy the plan's area briefs into the script's `AREA` map and set each unit's `areas`
- [ ] It states the ~1500-token cap and that only touched areas are passed
- [ ] `implementer-prompt.md`'s `## Context` placeholder is replaced with one that pastes the task's area briefs verbatim
- [ ] The implementer prompt gains the interface-change reporting obligation

**Verify:** `grep -q 'AREA' skills/orchestrating-execution/SKILL.md && grep -q 'Area:' skills/subagent-driven-development/implementer-prompt.md && echo TASK4_OK`

**Steps:**

- [ ] **Step 1: Add the brief-wiring subsection to `orchestrating-execution`**

Immediately before the line `### 6b. The reference script`, insert:

````markdown
### 6a-bis. Carry the plan's area briefs into the script

The plan document has a `## Code Areas` section with one `### Area: <slug>` brief each, and every
task's `json:metadata` carries an `"areas"` list. Copy them across:

- Each brief becomes an entry in the script's `AREA` map, verbatim, as a template literal.
- Each unit's `areas` array is the union of its task(s)' `areas` values.
- `briefFor(unit)` then inlines only the briefs that unit actually touches. **Do not pass every
  brief to every agent** — the brief is re-read on every turn of that agent, so an irrelevant one
  is a pure tax.

If a brief exceeds ~1500 tokens, cut it down here rather than passing it through. If the plan has
no `## Code Areas` section (older plans), set `AREA = {}` and `areas: []` on every unit; the
pipeline degrades to the previous behaviour rather than failing.

Backticks inside a brief must be escaped for the template literal, or the script will not parse.
````

- [ ] **Step 2: Replace the `## Context` slot in the implementer prompt**

In `skills/subagent-driven-development/implementer-prompt.md`, replace:

```
    ## Context

    [Scene-setting: where this fits, dependencies, architectural context]
```

with:

```
    ## Context

    [Scene-setting: where this fits, dependencies, architectural context]

    ### Code areas

    [For each slug in the task's metadata "areas": paste that area's brief from the plan's
    ## Code Areas section, VERBATIM, under a "### Area: <slug>" heading. Pass only the areas
    this task touches — an unused brief is re-read on every turn of this agent and buys nothing.
    If the plan has no ## Code Areas section, omit this subsection entirely.]

    **If you change an interface named in a brief above, say so explicitly in your report.**
    Later tasks are working from these briefs and will not know the interface moved unless you
    tell them.
```

- [ ] **Step 3: Verify**

```bash
cd ~/projects/claude-superpowers
grep -q '6a-bis' skills/orchestrating-execution/SKILL.md \
  && grep -q 'AREA = {}' skills/orchestrating-execution/SKILL.md \
  && grep -q '### Code areas' skills/subagent-driven-development/implementer-prompt.md \
  && grep -q 'change an interface named in a brief' skills/subagent-driven-development/implementer-prompt.md \
  && echo TASK4_OK
```

Expected: `TASK4_OK`

- [ ] **Step 4: Commit**

```bash
git add skills/orchestrating-execution/SKILL.md skills/subagent-driven-development/implementer-prompt.md
git commit -m "consume plan-time area briefs in both execution paths"
```

```json:metadata
{"files": ["skills/orchestrating-execution/SKILL.md", "skills/subagent-driven-development/implementer-prompt.md"], "verifyCommand": "cd ~/projects/claude-superpowers && grep -q '6a-bis' skills/orchestrating-execution/SKILL.md && grep -q '### Code areas' skills/subagent-driven-development/implementer-prompt.md && echo TASK4_OK", "acceptanceCriteria": ["§6a-bis tells coordinator to copy briefs into AREA map and set unit areas", "states the ~1500 token cap and only-touched-areas rule", "implementer-prompt Context slot pastes task's area briefs", "implementer prompt carries the interface-change reporting obligation"], "modelTier": "mechanical", "estimatedScope": "small"}
```

---

### Task 5: Ship `scripts/wf-cost.mjs` with tests

**Goal:** A zero-dependency post-run cost report that reads a Workflow run's agent transcripts and reports turns, context growth, and cost per agent and per phase.

**Files:**
- Create: `scripts/wf-cost.mjs`
- Create: `tests/wf-cost/wf-cost.test.mjs`
- Create: `tests/wf-cost/fixtures/agent-aaa.jsonl`
- Create: `tests/wf-cost/fixtures/agent-bbb.jsonl`

**Acceptance Criteria:**
- [ ] `node scripts/wf-cost.mjs <dir>` prints a per-agent table and totals
- [ ] `--json` emits machine-readable output with `agents` and `totals` keys
- [ ] Cost index is `output*5 + fresh*1 + cacheRead*0.1`, where fresh = `input_tokens + cache_creation_input_tokens`
- [ ] Agents are labelled from `journal.jsonl` when present, else the transcript filename
- [ ] Exits 2 with a message when the directory has no `agent-*.jsonl`
- [ ] Malformed JSON lines are skipped, not fatal
- [ ] `bun test tests/wf-cost/` passes

**Verify:** `cd ~/projects/claude-superpowers && bun test tests/wf-cost/` → all tests pass

**Steps:**

- [ ] **Step 1: Write the fixtures**

`tests/wf-cost/fixtures/agent-aaa.jsonl` — two assistant turns, one Bash tool call, one malformed line:

```jsonl
{"type":"assistant","agentId":"aaa","message":{"model":"claude-sonnet-5","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":100,"cache_creation_input_tokens":900,"cache_read_input_tokens":0,"output_tokens":50}}}
{not valid json at all
{"type":"assistant","agentId":"aaa","message":{"model":"claude-sonnet-5","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"bun test"}}],"usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":1000,"output_tokens":20}}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","content":"ok"}]}}
```

`tests/wf-cost/fixtures/agent-bbb.jsonl` — one assistant turn, a Read call:

```jsonl
{"type":"assistant","agentId":"bbb","message":{"model":"claude-opus-5","content":[{"type":"tool_use","id":"tu2","name":"Read","input":{"file_path":"/x/y.ts"}}],"usage":{"input_tokens":0,"cache_creation_input_tokens":2000,"cache_read_input_tokens":5000,"output_tokens":400}}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu2","content":"file body"}]}}
```

- [ ] **Step 2: Write `scripts/wf-cost.mjs`**

```js
#!/usr/bin/env node
// Post-run cost report for a Claude Code Workflow run.
// Usage: node scripts/wf-cost.mjs <transcriptDir> [--json]
//
// Reads agent-*.jsonl transcripts and reports where a run's tokens went. Cost is
// dominated by cache-read input, which is the accumulated context re-sent on every
// turn — so the report leads with turns and context growth, not raw token counts.
// Zero dependencies by design.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

// Relative to base input price: output ~5x, cache read ~0.1x, cache write ~1.25x
// (folded into `fresh` at 1x — close enough for a relative report).
const W = { out: 5, fresh: 1, cache: 0.1 };

function scanAgent(path) {
  let turns = 0, fresh = 0, cache = 0, out = 0, model = null;
  let ctxFirst = 0, ctxMax = 0;
  const tools = new Map();
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue; // malformed lines are skipped, never fatal
    }
    if (d.type !== "assistant") continue;
    const msg = d.message || {};
    const u = msg.usage || {};
    model ??= msg.model ?? null;
    turns++;
    const f = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const c = u.cache_read_input_tokens || 0;
    fresh += f;
    cache += c;
    out += u.output_tokens || 0;
    const ctx = f + c;
    if (turns === 1) ctxFirst = ctx;
    if (ctx > ctxMax) ctxMax = ctx;
    for (const part of msg.content || []) {
      if (part && part.type === "tool_use") {
        tools.set(part.name, (tools.get(part.name) || 0) + 1);
      }
    }
  }
  if (!turns) return null;
  return {
    id: basename(path).replace(/^agent-/, "").replace(/\.jsonl$/, ""),
    model, turns, fresh, cache, out, ctxFirst, ctxMax,
    growthPerTurn: turns > 1 ? Math.round((ctxMax - ctxFirst) / (turns - 1)) : 0,
    cost: out * W.out + fresh * W.fresh + cache * W.cache,
    tools: Object.fromEntries([...tools.entries()].sort((a, b) => b[1] - a[1])),
  };
}

function labels(dir) {
  const map = new Map();
  const jp = join(dir, "journal.jsonl");
  if (!existsSync(jp)) return map;
  let text;
  try {
    text = readFileSync(jp, "utf8");
  } catch {
    return map;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const id = d.agentId;
    if (!id || map.has(id)) continue;
    const v = d.label ?? d.key ?? d.name;
    if (typeof v === "string" && v) map.set(id, v);
  }
  return map;
}

function main(argv) {
  const asJson = argv.includes("--json");
  const dir = argv.find((a) => !a.startsWith("--"));
  if (!dir) {
    console.error("usage: node scripts/wf-cost.mjs <transcriptDir> [--json]");
    return 2;
  }
  let files;
  try {
    files = readdirSync(dir).filter((f) => /^agent-.*\.jsonl$/.test(f)).sort();
  } catch {
    console.error(`cannot read directory: ${dir}`);
    return 2;
  }
  if (!files.length) {
    console.error(`no agent-*.jsonl transcripts in ${dir}`);
    return 2;
  }
  const lab = labels(dir);
  const agents = files.map((f) => scanAgent(join(dir, f))).filter(Boolean)
    .map((a) => ({ ...a, label: lab.get(a.id) ?? a.id }))
    .sort((a, b) => b.cost - a.cost);
  if (!agents.length) {
    console.error(`no agents with usage records in ${dir}`);
    return 2;
  }

  const totals = agents.reduce((t, a) => ({
    turns: t.turns + a.turns, fresh: t.fresh + a.fresh,
    cache: t.cache + a.cache, out: t.out + a.out, cost: t.cost + a.cost,
  }), { turns: 0, fresh: 0, cache: 0, out: 0, cost: 0 });
  totals.agents = agents.length;
  totals.medianTurns = agents.map((a) => a.turns).sort((x, y) => x - y)[agents.length >> 1];
  const top20 = agents.slice(0, Math.max(1, Math.ceil(agents.length / 5)));
  totals.top20PctCostShare = totals.cost
    ? +(100 * top20.reduce((s, a) => s + a.cost, 0) / totals.cost).toFixed(1)
    : 0;

  if (asJson) {
    console.log(JSON.stringify({ agents, totals }, null, 2));
    return 0;
  }

  const n = (v) => v.toLocaleString("en-US");
  console.log(`${"label".padEnd(26)} ${"model".padEnd(17)} ${"turns".padStart(6)} ` +
              `${"ctx_end".padStart(10)} ${"g/turn".padStart(8)} ${"cost_idx".padStart(14)}`);
  for (const a of agents) {
    console.log(`${a.label.slice(0, 26).padEnd(26)} ${String(a.model).slice(0, 17).padEnd(17)} ` +
                `${String(a.turns).padStart(6)} ${n(a.ctxMax).padStart(10)} ` +
                `${n(a.growthPerTurn).padStart(8)} ${n(Math.round(a.cost)).padStart(14)}`);
  }
  console.log(`\nagents ${totals.agents}   turns ${n(totals.turns)}   ` +
              `median turns/agent ${totals.medianTurns}`);
  console.log(`cache_read ${n(totals.cache)}   fresh ${n(totals.fresh)}   output ${n(totals.out)}`);
  console.log(`cost index ${n(Math.round(totals.cost))}   ` +
              `top 20% of agents = ${totals.top20PctCostShare}% of cost`);
  return 0;
}

// Set the code rather than calling process.exit(): process.exit() can truncate buffered
// stdout when it is a pipe, which would corrupt --json output for any caller.
process.exitCode = main(process.argv.slice(2));
```

- [ ] **Step 3: Write the test**

`tests/wf-cost/wf-cost.test.mjs`:

```js
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
```

- [ ] **Step 4: Run the tests**

```bash
cd ~/projects/claude-superpowers && bun test tests/wf-cost/
```

Expected: 8 pass, 0 fail.

- [ ] **Step 5: Smoke-test against a real run**

```bash
cd ~/projects/claude-superpowers
REAL=$(find ~/.claude/projects -type d -name 'wf_*' | head -1)
node scripts/wf-cost.mjs "$REAL" | tail -5
```

Expected: a totals block with non-zero `cache_read` and a `top 20% of agents` percentage. If no
real run exists on this machine, skip — the fixture tests are the gate.

- [ ] **Step 6: Commit**

```bash
git add scripts/wf-cost.mjs tests/wf-cost/
git commit -m "feat: wf-cost.mjs, a post-run cost report for workflow runs"
```

```json:metadata
{"files": ["scripts/wf-cost.mjs", "tests/wf-cost/wf-cost.test.mjs", "tests/wf-cost/fixtures/agent-aaa.jsonl", "tests/wf-cost/fixtures/agent-bbb.jsonl"], "verifyCommand": "cd ~/projects/claude-superpowers && bun test tests/wf-cost/", "acceptanceCriteria": ["node scripts/wf-cost.mjs <dir> prints per-agent table and totals", "--json emits agents and totals keys", "cost index is output*5 + fresh*1 + cacheRead*0.1", "labels come from journal.jsonl when present", "exits 2 when no agent-*.jsonl found", "malformed JSON lines skipped not fatal", "bun test tests/wf-cost/ passes"], "modelTier": "standard", "estimatedScope": "medium"}
```

---

### Task 6: Wire the cost report into Step 8

**Goal:** Make every orchestrated run end with a real cost number.

**Files:**
- Modify: `skills/orchestrating-execution/SKILL.md` (Step 7 launch note, Step 8 numbered list)

**Acceptance Criteria:**
- [ ] Step 7 tells the coordinator to keep the `transcriptDir` from the Workflow result
- [ ] Step 8 gains a numbered item running `scripts/wf-cost.mjs` and reporting median turns per agent plus the top-20% cost share
- [ ] It states the report is non-fatal if the directory is missing
- [ ] It notes that `budget.spent()` in the script is output-only and the report supersedes it

**Verify:** `grep -q 'wf-cost.mjs' skills/orchestrating-execution/SKILL.md && echo TASK6_OK`

**Steps:**

- [ ] **Step 1: Amend Step 7**

At the end of the `## Step 7: Claim, then launch` section, after the `**When it breaks:**` paragraph, append:

```markdown
**Keep the `transcriptDir`** from the Workflow tool's result alongside the `runId`. Step 8 needs it
for the cost report, and it is not recoverable from the returned summary.
```

- [ ] **Step 2: Insert the cost-report item into Step 8**

In `## Step 8: On completion`, insert a new item between the current items 2 and 3, renumbering the rest:

````markdown
3. **Run the cost report** and include it in what you report back:

   ```bash
   node ~/.claude/plugins/marketplaces/claude-superpowers/scripts/wf-cost.mjs <transcriptDir>
   ```

   Quote the totals line: agents, median turns per agent, and the top-20% cost share. Median turns
   per agent is the number this pipeline is designed to hold down — a median above ~120 means units
   are too large and the bundling in Step 3 was too generous. If `transcriptDir` is missing or the
   script exits non-zero, say "cost report unavailable" and carry on; it is a report, not a gate.

   The script's own `budget.spent()` log lines cover output tokens only, roughly 5% of real cost.
   Where the two disagree, the report is right.
````

- [ ] **Step 3: Verify**

```bash
cd ~/projects/claude-superpowers
grep -q 'wf-cost.mjs' skills/orchestrating-execution/SKILL.md \
  && grep -q 'cost report unavailable' skills/orchestrating-execution/SKILL.md \
  && grep -q 'Keep the `transcriptDir`' skills/orchestrating-execution/SKILL.md \
  && echo TASK6_OK
```

Expected: `TASK6_OK`

- [ ] **Step 4: Commit**

```bash
git add skills/orchestrating-execution/SKILL.md
git commit -m "orchestrating-execution: report real run cost at completion"
```

```json:metadata
{"files": ["skills/orchestrating-execution/SKILL.md"], "verifyCommand": "cd ~/projects/claude-superpowers && grep -q 'wf-cost.mjs' skills/orchestrating-execution/SKILL.md && grep -q 'cost report unavailable' skills/orchestrating-execution/SKILL.md && echo TASK6_OK", "acceptanceCriteria": ["Step 7 says to keep transcriptDir", "Step 8 runs wf-cost.mjs and reports median turns + top-20% share", "report is non-fatal when unavailable", "notes budget.spent() is output-only"], "modelTier": "mechanical", "estimatedScope": "small"}
```

---

### Task 7: Sync the docs

**Goal:** Make `README.md` and the superseded 2026-08-13 design document describe what now runs.

**Files:**
- Modify: `README.md` (the `### Bundling` subsection and the pipeline table in `## Orchestrated Execution — Optional Flow`)
- Modify: `docs/superpowers/specs/2026-08-13-orchestrated-execution-design.md` (superseded banner)

**Acceptance Criteria:**
- [ ] README's `### Bundling` paragraph describes one-task-per-agent and no longer says shared files must share a bundle
- [ ] README's pipeline table mentions the Gate phase and conditional refactor
- [ ] README gains a short `### Cost reporting` subsection naming `scripts/wf-cost.mjs`
- [ ] The 2026-08-13 spec's banner points at the new spec for bundling and pipeline shape
- [ ] `README.md` changes are limited to the Orchestrated Execution section (unrelated WIP in that file is untouched)

**Verify:** `grep -q 'wf-cost.mjs' README.md && grep -q '2026-08-15-orchestration-cost-redesign' docs/superpowers/specs/2026-08-13-orchestrated-execution-design.md && echo TASK7_OK`

**Steps:**

- [ ] **Step 1: Replace README's `### Bundling` body**

Replace the paragraph under `### Bundling` with:

```markdown
A bundle is the set of tasks handed to one implementer agent in one dispatch, and **the default is
one task per bundle.** Measurement of 240 workflow agents found that cost is the integral of
context over turns — every turn re-reads the agent's whole accumulated context — so it grows
superlinearly with agent lifetime. The worst agent observed ran 443 turns and moved 208M tokens,
20% of its entire run, while a fresh agent's floor is only ~26k. Splitting is cheap; merging is
not.

Two tasks merge only when all three of these hold: both are trivially small (≤2 files, small
scope), they share a file, and a direct `blockedBy` edge joins them. Never across `modelTier`, and
never more than two tasks. An earlier version made shared files a *mandatory* merge on the grounds
that two agents would clobber one file — but implementation is sequential and there are no
concurrent writers, so that rule bought nothing and built long agents. A shared file is now a
notes-chain obligation instead: the earlier task must report any interface it changed.
```

- [ ] **Step 2: Update the README pipeline table**

Replace the two table rows with:

```markdown
| **Orchestrated — Simple** | Implement → deterministic gate → one combined review-and-fix pass → bounded test loop |
| **Orchestrated — Full** | Implement (reviews overlapped) → deterministic gate → per-unit + whole-plan review → routed fixes → test loop → refactor *only on structural findings* → test loop |
```

- [ ] **Step 3: Add a cost-reporting subsection**

After the `### Model tiers` subsection, insert:

```markdown
### Cost reporting

Every orchestrated run ends with a real cost number. `scripts/wf-cost.mjs` reads the run's
`agent-*.jsonl` transcripts and reports turns, context growth and a cost index per agent, plus the
share carried by the most expensive fifth of agents. `orchestrating-execution` runs it in Step 8.
Median turns per agent is the number the pipeline is tuned to hold down — above ~120 means the
bundling was too generous.

```bash
node scripts/wf-cost.mjs <transcriptDir>
```
```

- [ ] **Step 4: Update the superseded banner**

In `docs/superpowers/specs/2026-08-13-orchestrated-execution-design.md`, append to the existing `> **Superseded.**` blockquote:

```markdown
> **Superseded again, 2026-08-15**, on bundling and pipeline shape, by
> `2026-08-15-orchestration-cost-redesign-design.md`. That document measures 240 real workflow
> agents and finds cost is the integral of context over turns; the "merge on coupling" bundling
> below and the unconditional refactor stage are both reversed there. The Beads integration, tier
> roles and bounded test loop still stand.
```

- [ ] **Step 5: Verify**

```bash
cd ~/projects/claude-superpowers
grep -q 'wf-cost.mjs' README.md \
  && grep -q 'notes-chain obligation' README.md \
  && grep -q '2026-08-15-orchestration-cost-redesign' docs/superpowers/specs/2026-08-13-orchestrated-execution-design.md \
  && echo TASK7_OK
```

Expected: `TASK7_OK`

- [ ] **Step 6: Commit**

```bash
git add README.md docs/superpowers/specs/2026-08-13-orchestrated-execution-design.md
git commit -m "docs: describe the cost-redesigned orchestration pipeline"
```

```json:metadata
{"files": ["README.md", "docs/superpowers/specs/2026-08-13-orchestrated-execution-design.md"], "verifyCommand": "cd ~/projects/claude-superpowers && grep -q 'wf-cost.mjs' README.md && grep -q 'notes-chain obligation' README.md && grep -q '2026-08-15-orchestration-cost-redesign' docs/superpowers/specs/2026-08-13-orchestrated-execution-design.md && echo TASK7_OK", "acceptanceCriteria": ["README Bundling describes one-task-per-agent", "README pipeline table mentions Gate and conditional refactor", "README has a Cost reporting subsection naming wf-cost.mjs", "2026-08-13 spec banner points at the new spec", "README edits confined to the Orchestrated Execution section"], "modelTier": "mechanical", "estimatedScope": "small"}
```

---

## Dependencies

```
1 (bundling) ─────┐
                  ├─> 2 (script) ──┐
3 (briefs) ───────┘                ├─> 4 (consume) ──┐
                                   │                 ├─> 6 (step 8) ──> 7 (docs)
5 (wf-cost.mjs) ───────────────────┴─────────────────┘
```

- Task 2 blockedBy 1 — same file, disjoint sections, ordered to avoid churn
- Task 4 blockedBy 2, 3 — needs the script shape and the brief format
- Task 6 blockedBy 4, 5 — needs the script to exist and is the last edit to the skill
- Task 7 blockedBy 1, 2, 3, 6 — documents the finished state

Tasks 1, 3 and 5 are independent and may start together.

## Manual verification after all tasks

```bash
cd ~/projects/claude-superpowers
bun test tests/wf-cost/                              # must be 8/8 — this plan owns it
bash tests/claude-code/test-handoff-guard.sh         # compare to baseline below
bash tests/claude-code/test-taskcreate-tier-hook.sh  # compare to baseline below
bash tests/claude-code/test-taskcreate-commit-strategy-hook.sh
```

<HARD-GATE>
**Pre-existing baseline, measured 2026-08-15 BEFORE any task in this plan ran.** Do not chase
these; you did not cause them, and fixing them is not in scope for this plan.

| Suite | Baseline |
|---|---|
| `test-handoff-guard.sh` | **21 failures** |
| `test-taskcreate-tier-hook.sh` | **14 failures** |
| `test-taskcreate-commit-strategy-hook.sh` | 0 failures |

Every failure in both suites is in the *should-block* direction (`expected exit=2, got exit=0`) —
the hooks are failing open, so the guards are dormant when the tests expect them armed. The
"should-allow" cases all pass. None of these suites assert on any section this plan edits.

**Your obligation is no regression, not a green suite:** the failure counts after your work must be
**≤ 21 and ≤ 14** respectively. If either rises, you broke something — stop and report it. Both
suites also exit 0 regardless of failures, so read the `=== Summary: N failure(s) ===` line rather
than trusting the exit code.
</HARD-GATE>

Then confirm the unrelated pre-existing WIP is still uncommitted and untouched:

```bash
git status --short
```

Expected: `README.md` modified only in the Orchestrated Execution section, `commands/onboard.md`
still modified, `scripts/bundle-plan.mjs` etc. still staged-deleted.
