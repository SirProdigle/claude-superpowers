# Closing Out the Tracker

Shared procedure for the end of a plan execution, referenced by
`skills/executing-plans/SKILL.md` and `skills/orchestrating-execution/SKILL.md`.

Execution knows which tasks finished and whether they went green. That knowledge is at its
sharpest the moment the run ends and decays from there — nobody reconstructs it later without
reading git archaeology. Spend it here, while it is free.

**The tracker is not a side effect of the work. Leaving it stale is leaving the job half done.**

## Precondition: green is not the same as finished

A run that *ended* is not a run that *passed*. Close nothing until you have established which
it was:

- Orchestrated runs: `greenAfterImpl` / `greenAfterRefactor` from the workflow summary. `false`
  means the loop exhausted its rounds. `null` means the verifier returned nothing and the state
  was never established — that is **unknown, not green**.
- In-session runs: the task's own `verifyCommand` and `acceptanceCriteria`, actually executed,
  with output you can quote.

Anything not proven green stays `in_progress` so a resume can pick it up. Say so explicitly in
what you report — a bead left open on purpose looks identical to one left open by neglect
unless you name it.

## Step 1: Close what passed

Close from the coordinator, never from inside a subagent. Agents close on optimism, mid-run,
before review and tests have spoken.

```bash
bd close <id> --reason "<what proves it: the gate that passed, the output you saw>"
```

When you are not certain a bead is still in the state you left it in, guard the transition:

```bash
bd update <id> --if-status in_progress --status closed
```

That writes nothing and exits **13** on a mismatch, so it cannot double-apply.

Give a real reason. "Done" is not a reason; "build clean, 14/14 unit tests pass, integration
suite green" is. The reason is what a retrospective quotes six weeks from now.

## Step 2: Sync the other trackers

Beads is rarely the only place status lives. Update every tracker the run touched, or the next
session inherits a set that disagree with each other:

- `<plan>.md.tasks.json` — set each finished task's `"status"` to `"completed"` and refresh
  `"lastUpdated"`. This file survives compaction and is what a cross-session resume reads.
- Native tasks, if the run used them.

A plan file that still says `"pending"` for work that shipped is the same defect as an open
bead, and it is easier to miss because nothing prompts you to look at it.

## Step 3: The chaff sweep

Every run turns up work that is real but out of scope — the thing you noticed and deliberately
did not do. Said out loud at the end of a run it evaporates; written down it becomes a backlog.

Collect the candidates first. They come from: deferred items the run logged, review findings
accepted as "not now", TODOs written into the diff, and anything you caught yourself saying
"we should really..." about.

Then **ask** — do not file silently, and do not skip the ask because the list is short:

```
This run turned up N things I didn't do:

  1. <title> — <one line: why it came up, why it was out of scope>
  2. ...

File any of these to the misc backlog? (all / none / pick numbers)
```

For each one the user accepts, file it under the repo's standing misc epic:

```bash
# Find the standing epic; create it once, then reuse it forever.
bd list --all --json | jq -r '.[] | select(.title == "Backlog: unsorted follow-ups") | .id'

# If that returns nothing:
bd create "Backlog: unsorted follow-ups" --type epic --priority 3 \
  --description "Standing catch-all for out-of-scope work surfaced by completed runs. Not a
project — a bucket. Items graduate out of here into real epics when someone picks them up."

# Then, per accepted item:
bd create "<title>" --type <task|bug|chore> --priority <P2-P4> \
  --parent <misc-epic-id> \
  --description "Surfaced by <epic-or-plan-id>. <context: what was seen, why it was deferred>"
bd link <new-id> <source-epic-id> --type discovered-from
```

The `discovered-from` link is what keeps provenance after the item leaves the run that found
it. One standing bucket per repo, not one per epic — the point is a single place to look.

Note the `bd link` argument order: `bd link A B` means **B blocks A**. Backwards silently
inverts the dependency graph and `bd ready` starts handing out work that is not unblocked.

## Step 4: Hand off

**Tracked runs (there is an epic):** continue into `/complete-epic <epic-id>`. That command
owns evidence gathering, the retrospective, follow-up filing and epic closure — do not
duplicate any of it here. Its two approval checkpoints stay: the user sees the report before
it is written and approves the follow-up beads before they exist. Automatic means "you did not
have to type the command", not "the report went in unread".

Its Phase 0 gate should now pass cleanly, because Step 1 already closed the children. If it
still reports open children, that is a real signal — something did not go green and you left it
open on purpose, or the close in Step 1 silently failed. Investigate; do not wave it through.

**Untracked runs (no epic):** there is nothing to complete. Report the outcome, name the plan
document, and stop.

## Anti-Patterns

| Anti-pattern | Reality |
|---|---|
| Leaving beads open "so the user can review" | The user reviews the report, not the tracker. An open bead means unfinished work, and now nobody can tell which kind you meant. |
| Closing everything because the run reached the end | Reaching the end is not passing. `greenAfterImpl: null` is unknown, and unknown is not green. |
| Letting subagents close their own beads | They close mid-run on optimism, before review and tests have spoken. The coordinator holds the only close. |
| Closing with `--reason "done"` | The reason is the evidence a retrospective quotes later. Name the gate and its output. |
| Updating beads but not `.tasks.json` | Two trackers that disagree, and the one that survives compaction is the stale one. |
| Filing chaff without asking | The user's backlog is theirs. Unrequested beads are noise with a tracking number. |
| Skipping the chaff sweep because nothing "big" came up | Chaff is by definition small. That is why it needs writing down — it will not be remembered. |
| A misc epic per source epic | Scatters the backlog across buckets nobody enumerates. One standing epic per repo; `discovered-from` carries the provenance. |
| Writing your own completion report here | `/complete-epic` owns that, with evidence. Two accounts of the same run will disagree. |
