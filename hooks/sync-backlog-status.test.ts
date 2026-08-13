import { test, expect } from "bun:test";
import {
  computeStatus,
  findCardId,
  findCardIds,
  parentEpicOf,
  deriveEpicStatus,
} from "./sync-backlog-status";
import { readFileSync } from "fs";

const fx = (n: string) => readFileSync(`tests/hook-fixtures/${n}.md`, "utf8");

test("all unchecked → In Progress", () => {
  expect(computeStatus(fx("unchecked"))).toBe("In Progress");
});
test("partial → In Progress", () => {
  expect(computeStatus(fx("partial"))).toBe("In Progress");
});
test("all checked → Done", () => {
  expect(computeStatus(fx("complete"))).toBe("Done");
});
test("findCardId prefers Backlog header line", () => {
  expect(findCardId(fx("unchecked"), "any/path.md", ".")).toBe("task-1.1");
});
test("unlinked plan → findCardId null", () => {
  expect(findCardId(fx("unlinked"), "no/match.md", "/tmp/nonexistent")).toBeNull();
});

// --- multiple Backlog refs per plan ---
test("findCardIds returns every Backlog header, de-duped", () => {
  const md = "# Plan\n\nBacklog: task-2.3\nBacklog: task-2.5\nBacklog: task-2.3\n\n- [ ] x";
  expect(findCardIds(md, "p.md", ".")).toEqual(["task-2.3", "task-2.5"]);
});
test("findCardId still returns the first of many", () => {
  const md = "Backlog: task-9.1\nBacklog: task-9.2\n";
  expect(findCardId(md, "p.md", ".")).toBe("task-9.1");
});

// --- parent epic derivation ---
test("parentEpicOf: child → epic, epic → null, big index safe", () => {
  expect(parentEpicOf("task-1.2")).toBe("task-1");
  expect(parentEpicOf("task-70.3")).toBe("task-70");
  expect(parentEpicOf("task-5")).toBeNull();
});

// --- pure epic roll-up rule ---
test("deriveEpicStatus rolls up children", () => {
  expect(deriveEpicStatus([])).toBeNull();
  expect(deriveEpicStatus(["Done", "done", "DONE"])).toBe("Done");
  expect(deriveEpicStatus(["To Do", "to do"])).toBe("To Do");
  expect(deriveEpicStatus(["Done", "To Do"])).toBe("In Progress");
  expect(deriveEpicStatus(["In Progress", "Done"])).toBe("In Progress");
});
