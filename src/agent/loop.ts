import type { ChatUsage, CpatConfig, ToolCall, ToolDefinition } from "../types.ts";
import { DeepSeekClient } from "../deepseek/client.ts";
import { ContextRuntime } from "../runtime/runtime.ts";
import {
  artifactGetTool,
  contextUpdateTool,
  parseContextUpdateArgs,
} from "./contextTool.ts";
import { TaskTools, taskToolDefs } from "./taskTools.ts";

const SYSTEM_PROMPT = `You are CPAT-agent: a research/coding agent that actively governs its own working context.

## How your context works
- The runtime renders your context from addressable blocks. Messages are tagged with [block:<id>] by the runtime. These tags are runtime-added — NEVER write [block:...] tags in your own replies.
- The final user message of every turn is a <context_manifest> listing each visible block (id, kind, tokens, description) and the archived blocks that can be restored. It is regenerated every turn; do not answer it directly.
- Under budget pressure the runtime injects a <budget_report> block (pressure: soft | must_act | critical) with the largest blocks and suggested operations.

## Context maintenance policy
- Treat the context as working memory you govern, but do most context maintenance at boundaries: after finishing a task loop, or immediately after a new user message clarifies what past context is still relevant. This avoids spending tool turns reorganizing memory while an active reasoning/tool-use chain is still unfolding.
- The runtime may run a boundary maintenance pass before you start answering a follow-up user message. In that pass, use context_update to keep only the context useful for the new request; use an empty operations list when no change is warranted.
- During ordinary task turns, do not call context_update just because you can. Finish the smallest useful investigation step, avoid opening broad new fronts under pressure, and leave large-scale cleanup for the next boundary pass unless overflow is imminent.
- pressure=soft: be conservative with new reads; prefer finishing the current narrow step so the next boundary pass can archive/offload digested material.
- pressure=must_act: you are close to overflow. Avoid broad task tools and either make a minimal context_update that prevents overflow or finish the current answer from known evidence. If you genuinely cannot free anything useful, reply with the literal phrase "no_context_update_needed" plus a one-line justification.
- pressure=critical: the runtime safety net may force-offload large tool results. This preserves API safety but is semantically dumb, so boundary maintenance should normally happen earlier.
- Concretely at boundaries: a large tool_result you have already read and understood should be payload_offloaded; finished exploration near the tail should be archived, compacted, or folded; duplicated findings should be merged only when the canonical summary is enough for future work.
- Operations available via context_update (transactional; rejections explain how to retry). Prefer the cheapest reversible move: archive < offload < compact/fold/merge.
  - set_visibility: archive blocks no longer needed (recoverable via visibility "model"); hide truly dead ones. Cheapest and reversible — reach for this first.
  - payload_offload: swap a bulky raw payload (large tool result) for a short inline summary + artifact reference. Always write a retrieval_hint. Recover later with artifact_get, or re-inline with restore, only if truly needed.
  - restore: re-inline a payload you previously offloaded when you need its full text back in context (inverse of payload_offload).
  - compact: replace finished exploration (ids) with a dense summary. Declare preserve (what the summary keeps) and drop (what is intentionally lost). Compact whole tool-call chains together (assistant turn + its tool results).
  - fold: collapse a CONTIGUOUS run of blocks for one finished subtask into a single scoped summary; pass a scope_label naming the subtask.
  - merge: consolidate 2+ overlapping or duplicate blocks (e.g. two reads of the same file) into one canonical block; set resolution to "update" (combine) or "contradiction" (newer supersedes older).
- Never invent block ids — only use ids from the manifest. Protected blocks (user requirements) can be compacted or archived but never lost: their constraints must survive in some visible block.
- budget_report blocks and the context_manifest are runtime-owned: the runtime rotates old budget reports automatically. NEVER include budget_* ids in a patch.
- Good patches preserve: user requirements and constraints, the current plan, open questions, and references needed for next steps.

## Task policy
- Use the task tools to investigate; keep tool usage purposeful. Read a few files at a time and patch finished exploration before opening new fronts — do not bulk-read everything at once.
- When the task is complete, reply with the final answer as plain text and no tool calls.`;

/**
 * Minimal ReAct baseline prompt: a standard tool-using agent with NO context
 * governance — no context_update, no budget reports, no runtime safety net.
 * Context simply accumulates. This is the control arm for measuring whether
 * CPAT's active governance actually improves task outcomes.
 */
const REACT_SYSTEM_PROMPT = `You are a research/coding agent. You investigate by calling tools and reason step by step (ReAct).

- The runtime tags each message with [block:<id>]; these are runtime-added — NEVER write [block:...] tags in your own replies.
- The final user message of every turn is a <context_manifest> listing what is in context; do not answer it directly.

## Task policy
- Use the task tools to investigate. Read the files you need to answer the task.
- When the task is complete, reply with the final answer as plain text and no tool calls.`;

