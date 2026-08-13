import { test, expect } from "bun:test";
import { isDesignDoc } from "./remind-backlog-reconcile";

test("matches design/spec docs", () => {
  expect(isDesignDoc("/repo/docs/GAME-DESIGN.md")).toBe(true);
  expect(isDesignDoc("docs/superpowers/specs/2026-07-01-thing-design.md")).toBe(true);
});
test("ignores plans, research, and unrelated markdown", () => {
  expect(isDesignDoc("/repo/docs/superpowers/plans/2026-07-01-thing.md")).toBe(false);
  expect(isDesignDoc("/repo/docs/research/BRIEF.md")).toBe(false);
  expect(isDesignDoc("/repo/README.md")).toBe(false);
});
