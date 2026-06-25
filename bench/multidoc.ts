/**
 * Multi-document retrieval benchmark for CPAT — the context-pressure arena.
 *
 * Builds a corpus of several long narrativeqa documents where the answer to a
 * question lives in exactly ONE of them. The agent must grep/read across files
 * over multiple turns. This is where context governance should matter: a ReAct
 * agent accumulates every large doc it reads (and gets diluted by the
 * distractors), while CPAT can offload documents it has ruled out.
 *
 * Scored with the same LongBench-equivalent token F1. Standalone module: only
 * imports runAgent + the client/env/types from src/, never modifies the core.
 *
 * Usage (from project root so .env is read):
 *   node bench/multidoc.ts --data <narrativeqa.jsonl> [--n 5] [--distractors 4]
 *        [--mode cpat|react] [--model deepseek-v4-pro] [--max-context 60000] [--turns 30]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CpatConfig } from "../src/types.ts";
import { loadDeepSeekEnv } from "../src/util/env.ts";
import { DeepSeekClient } from "../src/deepseek/client.ts";
import { runAgent } from "../src/agent/loop.ts";
import type { AgentMode } from "../src/agent/loop.ts";
import { qaF1Score } from "./f1.ts";

interface Sample {
  input: string;
  context: string;
  answers: string[];
  _id?: string;
}

interface Args {
  data: string;
  n: number;
  distractors: number;
  mode: AgentMode;
  model: string;
  maxContext: number;
  turns: number;
}

function usage(message?: string): never {
  if (message) console.error(`error: ${message}\n`);
  console.error(`Multi-document retrieval benchmark for CPAT

Usage:
  node bench/multidoc.ts --data <narrativeqa.jsonl> [options]

Options:
  --data <path.jsonl>   narrativeqa jsonl (required). One JSON object per line.
  --n <count>           Number of target questions to run (default 5).
  --distractors <k>     Distractor docs added per question (default 4).
  --mode <cpat|react>   cpat: full governance (default). react: baseline, no governance.
  --model <name>        DeepSeek model (default deepseek-v4-pro).
  --max-context <n>     Working context budget in tokens (default 60000).
  --turns <n>           Max agent turns per question (default 30).`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) usage(`unexpected argument "${a}"`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) usage(`flag --${key} needs a value`);
    flags.set(key, next);
    i++;
  }
  const data = flags.get("data");
  if (!data) usage("--data <path.jsonl> is required");
  const mode = (flags.get("mode") ?? "cpat") as AgentMode;
  if (mode !== "cpat" && mode !== "react") usage(`--mode must be "cpat" or "react"`);
  return {
    data: resolve(data),
    n: Number(flags.get("n") ?? 5),
    distractors: Number(flags.get("distractors") ?? 4),
    mode,
    model: flags.get("model") ?? "deepseek-v4-pro",
    maxContext: Number(flags.get("max-context") ?? 60000),
    turns: Number(flags.get("turns") ?? 30),
  };
}

function loadSamples(path: string, need: number): Sample[] {
  if (!existsSync(path)) throw new Error(`data file not found: ${path}`);
  const lines = readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error(`data file is empty: ${path}`);
  const out: Sample[] = [];
  for (let i = 0; i < lines.length && out.length < need; i++) {
    const s = JSON.parse(lines[i]) as Partial<Sample>;
    if (typeof s.input !== "string" || typeof s.context !== "string" || !Array.isArray(s.answers)) {
      throw new Error(`line ${i + 1} missing input/context/answers`);
    }
    out.push({ input: s.input, context: s.context, answers: s.answers.map(String), _id: s._id });
  }
  return out;
}

/**
 * Deterministic distractor pick: for target index t, take the next `k` samples
 * (wrapping) as distractors. No RNG (kept reproducible across resume), and the
 * gold doc is placed at a rotating slot so it isn't always doc_1.
 */
function buildCorpus(
  pool: Sample[],
  target: number,
  k: number,
): { docs: string[]; goldSlot: number } {
  const goldDoc = pool[target].context;
  const distractors: string[] = [];
  for (let j = 1; j <= k; j++) distractors.push(pool[(target + j) % pool.length].context);
  const goldSlot = target % (k + 1); // rotate gold position
  const docs: string[] = [];
  let di = 0;
  for (let slot = 0; slot < k + 1; slot++) {
    docs.push(slot === goldSlot ? goldDoc : distractors[di++]);
  }
  return { docs, goldSlot };
}

