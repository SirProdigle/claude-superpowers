---
description: Wrap up a finished Beads epic — evidence-backed completion report, follow-up work filed as beads, learnings captured, then close the epic
argument-hint: <epic-id>
---

# Complete Epic

**Target epic:** $ARGUMENTS

An epic ends with three artifacts: a report that says what actually happened, follow-up work
that exists as tracked beads rather than good intentions, and captured learnings that change
how the next epic runs. Produce all three, then close the epic.

**The iron rule: every claim in the report comes from a command you ran in this session.**
Ticket counts, test results, file churn, dates — all of it. If you cannot produce the command
that yielded a number, the number does not go in the report. This is
`claude-superpowers:verification-before-completion` applied to retrospectives, and it is
the whole point. A retrospective written from memory is fiction with a table of contents.

**This command is often entered automatically**, straight from the end of an execution run —
`executing-plans` Step 3 and `orchestrating-execution` Step 8 both continue into it rather than
stopping to suggest it. That changes nothing about how it runs. The iron rule still holds: the
run that just finished is not evidence, and "the workflow said it was green" is a claim to
verify here, not a number to copy forward. Both approval checkpoints stay — arriving here
without being typed is not consent to write the report unread.

If `$ARGUMENTS` is empty, list candidate epics and ask which one:
```bash
bd list --type=epic --all
```

**If that returns "No issues found", do not conclude there are no epics.** Plenty of parents are
typed `feature` or `task` and are epics in everything but the type field. Fall back to listing
anything with children and offer those:

```bash
bd list --all
```

Any row with children beneath it is a candidate. Say which fallback you used, so the user knows
the list came from structure rather than the type field.

## Phase 0: Eligibility Gate

```bash
bd show $ARGUMENTS
```

Read the `CHILDREN` block and count the status glyph on each row yourself: `✓` closed,
`◐` in_progress, `○` open, `●` blocked, `❄` deferred.

Some `bd` versions print a completion summary line (`✓ 12/12 complete (100%) — eligible for
close`) and some print only the bare child rows. **Do not wait for that line or treat its absence
as a pass** — count the glyphs. If you find yourself reporting "eligible for close" without having
counted, you are reading a line that may not be there.

**FAILURE CONDITION — incomplete children.** If any child is not closed, STOP. Report:

```
Epic {epic-id} has {n} open children:
  {id}: {title} [{status}]

Options:
1. Close them first (I can show what each still needs)
2. Descope them out of this epic (bd update --parent to move, or drop the link)
3. Proceed anyway and document them as carried-forward (needs your explicit go-ahead)
```

Do not pick for them. Wait.

**FAILURE CONDITION — not an epic.** If the target is not type `epic`, ask whether they meant
a parent task, and confirm before treating it as one.

## Phase 1: Evidence Gathering

Run these. Keep the raw output — you will cite it.

**Scope and outcome:**
```bash
bd show $ARGUMENTS --json
bd children $ARGUMENTS
bd list --parent $ARGUMENTS --all --json
```
Capture per child: id, title, type, priority, status, close reason, created/closed dates.
Cycle time per child = closed − created. Epic cycle time = earliest create → latest close.

**What the code actually did:**
```bash
git log --oneline --all --grep '$ARGUMENTS' --date=short --pretty='%h %ad %s'
git diff --stat <first-commit>~1..<last-commit>
```
If commits don't reference bead ids, fall back to the epic's date window (`git log --since
--until`) and say so in the report — an inferred commit set is labelled as inferred.

**Whether it works:**
Run the project's real verification commands — read `package.json` scripts, `Makefile`, or
CLAUDE.md to find them. Typically test, typecheck, lint, build. Paste the actual result lines.

**FAILURE CONDITION — failing verification.** If tests fail at epic close, that is a finding,
not a footnote. Surface it before writing anything else and ask whether to file it as a
blocker bead and hold the epic open.

**Plans and specs:**
```bash
grep -rl '$ARGUMENTS' docs/superpowers/ 2>/dev/null
```
Read every superpowers plan file linked to this epic. Diff intent against outcome — what the
plan said versus what the commits show. That gap is the most useful thing in the whole report.

**Deferred and spawned work:**
```bash
bd list --all --json | jq '[.[] | select(.description | test("'"$ARGUMENTS"'"))]'
bd list --status=open --created-after <epic-start-date>
```
Anything created during the epic window that isn't a child of it is probably spawned work.

## Phase 2: The Report

Write to `docs/superpowers/retrospectives/YYYY-MM-DD-<epic-id>-<slug>.md`.

Sections, in order. Omit any section you have no evidence for — an empty section is worse
than an absent one, because it reads as "nothing happened here" rather than "not measured."

1. **Header** — epic id, title, dates, cycle time, one-sentence outcome.
2. **What shipped** — child beads as a table: id, title, type, cycle time. Group by theme,
   not by id order.
3. **Code delivered** — commit count, files changed, insertions/deletions, the packages or
   modules touched. Straight from `git diff --stat`.
