import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// scripts/orchestrate.js is a Workflow-tool script, not an importable ES
// module: its workflow body ends in a top-level `return`, which is a
// SyntaxError under a plain ESM `import`. So instead of importing the whole
// file, slice off everything from the workflow-body guard onward and
// evaluate only the helper prelude (TIERS, resolveModel, escalate,
// validateArgs, meta). This tests the REAL helper source with no
// duplication, and fails loudly if the guard marker changes.
const src = readFileSync(new URL("../../scripts/orchestrate.js", import.meta.url), "utf8");
const marker = 'if (typeof agent === "function")';
const idx = src.indexOf(marker);
if (idx === -1) throw new Error("orchestrate.js: workflow-body guard not found — did the marker change?");
const prelude = src.slice(0, idx);

// Loaded via a temp .mjs file rather than a `data:` URL: bun 1.2.22's
// data:-URL module loader silently mis-detects source containing optional
// chaining on a computed member (`routing?.[tier]`, which resolveModel
// actually uses below) as CommonJS and drops every named export — repro
// reduces to `export function f(t, r) { return r?.[t]; }` importing as
// {__esModule, default} with no `f`. Writing the identical slice to a real
// file and importing that sidesteps the loader bug while still executing
// the unmodified source text.
const preludePath = join(tmpdir(), `orchestrate-prelude-${randomUUID()}.mjs`);
writeFileSync(preludePath, prelude);
let TIERS, resolveModel, escalate, validateArgs;
try {
  ({ TIERS, resolveModel, escalate, validateArgs } = await import(preludePath));
} finally {
  unlinkSync(preludePath);
}

const ROUTING = { mechanical: "sonnet", standard: "opus", frontier: "fable" };
// validateArgs now also requires ctx/epicId (fix round 2, minor 7) — every
// validateArgs fixture below carries these so each test still isolates the
// one rejection/acceptance rule it's meant to exercise.
const CTX = { ctx: "context", epicId: "epic-1" };

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
  expect(() => validateArgs({ mode: "full", routing: ROUTING, ...CTX,
    bundles: [{ id: "b1", taskIds: [1] }] })).toThrow(/tier/);
});

test("rejects an unknown mode", () => {
  expect(() => validateArgs({ mode: "turbo", routing: ROUTING, ...CTX,
    bundles: [{ id: "b1", tier: "standard", taskIds: [1] }] })).toThrow(/mode/);
});

test("accepts a well-formed args object", () => {
  expect(() => validateArgs({ mode: "simple", routing: ROUTING, ...CTX,
    bundles: [{ id: "b1", tier: "standard", taskIds: [1] }] })).not.toThrow();
});

// Guards against a future edit silently removing the workflow's return value
// (see task-3-report.md fix-round-1 section for why that regression happened
// once already): the source must still contain a top-level `return` inside
// the guarded block, ending in the same result shape the workflow surfaces.
test("workflow body still ends in a top-level return of the result object", () => {
  const body = src.slice(idx);
  expect(body).toMatch(/\n\s*return\s*\{\s*\n\s*epicId,/);
});

// ---- fix round 2 ----

test("rejects an args object with no ctx", () => {
  expect(() => validateArgs({ mode: "simple", routing: ROUTING, epicId: "epic-1",
    bundles: [{ id: "b1", tier: "standard", taskIds: [1] }] })).toThrow(/ctx/);
});

test("rejects an args object with no epicId", () => {
  expect(() => validateArgs({ mode: "simple", routing: ROUTING, ctx: "context",
    bundles: [{ id: "b1", tier: "standard", taskIds: [1] }] })).toThrow(/epicId/);
});

test("rejects a bundle with no id", () => {
  expect(() => validateArgs({ mode: "simple", routing: ROUTING, ...CTX,
    bundles: [{ tier: "standard", taskIds: [1] }] })).toThrow(/id/);
});

// This is the exact double-dispatch scenario from the review: two id-less
// bundles would previously both pass validation, then both `f.bundleId ===
// b.id` (undefined === undefined) AND `!f.bundleId` would match the same
// finding, sending it to two fixers that both commit.
test("rejects duplicate bundle ids", () => {
  expect(() => validateArgs({ mode: "simple", routing: ROUTING, ...CTX,
    bundles: [
      { id: "b1", tier: "standard", taskIds: [1] },
      { id: "b1", tier: "mechanical", taskIds: [2] },
    ] })).toThrow(/duplicate/i);
});

test("rejects a bundle with an empty taskIds array", () => {
  expect(() => validateArgs({ mode: "simple", routing: ROUTING, ...CTX,
    bundles: [{ id: "b1", tier: "standard", taskIds: [] }] })).toThrow(/taskIds/);
});

test("rejects a missing taskIds array without waiting for the Implement dispatch to fail", () => {
  expect(() => validateArgs({ mode: "simple", routing: ROUTING, ...CTX,
    bundles: [{ id: "b1", tier: "standard" }] })).toThrow(/taskIds/);
});

test("rejects blockedByBundles naming a bundle that appears later in the array", () => {
  expect(() => validateArgs({ mode: "full", routing: ROUTING, ...CTX,
    bundles: [
      { id: "b1", tier: "standard", taskIds: [1], blockedByBundles: ["b2"] },
      { id: "b2", tier: "standard", taskIds: [2] },
    ] })).toThrow(/blockedByBundles/);
});

test("rejects blockedByBundles naming a bundle that doesn't exist", () => {
  expect(() => validateArgs({ mode: "full", routing: ROUTING, ...CTX,
    bundles: [{ id: "b1", tier: "standard", taskIds: [1], blockedByBundles: ["nope"] }] }))
    .toThrow(/blockedByBundles/);
});

test("accepts blockedByBundles naming a bundle earlier in the array", () => {
  expect(() => validateArgs({ mode: "full", routing: ROUTING, ...CTX,
    bundles: [
      { id: "b1", tier: "standard", taskIds: [1] },
      { id: "b2", tier: "standard", taskIds: [2], blockedByBundles: ["b1"] },
    ] })).not.toThrow();
});

// Execution-testing the fix itself isn't possible under `bun test` (the
// workflow body never runs — `agent` is undefined, so the whole guarded
// block is skipped). This asserts the fix is present in the real source:
// after the 2-round fix loop, testLoop must run one more mechanical-tier
// verify() before falling through to "exhausted", so a fix applied on the
// last iteration is checked instead of being reported as still-red by
// default (which, in full mode, silently cancels Refactor on a green tree).
test("test loop does a final mechanical verification before giving up", () => {
  const body = src.slice(idx);
  const loopToExhausted = body.slice(
    body.indexOf("for (let i = 0; i < 2; i++)"),
    body.indexOf("test loop exhausted after 2 fix rounds")
  );
  expect(loopToExhausted).toMatch(/const finalRes = await verify\(/);
  expect(loopToExhausted).toMatch(/if \(finalRes && finalRes\.pass\)/);
});
