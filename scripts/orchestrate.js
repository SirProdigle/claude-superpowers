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

// Set by the workflow body below when it runs under the Workflow tool. Exported
// as a live binding (not returned) because top-level `return` is a SyntaxError
// in an ES module — this file must stay import-able by `bun test`.
export let result = null;

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

  result = {
    epicId,
    mode,
    bundles: bundles.length,
    findings: findings.length,
    greenAfterImpl,
    greenAfterRefactor,
    notes,
  };
}
