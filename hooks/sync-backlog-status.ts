#!/usr/bin/env bun
import { execFileSync } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";

const BACKLOG = process.env.BACKLOG_BIN || `${process.env.HOME}/.bun/bin/backlog`;

export function computeStatus(md: string): "In Progress" | "Done" | null {
  const lines = md.split("\n");
  const unchecked = lines.filter((l) => /^\s*- \[ \]/.test(l)).length;
  const checked = lines.filter((l) => /^\s*- \[x\]/i.test(l)).length;
  if (checked + unchecked === 0) return "In Progress"; // present, no steps yet
  return unchecked === 0 ? "Done" : "In Progress";
}

export function findRepoRoot(startDir: string): string | null {
  let d = startDir;
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(d, "backlog", "config.yml"))) return d;
    const p = dirname(d);
    if (p === d) break;
    d = p;
  }
  return null;
}

/** All cards a plan implements: every `Backlog: task-N.M` header line (a plan may
 *  implement several task-cards), else the grep-by-reference fallback. */
export function findCardIds(planText: string, planPath: string, repoRoot: string): string[] {
  const headers = [...planText.matchAll(/^\s*Backlog:\s*(task-[0-9.]+)/gim)].map((m) => m[1].toLowerCase());
  if (headers.length) return [...new Set(headers)];
  const tasksDir = join(repoRoot, "backlog", "tasks");
  if (!existsSync(tasksDir)) return [];
  const ids: string[] = [];
  for (const f of readdirSync(tasksDir)) {
    if (!f.endsWith(".md")) continue;
    const body = readFileSync(join(tasksDir, f), "utf8");
    if (body.includes(planPath)) {
      const id = body.match(/^id:\s*(\S+)/im);
      if (id) ids.push(id[1].toLowerCase());
    }
  }
  return [...new Set(ids)];
}

/** Back-compat single-card lookup (first match). */
export function findCardId(planText: string, planPath: string, repoRoot: string): string | null {
  return findCardIds(planText, planPath, repoRoot)[0] ?? null;
}

/** task-1.2 → task-1 ; task-1 (an epic) → null */
export function parentEpicOf(cardId: string): string | null {
  const m = cardId.match(/^(task-\d+)\.\d+$/i);
  return m ? m[1].toLowerCase() : null;
}

/** Pure roll-up rule: derive an epic's status from its children's statuses.
 *  Empty (no children) → null (leave alone). */
export function deriveEpicStatus(
  childStatuses: string[],
): "To Do" | "In Progress" | "Done" | null {
  const s = childStatuses.map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (s.length === 0) return null;
  if (s.every((x) => x === "done")) return "Done";
  if (s.every((x) => x === "to do")) return "To Do";
  return "In Progress";
}

function childStatuses(epicId: string, repoRoot: string): string[] {
  const tasksDir = join(repoRoot, "backlog", "tasks");
  if (!existsSync(tasksDir)) return [];
  const prefix = epicId.toLowerCase() + "."; // "task-7." excludes task-70.*
  const out: string[] = [];
  for (const f of readdirSync(tasksDir)) {
    if (!f.toLowerCase().startsWith(prefix)) continue;
    const body = readFileSync(join(tasksDir, f), "utf8");
    const m = body.match(/^status:\s*['"]?([^'"\n]+?)['"]?\s*$/im);
    if (m) out.push(m[1]);
  }
  return out;
}

function setStatus(id: string, status: string, repoRoot: string) {
  try {
    execFileSync(BACKLOG, ["task", "edit", id, "-s", status, "--plain"], { cwd: repoRoot, stdio: "ignore" });
    console.error(`[tracker] ${id} → ${status}`);
  } catch {
    console.error(`[tracker] failed to edit ${id}`);
  }
}

function main() {
  let payload: any = {};
  try { payload = JSON.parse(readFileSync(0, "utf8")); } catch { process.exit(0); }
  const path: string = payload?.tool_input?.file_path || "";
  if (!/docs\/superpowers\/plans\/.*\.md$/.test(path)) process.exit(0);
  if (!existsSync(path)) process.exit(0);
  const repoRoot = findRepoRoot(dirname(path));
  if (!repoRoot) { console.error("[tracker] not a Backlog repo — skipping"); process.exit(0); }
  const text = readFileSync(path, "utf8");
  const rel = path.startsWith(repoRoot) ? path.slice(repoRoot.length + 1) : path;
  const ids = findCardIds(text, rel, repoRoot);
  if (!ids.length) { console.error(`[tracker] no card linked to ${rel} — skipping`); process.exit(0); }
  const status = computeStatus(text);
  if (!status) process.exit(0);
  // Set every linked card, then roll up each distinct parent epic.
  const epics = new Set<string>();
  for (const id of ids) {
    setStatus(id, status, repoRoot);
    const e = parentEpicOf(id);
    if (e) epics.add(e);
  }
  for (const epic of epics) {
    const es = deriveEpicStatus(childStatuses(epic, repoRoot));
    if (es) setStatus(epic, es, repoRoot);
  }
  process.exit(0);
}

if (import.meta.main) main();
