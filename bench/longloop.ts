/**
 * Long-horizon multi-question loop benchmark — CPAT's real arena.
 *
 * Builds a LARGE corpus (~20 unique narrativeqa books, ~500k tokens) that far
 * exceeds any sane working budget, then asks a SEQUENCE of questions on the
 * SAME runtime. Each answer lives in a different book; some questions revisit a
 * book asked about earlier. To answer, the agent must scan broadly, set aside
 * (offload) what it isn't using, and pull back (restore / artifact_get) the
 * specific book a later question needs.
 *
 * This is the scenario the earlier single-doc/multi-doc benchmarks could NOT
 * create: information that cannot all fit the budget at once, and a revisit
 * pattern that makes the offload→restore reversible cycle load-bearing.
 *
 * ReAct (no governance) must carry every book it has read — it bloats toward
 * the model's real window and gets diluted. CPAT can govern against a budget
 * far below corpus size and reload on demand.
 *
 * Scored with LongBench-equivalent token F1, per question. Standalone module.
 *
 * Usage (from project root):
 *   node bench/longloop.ts --data <narrativeqa.jsonl> --mode cpat|react
 *        [--docs 20] [--questions 6] [--max-context 120000] [--turns 80]
 *        [--model deepseek-v4-pro]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CpatConfig } from "../src/types.ts";
import { loadDeepSeekEnv } from "../src/util/env.ts";
import { DeepSeekClient } from "../src/deepseek/client.ts";
import { runAgent } from "../src/agent/loop.ts";
import type { AgentMode } from "../src/agent/loop.ts";
import { qaF1Score } from "./f1.ts";

interface Raw {
  input: string;
  context: string;
  answers: string[];
  _id?: string;
}

interface Doc {
  text: string;
  slot: number; // doc_<slot>.txt (1-based)
}

interface Question {
  prompt: string;
  answers: string[];
  goldSlot: number; // which doc_<n>.txt holds the answer
}

interface Args {
  data: string;
  docs: number;
  questions: number;
  mode: AgentMode;
  model: string;
  maxContext: number;
  turns: number;
}

function usage(message?: string): never {
  if (message) console.error(`error: ${message}\n`);
  console.error(`Long-horizon multi-question loop benchmark for CPAT

Usage:
  node bench/longloop.ts --data <narrativeqa.jsonl> [options]

Options:
  --data <path.jsonl>   narrativeqa jsonl (required).
  --docs <k>            Unique books in the corpus (default 20, ~500k tokens).
  --questions <m>       Questions asked in sequence (default 6, includes revisits).
  --mode <cpat|react>   cpat: full governance (default). react: baseline.
  --model <name>        DeepSeek model (default deepseek-v4-pro).
  --max-context <n>     CPAT working budget (default 120000; << corpus size).
  --turns <n>           Max total agent turns across all questions (default 80).`);
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
  if (!data) usage("--data is required");
  const mode = (flags.get("mode") ?? "cpat") as AgentMode;
  if (mode !== "cpat" && mode !== "react") usage(`--mode must be "cpat" or "react"`);
  return {
    data: resolve(data),
    docs: Number(flags.get("docs") ?? 20),
    questions: Number(flags.get("questions") ?? 6),
    mode,
    model: flags.get("model") ?? "deepseek-v4-pro",
    maxContext: Number(flags.get("max-context") ?? 120000),
    turns: Number(flags.get("turns") ?? 80),
  };
}

/**
 * Load narrativeqa, dedupe by book (many questions share one book), and keep
 * the first `docs` unique books — each with one of its QA pairs attached.
 */
