/**
 * Controlled cache probe: isolate the effect of generational tail RENDERING on
 * DeepSeek's prompt cache, with the offload decisions held identical across arms.
 *
 * Both arms ingest the same fixed corpus and apply the SAME scripted offload
 * sequence (retire the oldest still-inline bulky block each round). The only
 * difference is config.generational — i.e. render order. After each round we
 * make a real API call and record prompt_cache_hit_tokens / prompt_tokens.
 *
 * This removes the agent-decision variance that made the longloop A/B unclean
 * (patches 13 vs 4, fallbacks 19 vs 29). Here the arms are byte-identical except
 * for where blocks sit in the rendered message list.
 *
 *   node bench/cacheprobe.ts --data data/narrativeqa.jsonl [--docs 6] [--model deepseek-chat]
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DeepSeekClient } from "../src/deepseek/client.ts";
import { loadDeepSeekEnv } from "../src/util/env.ts";
import { ContextRuntime } from "../src/runtime/runtime.ts";
import { resetIdCounter } from "../src/util/misc.ts";
import type { CpatConfig, ContextOperation, ToolCall } from "../src/types.ts";

interface Raw { input: string; context: string; answers: string[]; _id?: string }

function parseArgs(argv: string[]): { data: string; docs: number; model: string } {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected arg ${a}`);
    flags.set(a.slice(2), argv[++i]);
  }
  const data = flags.get("data");
  if (!data) throw new Error("--data <narrativeqa.jsonl> required");
  return {
    data: resolve(data),
    docs: Number(flags.get("docs") ?? 6),
    model: flags.get("model") ?? "deepseek-chat",
  };
}

function loadBooks(path: string, docs: number): Raw[] {
  if (!existsSync(path)) throw new Error(`data not found: ${path}`);
  const lines = readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  const seen = new Set<string>();
  const books: Raw[] = [];
  for (const line of lines) {
    if (books.length >= docs) break;
    const s = JSON.parse(line) as Partial<Raw>;
    if (typeof s.input !== "string" || typeof s.context !== "string" || !Array.isArray(s.answers)) continue;
    const key = s.context.slice(0, 300);
    if (seen.has(key)) continue;
    seen.add(key);
    // Cap each book so the whole corpus fits the real window but stays bulky.
    books.push({ input: s.input, context: s.context.slice(0, 24000), answers: s.answers.map(String) });
  }
  if (books.length < docs) throw new Error(`only ${books.length} unique books; need ${docs}`);
  return books;
}

function tc(id: string): ToolCall {
  return { id, type: "function", function: { name: "read_file", arguments: `{"path":"${id}"}` } };
}

function makeConfig(generational: boolean, runDir: string): CpatConfig {
  return {
    model: "probe",
    maxContextTokens: 1_000_000, // never trip the budget monitor; we script offloads
    softLimitRatio: 0.7,
    mustActRatio: 0.8,
    criticalRatio: 0.95,
    generational,
    allowReplace: false,
    allowRedact: false,
    strictTools: true,
    maxTurns: 100,
    runDir,
    verbose: false,
  };
}

/** Build a runtime preloaded with the corpus as bulky read-chains. */
function seed(books: Raw[], generational: boolean, runDir: string): { rt: ContextRuntime; toolIds: string[] } {
  resetIdCounter();
  const rt = new ContextRuntime(makeConfig(generational, runDir));
  rt.ingestSystem("You are answering questions over a corpus already read into context.");
  rt.ingestUser("Work through the books; offloaded ones can be restored if needed.");
  const toolIds: string[] = [];
  books.forEach((b, i) => {
    const callId = `call_${i}`;
    rt.ingestAssistant({ role: "assistant", content: "", tool_calls: [tc(callId)] });
    rt.ingestToolResult(tc(callId), `BOOK ${i + 1}\n${b.context}`);
    const tool = rt.blocks.all().find((x) => x.api?.tool_call_id === callId)!;
    toolIds.push(tool.id);
  });
  return { rt, toolIds };
}

/** Offload one block by id (zero-copy), then promote it to a fresh generation. */
function scriptedOffload(rt: ContextRuntime, blockId: string): void {
  const b = rt.blocks.get(blockId)!;
  const head = typeof b.content === "string" ? b.content.slice(0, 200) : "";
  const ops: ContextOperation[] = [
    {
      op: "payload_offload",
      ids: [blockId],
      store: "file",
      replace_with: {
        description: "scripted offload",
        summary: `head: ${head}`,
        retrieval_hint: "artifact_get",
      },
    },
  ];
  rt.applyUpdate({ operations: ops, reason: "scripted controlled offload" }, "runtime");
  rt.blocks.setGeneration(blockId, rt.blocks.allocGeneration());
}

