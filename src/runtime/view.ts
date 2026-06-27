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
 *
 * Generational mode (config.generational) goes further: it physically lays out
 * blocks by *volatility* rather than insertion order —
 *   L0/L1  stable prefix : system, messages, summaries, small tool results
 *   L2     volatile tail : large tool-result chain groups, ordered by generation
 * Offload only ever retires whole generations from the oldest end of L2, so a
 * patch never punches a hole into the stable prefix — it just truncates the
 * tail. Reordering happens at chain-GROUP granularity so an assistant
 * tool_calls message always stays immediately followed by its tool results.
 */
export function buildMessages(
  store: BlockStore,
  ephemeralTailMessages?: ChatMessage[],
  opts: { generational?: boolean } = {},
): {
  messages: ChatMessage[];
  view: ContextView;
} {
  const messages: ChatMessage[] = [];
  const viewIds: string[] = [];

  const ordered = opts.generational ? layoutGenerational(store) : store.visible();
  for (const block of ordered) {
    viewIds.push(block.id);
    messages.push(renderBlock(store, block));
  }

  // Ephemeral tail messages are per-call instructions that must not become
  // blocks. Keep them immediately before the manifest so the stable prefix
  // remains the persisted block sequence.
  if (ephemeralTailMessages?.length) {
    messages.push(...ephemeralTailMessages);
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

/** Token threshold above which a tool_result is treated as a volatile L2 payload. */
const TAIL_PAYLOAD_TOKENS = 300;

/**
 * Lay out visible blocks as stable-prefix (L0/L1) followed by a generational
 * volatile tail (L2). Chain groups are the atomic unit: a group lands in L2 if
 * any member is a bulky tool_result, otherwise it stays in the prefix.
 *
 * Cache-preserving tail order — by predicted lifespan, longest-lived FIRST:
 * the bulky group most likely to be offloaded next sits at the very END of the
 * view, so retiring it shifts nothing before it and the cached prefix survives.
 * Predictor = recency: a recently-read group is more likely to be reused soon,
 * so newest groups sort to the FRONT of the tail and the oldest unused group
 * falls to the BACK — exactly the next offload target. Once a group is retired
 * it carries a generation id and is pinned even further back, ordered by that
 * id so successive retirements keep peeling from the same (tail) end.
 */
function layoutGenerational(store: BlockStore): ContextBlock[] {
  const visible = store.visible();
  const groups = store.chainGroups(visible);

  const prefix: ContextBlock[][] = [];
  const tail: ContextBlock[][] = [];
  for (const group of groups) {
    // A group belongs to the volatile tail if it carries a bulky tool_result OR
    // it has already been retired to a ref. The retired case matters: once
    // offloaded, a block's token_count drops below the bulky threshold, but it
    // must NOT migrate back into the prefix — that would re-insert it at its
    // old (mid-prefix) position and punch the very hole the tail layout avoids.
    const tailGroup = group.some(
      (b) =>
        (b.kind === "tool_result" && b.token_count >= TAIL_PAYLOAD_TOKENS) ||
        ContentStore.isRef(b.content),
    );
    (tailGroup ? tail : prefix).push(group);
  }

  // Order key (smaller = earlier in the tail = longer-lived, kept toward front):
  //   - ungenerated (still-inline) groups: newest first, so the oldest unused
  //     bulky group sits last and is the next offload target.
  //   - generated (already-retired refs): pushed to the very back, ordered by
  //     generation id so retirements always peel from the physical tail end.
  // `i` is the group's insertion index within `tail` (ascending = oldest→newest).
  const tailLen = tail.length;
  const keyOf = (group: ContextBlock[], i: number): number => {
    for (const b of group) {
      const g = store.generationOf(b.id);
      if (g !== undefined) return tailLen + g; // retired: behind all inline groups
    }
    return tailLen - 1 - i; // inline: newest (largest i) → smallest key → front
  };
  const indexed = tail.map((g, i) => ({ g, key: keyOf(g, i), i }));
  indexed.sort((a, b) => a.key - b.key || a.i - b.i);

  return [...prefix.flat(), ...indexed.map((x) => x.g).flat()];
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
