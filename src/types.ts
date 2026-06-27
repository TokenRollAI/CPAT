/**
 * CPAT — Context Patch as Tool.
 *
 * Storage model (single-copy):
 *   ContentStore  — every payload is stored exactly once at ingestion,
 *                   addressed as artifact://<key>. The only recovery channel.
 *   Journal       — append-only event log (ingest / patch / llm_call).
 *                   Metadata + content keys only, never full payload copies.
 *   ContextBlock  — patchable working state, addressable by id.
 *   ContextView   — the block list actually rendered into the next LLM call.
 *
 * payload_offload is therefore a pure view-level operation: the block stops
 * inlining its content and renders an ArtifactRef instead. Zero copy.
 */

export type Role = "user" | "assistant" | "tool" | "runtime";

export type BlockKind =
  | "system_prompt" // runtime extension: system prompt as a block, never patchable
  | "user_message"
  | "assistant_message"
  | "reasoning_trace"
  | "tool_result"
  | "summary"
  | "artifact_ref"
  | "task_state"
  | "budget_report";

/**
 * "model"        — rendered into the next context view.
 * "archived"     — kept in the block store, not rendered; recoverable.
 * "hidden"       — not rendered and not listed in the manifest.
 * "api_required" — runtime-internal: DeepSeek thinking mode requires
 *                  reasoning_content to be replayed while a tool-call chain is
 *                  open. The agent cannot patch api_required blocks; the
 *                  runtime downgrades them to "hidden" once the chain closes.
 */
export type Visibility = "model" | "archived" | "hidden" | "api_required";

export type Retention = "ephemeral" | "session" | "persistent";

export type ArtifactStoreKind = "file" | "object_store" | "sqlite" | "s3";

export interface ArtifactRef {
  artifact_id: string;
  uri: string; // artifact://<id>
  store: ArtifactStoreKind;
  summary: string;
  retrieval_hint: string;
}

export interface ContextBlock {
  id: string;
  role: Role;
  kind: BlockKind;

  description: string;
  content: string | ArtifactRef;

  source_ids: string[];
  token_count: number;

  visibility: Visibility;
  retention: Retention;

  protected?: boolean;
  version: number;
  created_at: string;

  /**
   * Runtime-internal API replay state. Not part of the semantic context view
   * and never exposed to the agent for patching. Keeps DeepSeek's multi-turn
   * tool-call protocol valid regardless of semantic patches:
   *   - tool_call_id / name: for role:"tool" messages.
   *   - tool_calls: original assistant tool_calls payload.
   *   - reasoning_content: thinking-mode trace that must be replayed while the
   *     tool-call chain is open.
   */
  api?: {
    tool_call_id?: string;
    name?: string;
    tool_calls?: ToolCall[];
    reasoning_content?: string;
  };
}

export interface TokenBudget {
  max: number;
  soft_limit: number;
  used: number;
}

export interface ContextView {
  blocks: string[]; // ordered block ids rendered into the next call
  token_budget: TokenBudget;
}

// ---------------------------------------------------------------------------
// Context operations (the payload of the context_update tool)
// ---------------------------------------------------------------------------

