---
name: adopting-backlog
description: Use when a repo should start using the tracker — there is no `backlog/config.yml` yet, or a hand-rolled TODO/BACKLOG file exists that should become the board. Initializes Backlog.md, installs the hook + CLAUDE snippet, and migrates an existing hand-rolled board with verified zero data loss.
---

# Adopting Backlog

Onboard a repo onto the tracker: initialize Backlog.md, install the sync hook and per-repo CLAUDE snippet, and — if a hand-rolled board already exists — migrate it into the board with a **verified parity check** and **archive-not-delete** safety so no work item is ever lost.

Cite `skills/shared/backlog-cli-cheatsheet.md` for the full CLI facts (single source of truth — do not restate them here) and `skills/shared/link-convention.md` for the epic/card ID scheme and labels.

## Procedure

```markdown
1. Init: `backlog init "<Project>" --agent-instructions claude --integration-mode cli`.
2. Count source items (if a hand-rolled board exists): `grep -cE '^\s*- \[[ x]\]' BACKLOG.md`.
3. For each `##` heading → create an epic (`-l epic`). For each `- [ ]` item under it → create a child card (`-p <epicId> -l plan`), mapping trailing status tags to labels (🟡→partial, 🧊→deferred, ❓→decision, ⛔→blocked); ticked items → create then `backlog task edit <id> -s Done`.
4. ASSERT parity: `backlog task list --plain | grep -cE 'task-[0-9]+\.'` (child count) ≥ source item count. Report both numbers.
5. Archive, never delete: `git mv BACKLOG.md BACKLOG.archived.md` (add a one-line pointer to the board at its top).
6. Drop the CLAUDE snippet (templates/CLAUDE-snippet.md) into the repo CLAUDE.md.
7. If the repo has a formatter/linter pre-commit hook (prettier, eslint, lefthook, husky, pre-commit), add `backlog/` to its ignore file(s) — `.prettierignore`, `.eslintignore`, etc. Backlog generates task FILENAMES from card titles, which often contain backticks/quotes; tools that shell out over staged filenames (e.g. `prettier --write {staged_files}`) break on them. Ignoring `backlog/` fixes it (the files are CLI-managed and shouldn't be formatted anyway).
```

> **Fresh board + an approved design doc?** After init, populate it with the `converting-a-design` skill (epics + task-cards from the design), rather than by hand.

## Installing the hook + snippet

- **Hook:** this plugin ships `hooks/hooks.json`, which the plugin auto-loads — point the user/agent at it; nothing needs to be hand-registered per repo. The `sync-backlog-status` hook keeps card status derived from plan-file checkbox state automatically (and rolls parent epics up to Done when all children are Done). A companion `remind-backlog-reconcile` hook nudges you to convert a design doc into the board before implementation planning.
- **CLAUDE snippet:** drop `templates/CLAUDE-snippet.md` into the repo's `CLAUDE.md` so every future session runs `backlog task list --plain` at start and consults the `tracking-with-backlog` skill.

## Rules

- **Parity assertion is mandatory (data-loss safety).** After migrating, the created child-card count MUST be ≥ the number of source `- [ ]` items. Report both numbers explicitly. If the count falls short, STOP and reconcile — do not proceed to archiving.
- **Archive, never delete.** Move the source board with `git mv BACKLOG.md BACKLOG.archived.md` and add a one-line pointer to the new board at its top. Never `rm` the source; the archived file is the audit trail proving zero data loss.
- **Migrate structure faithfully:** `##` headings become epics, `- [ ]` items become child plan-cards, and trailing emoji/status tags become labels (🟡→partial, 🧊→deferred, ❓→decision, ⛔→blocked). Ticked `- [x]` items are created and then set to `Done`.
- **Never hand-edit `backlog/tasks/*`** — always go through the `backlog` CLI. Card status is kept in sync automatically by the sync-backlog-status hook.
- **Guard the commit hooks (backtick filenames).** Repos with a formatter/linter pre-commit hook that operates on staged filenames can choke on Backlog's task files, whose names are derived from card titles and often contain backticks or quotes (e.g. `` task-1.1 - Six-layer `Wrestler` model.md ``). Add `backlog/` to the relevant ignore file (`.prettierignore`, `.eslintignore`, …) during onboarding so board commits pass without `--no-verify`. If a board commit ever needs `--no-verify`, that ignore is missing.
