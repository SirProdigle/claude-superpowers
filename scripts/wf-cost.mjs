#!/usr/bin/env node
// Post-run cost report for a Claude Code Workflow run.
// Usage: node scripts/wf-cost.mjs <transcriptDir> [--json]
//
// Reads agent-*.jsonl transcripts and reports where a run's tokens went. Cost is
// dominated by cache-read input, which is the accumulated context re-sent on every
// turn — so the report leads with turns and context growth, not raw token counts.
// Zero dependencies by design.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

// Relative to base input price: output ~5x, cache read ~0.1x, cache write ~1.25x
// (folded into `fresh` at 1x — close enough for a relative report).
const W = { out: 5, fresh: 1, cache: 0.1 };

function scanAgent(path) {
  let model = null;
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  // A real transcript emits SEVERAL type:"assistant" lines per API response, all sharing one
  // message.id, each carrying a snapshot of the same usage object. Counting per line inflates
  // every figure (measured 1.60x-1.78x on turns across four real runs). Within one id,
  // input/cache_creation/cache_read are IDENTICAL in every snapshot while output_tokens grows
  // partial -> final, so naive summing inflates input more than output and understates
  // output's share of cost. Correct method: key on message.id and keep the LAST record per id.
  // Never sum within a group, never keep the first.
  const usageById = new Map();
  // Content is not a growing superset: each snapshot carries a different slice, so one
  // response's tool calls can be split across snapshots. Keeping only the last snapshot's
  // content loses calls (measured 98 kept vs 112 real on one run), and counting every line
  // double-counts them. Both are avoided by de-duplicating tool_use blocks on their own id.
  const toolNameById = new Map();
  let lineNo = 0;
  let anon = 0;

  for (const line of text.split("\n")) {
    lineNo++;
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue; // malformed lines are skipped, never fatal
    }
    if (d.type !== "assistant") continue;
    const msg = d.message || {};
    model ??= msg.model ?? null;
    // Records with no message.id fall back to a synthetic per-line key so they still count
    // once each rather than collapsing into a single turn.
    const id = typeof msg.id === "string" && msg.id ? msg.id : `line:${lineNo}`;
    usageById.set(id, msg.usage || {}); // later snapshots overwrite earlier ones
    for (const part of msg.content || []) {
      if (part && part.type === "tool_use") {
        const tid = typeof part.id === "string" && part.id ? part.id : `anon:${++anon}`;
        toolNameById.set(tid, part.name);
      }
    }
  }

  const turns = usageById.size;
  if (!turns) return null;

  let fresh = 0, cache = 0, out = 0, ctxFirst = 0, ctxMax = 0, seen = 0;
  for (const u of usageById.values()) {
    const f = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const c = u.cache_read_input_tokens || 0;
    fresh += f;
    cache += c;
    out += u.output_tokens || 0;
    const ctx = f + c;
    if (seen === 0) ctxFirst = ctx; // Map preserves first-seen order
    if (ctx > ctxMax) ctxMax = ctx;
    seen++;
  }

  const tools = new Map();
  for (const name of toolNameById.values()) {
    tools.set(name, (tools.get(name) || 0) + 1);
  }

  return {
    id: basename(path).replace(/^agent-/, "").replace(/\.jsonl$/, ""),
    model, turns, fresh, cache, out, ctxFirst, ctxMax,
    growthPerTurn: turns > 1 ? Math.round((ctxMax - ctxFirst) / (turns - 1)) : 0,
    cost: out * W.out + fresh * W.fresh + cache * W.cache,
    tools: Object.fromEntries([...tools.entries()].sort((a, b) => b[1] - a[1])),
  };
}

// Real journal.jsonl records come in two shapes, {agentId,key,type} and
// {agentId,key,result,type}. Neither carries a `label` or a `name`, and `key` is a
// v2:<64-hex> cache key that renders as an indistinguishable truncated stub — strictly worse
// than the transcript filename — so `key` is deliberately not a candidate. The readable name
// lives at result.task. Candidates are ranked because the record that carries result.task is
// not the first one seen for an agent: the {agentId,key,type} "started" line comes first, so
// a later, richer record must be allowed to upgrade a weaker label.
function labelCandidate(d) {
  const task = d.result && d.result.task;
  if (typeof task === "string" && task) return { value: task, rank: 3 };
  if (typeof d.label === "string" && d.label) return { value: d.label, rank: 2 };
  if (typeof d.name === "string" && d.name) return { value: d.name, rank: 1 };
  return null;
}

