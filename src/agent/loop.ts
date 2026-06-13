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
- Treat the context as working memory you govern. The runtime has a critical-pressure safety net that will force-offload your largest tool results, but relying on it is a FAILURE: it is dumb (largest-first, no understanding of what matters), it shreds your context unpredictably, and it means you stopped governing. A run where the runtime had to bail you out is a run you mismanaged. Govern early so it never fires.
- pressure=soft: patch now — archive or offload the exploration you have already digested. Do not wait.
- pressure=must_act: you are close to overflow. On THIS turn, before doing any more task work, call context_update to free space (offload bulky tool results you have already summarized, compact/fold finished exploration). Only if you genuinely cannot free anything useful, reply with the literal phrase "no_context_update_needed" plus a one-line justification — but treat that as a last resort, not the default. Do NOT simply keep reading more files under must_act pressure.
- Concretely under pressure: a large tool_result you have already read and understood should be payload_offloaded (you keep a summary + can artifact_get it back); a finished line of exploration (an assistant turn + its tool results) should be compacted or folded.
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

export type AgentMode = "cpat" | "react";

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
  agent_patches_rejected: number;
  runtime_fallback_offloads: number;
  governance_nudges: number;
  freed_tokens: number;
  ops_by_type: Record<string, number>;
  final_visible_tokens: number;
  final_visible_blocks: number;
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
  onTurn?: (log: TurnLog) => void;
}): Promise<RunResult & { runtime: ContextRuntime }> {
  const { task, config, client, workdir, onTurn } = opts;
  const mode: AgentMode = opts.mode ?? "cpat";
  const runtime = new ContextRuntime(config);
  const taskTools = new TaskTools(workdir);
  // ReAct control arm: only task tools, no governance tools, no safety net.
  const tools: ToolDefinition[] =
    mode === "react"
      ? [...taskToolDefs]
      : [...taskToolDefs, artifactGetTool, contextUpdateTool];

  runtime.ingestSystem(mode === "react" ? REACT_SYSTEM_PROMPT : SYSTEM_PROMPT);
  runtime.ingestUser(task);

  const turnLogs: TurnLog[] = [];
  const answers: string[] = [];
  const pending = [...(opts.followups ?? [])]; // followup questions to inject
  let answer = "(max turns reached without a final answer)";
  let governanceNudges = 0;

  for (let turn = 1; turn <= config.maxTurns; turn++) {
    const fallbacksBefore = runtime.runtimeFallbacks;
    // ReAct arm has no budget monitor and no runtime safety net: context just
    // accumulates. CPAT arm injects budget reports and force-offloads at 95%.
    const { pressure } = mode === "react" ? { pressure: "ok" as const } : runtime.checkBudget();
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

      // Soft governance enforcement: under must_act pressure the agent is
      // expected to patch (or explicitly opt out). If this turn it only did
      // task work — no context_update, no "no_context_update_needed" — nudge it
      // to govern on the next turn instead of letting it read its way to the
      // runtime safety net. The escape hatch is preserved; this only raises the
      // friction of ignoring pressure.
      const calledUpdate = log.toolCalls.includes("context_update");
      const optedOut = /no_context_update_needed/.test(resp.message.content ?? "");
      if (pressure === "must_act" && !calledUpdate && !optedOut) {
        governanceNudges += 1;
        log.nudged = true;
        runtime.ingestUser(
          "Reminder: context pressure is must_act and you continued task work without governing your context. " +
            "Next turn, before any more task tools, call context_update to free space — payload_offload the bulky " +
            "tool results you have already read, or compact/fold finished exploration. Do not let the runtime safety " +
            'net bail you out. If you truly cannot free anything, say "no_context_update_needed" with a reason.',
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
        // context (and any offloaded payloads) carry over, and ask the next.
        runtime.ingestUser(pending.shift()!);
        continue;
      }
      return {
        answer,
        answers,
        turns: turn,
        turnLogs,
        metrics: collectMetrics(runtime, governanceNudges),
        runtime,
      };
    }
    turnLogs.push(log);
    onTurn?.(log);
  }

  // Turn limit exhausted — flush a final answer with tools disabled so the
  // run never ends without a usable result.
  runtime.ingestUser(
    "Turn limit reached. Produce your final answer now from what you already know. Do not request tools.",
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

  return {
    answer,
    answers,
    turns: config.maxTurns,
    turnLogs,
    metrics: collectMetrics(runtime, governanceNudges),
    runtime,
  };
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

function collectMetrics(runtime: ContextRuntime, governanceNudges = 0): RunMetrics {
  const usages: ChatUsage[] = [];
  let agentApplied = 0;
  let agentRejected = 0;
  let freed = 0;
  const opsByType: Record<string, number> = {};

  for (const e of runtime.journal.events) {
    if (e.type === "llm_call") usages.push(e.usage);
    if (e.type === "patch") {
      if (e.result.ok) {
        if (e.actor === "agent") agentApplied += 1;
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
    agent_patches_rejected: agentRejected,
    runtime_fallback_offloads: runtime.runtimeFallbacks,
    governance_nudges: governanceNudges,
    freed_tokens: freed,
    ops_by_type: opsByType,
    final_visible_tokens: visible.reduce((s, b) => s + b.token_count, 0),
    final_visible_blocks: visible.length,
  };
}
