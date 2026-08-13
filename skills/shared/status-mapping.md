# Status Mapping

| Plan/spec state | Card status |
|---|---|
| Spec approved, no plan file yet | To Do |
| Plan file exists, ≥1 unchecked `- [ ]` remains | In Progress |
| Plan file exists, all steps `- [x]` | Done |
| Epic (parent) — all child cards Done | Done |

Checkbox detection: a step line matching `^\s*- \[ \]` is unchecked; `^\s*- \[x\]` (any case) is checked. A plan with zero checkbox lines but present on disk counts as In Progress (work started, no steps yet).