function buildTask(question: string, docCount: number): string {
  return (
    `${question}\n\n` +
    `Your workdir has a corpus/ folder with ${docCount} documents (doc_1.txt … doc_${docCount}.txt). ` +
    `The answer is contained in exactly ONE of them; the others are unrelated. ` +
    `Use list_dir and grep_search to locate the relevant document, read the needed parts, then answer concisely.`
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // Need enough samples to supply target + distractors.
  const pool = loadSamples(args.data, args.n + args.distractors);
  if (pool.length < args.distractors + 1) {
    throw new Error(`need at least ${args.distractors + 1} samples; got ${pool.length}`);
  }
  const targets = Math.min(args.n, pool.length);

  const env = loadDeepSeekEnv();
  const client = new DeepSeekClient(env);

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const benchDir = join("runs", `multidoc-${args.mode}-${ts}`);
  mkdirSync(benchDir, { recursive: true });

  console.log(
    `Multidoc runner  mode=${args.mode}  model=${args.model}  budget=${args.maxContext} tokens  ` +
      `turns=${args.turns}  targets=${targets}  distractors=${args.distractors}`,
  );
  console.log(`data: ${args.data}\nrun dir: ${benchDir}\n`);

  const results: Array<Record<string, unknown>> = [];

  for (let t = 0; t < targets; t++) {
    const sample = pool[t];
    const { docs, goldSlot } = buildCorpus(pool, t, args.distractors);
    const sampleDir = join(benchDir, `q-${t}`);
    const corpusDir = join(sampleDir, "corpus");
    mkdirSync(corpusDir, { recursive: true });
    docs.forEach((d, idx) => writeFileSync(join(corpusDir, `doc_${idx + 1}.txt`), d, "utf8"));

    const config: CpatConfig = {
      model: args.model,
      maxContextTokens: args.maxContext,
      softLimitRatio: 0.7,
      mustActRatio: 0.8,
      criticalRatio: 0.95,
      allowReplace: false,
      allowRedact: false,
      strictTools: true,
      maxTurns: args.turns,
      runDir: sampleDir,
      verbose: false,
    };

    const run = await runAgent({
      task: buildTask(sample.input, docs.length),
      config,
      client,
      workdir: resolve(sampleDir),
      mode: args.mode,
    });

    const f1 = qaF1Score(run.answer, sample.answers);
    const m = run.metrics;
    results.push({
      index: t,
      id: sample._id,
      gold_slot: goldSlot + 1,
      f1,
      turns: run.turns,
      question: sample.input,
      prediction: run.answer,
      answers: sample.answers,
      prompt_tokens: m.prompt_tokens,
      completion_tokens: m.completion_tokens,
      agent_patches_applied: m.agent_patches_applied,
      agent_patches_noop: m.agent_patches_noop,
      runtime_fallback_offloads: m.runtime_fallback_offloads,
      governance_nudges: m.governance_nudges,
      boundary_maintenance_calls: m.boundary_maintenance_calls,
      cache_hit_ratio: m.cache_hit_ratio,
      final_visible_tokens: m.final_visible_tokens,
    });

    const preview = run.answer.replace(/\s+/g, " ").trim().slice(0, 70);
    console.log(
      `q ${String(t).padStart(2)}: F1 ${(f1 * 100).toFixed(1).padStart(5)}  ` +
        `gold=doc_${goldSlot + 1}  prompt ${m.prompt_tokens}  cache ${(m.cache_hit_ratio * 100).toFixed(0)}%  ` +
        `patch ${m.agent_patches_applied}/fb ${m.runtime_fallback_offloads}  turns ${run.turns}  ` +
        `pred: ${preview}${run.answer.length > 70 ? "…" : ""}`,
    );
  }

  const c = results.length;
  const num = (k: string) => results.reduce((s, r) => s + (r[k] as number), 0);
  const summary = {
    mode: args.mode,
    model: args.model,
    max_context_tokens: args.maxContext,
    targets: c,
    distractors: args.distractors,
    avg_f1: Number(((num("f1") / c) * 100).toFixed(2)),
    avg_prompt_tokens: Math.round(num("prompt_tokens") / c),
    avg_cache_hit_ratio: Number((num("cache_hit_ratio") / c).toFixed(3)),
    total_agent_patches: num("agent_patches_applied"),
    total_runtime_fallbacks: num("runtime_fallback_offloads"),
  };

  console.log(`\n=== summary (${c} targets, mode=${args.mode}) ===`);
  console.log(`avg F1            : ${summary.avg_f1}`);
  console.log(`avg prompt tokens : ${summary.avg_prompt_tokens}`);
  console.log(`avg cache hit     : ${(summary.avg_cache_hit_ratio * 100).toFixed(1)}%`);
  console.log(`governance        : agent patches ${summary.total_agent_patches} vs runtime fallbacks ${summary.total_runtime_fallbacks}`);

  const outPath = join(benchDir, "results.json");
  writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2), "utf8");
  console.log(`\nresults: ${outPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
