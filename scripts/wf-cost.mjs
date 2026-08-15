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
  let turns = 0, fresh = 0, cache = 0, out = 0, model = null;
  let ctxFirst = 0, ctxMax = 0;
  const tools = new Map();
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue; // malformed lines are skipped, never fatal
    }
    if (d.type !== "assistant") continue;
    const msg = d.message || {};
    const u = msg.usage || {};
    model ??= msg.model ?? null;
    turns++;
    const f = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const c = u.cache_read_input_tokens || 0;
    fresh += f;
    cache += c;
    out += u.output_tokens || 0;
    const ctx = f + c;
    if (turns === 1) ctxFirst = ctx;
    if (ctx > ctxMax) ctxMax = ctx;
    for (const part of msg.content || []) {
      if (part && part.type === "tool_use") {
        tools.set(part.name, (tools.get(part.name) || 0) + 1);
      }
    }
  }
  if (!turns) return null;
  return {
    id: basename(path).replace(/^agent-/, "").replace(/\.jsonl$/, ""),
    model, turns, fresh, cache, out, ctxFirst, ctxMax,
    growthPerTurn: turns > 1 ? Math.round((ctxMax - ctxFirst) / (turns - 1)) : 0,
    cost: out * W.out + fresh * W.fresh + cache * W.cache,
    tools: Object.fromEntries([...tools.entries()].sort((a, b) => b[1] - a[1])),
  };
}

function labels(dir) {
  const map = new Map();
  const jp = join(dir, "journal.jsonl");
  if (!existsSync(jp)) return map;
  let text;
  try {
    text = readFileSync(jp, "utf8");
  } catch {
    return map;
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
    if (!id || map.has(id)) continue;
    const v = d.label ?? d.key ?? d.name;
    if (typeof v === "string" && v) map.set(id, v);
  }
  return map;
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
  totals.medianTurns = agents.map((a) => a.turns).sort((x, y) => x - y)[agents.length >> 1];
  const top20 = agents.slice(0, Math.max(1, Math.ceil(agents.length / 5)));
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
              `top 20% of agents = ${totals.top20PctCostShare}% of cost`);
  return 0;
}

// Set the code rather than calling process.exit(): process.exit() can truncate buffered
// stdout when it is a pipe, which would corrupt --json output for any caller.
process.exitCode = main(process.argv.slice(2));
