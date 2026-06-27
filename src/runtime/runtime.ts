import { mkdirSync } from "node:fs";
import type {
  ChatMessage,
  ChatUsage,
  ContextOperation,
  ContextUpdateRequest,
  ContextView,
  CpatConfig,
  PatchResult,
  TokenBudget,
  ToolCall,
} from "../types.ts";
import { BlockStore, describeText } from "./blocks.ts";
import { applyContextUpdate } from "./patch.ts";
import { ContentStore, Journal } from "./stores.ts";
import { buildBudgetReport, buildMessages } from "./view.ts";

export type Pressure = "ok" | "soft" | "must_act" | "critical";

/**
 * Context runtime facade:
 *   content store (single copy) + journal (append-only) + block store
 *   + view builder + budget monitor + patch engine.
 */
export class ContextRuntime {
  readonly journal: Journal;
  readonly content: ContentStore;
  readonly blocks: BlockStore;

  /** Calibration: actual prompt tokens vs our estimate for the same view. */
  private lastEstimate = 0;
  private lastActualPrompt = 0;
  /**
   * Cache economics, learned from the last call's usage. cachedFraction is the
   * share of prompt tokens DeepSeek served from cache (the prefix that survived
   * our last edit). It drives the net-benefit gate: a cheap cached prefix means
   * keeping a bulky block costs little, so offload must clear a higher bar.
   */
  private cachedFraction = 0;
  private llmCalls = 0;
  runtimeFallbacks = 0;
  readonly config: CpatConfig;

  constructor(config: CpatConfig) {
    this.config = config;
    mkdirSync(config.runDir, { recursive: true });
    this.journal = new Journal(config.runDir);
    this.content = new ContentStore(config.runDir);
    this.blocks = new BlockStore(this.content, this.journal);
  }

  // -- ingestion --------------------------------------------------------------

  ingestSystem(content: string): void {
    this.blocks.createSystem(content);
  }

  ingestUser(content: string): void {
    this.blocks.createUserMessage(content);
  }

  ingestAssistant(msg: ChatMessage): void {
    // The previous tool-call round is complete once a new assistant message
    // arrives — its reasoning_content no longer needs API replay.
    this.releaseReasoning();
    this.blocks.createAssistantMessage(msg);
  }

  ingestToolResult(toolCall: ToolCall, output: string): void {
    let args = "";
    try {
      const parsed = JSON.parse(toolCall.function.arguments || "{}");
      args = Object.entries(parsed)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ")
        .slice(0, 80);
    } catch {
      args = toolCall.function.arguments.slice(0, 80);
    }
    this.blocks.createToolResult(
      toolCall,
      output,
      describeText(`Result of ${toolCall.function.name}(${args})`, output),
    );
  }

  private releaseReasoning(): void {
    for (const b of this.blocks.all()) {
      if (b.kind === "reasoning_trace" && b.visibility === "api_required") {
        b.visibility = "hidden";
        const parent = b.source_ids[0] ? this.blocks.get(b.source_ids[0]) : undefined;
        if (parent?.api) delete parent.api.reasoning_content;
      }
    }
  }

  // -- view + budget ------------------------------------------------------------

  buildView(ephemeralTailMessages?: ChatMessage[]): { messages: ChatMessage[]; view: ContextView } {
    const { messages, view } = buildMessages(this.blocks, ephemeralTailMessages, {
      generational: this.config.generational,
    });
    this.lastEstimate = view.token_budget.used;
    view.token_budget = this.budget(view.token_budget.used);
    return { messages, view };
  }

  private budget(used: number): TokenBudget {
    return {
      max: this.config.maxContextTokens,
      soft_limit: Math.floor(this.config.maxContextTokens * this.config.softLimitRatio),
      used,
    };
  }

  /** Calibrated estimate of the next call's prompt tokens. */
  estimatedUsed(): number {
    const { view } = buildMessages(this.blocks, undefined, {
      generational: this.config.generational,
    });
    const est = view.token_budget.used;
    if (this.lastActualPrompt > 0 && this.lastEstimate > 0) {
      const ratio = Math.min(2, Math.max(0.5, this.lastActualPrompt / this.lastEstimate));
      return Math.round(est * ratio);
    }
    return est;
  }

