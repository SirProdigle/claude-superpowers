# Orchestrated Execution — Design

**Status:** approved
**Date:** 2026-08-13

A third execution option at the plan handoff, alongside Subagent-Driven and Parallel Session.
Orchestrated runs an implementation plan through a fixed, versioned Workflow-tool script:
bundled sequential implementation, layered review, routed fixes, refactor, and a bounded test
loop — with Beads as the durable tracker throughout.

## Motivation

Two things drive this.

**The pipeline already exists and works.** `epic-pipeline` (138 lines) has been running in
chimera-ant, including an authorised overnight autonomous build across a dozen epics. Its shape —
sequential task implementation with commits, batched reviews plus a whole-epic review, fixes,
refactor, test loop — is proven. It is also bespoke: authored per-session, unversioned, untested,
and re-derived by hand each time. This design generalises it into the plugin.

**The subagent path cannot express it.** `subagent-driven-development` dispatches one implementer
per task with a two-stage review, and the coordinator carries the whole run in its own context.
There is no way to say "these four tasks are one unit of work", no whole-epic review layer, and no
refactor phase.

## The finding that shapes the architecture

**`PreToolUse:Agent` hooks do not fire for Workflow `agent()` spawns.** Measured 2026-08-13:

| Time | Event | Trace |
|---|---|---|
| 01:28:04Z | `model-routing.json` armed at user level | — |
| ~01:28:10Z | workflow `agent()` dispatch (sonnet) | **nothing** |
| 01:29:05Z | control `TaskCreate` | `pre-taskcreate-tier` ✓ `pre-taskcreate-commit-strategy` ✓ |

The control rules out the confounds: hooks were live (two fired), routing was genuinely armed
(`pre-taskcreate-tier` skipped with `no-metadata-fence`, not `no-routing-file`), and the hook
traces even when it no-ops — 83 historical `pre-routing` entries, mostly skips. Absence of a trace
means the hook never ran.

Consequence: of the four enforcement layers in `docs/model-routing-flow.md`, the **dispatch gate is
blind inside a workflow**. The session notice, the plan gate and the handoff guard still work.

Therefore **the script is the enforcement**. `orchestrate.js` resolves `tier → model` itself for
every dispatch, refuses to start if any bundle lacks a tier, and `log()`s every dispatch's tier and
resolved model as the audit trail no hook will produce. This mirrors the plugin's recurring lesson
("skill prose is not enforcement; this hook is") one level down: here, the script is.

## Architecture

```
writing-plans          TaskCreate  →  <plan>.tasks.json  { files[], modelTier, blockedBy }
                       (pre-taskcreate-model-tier fires here — unchanged)
        ↓  user picks "Orchestrated — Simple" or "Orchestrated — Full"
orchestrating-execution
    1. bd present?  no → offer `bd init` / continue untracked / cancel
    2. scripts/bundle-plan.mjs <plan>.tasks.json → <plan>.bundles.json   (committed, reviewable)
    3. bd create epic + one child per task, external_ref → plan path
    4. read manifest + model-routing.json, pass parsed objects via `args`
        ↓
scripts/orchestrate.js    Implement → Review → Fixes → Test → Refactor → Test
        ↓
orchestrating-execution   closes beads, suggests /complete-epic
```

### Why a fixed script plus a generated manifest

The script is versioned with the plugin, so a routing bug is fixed once rather than recurring in
every hand-authored run, and it is testable. The manifest is a committed artifact the user can read
and diff *before* launching, which is where bundling mistakes are cheap to catch.

Workflow scripts have **no filesystem access**, so the script cannot read the manifest itself. The
coordinator reads it and passes the parsed object through `args`. The file remains the durable,
inspectable artifact; it is simply not the script's input channel.

### Why the bundler is a script, not skill prose

