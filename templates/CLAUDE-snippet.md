## Project board (Backlog.md)

This repo tracks work on a Backlog.md board — the **epic layer** above superpowers plans.
- At session start, run `backlog task list --plain` to see current work; `backlog sequence list --plain` for order.
- Epics are `task-N` (label `epic`); child cards are `task-N.M` — either a **plan-card** (one per superpowers plan) or a **task-card** (a concrete build unit referencing the design doc).
- After a design/spec is approved and **before** writing implementation plans, reconcile it into the board with the `converting-a-design` skill.
- Consult the `tracking-with-backlog` skill for the model and rules.
- NEVER hand-edit files under `backlog/tasks/` — use the `backlog` CLI. Card status is kept in sync automatically by the sync-backlog-status hook (which also rolls parent epics up to Done when all children are Done).