  recordLlmCall(model: string, usage: ChatUsage, view: ContextView): void {
    this.lastActualPrompt = usage.prompt_tokens;
    this.llmCalls += 1;
    const hit = usage.prompt_cache_hit_tokens;
    if (hit !== undefined && usage.prompt_tokens > 0) {
      this.cachedFraction = Math.min(1, hit / usage.prompt_tokens);
    }
    this.journal.append("llm_call", {
      model,
      usage,
      visible_blocks: view.blocks.length,
      est_view_tokens: view.token_budget.used,
    });
  }

  pressureOf(used: number): Pressure {
    const max = this.config.maxContextTokens;
    if (used >= max * this.config.criticalRatio) return "critical";
    if (used >= max * this.config.mustActRatio) return "must_act";
    if (used >= max * this.config.softLimitRatio) return "soft";
    return "ok";
  }

  /**
   * Budget monitor. Called before each LLM call:
   *   soft      → inject a budget_report block; task turns should stay narrow.
   *   must_act  → same report; boundary maintenance or imminent overflow should
   *               produce a minimal patch / explicit no-op.
   *   critical  → runtime safety net: force-offload largest tool results,
   *               then report what happened.
   */
  checkBudget(): { pressure: Pressure; report?: string } {
    let used = this.estimatedUsed();
    let pressure = this.pressureOf(used);
    if (pressure === "ok") return { pressure };

    let reportPressure: "soft" | "must_act" | "critical" = pressure;
    if (pressure === "critical") {
      if (this.config.generational) {
        this.generationalFallback();
      } else {
        this.criticalFallback();
      }
      used = this.estimatedUsed();
      const after = this.pressureOf(used);
      // still report what the fallback did, even if pressure is relieved
      reportPressure = after === "ok" || after === "soft" ? "soft" : after;
      pressure = reportPressure;
    }

    // Budget reports are runtime-owned and ephemeral: hide the previous one
    // (not archive — they must not tempt the agent from the manifest).
    for (const b of this.blocks.all()) {
      if (b.kind === "budget_report" && b.visibility === "model") {
        b.visibility = "hidden";
      }
    }

    const report = buildBudgetReport(this.blocks, this.budget(used), reportPressure);
    const content = JSON.stringify(report, null, 2);
    const block = this.blocks.create({
      idPrefix: "budget",
      role: "runtime",
      kind: "budget_report",
      description: `Context budget pressure report (${pressure}).`,
      content,
      retention: "ephemeral",
    });
    return { pressure, report: block.id };
  }

  /** 95% safety net: offload the largest inline tool results, largest first. */
  private criticalFallback(): void {
    const soft = this.config.maxContextTokens * this.config.softLimitRatio;
    // Only bulky payloads are worth force-offloading; tiny results would
    // shred the context into refs for negligible savings.
    const candidates = this.blocks
      .visible()
      .filter(
        (b) =>
          b.kind === "tool_result" &&
          typeof b.content === "string" &&
          b.token_count >= 300,
      )
      .sort((a, b) => b.token_count - a.token_count);

    for (const target of candidates) {
      if (this.estimatedUsed() < soft) break;
      const text = target.content as string;
      const ops: ContextOperation[] = [
        {
          op: "payload_offload",
          ids: [target.id],
          store: "file",
          replace_with: {
            description: `${target.description} (runtime auto-offloaded)`,
            summary:
              `Auto-offloaded under critical budget pressure. Head of payload:\n` +
              text.slice(0, 300),
            retrieval_hint: `Call artifact_get with this block's uri if the raw payload is needed.`,
          },
        },
      ];
      this.applyUpdate(
        { operations: ops, reason: "runtime critical-pressure fallback" },
        "runtime",
      );
      this.runtimeFallbacks += 1;
    }
  }