Partitioning is set arithmetic over `modelTier`, `files[]` and `blockedBy`. A model doing it by eye
is inconsistent, and the failure mode is silent. `bundle-plan.mjs` is deterministic, unit-testable
with fixtures, and produces precise errors ("merging on coupling produced a 9-task bundle spanning
40 files; restructure so `src/index.ts` is touched by one task"). The model keeps the judgment work:
dispatch prompts, review adjudication, refactor planning.

`bun` is already a plugin dependency (the PostToolUse hooks are `.ts`), so this adds no new runtime.

## Bundling

Input `<plan>.tasks.json`, output `<plan>.bundles.json`.

1. **Partition by `modelTier`.** Never merge across tiers — a bundle containing one `frontier` task
   forces the whole bundle to frontier, so bundling by similarity alone would pay frontier prices
   for mechanical work. Tier partitioning makes a bundle's tier trivially the shared tier of its
   members rather than an upgrade.
2. **Merge within a tier on coupling signals:** overlapping `files[]`, a direct `blockedBy` edge, or
   both tasks being small. File overlap is a *coupling hint*, not a safety constraint — implementation
   is sequential, so concurrent writers are not a risk.
3. **Order bundles** by the `blockedBy` graph.
4. **Reject** any bundle over the size cap, or any task missing `modelTier`.

The size cap defaults to **5 tasks or 15 distinct files**, whichever binds first, overridable via
`--max-tasks` / `--max-files`. The numbers are a smell test, not a hard truth: a bundle past either
threshold usually means several tasks share a file that ought to be touched once, which is a plan
problem the bundler should surface rather than absorb.

A representative 10-task plan (7 `standard`, 3 `mechanical`) yields roughly 4 bundles, matching the
hand-tuned batching already recorded in `task-batching-user-2026-08-12`.

## Pipelines

```
SIMPLE
  1. Implement    sequential bundles, notes chained     model = bundle tier
  2. Review & Fix one agent reviews AND fixes           standard
  3. Test         run → fix loop, max 2 rounds     mechanical / standard → frontier

FULL
  1. Implement    sequential bundles, notes chained     model = bundle tier
  2. Review       per-bundle reviews (parallel)         mechanical
                + whole-epic review                     frontier
  3. Fixes        routed by owning bundle, sequential   standard
                + one cross-cutting pass                standard
  4. Test         run → fix loop, max 2 rounds     mechanical / standard → frontier
  5. Refactor     plan                                  frontier
                  execute                               standard
  6. Test         run → fix loop, max 2 rounds     mechanical / standard → frontier
```

**Implementation is sequential and notes are chained.** Each implementer receives short summaries
from every prior bundle — "anything later bundles must know". This is the mechanism that keeps
conventions and invariants consistent across a plan, and it is why implementation is not
parallelised. Bundling still delivers the token saving (4 agents rather than 10); only wall-clock
parallelism is given up. Sequential implementation also removes any need for a disjoint-files
constraint, and with it the failure mode where a shared barrel file collapses a plan into one
oversized bundle.

**Full keeps both review layers.** Cheap per-bundle reviews catch local defects; the whole-epic
review catches what per-task review structurally cannot — cross-bundle integration, architecture
drift, determinism across a whole tick, duplicated logic between systems. Findings from both merge
into one pool before routing.

**Fixes are routed but sequential.** Routing scopes context: a fixer handling three findings for its
own bundle reasons better than one holding twenty-five across the epic. Sequential because, without
a disjointness guarantee, parallel fixers could write the same file. Findings that span bundles or
belong to none collect into a single final pass, so cross-cutting issues are handled exactly once
rather than duplicated or dropped.

**Test precedes refactor.** Refactoring against unverified code, with a single test run afterwards,
cannot distinguish an implementation bug from a refactor bug. Two mechanical-tier test runs cost far
less than that ambiguity. (`epic-pipeline` refactors before its only test run; this corrects it.)

**The test loop** runs the suite at mechanical tier reporting `{pass, summary}` under an explicit
"do not fix anything" instruction, then fixes at standard tier. Round two escalates the fixer one
tier. Still red after that: stop, leave the branch intact, report failing tests and both fix diffs.
Escalation raises the tier, never the effort — raising effort on a routed-down model does not
recover capability.

### Model routing

Tiers, never model names, in the script. `docs/superpowers/model-routing.json` maps
`mechanical | standard | frontier` to concrete models; the project mapping is
`sonnet | opus | fable`, matching the rule recorded in `model-mix-rule-user-2026-08-12-sonnet`:
sonnet for rote work and checks, opus for the bulk of coding, fable for design and thinking-heavy
work. Per-bundle review at mechanical tier is consistent with that rule, which names "lint-style
reviews" as sonnet work.

## Beads integration

At handoff, `.tasks.json` maps directly onto beads:

```bash
bd create "<plan title>" -t epic -p 1 --external-ref <planPath>
bd create "<task subject>" --parent <EPIC> -t task -p <n> \
   -d "<Goal + Files + Steps>" --acceptance "<AC block>" --external-ref <planPath>
```

`blockedBy` replays as `bd link <blocked> <blocker>` (argument order: `bd link A B` means **B blocks
A**). Bundles are never modelled in beads — the bundle→bead relationship lives only in the manifest.

A bundle claims its members with `bd update <id> --claim`, which is atomic and idempotent. Re-runs
are safe: `--if-status` writes nothing and exits 13 on mismatch, so a resumed workflow cannot
double-apply transitions.

**Agents never close beads.** The CTX rule "Do NOT run bd close" is preserved verbatim; only the
coordinator transitions to closed. On completion the coordinator reports the epic id and suggests
`/complete-epic`, which already owns evidence-gathering, follow-up filing and the retrospective.

Native tasks remain the plan-time artifact so `pre-taskcreate-model-tier` still enforces that every
task carries a tier, and so `.tasks.json` remains the bundler's input. They are ephemeral execution
scaffolding; beads is the durable record. The port is one-way and happens once, at handoff.
chimera-ant's CLAUDE.md rule ("do NOT use TaskCreate") needs a carve-out permitting native tasks as
superpowers plan scaffolding.

Where beads is absent, the handoff offers `bd init`, continuing untracked, or cancelling.

## Changes to existing files

| File | Change |
|---|---|
| `skills/writing-plans/SKILL.md` | Two new options in the HARD-GATE `AskUserQuestion`; routing branch for each |
| `hooks/pre-askuser-handoff-guard` | Add `orchestrating-execution` to the disarm list; correct the "exactly two options" teach message |
| `tests/claude-code/test-handoff-guard.sh` | Four-option menu case; new disarm-signal case |

The handoff menu becomes flat rather than a three-option menu plus a follow-up prompt — one
decision, no second question, and it passes the guard unmodified because both required labels are
still present:

```
Subagent-Driven (this session)  |  Parallel Session (separate)
Orchestrated — Simple           |  Orchestrated — Full
```

`subagent-driven-development` and `executing-plans` are untouched. They are the files most likely to
churn upstream, and the new option sits beside them rather than modifying them.

### Backlog.md removal

The five Backlog.md skills, three shared references, two PostToolUse hooks, `templates/` and
`tests/hook-fixtures/` are deleted outright. Nothing replaces them: `bd init` writes the agent
instructions snippet and installs hooks that auto-inject `bd prime` at session start, so Beads
covers both onboarding and always-on context without a skill layer — and `bd prime` is dynamic where
a skill would be static. The `PostToolUse` block is removed from `hooks/hooks.json`.

Migrating the two live Backlog.md boards (wrestling-game, 127 cards; anime-manga-game, 164 cards) is
out of scope for this work and tracked separately.

## Failure handling

| Failure | Behaviour |
|---|---|
| No `bd` / no `.beads/` | Offer `bd init`, continue untracked, or cancel |
| Bundle exceeds size cap | `bundle-plan.mjs` exits non-zero naming the tasks, the shared files, and the restructuring needed |
| Any task missing `modelTier` | Script refuses to start; no defaulting |
| Implementer returns null | Fatal — the notes chain is broken and later bundles would build on a hole |
| Reviewer returns null | Non-fatal, logged |
| Test loop exhausted | Stop, branch intact, report failing tests and both fix diffs |
| Workflow dies mid-run | Beads shows what completed; `resumeFromRunId` replays cached agents |

Carried over from `epic-pipeline`: the `typeof args === 'string' ? JSON.parse(args) : args` guard,
the shared `CTX` conventions block injected into every agent, and the `FINDINGS` / `TESTRES` schemas.

## Testing

- **`bundle-plan.mjs`** — fixture `.tasks.json` → expected `.bundles.json`. Covers tier
  partitioning, coupling merges, ordering, the size cap, and missing-tier rejection. Runs in CI
  under bun.
- **`test-handoff-guard.sh`** — four-option menu passes; `orchestrating-execution` disarms the guard.
- **`orchestrate.js`** — tier resolution and arg validation extracted as pure functions and tested
  directly. The dispatch graph is not unit-testable without real spend, so it is covered by `log()`
  output at every dispatch — which doubles as the only routing audit trail, given the dispatch gate
  is blind inside workflows.

## Out of scope

- Token budgets, spend ceilings, per-bundle cost reporting.
- Parallel implementation — deliberately traded for the notes chain.
- Automatic re-bundling if a bundle proves mis-sized mid-run.
- Migration of the two existing Backlog.md boards.
- Any change to `subagent-driven-development` or `executing-plans`.
