# Orchestration Cost Redesign — Design

**Status:** Proposed
**Date:** 2026-08-15
**Supersedes parts of:** `skills/orchestrating-execution/SKILL.md` §3 (bundling), §6b (reference script),
`skills/writing-plans/SKILL.md` (plan header), `skills/subagent-driven-development/implementer-prompt.md`

A cost and latency redesign of the orchestrated execution pipeline, grounded in measurement of 240
real workflow agents across five large runs. The pipeline's *quality* properties are not the target
and must not regress; the target is the token cost and wall-clock of achieving them.

## Motivation

Orchestrated and hand-authored workflow runs produce good code at a cost that scales badly: a
complex epic burns millions of tokens and takes hours. The community diagnosis — repeated in
[r/ClaudeAI thread 1vp3177](https://reddit.com/r/ClaudeAI/comments/1vp3177/best_practices_for_workflows/) —
is that fresh implementers re-explore the same code, and the fix is to keep agents alive per code
area or to hand every implementer a pre-built map.

**Measurement contradicts that diagnosis.** Exploration is a rounding error. The cost is agent
lifetime, and keeping agents alive is the most expensive available change.

## The measurement

Five workflow runs, chosen as the largest by total context moved:

| Run | Project | Agents |
|---|---|---|
| `wf_1cfcc8de-49b` | chimera-ant | 29 |
| `wf_bc5b71bd-821` | lottogame | 106 |
| `wf_9dfbf881-c23` | spacelanguage | 51 |
| `wf_da9c80a2-756` | mtggame | 47 |
| `wf_8bdce681-4e8` | chimera-ant | 38 |

Source: `~/.claude/projects/<proj>/<session>/subagents/workflows/<runId>/agent-*.jsonl`. Every
assistant message carries a `usage` record with `input_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens` and `output_tokens`, plus the full tool-call stream. 236 agents with ≥5
turns; ~25,500 turns total.

Cost index used throughout: `output×5 + fresh_input×1 + cache_read×0.1`, reflecting the shape of
Anthropic pricing (output ≈ 5× input, cache read ≈ 0.1× input). `fresh_input` =
`input_tokens + cache_creation_input_tokens`.

### Finding 1 — cost is cache-read input, not output and not exploration

| | chimera-49b | lotto | spacelang | mtg | chimera-4e8 |
|---|---|---|---|---|---|
| cache-read input | 977M | 677M | 762M | 594M | 808M |
| fresh input | 16M | 36M | 19M | 25M | 14M |
| output | 1.3M | 2.7M | 1.8M | 1.6M | 1.1M |

Cache-read is 95-98% of tokens moved and ~81% of cost. Output is ~5%. Tool results — everything
the agents read from the repo and the shell combined — total ~1.26M tokens against ~994M tokens of
input in the chimera-49b run: **0.1%**.

### Finding 2 — the cost function

Every turn re-sends the whole accumulated context. Therefore:

```
cost(agent) ≈ Σ over turns of context-at-that-turn
            ≈ turns × mean context
```

Context grows monotonically. **Workflow agents do not compact** — only 1.7% of 236 agents show any
context drop, consistent with noise. A long agent never gets relief.

Measured parameters:

- **Fresh-agent floor** (turn-1 context: system prompt + tool definitions + dispatch prompt):
  median **26,306** tokens (p25 23,148, p75 27,993, max 65,484).
- **Growth**: median **1,028** tokens/turn (p75 1,327, p90 1,691).
- **Turns per agent**: median 72-204 depending on run; p90 132-273.

Because the floor is low and growth is superlinear in lifetime, *spawning an agent is cheap and
keeping one alive is expensive*.

### Finding 3 — cost concentrates in long-lived agents

| Run | top agent's share | top 3 | top 20% of agents |
|---|---|---|---|
| chimera-49b | 19.6% | 38.2% | 47.3% |
| lottogame | 5.7% | 13.1% | 47.3% |
| spacelanguage | 9.4% | 22.9% | 48.8% |
| mtggame | 12.1% | 28.0% | 56.5% |
| chimera-4e8 | 13.6% | 33.1% | 33.1% |

The worst single agent observed: **443 turns, context 42k → 699k, 208M tokens of context moved** —
20% of a 29-agent run by itself.

### Finding 4 — the agent's own output drives context growth

For the most expensive agent in each run, decomposing growth:

| Run | turns | ctx start → end | own output | tool results |
|---|---|---|---|---|
| chimera-49b | 443 | 42k → 699k | 254k | 126k |
| lottogame | 272 | 23k → 267k | 122k | 64k |
| spacelanguage | 337 | 26k → 368k | 108k | 121k |
| mtggame | 325 | 22k → 349k | 124k | 118k |
| chimera-4e8 | 335 | 51k → 501k | 130k | 113k |

Own output is the larger component in four of five. Since thinking tokens are output tokens,
**reasoning effort compounds into context growth**, not just into per-turn price.

### Finding 5 — turns are driven by Bash, not Read

In chimera-49b: 1,583 Bash calls, 305 Edit, 102 Read, 30 Write. Bash is **78%** of tool calls;
Read is **5%**. Top Bash commands are test-suite invocations, `grep`, `git` and `sed`.

Bash *output volume* is not the problem (917k tokens across a run). Bash *call count* is: each call
is a turn, and a turn late in an agent's life costs 300-700k tokens of context re-read.

### Finding 6 — model tier compounds beyond the rate card

Median totals per agent, by model:

| model | n | median turns | growth/turn | output/turn | median total context |
|---|---|---|---|---|---|
| sonnet-5 | 70 | 60 | 831 | 184 | **3.3M** |
| opus-4.8 | 63 | 81 | 1,008 | 334 | 5.6M |
| opus-5 | 88 | 132 | 1,161 | 327 | 17.2M |
| fable-5 | 13 | 137 | 1,745 | 418 | **35.0M** |

A 10.5× spread in volume before rate multipliers, because higher tiers take more turns *and* grow
faster per turn *and* emit more per turn, and those multiply.

**Caveat:** this is confounded by selection — harder tasks are routed to higher tiers, and harder
tasks take more turns. The table does not isolate a model effect. The mechanism it illustrates
(turns → superlinear cost) is sound regardless of which way the causality runs.

### Finding 7 — the split model

Using measured floor = 26,306 and g = 1,028, modelling an agent of `T` turns split into `k` agents
of `T/k` turns each, charging a 5,000-token handoff brief to each non-first agent:

| Agent length | 1 agent | ×2 | ×4 | ×8 |
|---|---|---|---|---|
| 100 turns | 7.8M | 5.8M | 4.5M | 3.6M |
| 300 turns | 54.3M | 32.7M | 21.1M | 15.0M |
| 443 turns | 112.7M | 64.3M | 38.9M | 26.4M |

Splitting the worst observed agent four ways is a **65%** cut; eight ways, **77%**.

**Caveat:** this is an extrapolation. It assumes work divides cleanly and that 5k of handoff is
sufficient re-establishment. If small agents need more, savings shrink — though the 26k floor
leaves substantial headroom before splitting stops paying.

## Design principles

The pipeline optimises **Σ over all agents, over all turns, of context-at-that-turn.**

1. **Agent-turns are the cost unit, not tokens.** Adding a turn to a long agent is expensive;
   adding a whole fresh agent costs ~26k.
2. **Prefer many short agents to few long ones.**
3. **Artifacts carry context, agents don't.** Because agents must be short, cross-task coherence
   moves into the area brief and the notes chain. Those become quality-load-bearing, not
   optimisations.

## Change 1 — invert bundling

`orchestrating-execution` §3 currently states, as an absolute rule, that tasks sharing a file in
`files[]` MUST occupy one bundle, justified as *"two agents writing one file clobber each other.
Not negotiable."*

**That hazard does not exist in this pipeline.** Implementation is sequential; there are never two
concurrent writers. `docs/superpowers/specs/2026-08-13-orchestrated-execution-design.md` says so
explicitly: *"File overlap is a coupling hint, not a safety constraint — implementation is
sequential, so concurrent writers are not a risk."* The rule's only real effect is to build
long-lived agents, which Findings 2, 3 and 7 identify as the dominant cost.

Replacement rules:

| Rule | Force |
|---|---|
| One task = one agent | **Default** |
| Never merge tasks of different `modelTier` | Absolute (unchanged) |
| Merge only when two tasks are both trivially small AND share a file AND have a direct `blockedBy` edge | Rare exception |
| Never merge more than 2 tasks into one bundle | Absolute |
| A shared file creates a **notes-chain obligation**, not a merge | New |

"Trivially small" is defined mechanically, not by judgment: a task whose `files[]` has at most 2
entries AND whose `estimatedScope` is `"small"` (or absent). If either condition fails, the task
stands alone. This keeps the exception from re-growing into the rule it replaced.

The notes-chain obligation: a task that changes an interface in a file a later task also touches
MUST report that change in its notes.

## Change 2 — pipeline restructure

- **Implementers do not run the full suite.** They run only the narrow test for their own task.
  Full verification is a separate fresh mechanical-tier agent, extending the pattern the existing
  test loop already uses (`{pass, summary}`, "do not fix anything").
- **Batch bash.** A `CTX` rule: combine independent commands into one call; never re-run the suite
  to check progress. Directly attacks Finding 5.
- **Per-task pipelining.** Review and fix move from phase-wide `parallel()` barriers to
  `pipeline()` chains, so a task reviews and fixes as soon as it is implemented. Implementation
  stays sequential — the notes chain requires it. **Wall-clock only; no token effect.**
- **Cheap gates before LLM review.** Typecheck and lint run as one mechanical dispatch first. The
  LLM review prompt is scoped to design and correctness and explicitly told not to report anything
  a linter or typechecker catches. Every avoided finding is a fix agent not spawned.
- **Refactor becomes conditional.** It runs only when the review phase produced at least one
  finding of `severity: "major"` or `"critical"` whose issue text concerns structure rather than
  behaviour — duplication across bundles, a boundary in the wrong place, an abstraction the plan
  outgrew. Behavioural findings, however severe, are fixed in the Fixes phase and do not trigger
  refactor. If no such finding exists, refactor is skipped and the reason logged. This removes a
  long-lived writing agent and a second full test loop from the common case.

  To make the trigger mechanical rather than a re-judgment, the `FINDINGS` schema gains a
  `structural: boolean` field that the reviewer sets, so the script tests a flag instead of
  re-reading prose.
- **Effort is actually passed.** The `effort` map in `model-routing.json` is applied per dispatch.
  Per Finding 4, this attacks the largest single component of context growth.

## Change 3 — the area brief

**Produced** at plan time by `writing-plans`. The planning session clusters the union of all
`files[]` across the plan into 2-5 code areas and writes one brief per area from context it already
holds from brainstorming; scouts are dispatched only for areas it has not read.

**Sized hard.** Measured, an 8,000-token brief attached to every dispatch adds 2.5-10% to
cache-read volume — it is not free. Each area brief is capped at **~1,500 tokens**, and an
implementer receives only the briefs for areas its task touches. At 60-turn agents that is ~90k per
agent against a 3-8M budget.

**Content** is narrow by construction:

- the 5-8 files that matter in this area, one line each on what each owns
- interfaces and contracts that must not change
- invariants holding across the area
- where this area's tests live

Not included: code dumps, exhaustive API surface, anything cheaply greppable.

**Delivered** by inlining into the dispatch prompt rather than having the agent read a file. A Read
costs a turn and lands in context anyway, so inlining is the same price and guarantees delivery.

**Staleness contract.** The brief describes structure as of plan time; the notes chain carries
deltas. This is why the notes-chain obligation in Change 1 exists — it is what makes trusting a
plan-time brief safe once agents are too short to rediscover the truth themselves.

**Consumed** by both execution paths: `orchestrating-execution` bakes the relevant briefs into the
script as literals; `subagent-driven-development` places them in the `## Context` slot that already
exists at `implementer-prompt.md:31`.

## Change 4 — instrumentation

Everything above is a hypothesis until measured on our own pipeline.

- **In-script:** log `budget.spent()` around each dispatch. This yields per-dispatch *output* cost
  only — partial, since output is ~5% of cost — but it is free and needs no post-processing.
- **Post-run:** ship the analysis used to produce this document as `scripts/wf-cost.mjs`. It reads
  a run's `agent-*.jsonl` transcripts and reports turns, context growth, and cost per agent and per
  phase. `orchestrating-execution` Step 8 runs it and reports the summary; `/complete-epic` may
  quote it as evidence.

This produces the metric the thread proposed — cost per task that survives review without rework —
as a real number.

## Risks

**Quality regression is the real danger, not cost.** Every measurement here concerns cost. None of
it validates that a 60-turn agent produces the same code as a 300-turn one. The area brief and the
notes-chain obligation are the mitigation and they are untested. The first run after this change
should be one where degradation would be noticed.

**The split model is an extrapolation** (see Finding 7 caveat).

**Model-tier comparisons are confounded** (see Finding 6 caveat). Do not use that table to justify
routing decisions on its own.

**Reduced bundling increases dispatch count**, which increases the number of places a dispatch can
fail and lengthens the Beads port. The 26k floor makes it cheap in tokens, not in moving parts.

## Failure handling

| Failure | Behaviour |
|---|---|
| An area brief is stale (interface moved) | Notes chain carries the delta; implementer verifies before trusting. Unreported drift is a review finding, not a silent break. |
| Planner cannot cluster files into areas | Fall back to one brief for the whole plan, still capped; log that it happened. |
| `wf-cost.mjs` finds no transcripts | Non-fatal; Step 8 reports "cost report unavailable" and continues. |
| Conditional refactor never triggers across several epics | Expected in a healthy codebase. Not a bug; the standing stage was the bug. |

## Out of scope

- **Budget-adaptive phase selection** using the `budget` API. Revisit once Change 4 produces a
  baseline.
- **Long-lived or resumable implementers.** Impossible inside a Workflow (all 69 workflow
  subagents measured at `spawnDepth=1`; no `Agent`/`Task`/`Workflow` call in 300 transcripts), and
  the data says it is the wrong direction regardless.
- **Moving implementers to Agent-tool dispatch** to unlock sub-agent nesting (which does work —
  `spawnDepth` 2 and 3 observed). It would lose resume, background execution and deterministic
  control flow, and the offload benefit is small next to shortening agents.
- **Per-agent worktrees.** Sequential implementation does not need them.
- **Any change to `model-routing.json` semantics.**

## Verifying it works

- Bundling: a plan whose tasks share files produces one bundle per task, not one merged bundle.
- Pipeline: a run's phase log shows review and fix dispatches for task N beginning before task N+2
  has implemented.
- Refactor: a run with no structural review findings logs a skipped refactor and runs exactly one
  test loop.
- Brief: each dispatch prompt contains only the briefs for areas its task touches, and each brief
  is under the cap.
- Cost: `scripts/wf-cost.mjs` on a post-change run reports median turns per implementer
  substantially below the 72-204 baseline recorded here, on a comparable plan.