  /**
   * Generational safety net. Instead of poking holes anywhere in the view, this
   * retires bulky tool-result chain GROUPS from the volatile tail in a single
   * batch, gated by net benefit (all in units of payloadTokens × FULL):
   *
   *   cost of KEEPING inline T more turns ≈ T × (1 − cachedFraction)
   *       (each turn re-sends the block; only the uncached share is paid)
   *   cost of OFFLOADING now              ≈ 1
   *       (a single full re-read if the block is revisited later)
   *
   * Offload only when keeping is the more expensive option:
   *       T × (1 − cachedFraction) > 1
   * so we SKIP (return early) when T × (1 − cachedFraction) ≤ 1. With a warm
   * cache (cachedFraction→1) keeping is nearly free, so the bar to offload is
   * high; with a cold cache (cachedFraction→0) even a couple of remaining turns
   * justify offloading. Survivors are promoted to a fresh generation so the
   * retired generation is always the contiguous oldest tail.
   */
  private generationalFallback(): void {
    const soft = this.config.maxContextTokens * this.config.softLimitRatio;
    const estRemainingTurns = Math.max(
      1,
      this.config.maxTurns - this.llmCalls,
    );
    // Net-benefit gate: skip offload when keeping the warm cache is cheaper than
    // offloading and possibly restoring later.
    if (estRemainingTurns * (1 - this.cachedFraction) <= 1) return;

    // Bulky inline tool-result blocks are the only worthwhile offload targets;
    // retire them oldest-first (insertion order) one chain at a time until we
    // drop back under the soft limit, promoting each retired block's generation
    // forward so the rendered tail stays a contiguous, prefix-preserving region.
    const targets = this.blocks
      .visible()
      .filter(
        (b) =>
          b.kind === "tool_result" &&
          typeof b.content === "string" &&
          b.token_count >= 300,
      );

    for (const target of targets) {
      if (this.estimatedUsed() < soft) break;
      const text = target.content as string;
      const ops: ContextOperation[] = [
        {
          op: "payload_offload",
          ids: [target.id],
          store: "file",
          replace_with: {
            description: `${target.description} (runtime batch-offloaded)`,
            summary:
              `Batch-offloaded under budget pressure (generational tail). Head of payload:\n` +
              text.slice(0, 300),
            retrieval_hint: `Call artifact_get with this block's uri if the raw payload is needed.`,
          },
        },
      ];
      const res = this.applyUpdate(
        { operations: ops, reason: "runtime generational batch fallback" },
        "runtime",
      );
      // Only promote/count a block we actually offloaded: if applyUpdate was
      // rejected (validation, etc.) the block is still inline, so advancing its
      // generation would wrongly reorder a block that never moved to the tail.
      if (res.ok) {
        // Promote: the offloaded block (now a small ref) moves to a fresh
        // generation at the tail end, so what remains of the old generation stays
        // a clean contiguous prefix rather than a hole-punched region.
        this.blocks.setGeneration(target.id, this.blocks.allocGeneration());
        this.runtimeFallbacks += 1;
      }
    }
  }

  // -- patching -----------------------------------------------------------------

  applyUpdate(req: ContextUpdateRequest, actor: "agent" | "runtime"): PatchResult {
    const outcome = applyContextUpdate(this.blocks, this.content, req.operations, {
      allowReplace: this.config.allowReplace,
      allowRedact: this.config.allowRedact,
    });
    const result: PatchResult = {
      ok: outcome.ok,
      applied: outcome.applied,
      rejections: outcome.rejections,
      freed_tokens: outcome.freed_tokens,
      created_block_ids: outcome.created_block_ids,
      budget: this.budget(this.estimatedUsed()),
    };
    this.journal.append("patch", {
      actor,
      reason: req.reason,
      operations: req.operations,
      result,
    });
    return result;
  }

  /** The single recovery channel for offloaded payloads. */
  artifactGet(uriOrKey: string): string | undefined {
    return this.content.get(uriOrKey);
  }
}