function labels(dir) {
  const best = new Map();
  const jp = join(dir, "journal.jsonl");
  if (!existsSync(jp)) return new Map();
  let text;
  try {
    text = readFileSync(jp, "utf8");
  } catch {
    return new Map();
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const id = d.agentId;
    if (!id) continue;
    const cand = labelCandidate(d);
    if (!cand) continue;
    const prev = best.get(id);
    if (!prev || cand.rank > prev.rank) best.set(id, cand);
  }
  return new Map([...best].map(([id, c]) => [id, c.value]));
}

function main(argv) {
  const asJson = argv.includes("--json");
  const dir = argv.find((a) => !a.startsWith("--"));
  if (!dir) {
    console.error("usage: node scripts/wf-cost.mjs <transcriptDir> [--json]");
    return 2;
  }
  let files;
  try {
    files = readdirSync(dir).filter((f) => /^agent-.*\.jsonl$/.test(f)).sort();
  } catch {
    console.error(`cannot read directory: ${dir}`);
    return 2;
  }
  if (!files.length) {
    console.error(`no agent-*.jsonl transcripts in ${dir}`);
    return 2;
  }
  const lab = labels(dir);
  const agents = files.map((f) => scanAgent(join(dir, f))).filter(Boolean)
    .map((a) => ({ ...a, label: lab.get(a.id) ?? a.id }))
    .sort((a, b) => b.cost - a.cost);
  if (!agents.length) {
    console.error(`no agents with usage records in ${dir}`);
    return 2;
  }

  const totals = agents.reduce((t, a) => ({
    turns: t.turns + a.turns, fresh: t.fresh + a.fresh,
    cache: t.cache + a.cache, out: t.out + a.out, cost: t.cost + a.cost,
  }), { turns: 0, fresh: 0, cache: 0, out: 0, cost: 0 });
  totals.agents = agents.length;
  // Even counts take the mean of the two middle values rather than the upper one.
  const sortedTurns = agents.map((a) => a.turns).sort((x, y) => x - y);
  const mid = sortedTurns.length >> 1;
  totals.medianTurns = sortedTurns.length % 2
    ? sortedTurns[mid]
    : (sortedTurns[mid - 1] + sortedTurns[mid]) / 2;
  // Rounding up means the slice is really >20% for small runs (with 4 agents it is the top
  // 25%), so report the share of agents actually included instead of claiming a flat 20%.
  const topCount = Math.max(1, Math.ceil(agents.length / 5));
  const top20 = agents.slice(0, topCount);
  totals.topSliceAgents = topCount;
  totals.topSlicePctAgents = +(100 * topCount / agents.length).toFixed(1);
  totals.top20PctCostShare = totals.cost
    ? +(100 * top20.reduce((s, a) => s + a.cost, 0) / totals.cost).toFixed(1)
    : 0;

  if (asJson) {
    console.log(JSON.stringify({ agents, totals }, null, 2));
    return 0;
  }

  const n = (v) => v.toLocaleString("en-US");
  console.log(`${"label".padEnd(26)} ${"model".padEnd(17)} ${"turns".padStart(6)} ` +
              `${"ctx_end".padStart(10)} ${"g/turn".padStart(8)} ${"cost_idx".padStart(14)}`);
  for (const a of agents) {
    console.log(`${a.label.slice(0, 26).padEnd(26)} ${String(a.model).slice(0, 17).padEnd(17)} ` +
                `${String(a.turns).padStart(6)} ${n(a.ctxMax).padStart(10)} ` +
                `${n(a.growthPerTurn).padStart(8)} ${n(Math.round(a.cost)).padStart(14)}`);
  }
  console.log(`\nagents ${totals.agents}   turns ${n(totals.turns)}   ` +
              `median turns/agent ${totals.medianTurns}`);
  console.log(`cache_read ${n(totals.cache)}   fresh ${n(totals.fresh)}   output ${n(totals.out)}`);
  console.log(`cost index ${n(Math.round(totals.cost))}   ` +
              `top ${totals.topSlicePctAgents}% of agents ` +
              `(${totals.topSliceAgents}/${totals.agents}) = ${totals.top20PctCostShare}% of cost`);
  return 0;
}

// Set the code rather than calling process.exit(): process.exit() can truncate buffered
// stdout when it is a pipe, which would corrupt --json output for any caller.
process.exitCode = main(process.argv.slice(2));
