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

// Guards against a future edit silently removing the workflow's return value
// (see task-3-report.md fix-round-1 section for why that regression happened
// once already): the source must still contain a top-level `return` inside
// the guarded block, ending in the same result shape the workflow surfaces.
test("workflow body still ends in a top-level return of the result object", () => {
  const body = src.slice(idx);
  expect(body).toMatch(/\n\s*return\s*\{\s*\n\s*epicId,/);
});
