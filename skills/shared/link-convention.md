# Link Convention

- Epic: `backlog task create "<epic title>" -l epic --plain` → `task-N`.
- Card: `backlog task create "<feature>" -p task-N -l plan --ref "docs/superpowers/plans/<file>.md" --plain` → `task-N.M`.
- Reciprocal: add a `Backlog: task-N.M` line to the plan file header (and its spec).
- Find card by plan path (idempotent): `grep -rl "docs/superpowers/plans/<file>.md" backlog/tasks/` → read `^id:` from the match.
- Never mirror a plan's individual `- [ ]` steps as cards.

See `skills/shared/backlog-cli-cheatsheet.md` for the full CLI facts (single source of truth).
