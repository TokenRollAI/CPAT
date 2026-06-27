import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import blessed from "blessed";
import type { CpatConfig } from "./types.ts";
import { loadDeepSeekEnv } from "./util/env.ts";
import { DeepSeekClient } from "./deepseek/client.ts";
import { runAgent, type TurnLog } from "./agent/loop.ts";

/**
 * Blessed-based TUI launcher for CPAT. A small form sets the key run knobs —
 * task, model, workdir and crucially the max working-context budget — then the
 * agent runs with every turn streamed live into a log pane.
 */

interface Defaults {
  task: string;
  model: string;
  maxContext: string;
  workdir: string;
  turns: string;
}

const DEFAULTS: Defaults = {
  task: "",
  model: "deepseek-v4-flash",
  maxContext: "16000",
  workdir: process.cwd(),
  turns: "40",
};

const screen = blessed.screen({
  smartCSR: true,
  fullUnicode: true,
  title: "CPAT — Context Patch as Tool",
});

const form = blessed.form<Record<string, never>>({
  parent: screen,
  keys: true,
  top: 0,
  left: 0,
  width: "100%",
  height: 14,
  label: " run config (Tab to move · Enter in a field to commit · Ctrl-R to run · Ctrl-C to quit) ",
  border: { type: "line" },
});

function field(label: string, top: number, value: string, censor = false) {
  blessed.text({ parent: form, top, left: 2, content: label });
  const input = blessed.textbox({
    parent: form,
    top,
    left: 18,
    width: "70%-20",
    height: 1,
    inputOnFocus: true,
    censor,
    style: { focus: { bg: "blue" }, bg: "black" },
  });
  input.setValue(value);
  return input;
}

const taskInput = field("task:", 1, DEFAULTS.task);
const modelInput = field("model:", 3, DEFAULTS.model);
const maxCtxInput = field("max-context:", 5, DEFAULTS.maxContext);
const workdirInput = field("workdir:", 7, DEFAULTS.workdir);
const turnsInput = field("max-turns:", 9, DEFAULTS.turns);

const hint = blessed.text({
  parent: form,
  top: 11,
  left: 2,
  style: { fg: "gray" },
  content: "max-context = working context budget in tokens; keep small to exercise budget pressure.",
});

const log = blessed.log({
  parent: screen,
  top: 14,
  left: 0,
  width: "100%",
  bottom: 0,
  label: " run log ",
  border: { type: "line" },
  scrollbar: { ch: " ", style: { bg: "blue" } },
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  keys: true,
  tags: true,
});

function write(line: string): void {
  log.log(line);
  screen.render();
}

let running = false;

async function run(): Promise<void> {
  if (running) return;
  const task = taskInput.getValue().trim();
  if (!task) {
    write("{red-fg}error:{/red-fg} task is empty.");
    return;
  }
  const maxContext = Number(maxCtxInput.getValue());
  if (!Number.isFinite(maxContext) || maxContext <= 0) {
    write("{red-fg}error:{/red-fg} max-context must be a positive number.");
    return;
  }
  running = true;

  const runDir = join("runs", new Date().toISOString().replace(/[:.]/g, "-"));
  const config: CpatConfig = {
    model: modelInput.getValue().trim() || DEFAULTS.model,
    maxContextTokens: maxContext,
    softLimitRatio: 0.7,
    mustActRatio: 0.8,
    criticalRatio: 0.95,
    generational: false,
    allowReplace: false,
    allowRedact: false,
    strictTools: true,
    maxTurns: Number(turnsInput.getValue()) || 40,
    runDir,
    verbose: false,
  };
  const workdir = resolve(workdirInput.getValue().trim() || process.cwd());

  write(`{cyan-fg}model={/cyan-fg}${config.model}  {cyan-fg}budget={/cyan-fg}${config.maxContextTokens} tokens`);
  write(`{cyan-fg}workdir={/cyan-fg}${workdir}`);
  write(`{cyan-fg}run dir={/cyan-fg}${config.runDir}`);
  write("");

  try {
    const env = loadDeepSeekEnv();
    const client = new DeepSeekClient(env);
    const result = await runAgent({
      task,
      config,
      client,
      workdir,
      onTurn: (t: TurnLog) => {
        const cache = t.promptTokens > 0 ? ` cache ${Math.round((100 * t.cacheHitTokens) / t.promptTokens)}%` : "";
        const tools = t.toolCalls.length ? ` → ${t.toolCalls.join(", ")}` : " → final answer";
        const patch = t.patchSummary ? ` {yellow-fg}[patch: ${t.patchSummary}]{/yellow-fg}` : "";
        const fallback = t.fallbackOffloads > 0 ? ` (runtime offloaded ${t.fallbackOffloads})` : "";
        const pressure = t.pressure !== "ok" ? ` {red-fg}⚠ ${t.pressure}${fallback}{/red-fg}` : "";
        write(
          `turn ${String(t.turn).padStart(2)}: ${t.promptTokens} in${cache} / ${t.completionTokens} out${pressure}${tools}${patch}`,
        );
      },
    });

    write("");
    write(`{green-fg}=== final answer (${result.turns} turns) ==={/green-fg}`);
    for (const line of result.answer.split("\n")) write(line);
    write("");
    write("{green-fg}=== metrics ==={/green-fg}");
    for (const line of JSON.stringify(result.metrics, null, 2).split("\n")) write(line);

    writeFileSync(join(config.runDir, "metrics.json"), JSON.stringify(result.metrics, null, 2));
    writeFileSync(join(config.runDir, "answer.md"), result.answer);
    write(`\n{cyan-fg}artifacts:{/cyan-fg} ${config.runDir}/{journal.jsonl,content/,metrics.json,answer.md}`);
  } catch (err) {
    write(`{red-fg}error:{/red-fg} ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    running = false;
    write("{gray-fg}(done — edit config and Ctrl-R to run again, Ctrl-C to quit){/gray-fg}");
  }
}

screen.key(["C-r"], () => void run());
screen.key(["C-c"], () => process.exit(0));

taskInput.focus();
screen.render();
