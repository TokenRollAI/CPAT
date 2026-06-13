import type {
  BudgetReportContent,
  ChatMessage,
  ContextBlock,
  ContextView,
  TokenBudget,
} from "../types.ts";
import { estimateTokens } from "../util/misc.ts";
import { BlockStore } from "./blocks.ts";
import { ContentStore } from "./stores.ts";

/**
 * Renders the context view for the next DeepSeek call.
 *
 * Cache-friendliness principle: the message list is the block order — a
 * stable prefix that only changes where a patch touched it. The per-turn
 * volatile parts (manifest, budget reports) are appended at the TAIL so the
 * persisted prefix keeps hitting DeepSeek's context cache.
 */
export function buildMessages(store: BlockStore): {
  messages: ChatMessage[];
  view: ContextView;
} {
  const messages: ChatMessage[] = [];
  const viewIds: string[] = [];

  for (const block of store.all()) {
    if (block.visibility !== "model") continue;
    viewIds.push(block.id);
    messages.push(renderBlock(store, block));
  }

  // Volatile tail: the manifest is rebuilt every turn and never stored as a
  // block (it would otherwise accumulate and break the stable prefix).
  const manifest = buildManifest(store);
  messages.push({ role: "user", content: manifest });

  const estTokens =
    messages.reduce((s, m) => s + estimateTokens(m.content ?? "") , 0) +
    messages.length * 4;

  return {
    messages,
    view: {
      blocks: viewIds,
      token_budget: { max: 0, soft_limit: 0, used: estTokens },
    },
  };
}

function renderBlock(store: BlockStore, block: ContextBlock): ChatMessage {
  const tag = `[block:${block.id}]`;
  const text = store.renderedText(block);

  switch (block.kind) {
    case "system_prompt":
      return { role: "system", content: text };
    case "user_message":
      return { role: "user", content: `${tag}\n${text}` };
    case "budget_report":
      return { role: "user", content: `${tag}\n<budget_report>\n${text}\n</budget_report>` };
    case "tool_result":
    case "artifact_ref":
      if (block.api?.tool_call_id) {
        return {
          role: "tool",
          tool_call_id: block.api.tool_call_id,
          content: `${tag}\n${text}`,
        };
      }
      return { role: "user", content: `${tag}\n${text}` };
    case "assistant_message": {
      const msg: ChatMessage = { role: "assistant", content: text };
      if (block.api?.tool_calls) msg.tool_calls = block.api.tool_calls;
      // DeepSeek thinking mode: reasoning_content must be replayed while the
      // tool-call chain is open. Runtime-internal; not a semantic block.
      if (block.api?.reasoning_content) {
        msg.reasoning_content = block.api.reasoning_content;
      }
      return msg;
    }
    case "summary":
    case "task_state":
      return {
        role: "assistant",
        content: `${tag} [compacted context — summary of ${block.source_ids.join(", ") || "earlier turns"}]\n${text}`,
      };
    case "reasoning_trace":
      // Rendered only if the agent deliberately set it to "model".
      return { role: "assistant", content: `${tag} [reasoning trace]\n${text}` };
  }
}

export function buildManifest(store: BlockStore): string {
  const lines: string[] = ["<context_manifest>"];
  for (const b of store.all()) {
    if (b.visibility === "model") {
      lines.push(
        `- block_id: ${b.id}`,
        `  kind: ${b.kind}`,
        `  tokens: ${b.token_count}`,
        ...(b.protected ? ["  protected: true"] : []),
        ...(ContentStore.isRef(b.content)
          ? [`  offloaded: true (payload at ${b.content.uri})`]
          : []),
        ...(b.kind === "budget_report"
          ? ["  runtime_owned: true (rotated automatically — never include in patches)"]
          : []),
        `  description: ${b.description}`,
      );
    }
  }
  const archived = store
    .all()
    .filter(
      (b) =>
        b.visibility === "archived" &&
        b.kind !== "budget_report" &&
        b.kind !== "reasoning_trace",
    );
  if (archived.length > 0) {
    lines.push("archived (recoverable via set_visibility=model):");
    for (const b of archived) {
      lines.push(`- ${b.id} (${b.kind}, ${b.token_count} tokens): ${b.description}`);
    }
  }
  lines.push("</context_manifest>");
  return lines.join("\n");
}

export function buildBudgetReport(
  store: BlockStore,
  budget: TokenBudget,
  pressure: BudgetReportContent["pressure"],
): BudgetReportContent {
  const candidates = store
    .visible()
    .filter(
      (b) =>
        (b.kind === "tool_result" || b.kind === "assistant_message" || b.kind === "summary") &&
        !ContentStore.isRef(b.content),
    )
    .sort((a, b) => b.token_count - a.token_count)
    .slice(0, 5);

  return {
    used_tokens: budget.used,
    max_tokens: budget.max,
    soft_limit: budget.soft_limit,
    pressure,
    largest_blocks: candidates.map((b) => ({
      id: b.id,
      kind: b.kind,
      tokens: b.token_count,
      suggested_ops:
        b.kind === "tool_result"
          ? ["payload_offload", "compact"]
          : ["compact", "set_visibility:archived"],
    })),
    required_preserve: [
      "user requirements and constraints",
      "current plan and task state",
      "open questions",
      "source references needed for the next step",
    ],
  };
}