4. **Verification state** — the actual command output. Test counts, coverage if the project
   measures it, typecheck/lint status. Green or red, stated plainly.
5. **Plan versus reality** — for each linked plan: what it specified, what got built, and
   where they diverged. Divergence is normal; unexamined divergence is the problem.
6. **Decisions made** — architectural calls taken during the epic that aren't written down
   anywhere else. Each one is a candidate for a `bd create --type decision` ADR bead; propose them.
7. **Debt and follow-ups** — see Phase 3. This section lists the beads you filed, with ids.
8. **What to do differently** — grounded in the evidence above. "Child 7 took 4× the median
   cycle time because the plan underspecified the data model" is useful. "Communication could
   be better" is not. If the evidence doesn't support a lesson, don't invent one.

Do not include story points, velocity, or burndown. Beads has priority and dependencies,
not points, and inventing an estimate to fill a table is exactly the fiction this command
exists to prevent.

**CHECKPOINT:** Present the report for review before writing the file. Wait for approval.

## Phase 3: Follow-ups Become Beads

Every piece of deferred work, known debt, or "we should really..." from the retrospective
becomes a real bead. Prose recommendations that live only in a report are lost work.

For each:
```bash
bd create "<title>" --type <task|bug|chore|decision> --priority <P1-P3> \
  --description "Surfaced by $ARGUMENTS retrospective. <context>"

# Record provenance — this work exists because of the epic:
bd link <new-id> $ARGUMENTS --type discovered-from

# Only if it has a real ordering constraint (arg order: id2 blocks id1):
bd link <new-id> <blocker-id>
```

Note the `bd link` argument order — `bd link A B` means **B blocks A**. Getting this
backwards silently inverts your dependency graph, and `bd ready` will hand out work that
isn't actually unblocked.

**CHECKPOINT:** Present the full list of proposed beads — title, type, priority, rationale —
and get approval before creating any of them. Batch the approval; do not ask per bead.

Then add their ids back into report section 7 so the report and the tracker agree.

### Where each follow-up goes

Two destinations, and the split matters:

- **Work with a real home** — a follow-up that belongs to a named epic, a known area, or blocks
  something already tracked — gets filed there, parented normally.
- **Chaff** — real but unowned. The thing worth doing that has no project to sit in: a fixture
  that should be better, a rename you noticed, a "we should really..." with no deadline. This
  goes to the repo's **standing misc epic**, one per repo, created once and reused forever.

```bash
# Find the standing epic:
bd list --all --json | jq -r '.[] | select(.title == "Backlog: unsorted follow-ups") | .id'

# If that returns nothing, create it once:
bd create "Backlog: unsorted follow-ups" --type epic --priority 3 \
  --description "Standing catch-all for out-of-scope work surfaced by completed runs. Not a
project — a bucket. Items graduate out of here into real epics when someone picks them up."

# Then file chaff under it, keeping provenance:
bd create "<title>" --type <task|bug|chore> --priority <P2-P4> \
  --parent <misc-epic-id> \
  --description "Surfaced by $ARGUMENTS retrospective. <context>"
bd link <new-id> $ARGUMENTS --type discovered-from
```

One bucket per repo, not one per epic — the point is a single place to look. The
`discovered-from` link is what carries provenance once the item outlives the run that found it.

Ask which items are chaff rather than sorting them yourself; the user knows what they intend to
come back to. Presenting the split as part of the Phase 3 checkpoint is enough — this is not a
second approval round.

## Phase 4: Capture Learnings

This is what the epic buys you beyond the code. Three destinations:

- **A repeated correction the user made** → belongs in CLAUDE.md. Propose the exact wording.
- **A procedure that worked and will recur** → candidate skill.
  **REQUIRED SUB-SKILL:** use `claude-superpowers:writing-skills` to author it. Do not
  hand-roll a SKILL.md.
- **A durable fact about this project** that isn't derivable from the code → a `decision` bead.

Propose each with its destination. Do not write to CLAUDE.md or create skills without approval.

If nothing meets the bar, say "no durable learnings from this epic" and move on. A forced
lesson is noise, and noise in CLAUDE.md costs every future session.

## Phase 5: Close

Only after the report file is written and follow-up beads exist:

```bash
bd close $ARGUMENTS --reason "Completed. Retrospective: docs/superpowers/retrospectives/<file>"
```

Then confirm:
```bash
bd show $ARGUMENTS
git status --short
```

Report back: epic id and title, report path, follow-up bead ids, any learnings captured,
and — explicitly — anything you could not verify. Name the gaps.

## Anti-Patterns

| Don't | Do |
|---|---|
| Fill the template from conversation memory | Run the command, cite the output |
| "Test coverage improved significantly" | "Coverage 61% → 78% per `bun test --coverage`" |
| Recommend follow-up work in prose | `bd create` it, cite the id |
| Write all 8 sections regardless of evidence | Omit sections you cannot support |
| Close the epic first, report after | Report and beads first, close last |
| Invent lessons to fill the section | "No durable learnings" is a valid finding |
| Bury failing tests in a footnote | Surface immediately, offer to hold the epic open |
