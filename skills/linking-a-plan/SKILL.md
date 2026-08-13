---
name: linking-a-plan
description: Use right after a superpowers spec or plan file is written under docs/superpowers/ — to find-or-create the Backlog.md card for that feature and wire the bidirectional link (card `references:` ⇄ plan `Backlog: <id>` header) idempotently. Fires at the spec-write and plan-write seams of the superpowers flow.
---

# Linking a Plan

At the spec-write and plan-write seams of the superpowers flow, connect the plan/spec file to its Backlog.md card so the board stays the epic layer over the plan detail. This skill is **find-or-create + bidirectional link + deps**, done idempotently so re-running it never creates a duplicate card.

Cite `skills/shared/link-convention.md` for the epic/card ID scheme and the idempotency rule; cite `skills/shared/backlog-cli-cheatsheet.md` for the full CLI facts (single source of truth). Do not restate CLI facts here.

## Procedure

1. Look for an existing card (idempotent):
   `grep -rl "docs/superpowers/plans/<file>.md" backlog/tasks/` → if a file matches, read its `id:` and STOP (already linked).
2. If none, create it under the right epic:
   `backlog task create "<feature>" -p <epicId> -l plan --ref "docs/superpowers/plans/<file>.md" --plain`
3. Write the reciprocal link: add `Backlog: <id>` to the plan file header (below the title), and to the matching spec.
4. Set ordering if this plan depends on a sibling: `backlog task edit <id> --dep <siblingId>`.
5. Reconcile: `backlog task view <id> --plain` must list the reference; the plan header must contain `Backlog: <id>`.

## Rules

- The idempotent `grep -rl` lookup ALWAYS comes first — search does not index `references:`, so this grep is the canonical find-by-plan lookup. Never blindly create a card without it.
- Always write BOTH directions of the link: the card's `--ref "<planPath>"` AND the plan/spec header's `Backlog: <id>` line. A one-sided link is a broken link.
- Never mirror the plan's individual `- [ ]` checkbox steps as cards — the board tracks epics and plans, the plan file holds the step detail. Card status is derived from checkbox state automatically by the sync-backlog-status hook.
- Deps are strictly validated: the dependency target must already exist before you reference it with `--dep`.
