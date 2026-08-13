#!/usr/bin/env bun
/**
 * PostToolUse nudge: when a design/spec doc is written in a Backlog.md repo and
 * the board does NOT yet reference it, remind the agent to reconcile it into the
 * board (via the `converting-a-design` skill) BEFORE implementation planning.
 *
 * This is the forcing function that closes the brainstorm→backlog seam so the
 * conversion isn't forgotten. Idempotent: silent once the design is on the board.
 */
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";

/** A design/spec doc worth reconciling: docs/GAME-DESIGN.md or docs/superpowers/specs/*.md */
export function isDesignDoc(path: string): boolean {
  return /(^|\/)GAME-DESIGN\.md$/i.test(path) || /(^|\/)docs\/superpowers\/specs\/[^/]+\.md$/i.test(path);
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

/** True if any card already references this design doc (→ already reconciled). */
export function alreadyOnBoard(relPath: string, repoRoot: string): boolean {
  const tasksDir = join(repoRoot, "backlog", "tasks");
  if (!existsSync(tasksDir)) return false;
  for (const f of readdirSync(tasksDir)) {
    if (!f.endsWith(".md")) continue;
    if (readFileSync(join(tasksDir, f), "utf8").includes(relPath)) return true;
  }
  return false;
}

function emit(context: string) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } }),
  );
}

function main() {
  let payload: any = {};
  try { payload = JSON.parse(readFileSync(0, "utf8")); } catch { process.exit(0); }
  const path: string = payload?.tool_input?.file_path || "";
  if (!path || !isDesignDoc(path) || !existsSync(path)) process.exit(0);
  const repoRoot = findRepoRoot(dirname(path));
  if (!repoRoot) process.exit(0); // not a Backlog repo — nothing to reconcile into
  const rel = path.startsWith(repoRoot) ? path.slice(repoRoot.length + 1) : path;
  if (alreadyOnBoard(rel, repoRoot)) process.exit(0); // already reconciled — stay quiet
  emit(
    `A design/spec doc (${rel}) was written in a repo with a Backlog.md board, and no card references it yet. ` +
      `Before implementation planning (writing-plans), reconcile it into the board using the claude-superpowers ` +
      `'converting-a-design' skill — idempotent find-or-create of epics + task-cards linked to the design doc. ` +
      `See 'tracking-with-backlog' for the model. (Skip if this design isn't ready to break down yet.)`,
  );
  process.exit(0);
}

if (import.meta.main) main();
