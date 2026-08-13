---
name: converting-a-design
description: Use when a design doc or spec has just been approved (brainstorming done) and you are about to plan or build it — to convert & reconcile it into the Backlog.md board as epics + task-cards before writing implementation plans. Also when a repo has a design doc (GAME-DESIGN.md, docs/superpowers/specs/*) whose work isn't on the board yet.
---

# Converting a Design into a Task-Board

At the seam **after** a design/spec is approved and **before** implementation planning, break the design into the board so the work is tracked from the start. This is the `brainstorm → **board** → plan → code` step that is easy to skip.

Cite `skills/shared/backlog-cli-cheatsheet.md` for CLI facts and `skills/shared/link-convention.md` for IDs/labels. Do not restate CLI facts here.

## Two granularities (pick one)

- **Task-board (this skill):** epics (`task-N`) + **fine task-cards** (`task-N.M`) that reference the **design doc** (`--ref docs/GAME-DESIGN.md`), each with acceptance criteria, phase/domain labels, and dependencies. Use when the design warrants an upfront work-breakdown.
- **Roadmap (`planning-an-epic`):** epic + one card **per future plan file**. Use when you only want a roadmap of plans to brainstorm later.

Both are valid; see `tracking-with-backlog` for the model and how each stays in sync.

## Procedure

1. **Reconcile first — never blind-create.** `grep -rl "<designDocPath>" backlog/tasks/` (search does not index `references:`). If cards exist, you are *updating*: list them (`backlog task list --plain`), diff against the design, and add only what's missing. If none, this is a fresh conversion. **Re-running this skill must never duplicate cards.**
2. **Identify epics** — one per major system/phase of the design.
3. **Create each epic** (`-l epic`), then its **task-cards** under it (`-p <epicId> -l plan,<phase>,<domain> --ref "<designDocPath>" --ac "..." --dep <prereqId>`). Dependencies are strictly validated — **create prerequisites first** (topological order).
4. **Verify:** `backlog task list --parent <epicId> --plain` and `backlog sequence list --plain` (proves the graph is acyclic).

## Large designs — fan out

For a big design (many epics × many tasks), decompose with a workflow instead of by hand: one agent per epic drafts its tasks (slug `<epic>.<name>`, within-epic deps, ACs, design-section refs); an integration pass wires cross-epic deps and flags duplicates; then **materialize deterministically in topological order** (a dep target must already exist before `--dep` references it). Keep the epic skeleton author-defined so coverage is complete.

## Completion path (how cards reach Done)

- A task-card is Done when its work lands: either the plan that implements it links back with a `Backlog: task-N.M` header (the `sync-backlog-status` hook flips the card **and rolls the epic to Done** when all children are Done), or you set it directly: `backlog task edit <id> -s Done`.
- One plan may implement several task-cards — list multiple `Backlog:` header lines; the hook syncs them all.

## Rules

- **Idempotent reconcile: the `grep -rl` check ALWAYS comes first.** Never create a card without confirming it doesn't already exist.
- **Never hand-edit `backlog/tasks/*`** — use the `backlog` CLI only.
- **Cards reference the design doc** (`--ref`), and cite the section in the description (e.g. "Implements §4.2").
- Keep cards at **concrete, buildable** granularity — a schema, a system, a component — not vague themes.