export type ContextOperation =
  | {
      op: "compact";
      ids: string[];
      output: {
        id?: string;
        description: string;
        content: string;
      };
      preserve: string[];
      drop: string[];
    }
  | {
      op: "payload_offload";
      ids: string[];
      store: ArtifactStoreKind;
      replace_with: {
        description: string;
        summary: string;
        retrieval_hint: string;
      };
    }
  | {
      op: "redact";
      ids: string[];
      drop_fields: string[];
      preserve_fields?: string[];
    }
  | {
      op: "set_visibility";
      ids: string[];
      visibility: "model" | "archived" | "hidden";
    }
  | {
      op: "replace";
      id: string;
      content: string;
      description?: string;
    }
  | {
      // Inverse of payload_offload: re-inline an offloaded block's full payload
      // from the content store. Zero-copy (the payload already lives at the
      // block's <id>@v<version> key); version is unchanged.
      op: "restore";
      ids: string[];
    }
  | {
      // Consolidate >=2 semantically overlapping blocks into one canonical
      // block, archiving the sources (the supersede chain). resolution records
      // intent: "update" combines, "contradiction" marks the older info as
      // superseded by the newer.
      op: "merge";
      ids: string[];
      output: {
        description: string;
        content: string;
      };
      resolution: "update" | "contradiction";
    }
  | {
      // Fold a contiguous block range (a finished subtask trajectory) into a
      // single scoped summary, archiving the range. Like compact but for a
      // structurally-marked, recoverable subtask branch (unfold via
      // set_visibility=model on the archived sources).
      op: "fold";
      ids: string[];
      output: {
        description: string;
        content: string;
      };
      scope_label: string;
    };

export interface ContextUpdateRequest {
  operations: ContextOperation[];
  reason: string;
}

export interface PatchRejection {
  op_index: number;
  rule: string;
  message: string;
}

export interface PatchResult {
  ok: boolean;
  applied: number;
  rejections: PatchRejection[];
  freed_tokens: number;
  created_block_ids?: string[];
  budget: TokenBudget;
}

export type JournalEvent =
  | {
      type: "ingest";
      seq: number;
      ts: string;
      block_id: string;
      role: Role;
      kind: BlockKind;
      content_key: string;
      token_count: number;
      description: string;
    }
  | {
      type: "patch";
      seq: number;
      ts: string;
      actor: "agent" | "runtime";
      reason: string;
      operations: ContextOperation[];
      result: PatchResult;
    }
  | {
      type: "llm_call";
      seq: number;
      ts: string;
      model: string;
      usage: ChatUsage;
      visible_blocks: number;
      est_view_tokens: number;
    };

// ---------------------------------------------------------------------------
// Budget report (injected by the runtime as a block, never auto-compacts)
// ---------------------------------------------------------------------------

export interface BudgetReportContent {
  used_tokens: number;
  max_tokens: number;
  soft_limit: number;
  pressure: "soft" | "must_act" | "critical";
  largest_blocks: Array<{
    id: string;
    kind: BlockKind;
    tokens: number;
    suggested_ops: string[];
  }>;
  required_preserve: string[];
}

// ---------------------------------------------------------------------------
// OpenAI-compatible chat types (the subset DeepSeek needs)
// ---------------------------------------------------------------------------

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    strict?: boolean;
    parameters: Record<string, unknown>;
  };
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

export interface ChatResponse {
  message: ChatMessage;
  finish_reason: string;
  usage: ChatUsage;
}

// ---------------------------------------------------------------------------
// Runtime configuration
// ---------------------------------------------------------------------------

export interface CpatConfig {
  model: string;
  /** Working context budget. Keep far below the real 1M window for experiments. */
  maxContextTokens: number;
  /** Fraction of max at which a budget_report block is injected (default 0.7). */
  softLimitRatio: number;
  /** Fraction at which task turns should stay narrow and boundary maintenance is expected. */
  mustActRatio: number;
  /** Fraction at which the runtime force-offloads largest tool results (default 0.95). */
  criticalRatio: number;
  /**
   * Generational tail rendering + batched, net-benefit-gated offload. When on,
   * the view lays bulky tool-result payloads out at the tail in generations and
   * retires whole generations at once, preserving the cached stable prefix.
   * Off → legacy insertion-order rendering + per-block critical fallback.
   */
  generational: boolean;
  /** MVP gates: replace/redact are off by default per the staged plan. */
  allowReplace: boolean;
  allowRedact: boolean;
  /** Ask DeepSeek for strict JSON-schema tool calls; falls back if rejected. */
  strictTools: boolean;
  maxTurns: number;
  runDir: string;
  verbose: boolean;
}
