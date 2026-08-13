# Backlog.md CLI Cheatsheet (v1.47.1)

## Pinned Backlog.md CLI facts (verified v1.47.1 during planning)

- Install: `bun add -g backlog.md` → binary at `~/.bun/bin/backlog`. Hooks/scripts must ensure `~/.bun/bin` is on `PATH` or resolve the binary explicitly.
- Init: `backlog init "<name>" --agent-instructions claude --integration-mode cli` → creates `backlog/config.yml` + `CLAUDE.md`.
- Config: `backlog/config.yml`; `statuses: ["To Do","In Progress","Done"]`; `default_status: "To Do"`; `task_prefix: "task"`. Presence of `backlog/config.yml` at repo root = "Backlog-enabled".
- Create epic: `backlog task create "<title>" -l epic --plain` → `task-N`.
- Create card: `backlog task create "<title>" -p <epicId> -l plan --ref "<planPath>" --ac "<criterion>" --plain` → `task-N.M` (dotted child ID).
- Dependencies: `--dep <id>` (comma-sep or repeated). **Strictly validated** — dep target must already exist.
- Status change: `backlog task edit <id> -s "In Progress"` (valid: `"To Do"`, `"In Progress"`, `"Done"`; case-insensitive).
- Read the board (agent-readable): `backlog task list --plain` (grouped by status), `backlog task list --parent <id> --plain`, `backlog task list --status "<s>" --plain`, `backlog task view <id> --plain`.
- Dependency order: `backlog sequence list --plain`.
- Web board: `backlog browser --port 6420 --no-open`.
- Raw task file: `backlog/tasks/task-N.M - <slug>.md` with YAML frontmatter: `id: TASK-N.M`, `title`, `status`, `labels`, `dependencies`, `references`, `parent_task_id`, `ordinal`.
- **Idempotent find-by-plan (search does NOT index `references:`):** `grep -rl "<planPath>" backlog/tasks/` then read `^id:` from the matched file. This is the canonical lookup for hook + linking skill.
