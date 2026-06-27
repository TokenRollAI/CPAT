import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CpatConfig } from "./types.ts";
import { loadDeepSeekEnv } from "./util/env.ts";
import { DeepSeekClient } from "./deepseek/client.ts";
import { runAgent } from "./agent/loop.ts";

const DEMO_TASK = `Investigate this repository and write a short technical report:
1. What is the overall architecture? Walk through every source file under src/ and explain its role.
2. How does the context_update patch validation work? List every rejection rule you can find.
3. Search for all TODO/FIXME/XXX markers and list them.
Use grep_search and read_file liberally (read whole files). Keep going until you have covered all of src/, then produce the final report.`;

function usage(): never {
  console.log(`CPAT — Context Patch as Tool (DeepSeek prototype)

Usage:
  node src/cli.ts run "<task>" [options]
  node src/cli.ts run --demo [options]
  node src/cli.ts tui

Options:
  --workdir <dir>      Tool sandbox root (default: cwd)
  --model <name>       DeepSeek model (default: deepseek-v4-flash)
  --max-context <n>    Working context budget in tokens (default: 16000;
                       keep it small to actually exercise budget pressure)
  --turns <n>          Max agent turns (default: 40)
  --allow-replace      Enable the replace op (off by default)
  --allow-redact       Enable the redact op (off by default)
  --demo               Run the built-in repository-analysis demo task
  --verbose            Print full tool traffic`);
  process.exit(1);
}

function parseArgs(argv: string[]): { task: string; config: CpatConfig; workdir: string; verbose: boolean } {
  if (argv[0] !== "run") usage();
  const rest = argv.slice(1);
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(a);
    }
  }

  const demo = flags.get("demo") === true;
  const task = demo ? DEMO_TASK : positional.join(" ");
  if (!task.trim()) usage();

  const runDir = join("runs", new Date().toISOString().replace(/[:.]/g, "-"));
  const config: CpatConfig = {
    model: String(flags.get("model") ?? "deepseek-v4-flash"),
    maxContextTokens: Number(flags.get("max-context") ?? 16000),
    softLimitRatio: 0.7,
    mustActRatio: 0.8,
    criticalRatio: 0.95,
    generational: flags.get("gen") === true,
    allowReplace: flags.get("allow-replace") === true,
    allowRedact: flags.get("allow-redact") === true,
    strictTools: true,
    maxTurns: Number(flags.get("turns") ?? 40),
    runDir,
    verbose: flags.get("verbose") === true,
  };
  return {
    task,
    config,
    workdir: resolve(String(flags.get("workdir") ?? process.cwd())),
    verbose: config.verbose,
  };
}

async function main(): Promise<void> {
  if (process.argv[2] === "tui") {
    // Guarantee UTF-8 rendering for CJK/multibyte text without the user having
    // to configure their shell. blessed reads the locale env at import time, so
    // these defaults must be set before the dynamic import below. We only fill
    // in a UTF-8 default when the env is missing or non-UTF-8; an explicit
    // UTF-8 locale set by the user is left untouched.
    const isUtf8 = (v?: string) => !!v && /utf-?8/i.test(v);
    if (!isUtf8(process.env.LC_ALL) && !isUtf8(process.env.LANG) && !isUtf8(process.env.LC_CTYPE)) {
      process.env.LANG = "en_US.UTF-8";
      process.env.LC_ALL = "en_US.UTF-8";
    }
    await import("./tui.ts");
    return;
  }
  const { task, config, workdir } = parseArgs(process.argv.slice(2));
  const env = loadDeepSeekEnv();
  const client = new DeepSeekClient(env);

  console.log(`model=${config.model}  budget=${config.maxContextTokens} tokens  workdir=${workdir}`);
  console.log(`run dir: ${config.runDir}\n`);

  const result = await runAgent({
    task,
    config,
    client,
    workdir,
    onTurn: (t) => {
      const cache = t.promptTokens > 0 ? ` cache ${Math.round((100 * t.cacheHitTokens) / t.promptTokens)}%` : "";
      const tools = t.toolCalls.length ? `  → ${t.toolCalls.join(", ")}` : "  → final answer";
      const patch = t.patchSummary ? `  [patch: ${t.patchSummary}]` : "";
      const nudge = t.nudged ? "  [governance nudge]" : "";
      const fallback = t.fallbackOffloads > 0 ? ` (runtime offloaded ${t.fallbackOffloads})` : "";
      const pressure = t.pressure !== "ok" ? `  ⚠ ${t.pressure}${fallback}` : "";
      console.log(`turn ${String(t.turn).padStart(2)}: ${t.promptTokens} in${cache} / ${t.completionTokens} out${pressure}${tools}${patch}${nudge}`);
    },
  });

  console.log(`\n=== final answer (${result.turns} turns) ===\n`);
  console.log(result.answer);
  console.log(`\n=== metrics ===`);
  console.log(JSON.stringify(result.metrics, null, 2));

  writeFileSync(join(config.runDir, "metrics.json"), JSON.stringify(result.metrics, null, 2));
  writeFileSync(join(config.runDir, "answer.md"), result.answer);
  console.log(`\nartifacts: ${config.runDir}/{journal.jsonl,content/,metrics.json,answer.md}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
