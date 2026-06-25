/**
 * LongBench v1 single-document QA benchmark runner for CPAT.
 *
 * Feeds LongBench single-doc QA samples (multifieldqa_en / narrativeqa /
 * qasper) through CPAT's agentic tool loop and scores answers with a
 * programmatic LongBench-equivalent token F1.
 *
 * This is a standalone module: it only imports from src/ (runAgent, the
 * DeepSeek client, env loader, CpatConfig type) and never modifies the core
 * runtime.
 *
 * Usage (run from the project root so .env is picked up):
 *   node bench/longbench.ts --data <path.jsonl> [--n 5] [--model deepseek-v4-pro]
 *                           [--max-context 50000] [--turns 30]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CpatConfig } from "../src/types.ts";
import { loadDeepSeekEnv } from "../src/util/env.ts";
import { DeepSeekClient } from "../src/deepseek/client.ts";
import { runAgent } from "../src/agent/loop.ts";
import type { AgentMode } from "../src/agent/loop.ts";
import { qaF1Score } from "./f1.ts";

interface LongBenchSample {
  input: string;
  context: string;
  answers: string[];
  dataset?: string;
  language?: string;
  _id?: string;
}

interface BenchArgs {
  data: string;
  n: number;
  model: string;
  maxContext: number;
  turns: number;
  mode: AgentMode;
}

interface SampleResult {
  index: number;
  id?: string;
  dataset?: string;
  f1: number;
  turns: number;
  question: string;
  prediction: string;
  answers: string[];
  metrics: {
    prompt_tokens: number;
    completion_tokens: number;
    agent_patches_applied: number;
    agent_patches_noop: number;
    runtime_fallback_offloads: number;
    governance_nudges: number;
    boundary_maintenance_calls: number;
    cache_hit_ratio: number;
    final_visible_tokens: number;
  };
}

function usage(message?: string): never {
  if (message) console.error(`error: ${message}\n`);
  console.error(`LongBench v1 single-doc QA benchmark for CPAT

Usage:
  node bench/longbench.ts --data <path.jsonl> [options]

Options:
  --data <path.jsonl>   LongBench single-doc QA jsonl file (required;
                        e.g. multifieldqa_en.jsonl). One JSON object per line.
  --n <count>           Number of leading samples to run (default 5).
  --model <name>        DeepSeek model (default deepseek-v4-pro).
  --max-context <n>     Working context budget in tokens (default 50000).
  --turns <n>           Max agent turns per sample (default 30).
  --mode <cpat|react>   cpat: full context governance (default).
                        react: baseline ReAct agent, no governance, no safety net.`);
  process.exit(1);
}

function parseArgs(argv: string[]): BenchArgs {
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
    model: flags.get("model") ?? "deepseek-v4-pro",
    maxContext: Number(flags.get("max-context") ?? 50000),
    turns: Number(flags.get("turns") ?? 30),
    mode,
  };
}

function loadSamples(path: string, n: number): LongBenchSample[] {
  if (!existsSync(path)) {
    throw new Error(
      `data file not found: ${path}\n` +
        `Provide a LongBench single-doc QA jsonl via --data (e.g. multifieldqa_en.jsonl).`,
    );
  }
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) throw new Error(`data file is empty: ${path}`);

  const samples: LongBenchSample[] = [];
  for (let i = 0; i < lines.length && samples.length < n; i++) {
    let obj: unknown;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      throw new Error(`line ${i + 1} of ${path} is not valid JSON`);
    }
    const s = obj as Partial<LongBenchSample>;
    if (typeof s.input !== "string" || typeof s.context !== "string" || !Array.isArray(s.answers)) {
      throw new Error(
        `line ${i + 1} of ${path} is missing required fields (input, context, answers)`,
      );
    }
    samples.push({
      input: s.input,
      context: s.context,
      answers: s.answers.map((a) => String(a)),
      dataset: s.dataset,
      language: s.language,
      _id: s._id,
    });
  }
  return samples;
}

function buildTask(question: string): string {
  return (
    `${question}\n\n` +
    `The source material is in corpus/document.txt under your workdir. ` +
    `Use read_file/grep_search to consult it, then answer concisely.`
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const samples = loadSamples(args.data, args.n);

  const env = loadDeepSeekEnv();
  const client = new DeepSeekClient(env);

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const benchDir = join("runs", `bench-${ts}`);
  mkdirSync(benchDir, { recursive: true });

  console.log(
    `LongBench runner  mode=${args.mode}  model=${args.model}  budget=${args.maxContext} tokens  ` +
      `turns=${args.turns}  samples=${samples.length}`,
  );
  console.log(`data: ${args.data}`);
  console.log(`run dir: ${benchDir}\n`);

  const results: SampleResult[] = [];

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const sampleDir = join(benchDir, `sample-${i}`);
    const corpusDir = join(sampleDir, "corpus");
    mkdirSync(corpusDir, { recursive: true });
    writeFileSync(join(corpusDir, "document.txt"), sample.context, "utf8");

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
      task: buildTask(sample.input),
      config,
      client,
      workdir: resolve(sampleDir),
      mode: args.mode,
    });

    const f1 = qaF1Score(run.answer, sample.answers);
    const m = run.metrics;
    const result: SampleResult = {
      index: i,
      id: sample._id,
      dataset: sample.dataset,
      f1,
      turns: run.turns,
      question: sample.input,
      prediction: run.answer,
      answers: sample.answers,
      metrics: {
        prompt_tokens: m.prompt_tokens,
        completion_tokens: m.completion_tokens,
        agent_patches_applied: m.agent_patches_applied,
        agent_patches_noop: m.agent_patches_noop,
        runtime_fallback_offloads: m.runtime_fallback_offloads,
        governance_nudges: m.governance_nudges,
        boundary_maintenance_calls: m.boundary_maintenance_calls,
        cache_hit_ratio: m.cache_hit_ratio,
        final_visible_tokens: m.final_visible_tokens,
      },
    };
    results.push(result);

    const preview = run.answer.replace(/\s+/g, " ").trim().slice(0, 80);
    console.log(
      `sample ${String(i).padStart(2)}: F1 ${(f1 * 100).toFixed(1).padStart(5)}  ` +
        `patches ${m.agent_patches_applied} / fallback ${m.runtime_fallback_offloads}  ` +
        `cache ${(m.cache_hit_ratio * 100).toFixed(0)}%  turns ${run.turns}  ` +
        `pred: ${preview}${run.answer.length > 80 ? "…" : ""}`,
    );
  }

  const count = results.length;
  const avgF1 = count > 0 ? results.reduce((s, r) => s + r.f1, 0) / count : 0;
  const avgCache =
    count > 0 ? results.reduce((s, r) => s + r.metrics.cache_hit_ratio, 0) / count : 0;
  const avgPromptTokens =
    count > 0 ? results.reduce((s, r) => s + r.metrics.prompt_tokens, 0) / count : 0;
  const totalAgentPatches = results.reduce((s, r) => s + r.metrics.agent_patches_applied, 0);
  const totalRuntimeFallbacks = results.reduce(
    (s, r) => s + r.metrics.runtime_fallback_offloads,
    0,
  );

  const summary = {
    mode: args.mode,
    data: args.data,
    model: args.model,
    max_context_tokens: args.maxContext,
    max_turns: args.turns,
    samples: count,
    avg_f1: Number((avgF1 * 100).toFixed(2)),
    avg_prompt_tokens: Math.round(avgPromptTokens),
    avg_cache_hit_ratio: Number(avgCache.toFixed(3)),
    total_agent_patches_applied: totalAgentPatches,
    total_runtime_fallback_offloads: totalRuntimeFallbacks,
  };

  console.log(`\n=== summary (${count} samples, mode=${args.mode}) ===`);
  console.log(`avg F1            : ${summary.avg_f1}`);
  console.log(`avg prompt tokens : ${summary.avg_prompt_tokens}`);
  console.log(`avg cache hit     : ${(avgCache * 100).toFixed(1)}%`);
  console.log(
    `governance balance: agent patches ${totalAgentPatches} vs runtime fallbacks ${totalRuntimeFallbacks}`,
  );

  const outPath = join(benchDir, "results.json");
  writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2), "utf8");
  console.log(`\nresults: ${outPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
