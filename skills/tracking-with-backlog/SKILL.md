---
name: tracking-with-backlog
description: Use whenever working in a repo that has a backlog/config.yml (Backlog.md board) — to see the current tasks, epics, dependencies and how superpowers plans map to cards, and to keep the board in sync as work progresses. The board is the epic layer above superpowers plans.
---

# Tracking with Backlog.md

This repo has a Backlog.md board (`backlog/config.yml` at its root). The board is the **epic layer** that sits above superpowers `brainstorm → plan → code`. It answers "what big pieces of work exist, in what order?" — while the superpowers plan files hold the step-by-step detail.

## The model

- **Epic** = a Backlog parent task `task-N`, label `epic`. One epic per multi-plan initiative.
- **Card** = a Backlog child task `task-N.M`, created with `-p <epicId>`. Two flavours:
  - **plan-card** (label `plan`) — one card per superpowers plan file (`--ref "<planPath>"`); the roadmap flavour.
  - **task-card** — one card per concrete build unit, referencing the **design doc** (`--ref "<designDocPath>"`); the work-breakdown flavour. Produced by the `converting-a-design` skill for designs that warrant an upfront breakdown.
- A plan-card links to its plan via `references:` and the plan links back with a reciprocal `Backlog: <id>` header line. A single plan may implement **several** task-cards — list multiple `Backlog: <id>` lines and the hook syncs them all, then **rolls the epic up to Done** once every child is Done.
- Full ID scheme, labels, `--ref`, the reciprocal header line, and the grep-idempotency lookup are defined in `skills/shared/link-convention.md`. Card status derivation is defined in `skills/shared/status-mapping.md`. All CLI commands come from `skills/shared/backlog-cli-cheatsheet.md` — treat that cheatsheet as the single source of truth and cite it rather than restating CLI facts.

## Golden rules

1. **The board is the epic layer.** Keep it at epic/plan granularity — epics and their plan-cards, nothing finer.
2. **Plan files hold the detail.** The individual `- [ ]` steps live in the superpowers plan file, not on the board.
3. **Never mirror checkbox steps as cards.** Don't double-track — a plan's individual `- [ ]` steps are never created as their own Backlog tasks.
4. **Never hand-edit task files.** Files under `backlog/tasks/` are managed by the `backlog` CLI only — use it for every create/edit. Card status is kept in sync automatically by the sync-backlog-status hook.

## How to read the board

- `backlog task list --plain` — the whole board, grouped by status. Start here.
- `backlog task view <id> --plain` — one task's full detail (title, status, labels, dependencies, references, acceptance criteria).
- `backlog task list --parent <id> --plain` — the child plan-cards under one epic.
- `backlog sequence list --plain` — the dependency ordering (what must come before what).
- `backlog instructions overview` — the repo's own agent instructions for the board.

## When you touch it

- **Converting an approved design doc / spec into the board?** Defer to the `converting-a-design` skill (epics + task-cards, reconciled idempotently). This is the `brainstorm → board → plan` seam.
- **Creating an epic + its plan-cards (a roadmap of future plans)?** Defer to the `planning-an-epic` skill.
- **Just wrote a spec or plan file and need it on the board?** Defer to the `linking-a-plan` skill.
- **Changing card status?** You almost never do this by hand — the sync-backlog-status hook derives status from the plan's checkbox state on every write and rolls parent epics up to Done when all children are Done (see `skills/shared/status-mapping.md`). Initial `To Do` is set at card-creation time. For a task-card finished without a plan file, set it directly: `backlog task edit <id> -s Done`.
