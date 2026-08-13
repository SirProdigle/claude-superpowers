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