function loadUniqueBooks(path: string, docs: number): Raw[] {
  if (!existsSync(path)) throw new Error(`data file not found: ${path}`);
  const lines = readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  const seen = new Set<string>();
  const books: Raw[] = [];
  for (const line of lines) {
    if (books.length >= docs) break;
    const s = JSON.parse(line) as Partial<Raw>;
    if (typeof s.input !== "string" || typeof s.context !== "string" || !Array.isArray(s.answers)) continue;
    const key = s.context.slice(0, 300); // dedupe by book opening
    if (seen.has(key)) continue;
    seen.add(key);
    books.push({ input: s.input, context: s.context, answers: s.answers.map(String), _id: s._id });
  }
  if (books.length < docs) throw new Error(`only found ${books.length} unique books; need ${docs}`);
  return books;
}

/**
 * Deterministic question schedule over the corpus: pick `m` book indices that
 * (a) spread across the corpus and (b) include at least one REVISIT — a book
 * asked again after others intervened, forcing a restore of something offloaded.
 * No RNG (resume-safe).
 */
function scheduleQuestions(books: Raw[], slotOf: number[], m: number): Question[] {
  const n = books.length;
  const picks: number[] = [];
  // spread: every floor(n/m)-th book
  const step = Math.max(1, Math.floor(n / m));
  for (let i = 0; i < m - 1; i++) picks.push((i * step) % n);
  // final question revisits the very first book (guaranteed long-range revisit)
  picks.push(picks[0]);
  return picks.map((bookIdx) => ({
    prompt: books[bookIdx].input,
    answers: books[bookIdx].answers,
    goldSlot: slotOf[bookIdx],
  }));
}

function mainTaskText(question: string, docCount: number): string {
  return (
    `You are working through a large corpus over several questions. ` +
    `Your workdir has a corpus/ folder with ${docCount} long documents (doc_1.txt … doc_${docCount}.txt), ` +
    `each a different book — together far larger than you can hold in context at once.\n\n` +
    `Working method (important):\n` +
    `- Each answer must quote or cite the SPECIFIC wording of the source document; a vague summary is not acceptable. ` +
    `So you need the verbatim text available when you answer, not just a paraphrase.\n` +
    `- When you finish reading a document you don't need right now, payload_offload its raw payload ` +
    `(NOT compact — you will likely need to re-read its exact wording for a later question, and offload keeps the full text recoverable). ` +
    `Keep a short note of which doc covers what.\n` +
    `- When a later question needs a document you set aside, restore it (or artifact_get its payload) to read the exact wording again.\n` +
    `- Later questions may return to a document an earlier one used.\n\n` +
    `First question: ${question}\n\n` +
    `Find the relevant document, read the exact passage, and answer with the specific wording.`
  );
}

