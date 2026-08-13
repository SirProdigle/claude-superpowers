# Backlog.md config alignment

Notes for a repo adopting the tracker. Keep the board's vocabulary aligned with
the plugin so the `sync-backlog-status` hook and the skills behave predictably.

## Recommended labels

Backlog.md labels are free-form; the tracker relies on this small, fixed set.
Apply them with `-l <label>` on `backlog task create` (or `backlog task edit <id> -l <label>`).

| Label | Meaning | Source signal |
|---|---|---|
| `epic` | Parent card — the epic layer above superpowers plans (`task-N`). | Created for each `##` heading. |
| `plan` | Child card linked to one superpowers plan file (`task-N.M`) via `references:`. | Created for each planned item. |
| `partial` | Work started but intentionally left incomplete. | 🟡 status tag |
| `deferred` | Consciously postponed / on ice. | 🧊 status tag |
| `decision` | Open question — needs a decision before proceeding. | ❓ status tag |
| `blocked` | Cannot proceed; waiting on an external dependency. | ⛔ status tag |

`epic` and `plan` are structural (see `skills/shared/link-convention.md`).
`partial`, `deferred`, `decision`, and `blocked` are the status tags migrated
from a hand-rolled board by the `adopting-backlog` skill.

## Statuses stay the Backlog defaults

Do NOT add or rename statuses. The tracker uses only the three built-in
Backlog.md statuses:

- `To Do`
- `In Progress`
- `Done`

Card status is derived from the linked plan file and applied automatically by the
`sync-backlog-status` hook — see `skills/shared/status-mapping.md` for the exact
plan-state → status rules. Never hand-edit status in `backlog/tasks/`; use the
`backlog` CLI (see `skills/shared/backlog-cli-cheatsheet.md`).