async function runArm(
  name: string,
  generational: boolean,
  books: Raw[],
  client: DeepSeekClient,
  model: string,
  runDir: string,
): Promise<{ name: string; rounds: Array<{ round: number; prompt: number; hit: number }>; totalPrompt: number; totalHit: number }> {
  const { rt, toolIds } = seed(books, generational, runDir);
  const rounds: Array<{ round: number; prompt: number; hit: number }> = [];
  let totalPrompt = 0;
  let totalHit = 0;

  // Round 0: full corpus inline (no offload yet) — warms the cache.
  // Rounds 1..N: retire the oldest still-inline book each round, then re-query.
  // A fixed trailing question forces a real generation each round.
  for (let round = 0; round <= toolIds.length - 1; round++) {
    if (round > 0) scriptedOffload(rt, toolIds[round - 1]);
    // Identical trailing question each round, passed as an ephemeral tail
    // message so it sits before the manifest and never becomes a stored block.
    const { messages, view } = rt.buildView([
      {
        role: "user",
        content: `Round ${round}: in one short sentence, which book numbers are still fully inline above?`,
      },
    ]);
    const resp = await client.chat({ model, messages });
    rt.recordLlmCall(model, resp.usage, view);
    const prompt = resp.usage.prompt_tokens;
    const hit = resp.usage.prompt_cache_hit_tokens ?? 0;
    totalPrompt += prompt;
    totalHit += hit;
    rounds.push({ round, prompt, hit });
    console.log(
      `  [${name}] round ${round}: prompt=${prompt}  cache_hit=${hit}  (${prompt ? Math.round((hit / prompt) * 100) : 0}%)`,
    );
  }
  return { name, rounds, totalPrompt, totalHit };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const books = loadBooks(args.data, args.docs);
  const env = loadDeepSeekEnv();
  const client = new DeepSeekClient(env);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const baseDir = join("runs", `cacheprobe-${ts}`);
  mkdirSync(baseDir, { recursive: true });

  const corpusTokens = books.reduce((s, b) => s + Math.round(b.context.length / 3.3), 0);
  console.log(
    `cache probe  model=${args.model}  books=${args.docs} ~${corpusTokens} tokens  rounds=${args.docs}\n` +
      `identical scripted offload sequence; ONLY difference between arms = render order\n`,
  );

  console.log("ARM A: baseline render (generational=false)");
  const a = await runArm("base", false, books, client, args.model, join(baseDir, "base"));
  console.log("\nARM B: generational render (generational=true)");
  const b = await runArm("gen", true, books, client, args.model, join(baseDir, "gen"));

  const summary = {
    model: args.model,
    books: args.docs,
    corpus_tokens_est: corpusTokens,
    base: { total_prompt: a.totalPrompt, total_cache_hit: a.totalHit, hit_ratio: a.totalPrompt ? a.totalHit / a.totalPrompt : 0 },
    gen: { total_prompt: b.totalPrompt, total_cache_hit: b.totalHit, hit_ratio: b.totalPrompt ? b.totalHit / b.totalPrompt : 0 },
    per_round: { base: a.rounds, gen: b.rounds },
  };
  writeFileSync(join(baseDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log("\n=== controlled cache comparison (identical offloads, render order differs) ===");
  console.log(`               total_prompt   total_cache_hit   hit_ratio`);
  console.log(`  base (off)   ${String(a.totalPrompt).padStart(12)}   ${String(a.totalHit).padStart(15)}   ${pct(summary.base.hit_ratio)}`);
  console.log(`  gen  (on)    ${String(b.totalPrompt).padStart(12)}   ${String(b.totalHit).padStart(15)}   ${pct(summary.gen.hit_ratio)}`);
  const dHit = summary.gen.hit_ratio - summary.base.hit_ratio;
  const dPrompt = b.totalPrompt - a.totalPrompt;
  console.log(
    `\n  Δ cache_hit_ratio: ${dHit >= 0 ? "+" : ""}${(dHit * 100).toFixed(1)}pp   ` +
      `Δ total_prompt: ${dPrompt >= 0 ? "+" : ""}${dPrompt} tokens`,
  );
  console.log(
    dHit > 0.02 && dPrompt <= 0
      ? "  → generational render IMPROVES cache without raising prompt tokens."
      : "  → generational render does NOT clearly help cache in this setup.",
  );
  console.log(`\nsummary: ${join(baseDir, "summary.json")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
