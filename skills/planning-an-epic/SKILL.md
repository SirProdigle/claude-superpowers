---
name: planning-an-epic
description: Use when brainstorming reveals that a piece of work spans more than one superpowers plan — decompose it into a Backlog.md epic (task-N) plus one child plan-card (task-N.M) per plan, wired with dependencies. Fires at the moment you realize "this is bigger than a single plan".
---

# Planning an Epic

When brainstorming reveals work that spans **more than one superpowers plan**, model it as a Backlog.md **epic** with one **child plan-card per plan**. The epic is the roadmap; each card is a placeholder for a plan that will be brainstormed and written later.

> To break an **approved design doc** into a finer work-breakdown of **task-cards** (referencing the design doc) rather than plan-cards, use the `converting-a-design` skill instead.

Cite `skills/shared/link-convention.md` for the epic/card ID scheme and labels. Do **not** restate CLI facts — see `skills/shared/backlog-cli-cheatsheet.md`.

## The command sequence

1. **Create the epic** with the `epic` label:
   `backlog task create "<epic title>" -l epic --plain` → `task-N`
2. **Create each child plan-card** under the epic (`-p <epicId> -l plan`), recording the *intended* plan path in `--ref` even before the plan file exists, plus an acceptance criterion:
   `backlog task create "<feature>" -p <epicId> -l plan --ref "<planPath>" --ac "<criterion>" --plain` → `task-N.M`
3. **Add dependencies** with `--dep <id>`. Dependencies are **strictly validated** — the dep target must already exist, so **create prerequisites first** (order matters).

## Worked example

```markdown
1. Create the epic:
   `backlog task create "Elysia Migration" -l epic --plain`   # → task-3
2. Create each plan-card (order matters for deps — prerequisites first):
   `backlog task create "Port shared contracts" -p task-3 -l plan --ref "docs/superpowers/plans/2026-06-16-contracts.md" --ac "TypeBox parity" --plain`   # → task-3.1
   `backlog task create "Port auth worker" -p task-3 -l plan --ref "docs/superpowers/plans/2026-06-17-auth.md" --dep task-3.1 --plain`   # → task-3.2
3. Confirm the shape: `backlog task list --parent task-3 --plain` and `backlog sequence list --plain`.
```

## Rules

- **Leave child cards in `To Do`.** There is no plan file yet, so the card stays at the default `To Do` status. The sync-backlog-status hook moves it to `In Progress`/`Done` once a plan file exists and its checkboxes change.
- **Record the intended plan path in `--ref` now**, even before the plan file exists — this is the link the hook and `linking-a-plan` grep for later.
- **Do not write plan files here.** Each card gets its plan through the normal superpowers `brainstorming` → `writing-plans` flow, one plan per card.
- **Never mirror a plan's individual `- [ ]` steps as cards** — the plan file holds that detail; the board is the epic layer.