export type AgentMode = "cpat" | "react" | "threshold";

export interface TurnLog {
  turn: number;
  pressure: string;
  fallbackOffloads: number;
  promptTokens: number;
  cacheHitTokens: number;
  completionTokens: number;
  toolCalls: string[];
  patchSummary?: string;
  nudged?: boolean;
}

export interface RunResult {
  /** The final question's answer (last of `answers`). Back-compat single-turn. */
  answer: string;
  /** One answer per question: [main task, ...followups]. */
  answers: string[];
  turns: number;
  turnLogs: TurnLog[];
  metrics: RunMetrics;
}

export interface RunMetrics {
  llm_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cache_hit_tokens: number;
  cache_miss_tokens: number;
  cache_hit_ratio: number;
  agent_patches_applied: number;
  agent_patches_noop: number;
  agent_patches_rejected: number;
  runtime_fallback_offloads: number;
  governance_nudges: number;
  boundary_maintenance_calls: number;
  freed_tokens: number;
  ops_by_type: Record<string, number>;
  final_visible_tokens: number;
  final_visible_blocks: number;
  /** ReAct death-knell: the run hit the hard context window and was forced to
   *  answer from whatever it had (the paper's "dialogue terminates early"). */
  terminated_early: boolean;
  /** Peak estimated view tokens reached during the run. */
  peak_view_tokens: number;
}

