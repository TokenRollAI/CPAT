import type {
  ArtifactRef,
  ContextBlock,
  ContextOperation,
  PatchRejection,
} from "../types.ts";
import { estimateTokens } from "../util/misc.ts";
import { BlockStore, describeText } from "./blocks.ts";
import { ContentStore } from "./stores.ts";

export interface PatchEngineOptions {
  allowReplace: boolean;
  allowRedact: boolean;
}

export interface PatchOutcome {
  ok: boolean;
  applied: number;
  rejections: PatchRejection[];
  freed_tokens: number;
  created_block_ids: string[];
}

interface StagedSummary {
  afterId: string | undefined; // insert position: after this block id
  description: string;
  content: string;
  sourceIds: string[];
}

/**
 * Validates and applies a context_update transactionally: every operation is
 * checked against a staged copy of the block store; if any operation is
 * rejected, nothing is committed. Rejection messages are returned to the
 * agent as the tool result so it can retry with a corrected patch.
 */
export function applyContextUpdate(
  store: BlockStore,
  content: ContentStore,
  operations: ContextOperation[],
  opts: PatchEngineOptions,
): PatchOutcome {
  const rejections: PatchRejection[] = [];
  const staged = new Map<string, ContextBlock>();
  const summaries: StagedSummary[] = [];

  const stagedGet = (id: string): ContextBlock | undefined => {
    if (staged.has(id)) return staged.get(id);
    const real = store.get(id);
    if (!real) return undefined;
    const clone: ContextBlock = { ...real, api: real.api ? { ...real.api } : undefined };
    staged.set(id, clone);
    return clone;
  };

  const reject = (i: number, rule: string, message: string): void => {
    rejections.push({ op_index: i, rule, message });
  };

  // Rule: these kinds are runtime-owned and never patchable.
  const unpatchable = (b: ContextBlock): string | null => {
    if (b.kind === "system_prompt") return "system prompt is not patchable";
    if (b.kind === "budget_report")
      return "budget reports are runtime-owned and rotated automatically every turn — remove this id from your operation and retry";
    if (b.visibility === "api_required")
      return "block is api_required (open tool-call chain); the runtime will release it";
    return null;
  };

  // Archive the target blocks and stage one replacement block at the position
  // of the earliest target. Shared by compact / merge / fold — the three ops
  // that collapse N visible blocks into a single denser block while keeping the
  // originals archived (recoverable via set_visibility=model). Returns false if
  // a target is hidden (must be restored to view before it can be collapsed).
  const collapseIntoBlock = (
    i: number,
    ids: string[],
    targets: ContextBlock[],
    description: string,
    contentText: string,
  ): boolean => {
    for (const b of targets) {
      if (b.visibility === "hidden") {
        reject(i, "hidden_target", `block "${b.id}" is hidden; restore it first`);
        return false;
      }
      b.visibility = "archived";
    }
    const firstIdx = Math.min(...ids.map((id) => store.order.indexOf(id)));
    summaries.push({
      afterId: firstIdx > 0 ? store.order[firstIdx - 1] : undefined,
      description,
      content: contentText,
      sourceIds: [...ids],
    });
    return true;
  };

  operations.forEach((op, i) => {
    const ids = "ids" in op ? op.ids : [op.id];
    if (!ids || ids.length === 0) {
      reject(i, "empty_ids", "operation has no target ids");
      return;
    }
    const targets: ContextBlock[] = [];
    for (const id of ids) {
      const b = stagedGet(id);
      if (!b) {
        reject(i, "unknown_id", `block "${id}" does not exist`);
        return;
      }
      const reason = unpatchable(b);
      if (reason) {
        reject(i, "protected_kind", `block "${id}": ${reason}`);
        return;
      }
      targets.push(b);
    }

    switch (op.op) {
      case "compact": {
        if (!op.output?.content?.trim() || !op.output?.description?.trim()) {
          reject(i, "compact_output", "compact requires output.description and output.content");
          return;
        }
        // Rule: compact must declare its preserve/drop policy.
        if (!Array.isArray(op.preserve) || op.preserve.length === 0 || !Array.isArray(op.drop)) {
          reject(i, "compact_policy", "compact must declare non-empty `preserve` and a `drop` list");
          return;
        }
        collapseIntoBlock(i, ids, targets, op.output.description, op.output.content);
        break;
      }

      case "payload_offload": {
        const rw = op.replace_with;
        // Rule: offload must leave artifact_ref + summary + retrieval_hint.
        if (!rw?.summary?.trim() || !rw?.retrieval_hint?.trim() || !rw?.description?.trim()) {
          reject(i, "offload_replacement", "payload_offload requires replace_with.{description,summary,retrieval_hint}");
          return;
        }
        for (const b of targets) {
          if (b.kind !== "tool_result" && b.kind !== "assistant_message") {
            reject(i, "offload_kind", `block "${b.id}" (${b.kind}) cannot be offloaded; only tool results and assistant messages`);
            return;
          }
          if (ContentStore.isRef(b.content)) {
            reject(i, "already_offloaded", `block "${b.id}" is already offloaded`);
            return;
          }
          // Zero copy: the payload already lives in the content store under
          // the block's current version key; the block just renders a ref now.
          // kind is deliberately NOT changed — offloading is a storage/render
          // state (content is an ArtifactRef), not a semantic re-kind; chain
          // membership and budget heuristics keep working off the real kind.
          const key = BlockStore.contentKey(b);
          const ref: ArtifactRef = {
            artifact_id: key,
            uri: ContentStore.uri(key),
            store: op.store ?? "file",
            summary: rw.summary,
            retrieval_hint: rw.retrieval_hint,
          };
          b.content = ref;
          b.description = rw.description;
          b.token_count = estimateTokens(store.renderedText(b));
        }
        break;
      }

      case "redact": {
        if (!opts.allowRedact) {
          reject(i, "op_disabled", "redact is disabled in this MVP configuration");
          return;
        }
        if (!op.drop_fields?.length) {
          reject(i, "redact_fields", "redact requires drop_fields");
          return;
        }
        for (const b of targets) {
          if (b.kind !== "tool_result" || ContentStore.isRef(b.content)) {
            reject(i, "redact_kind", `block "${b.id}" is not an inline tool result`);
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(b.content);
          } catch {
            reject(i, "redact_not_json", `block "${b.id}" content is not JSON; use compact or payload_offload instead`);
            return;
          }
          if (typeof parsed !== "object" || parsed === null) {
            reject(i, "redact_not_json", `block "${b.id}" content is not a JSON object`);
            return;
          }
          const obj = parsed as Record<string, unknown>;
          for (const f of op.drop_fields) delete obj[f];
          b.content = JSON.stringify(obj);
          b.version += 1;
          b.token_count = estimateTokens(b.content);
        }
        break;
      }

      case "set_visibility": {
        if (!op.visibility) {
          reject(i, "visibility_missing", "set_visibility requires a visibility value");
          return;
        }
        for (const b of targets) {
          // Rule: protected blocks cannot be hidden (archive keeps them
          // listed in the manifest and recoverable; hidden does not).
          if (op.visibility === "hidden" && b.protected) {
            reject(i, "protected_hidden", `block "${b.id}" is protected and cannot be hidden; archive it or compact it into a summary`);
            return;
          }
          b.visibility = op.visibility;
        }
        break;
      }

      case "replace": {
        if (!opts.allowReplace) {
          reject(i, "op_disabled", "replace is disabled in this MVP configuration (history must not be rewritten)");
          return;
        }
        const b = targets[0];
        // Rule: user originals can be summarized or archived, never rewritten.
        if (b.kind === "user_message" || b.protected) {
          reject(i, "replace_protected", `block "${b.id}" is a protected original and cannot be replaced`);
          return;
        }
        if (!op.content?.trim()) {
          reject(i, "replace_content", "replace requires non-empty content");
          return;
        }
        b.content = op.content;
        if (op.description) b.description = op.description;
        b.version += 1;
        b.token_count = estimateTokens(op.content);
        break;
      }

      case "restore": {
        // Inverse of payload_offload: re-inline the full payload from the
        // content store. The payload already lives at the block's current
        // <id>@v<version> key (offload never changed the version), so this is a
        // zero-copy view flip — ArtifactRef back to inline string.
        for (const b of targets) {
          if (!ContentStore.isRef(b.content)) {
            reject(i, "not_offloaded", `block "${b.id}" is not offloaded; restore only re-inlines payload_offloaded blocks`);
            return;
          }
          const payload = content.get(BlockStore.contentKey(b));
          if (payload === undefined) {
            reject(i, "artifact_missing", `block "${b.id}" payload is unrecoverable (no content at its version key)`);
            return;
          }
          b.content = payload;
          b.description = describeText("Restored payload", payload);
          b.token_count = estimateTokens(payload);
        }
        break;
      }

      case "merge": {
        if (!op.output?.content?.trim() || !op.output?.description?.trim()) {
          reject(i, "merge_output", "merge requires output.description and output.content (the consolidated block)");
          return;
        }
        // Merge consolidates duplicates/overlap — it is meaningless on one block.
        if (ids.length < 2) {
          reject(i, "merge_arity", "merge needs at least 2 source ids to consolidate");
          return;
        }
        if (op.resolution !== "update" && op.resolution !== "contradiction") {
          reject(i, "merge_resolution", 'merge requires resolution: "update" (combine overlapping info) or "contradiction" (newer info supersedes older)');
          return;
        }
        const tag = op.resolution === "contradiction" ? "merged (contradiction resolved)" : "merged";
        collapseIntoBlock(i, ids, targets, `[${tag}] ${op.output.description}`, op.output.content);
        break;
      }

      case "fold": {
        if (!op.output?.content?.trim() || !op.output?.description?.trim()) {
          reject(i, "fold_output", "fold requires output.description and output.content (the scope summary)");
          return;
        }
        if (!op.scope_label?.trim()) {
          reject(i, "fold_scope", "fold requires a scope_label naming the subtask being folded");
          return;
        }
        // Rule: fold operates on a contiguous block range (a subtask
        // trajectory), unlike compact which takes any set. Enforce that the ids
        // form a consecutive run in the block order.
        const idxs = ids.map((id) => store.order.indexOf(id)).sort((a, b) => a - b);
        const contiguous = idxs.every((v, k) => k === 0 || v === idxs[k - 1] + 1);
        if (!contiguous) {
          reject(i, "fold_range", "fold ids must be a contiguous block range (a subtask trajectory); use compact for a non-contiguous set");
          return;
        }
        collapseIntoBlock(i, ids, targets, `[folded scope: ${op.scope_label}] ${op.output.description}`, op.output.content);
        break;
      }
    }
  });

  // Transaction-level post-check: the resulting view must keep every
  // tool-call chain atomic, or the next API call would be rejected
  // (a tool message without its assistant tool_calls head, or vice versa).
  if (rejections.length === 0) {
    const viewOf = (id: string): ContextBlock | undefined => staged.get(id) ?? store.get(id);
    const seen = new Set<string>();
    for (const id of store.order) {
      const b = viewOf(id);
      if (!b || b.visibility !== "model") continue;
      for (const member of store.chainOf(b)) {
        const m = viewOf(member.id);
        if (m && m.visibility !== "model") {
          const chainIds = store.chainOf(b).map((c) => c.id).join(", ");
          if (seen.has(chainIds)) continue;
          seen.add(chainIds);
          rejections.push({
            op_index: -1,
            rule: "chain_atomicity",
            message:
              `tool-call chain would be broken: "${b.id}" stays visible but its chain member ` +
              `"${member.id}" would not. Patch the whole chain together (e.g. compact all of: ` +
              chainIds + ").",
          });
        }
      }
    }
  }

  if (rejections.length > 0) {
    return { ok: false, applied: 0, rejections, freed_tokens: 0, created_block_ids: [] };
  }

  // Commit.
  const visibleTokens = (): number =>
    store.visible().reduce((s, b) => s + b.token_count, 0);
  const before = visibleTokens();

  for (const [id, clone] of staged) {
    const real = store.get(id)!;
    if (clone.version > real.version && typeof clone.content === "string") {
      content.put(`${id}@v${clone.version}`, clone.content);
    }
    Object.assign(real, clone);
  }
  const created: string[] = [];
  for (const s of summaries) {
    const block = store.create({
      idPrefix: "summary",
      role: "assistant",
      kind: "summary",
      description: describeText(s.description, ""),
      content: s.content,
      sourceIds: s.sourceIds,
      insertAfter: s.afterId,
    });
    created.push(block.id);
  }

  return {
    ok: true,
    applied: operations.length,
    rejections: [],
    freed_tokens: Math.max(0, before - visibleTokens()),
    created_block_ids: created,
  };
}