function followupText(question: string, idx: number): string {
  return (
    `Next question (#${idx + 1}): ${question}\n` +
    `Answer using the SPECIFIC wording of the source document. The answer may be in a document you ` +
    `set aside (offloaded) earlier — restore it or artifact_get its payload to read the exact text before answering.`
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const books = loadUniqueBooks(args.data, args.docs);

  const env = loadDeepSeekEnv();
  const client = new DeepSeekClient(env);

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const benchDir = join("runs", `longloop-${args.mode}-${ts}`);
  const corpusDir = join(benchDir, "corpus");
  mkdirSync(corpusDir, { recursive: true });

  // Lay the corpus down once; doc_<i+1>.txt = books[i].
  const slotOf: number[] = books.map((_, i) => i + 1);
  let corpusTokens = 0;
  books.forEach((b, i) => {
    writeFileSync(join(corpusDir, `doc_${i + 1}.txt`), b.context, "utf8");
    corpusTokens += Math.round(b.context.length / 3.3);
  });

  const questions = scheduleQuestions(books, slotOf, args.questions);

  console.log(
    `Longloop runner  mode=${args.mode}  model=${args.model}  budget=${args.maxContext} tokens  ` +
      `turns=${args.turns}`,
  );
  console.log(
    `corpus: ${args.docs} books ~${corpusTokens} tokens (~${Math.round(corpusTokens / args.maxContext * 10) / 10}× budget)  ` +
      `questions: ${questions.length} (gold slots: ${questions.map((q) => q.goldSlot).join(",")})`,
  );
  console.log(`run dir: ${benchDir}\n`);

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
    runDir: benchDir,
    verbose: false,
  };

  let apiError: string | undefined;
  let run: Awaited<ReturnType<typeof runAgent>> | undefined;
  try {
    run = await runAgent({
      task: mainTaskText(questions[0].prompt, args.docs),
      followups: questions.slice(1).map((q, i) => followupText(q.prompt, i + 1)),
      config,
      client,
      workdir: resolve(benchDir),
      mode: args.mode,
    });
  } catch (err) {
    // ReAct may blow the real context window on a 500k corpus → API 400.
    apiError = err instanceof Error ? err.message : String(err);
  }

  const perQuestion: Array<Record<string, unknown>> = [];
  if (run) {
    questions.forEach((q, i) => {
      const ans = run!.answers[i] ?? "";
      perQuestion.push({
        index: i,
        gold_slot: q.goldSlot,
        f1: qaF1Score(ans, q.answers),
        question: q.prompt,
        prediction: ans,
        answers: q.answers,
      });
    });
  }

  const answered = perQuestion.length;
  const avgF1 = answered > 0 ? perQuestion.reduce((s, r) => s + (r.f1 as number), 0) / answered : 0;
  const m = run?.metrics;
  const ops = m?.ops_by_type ?? {};

  const summary = {
    mode: args.mode,
    model: args.model,
    corpus_books: args.docs,
    corpus_tokens_est: corpusTokens,
    max_context_tokens: args.maxContext,
    questions: questions.length,
    questions_answered: answered,
    api_error: apiError ?? null,
    avg_f1: Number((avgF1 * 100).toFixed(2)),
    total_prompt_tokens: m?.prompt_tokens ?? 0,
    cache_hit_ratio: m?.cache_hit_ratio ?? 0,
    final_visible_tokens: m?.final_visible_tokens ?? 0,
    ops_by_type: ops,
    offloads: (ops.payload_offload ?? 0) as number,
    restores: (ops.restore ?? 0) as number,
    agent_patches_applied: m?.agent_patches_applied ?? 0,
    agent_patches_noop: m?.agent_patches_noop ?? 0,
    runtime_fallback_offloads: m?.runtime_fallback_offloads ?? 0,
    governance_nudges: m?.governance_nudges ?? 0,
    boundary_maintenance_calls: m?.boundary_maintenance_calls ?? 0,
  };

  console.log(`\n=== per-question F1 (mode=${args.mode}) ===`);
  for (const r of perQuestion) {
    const pred = String(r.prediction).replace(/\s+/g, " ").trim().slice(0, 60);
    console.log(
      `  Q${r.index} gold=doc_${r.gold_slot}  F1 ${((r.f1 as number) * 100).toFixed(1).padStart(5)}  pred: ${pred}…`,
    );
  }
  console.log(`\n=== summary (mode=${args.mode}) ===`);
  if (apiError) console.log(`API ERROR (ReAct likely overflowed window): ${apiError.slice(0, 160)}`);
  console.log(`questions answered : ${answered}/${questions.length}`);
  console.log(`avg F1             : ${summary.avg_f1}`);
  console.log(`total prompt tokens: ${summary.total_prompt_tokens}  (corpus ~${corpusTokens})`);
  console.log(`cache hit          : ${(summary.cache_hit_ratio * 100).toFixed(1)}%`);
  console.log(`offload / restore  : ${summary.offloads} / ${summary.restores}   (the reversible cycle)`);
  console.log(`agent patches      : ${summary.agent_patches_applied}  runtime fallbacks: ${summary.runtime_fallback_offloads}`);

  writeFileSync(join(benchDir, "results.json"), JSON.stringify({ summary, perQuestion }, null, 2), "utf8");
  console.log(`\nresults: ${join(benchDir, "results.json")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