export async function runAgent(opts: {
  task: string;
  config: CpatConfig;
  client: DeepSeekClient;
  workdir: string;
  mode?: AgentMode;
  /** Extra questions asked in sequence on the SAME runtime after the main task
   *  is answered. Context accumulates across questions — this is what exercises
   *  the offload→restore reversible cycle over a long-horizon loop. */
  followups?: string[];
  /** Hard context window (tokens). When the rendered view exceeds this, the
   *  react arm is forced to answer from what it has (the paper's "dialogue
   *  terminates early"); the threshold/cpat arms keep their runtime safety net
   *  and never terminate. Independent of CpatConfig.maxContextTokens (which
   *  drives CPAT's soft/must_act/critical ladder). 0 = no hard window. */
  hardWindowTokens?: number;
  /** Restrict the task tools offered to the agent to this set of names (e.g.
   *  ["list_dir", "read_file"] to force whole-document reads with no grep
   *  shortcut). Undefined = all task tools. context_update/artifact_get are
   *  unaffected (still added for the cpat arm). */
  taskToolNames?: string[];
  onTurn?: (log: TurnLog) => void;
}): Promise<RunResult & { runtime: ContextRuntime }> {
  const { task, config, client, workdir, onTurn } = opts;
  const mode: AgentMode = opts.mode ?? "cpat";
  const hardWindow = opts.hardWindowTokens ?? 0;
  const runtime = new ContextRuntime(config);
  const taskTools = new TaskTools(workdir);
  const baseTaskTools = opts.taskToolNames
    ? taskToolDefs.filter((t) => opts.taskToolNames!.includes(t.function.name))
    : taskToolDefs;
  // Three-arm setup (aligned with CAT paper, arXiv:2512.22087):
  //   react     — no governance tool, no runtime safety net; append-only.
  //   threshold — runtime safety net (checkBudget auto-offloads at critical)
  //               but NO context_update tool: passive, runtime-driven only.
  //   cpat      — full active governance: context_update tool + ladder + nudges.
  const tools: ToolDefinition[] =
    mode === "cpat"
      ? [...baseTaskTools, artifactGetTool, contextUpdateTool]
      : [...baseTaskTools]; // react & threshold: task tools only

  // react/threshold get the minimal prompt (no governance guidance); only cpat
  // is told to actively manage its context.
  runtime.ingestSystem(mode === "cpat" ? SYSTEM_PROMPT : REACT_SYSTEM_PROMPT);
  runtime.ingestUser(task);

  const turnLogs: TurnLog[] = [];
  const answers: string[] = [];
  const pending = [...(opts.followups ?? [])]; // followup questions to inject
  let answer = "(max turns reached without a final answer)";
  let governanceNudges = 0;
  let boundaryMaintenanceCalls = 0;
  let terminatedEarly = false;
  let peakViewTokens = 0;

  for (let turn = 1; turn <= config.maxTurns; turn++) {
    const fallbacksBefore = runtime.runtimeFallbacks;
    // react: no budget monitor / safety net (append-only).
    // threshold & cpat: checkBudget runs the runtime safety net.
    const { pressure } = mode === "react" ? { pressure: "ok" as const } : runtime.checkBudget();

    // Hard context window. After any runtime safety net has run, measure the
    // view. If still over the window, the react arm cannot continue — it is
    // forced to answer from what it has (paper: "dialogue terminates early").
    const estTokens = runtime.estimatedUsed();
    if (estTokens > peakViewTokens) peakViewTokens = estTokens;
    if (hardWindow > 0 && estTokens > hardWindow && mode === "react") {
      terminatedEarly = true;
      break;
    }

    const { messages, view } = runtime.buildView();

    const resp = await client.chat({ model: config.model, messages, tools });
    runtime.recordLlmCall(config.model, resp.usage, view);
    runtime.ingestAssistant(resp.message);

    const log: TurnLog = {
      turn,
      pressure,
      fallbackOffloads: runtime.runtimeFallbacks - fallbacksBefore,
      promptTokens: resp.usage.prompt_tokens,
      cacheHitTokens: resp.usage.prompt_cache_hit_tokens ?? 0,
      completionTokens: resp.usage.completion_tokens,
      toolCalls: (resp.message.tool_calls ?? []).map((t) => t.function.name),
    };

    if (resp.message.tool_calls?.length) {
      for (const tc of resp.message.tool_calls) {
        const output = dispatchTool(tc, runtime, taskTools, log);
        runtime.ingestToolResult(tc, output);
      }

      // Soft warning only. Larger maintenance is expected at user-message
      // boundaries, but this metric still marks ordinary task turns that kept
      // opening tools while already under must_act pressure.
      const calledUpdate = log.toolCalls.includes("context_update");
      const optedOut = /no_context_update_needed/.test(resp.message.content ?? "");
      if (mode === "cpat" && pressure === "must_act" && !calledUpdate && !optedOut) {
        governanceNudges += 1;
        log.nudged = true;
        runtime.ingestUser(
          "Reminder: context pressure is must_act and you continued task work. Keep the next step narrow; " +
            "do not open broad new exploration. If overflow is imminent, use a minimal context_update; otherwise " +
            'finish from known evidence or say "no_context_update_needed" with a reason.',
        );
      }
    } else {
      // A final (tool-free) answer for the current question.
      answer = resp.message.content ?? "";
      answers.push(answer);
      turnLogs.push(log);
      onTurn?.(log);
      if (pending.length > 0) {
        // More questions in this long-horizon loop: keep the SAME runtime so
        // context (and any offloaded payloads) carry over, ask the next, then
        // run one ephemeral boundary-maintenance pass before normal task work.
        runtime.ingestUser(pending.shift()!);
        if (mode === "cpat") {
          boundaryMaintenanceCalls += 1;
          await runBoundaryMaintenance({ runtime, client, config });
        }
        continue;
      }
      return {
        answer,
        answers,
        turns: turn,
        turnLogs,
        metrics: collectMetrics(runtime, governanceNudges, boundaryMaintenanceCalls, terminatedEarly, peakViewTokens),
        runtime,
      };
    }
    turnLogs.push(log);
    onTurn?.(log);
  }

  // Loop ended — either turn limit exhausted, or (react) the hard context
  // window was hit. Flush a final answer with tools disabled so the run never
  // ends without a usable result. A window-terminated react run answers from
  // its (now-overflowing) context: this is the paper's "dialogue terminates
  // early" failure, captured as terminated_early in the metrics.
  runtime.ingestUser(
    terminatedEarly
      ? "Your context window is exhausted; you can read no more. Produce your best final answer NOW from what you already have. Do not request tools."
      : "Turn limit reached. Produce your final answer now from what you already know. Do not request tools.",
  );
  if (mode !== "react") runtime.checkBudget();
  const { messages, view } = runtime.buildView();
  const resp = await client.chat({
    model: config.model,
    messages,
    tools,
    toolChoice: "none",
  });
  runtime.recordLlmCall(config.model, resp.usage, view);
  runtime.ingestAssistant(resp.message);
  if (resp.message.content?.trim()) answer = resp.message.content;
  answers.push(answer);
  // Any questions never reached (e.g. react terminated before later followups)
  // are recorded as empty so answers[] stays aligned with the question list.
  while (pending.length > 0) {
    pending.shift();
    answers.push("");
  }

  return {
    answer,
    answers,
    turns: config.maxTurns,
    turnLogs,
    metrics: collectMetrics(runtime, governanceNudges, boundaryMaintenanceCalls, terminatedEarly, peakViewTokens),
    runtime,
  };
}

async function runBoundaryMaintenance(opts: {
  runtime: ContextRuntime;
  client: DeepSeekClient;
  config: CpatConfig;
}): Promise<void> {
  const { runtime, client, config } = opts;
  const { pressure } = runtime.checkBudget();
  const { messages, view } = runtime.buildView([
    { role: "user", content: boundaryMaintenancePrompt(pressure) },
  ]);
  const resp = await client.chat({
    model: config.model,
    messages,
    tools: [contextUpdateTool],
  });
  runtime.recordLlmCall(config.model, resp.usage, view);

  const call = resp.message.tool_calls?.find((tc) => tc.function.name === "context_update");
  if (!call) return;
  const req = parseContextUpdateArgs(call.function.arguments);
  runtime.applyUpdate(req, "agent");
}

