import type {
  ArtifactRef,
  BlockKind,
  ChatMessage,
  ContextBlock,
  Role,
  ToolCall,
  Visibility,
} from "../types.ts";
import { estimateTokens, nextId, nowIso } from "../util/misc.ts";
import { ContentStore, Journal } from "./stores.ts";

/**
 * The patchable working-state layer. Blocks are addressable by id, ordered by
 * insertion; the context view is this order filtered by visibility.
 */
export class BlockStore {
  private readonly map = new Map<string, ContextBlock>();
  order: string[] = [];
  private readonly content: ContentStore;
  private readonly journal: Journal;

  constructor(content: ContentStore, journal: Journal) {
    this.content = content;
    this.journal = journal;
  }

  get(id: string): ContextBlock | undefined {
    return this.map.get(id);
  }

  all(): ContextBlock[] {
    return this.order
      .map((id) => this.map.get(id))
      .filter((b): b is ContextBlock => b !== undefined);
  }

  visible(): ContextBlock[] {
    return this.all().filter((b) => b.visibility === "model");
  }

  /** Content-store key for the current version of a block. */
  static contentKey(block: ContextBlock): string {
    return `${block.id}@v${block.version}`;
  }

  renderedText(block: ContextBlock): string {
    if (ContentStore.isRef(block.content)) {
      const ref = block.content;
      return (
        `[offloaded payload] ${ref.summary}\n` +
        `(full payload recoverable at ${ref.uri} — ${ref.retrieval_hint})`
      );
    }
    return block.content;
  }

  create(opts: {
    idPrefix: string;
    role: Role;
    kind: BlockKind;
    description: string;
    content: string;
    sourceIds?: string[];
    visibility?: Visibility;
    retention?: ContextBlock["retention"];
    protected?: boolean;
    api?: ContextBlock["api"];
    insertAfter?: string;
  }): ContextBlock {
    const id = nextId(opts.idPrefix);
    const block: ContextBlock = {
      id,
      role: opts.role,
      kind: opts.kind,
      description: opts.description,
      content: opts.content,
      source_ids: opts.sourceIds ?? [],
      token_count: estimateTokens(opts.content),
      visibility: opts.visibility ?? "model",
      retention: opts.retention ?? "session",
      protected: opts.protected,
      version: 1,
      created_at: nowIso(),
      ...(opts.api ? { api: opts.api } : {}),
    };
    this.map.set(id, block);
    if (opts.insertAfter) {
      const at = this.order.indexOf(opts.insertAfter);
      this.order.splice(at === -1 ? this.order.length : at + 1, 0, id);
    } else {
      this.order.push(id);
    }
    const key = this.content.put(BlockStore.contentKey(block), opts.content);
    this.journal.append("ingest", {
      block_id: id,
      role: block.role,
      kind: block.kind,
      content_key: key,
      token_count: block.token_count,
      description: block.description,
    });
    return block;
  }

  // -- ingestion helpers ----------------------------------------------------

  createSystem(content: string): ContextBlock {
    return this.create({
      idPrefix: "system",
      role: "runtime",
      kind: "system_prompt",
      description: "System prompt and tool policy. Never patchable.",
      content,
      visibility: "model",
      retention: "persistent",
      protected: true,
    });
  }

  createUserMessage(content: string): ContextBlock {
    return this.create({
      idPrefix: "user",
      role: "user",
      kind: "user_message",
      description: describeText("User message", content),
      content,
      retention: "persistent",
      protected: true,
    });
  }

  /**
   * Splits an assistant API message into an assistant_message block plus, when
   * thinking mode returned reasoning alongside tool calls, an api_required
   * reasoning_trace block (DeepSeek requires replay while the chain is open).
   */
  createAssistantMessage(msg: ChatMessage): {
    block: ContextBlock;
    reasoning?: ContextBlock;
  } {
    const block = this.create({
      idPrefix: "assistant",
      role: "assistant",
      kind: "assistant_message",
      description: describeText(
        msg.tool_calls?.length
          ? `Assistant turn calling ${msg.tool_calls.map((t) => t.function.name).join(", ")}`
          : "Assistant message",
        msg.content ?? "",
      ),
      content: msg.content ?? "",
      api: msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : undefined,
    });
    let reasoning: ContextBlock | undefined;
    if (msg.reasoning_content && msg.tool_calls?.length) {
      reasoning = this.create({
        idPrefix: "reasoning",
        role: "assistant",
        kind: "reasoning_trace",
        description: `Thinking-mode trace for ${block.id}; API-required while its tool-call chain is open.`,
        content: msg.reasoning_content,
        sourceIds: [block.id],
        visibility: "api_required",
        retention: "ephemeral",
      });
      block.api = { ...block.api, reasoning_content: msg.reasoning_content };
    }
    return { block, reasoning };
  }

  createToolResult(
    toolCall: ToolCall,
    output: string,
    description: string,
  ): ContextBlock {
    return this.create({
      idPrefix: "tool",
      role: "tool",
      kind: "tool_result",
      description,
      content: output,
      api: { tool_call_id: toolCall.id, name: toolCall.function.name },
    });
  }

  /**
   * All blocks belonging to the same tool-call chain as `block`. Membership is
   * decided by api.tool_calls / api.tool_call_id, NOT by kind — offloaded
   * blocks still render as role:"tool" messages and stay chain members.
   */
  chainOf(block: ContextBlock): ContextBlock[] {
    const blocks = this.all();
    let head: ContextBlock | undefined;
    if (block.api?.tool_calls?.length) {
      head = block;
    } else if (block.api?.tool_call_id) {
      const idx = blocks.findIndex((b) => b.id === block.id);
      for (let i = idx - 1; i >= 0; i--) {
        const b = blocks[i];
        if (b.api?.tool_calls?.length) {
          const ids = new Set(b.api.tool_calls.map((t) => t.id));
          if (ids.has(block.api.tool_call_id)) head = b;
          break;
        }
      }
    }
    if (!head) return [block];
    const callIds = new Set(head.api!.tool_calls!.map((t) => t.id));
    const chain = [head];
    for (const b of blocks) {
      if (b.api?.tool_call_id && callIds.has(b.api.tool_call_id)) {
        chain.push(b);
      }
    }
    return chain;
  }
}

export function describeText(prefix: string, content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat ? `${prefix}: ${flat.slice(0, 110)}${flat.length > 110 ? "…" : ""}` : prefix;
}