function boundaryMaintenancePrompt(pressure: string): string {
  return (
    "<context_maintenance_boundary>\n" +
    "A previous task loop has ended and a new user message is now in context. Before answering it, " +
    "perform one context_update transaction that organizes memory for the NEW request.\n\n" +
    "Decision policy:\n" +
    "- If the previous context is already small, still relevant, or expensive to rewrite for cache reasons, " +
    'call context_update with operations: [] and reason "boundary maintenance: no update needed".\n' +
    "- Prefer cache-friendly reversible moves: archive irrelevant tail blocks, payload_offload bulky raw " +
    "tool results already digested, restore only if the new request needs exact offloaded text.\n" +
    "- Use compact/fold/merge only for completed tail work where the summary clearly preserves requirements, " +
    "decisions, open questions, and source references. Avoid rewriting early high-reuse prefix blocks.\n" +
    "- Do not answer the user here, and do not request task tools. This pass is only for context_update.\n" +
    `Current budget pressure: ${pressure}.\n` +
    "</context_maintenance_boundary>"
  );
}

function dispatchTool(
  tc: ToolCall,
  runtime: ContextRuntime,
  taskTools: TaskTools,
  log: TurnLog,
): string {
  const name = tc.function.name;
  try {
    if (name === "context_update") {
      const req = parseContextUpdateArgs(tc.function.arguments);
      const result = runtime.applyUpdate(req, "agent");
      log.patchSummary = result.ok
        ? `applied ${result.applied} ops, freed ~${result.freed_tokens} tokens`
        : `rejected: ${result.rejections.map((r) => r.rule).join(", ")}`;
      return JSON.stringify(result);
    }
    if (name === "artifact_get") {
      const args = JSON.parse(tc.function.arguments || "{}") as {
        uri?: string;
        max_chars?: number;
      };
      const payload = runtime.artifactGet(args.uri ?? "");
      if (payload === undefined) return `error: no artifact at "${args.uri}"`;
      const max = args.max_chars ?? 6000;
      return payload.length > max
        ? payload.slice(0, max) + `\n…[truncated, full payload is ${payload.length} chars]`
        : payload;
    }
    return taskTools.dispatch(name, tc.function.arguments);
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function collectMetrics(
  runtime: ContextRuntime,
  governanceNudges = 0,
  boundaryMaintenanceCalls = 0,
  terminatedEarly = false,
  peakViewTokens = 0,
): RunMetrics {
  const usages: ChatUsage[] = [];
  let agentApplied = 0;
  let agentNoop = 0;
  let agentRejected = 0;
  let freed = 0;
  const opsByType: Record<string, number> = {};

  for (const e of runtime.journal.events) {
    if (e.type === "llm_call") usages.push(e.usage);
    if (e.type === "patch") {
      if (e.result.ok) {
        if (e.actor === "agent") {
          if (e.result.applied > 0) agentApplied += 1;
          else agentNoop += 1;
        }
        freed += e.result.freed_tokens;
        for (const op of e.operations) {
          opsByType[op.op] = (opsByType[op.op] ?? 0) + 1;
        }
      } else if (e.actor === "agent") {
        agentRejected += 1;
      }
    }
  }

  const prompt = usages.reduce((s, u) => s + u.prompt_tokens, 0);
  const hit = usages.reduce((s, u) => s + (u.prompt_cache_hit_tokens ?? 0), 0);
  const miss = usages.reduce((s, u) => s + (u.prompt_cache_miss_tokens ?? 0), 0);
  const visible = runtime.blocks.visible();

  return {
    llm_calls: usages.length,
    prompt_tokens: prompt,
    completion_tokens: usages.reduce((s, u) => s + u.completion_tokens, 0),
    cache_hit_tokens: hit,
    cache_miss_tokens: miss,
    cache_hit_ratio: prompt > 0 ? Number((hit / prompt).toFixed(3)) : 0,
    agent_patches_applied: agentApplied,
    agent_patches_noop: agentNoop,
    agent_patches_rejected: agentRejected,
    runtime_fallback_offloads: runtime.runtimeFallbacks,
    governance_nudges: governanceNudges,
    boundary_maintenance_calls: boundaryMaintenanceCalls,
    freed_tokens: freed,
    ops_by_type: opsByType,
    final_visible_tokens: visible.reduce((s, b) => s + b.token_count, 0),
    final_visible_blocks: visible.length,
    terminated_early: terminatedEarly,
    peak_view_tokens: peakViewTokens,
  };
}
