import type {
  ContextOperation,
  ContextUpdateRequest,
  ToolDefinition,
} from "../types.ts";

/**
 * The single core tool of CPAT. Schema follows the design doc: a flat
 * per-operation item shape (strict-mode friendly); the runtime normalizes it
 * into the typed ContextOperation union and the patch engine validates it.
 *
 * Field descriptions below are deliberately verbose: the schema is the
 * agent-facing contract, so each field spells out which ops use it and the
 * exact effect of the operation on the future context view.
 */
export const contextUpdateTool: ToolDefinition = {
  type: "function",
  function: {
    name: "context_update",
    strict: true,
    description:
      "Edit the blocks that will be rendered into your FUTURE context. You are governing your own " +
      "working memory: this does not change the conversation you already see, it changes what the " +
      "next turns will see. Target blocks by the ids shown in the <context_manifest>.\n\n" +
      "Transactional: all operations are validated against a staged copy; if ANY operation is " +
      "rejected, nothing is applied and the rejections (rule + message) are returned so you can fix " +
      "and retry. An empty operations list is an explicit, accepted no-op — use it to acknowledge " +
      "budget pressure when no patch is warranted.\n\n" +
      "Choose the cheapest reversible operation that fits, escalating only as needed:\n" +
      "  1. set_visibility=archived — hide a block you might still need; fully reversible, listed in " +
      "the manifest, restore with set_visibility=model. Cheapest, loses nothing.\n" +
      "  2. payload_offload — replace one bulky raw payload (large tool_result) with a short inline " +
      "summary + artifact reference; the full payload is recoverable via artifact_get or restore.\n" +
      "  3. restore — re-inline a payload you previously offloaded, when you need the full text again.\n" +
      "  4. compact / fold / merge — collapse several blocks into one denser block (sources are " +
      "archived, still recoverable). Lossy in the view; use when the detail is genuinely finished.\n" +
      "Keep tool-call chains atomic: an assistant tool-call turn and ALL of its tool_results must be " +
      "patched together, or the patch is rejected (chain_atomicity).",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            "One line explaining why this patch is needed now (recorded in the audit journal).",
        },
        operations: {
          type: "array",
          description:
            "Operations applied as one atomic transaction, in order. Each item below uses only the " +
            "fields relevant to its `op`; unused fields are ignored.",
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: [
                  "compact",
                  "payload_offload",
                  "restore",
                  "merge",
                  "fold",
                  "redact",
                  "set_visibility",
                  "replace",
                ],
                description:
                  "compact: collapse a set of finished blocks into one summary (sources archived). " +
                  "payload_offload: swap a bulky raw payload for a short inline summary + artifact ref. " +
                  "restore: re-inline a previously offloaded payload (inverse of payload_offload). " +
                  "merge: consolidate >=2 overlapping/duplicate blocks into one canonical block. " +
                  "fold: collapse a CONTIGUOUS block range (a finished subtask) into one scoped summary. " +
                  "set_visibility: archive/hide/restore blocks without summarizing. " +
                  "redact: drop fields from an inline JSON tool_result (gated, may be disabled). " +
                  "replace: overwrite a non-protected block's content (gated, may be disabled).",
              },
              ids: {
                type: "array",
                items: { type: "string" },
                description:
                  "Target block ids, taken verbatim from the <context_manifest> (never invent ids). " +
                  "compact/merge/set_visibility/redact: one or more ids. merge: at least 2 ids. " +
                  "fold: a contiguous run of blocks (a subtask trajectory). payload_offload/restore: " +
                  "the bulky/offloaded block ids. replace: exactly one id (the first is used). " +
                  "When targeting any member of a tool-call chain, include the whole chain.",
              },
              description: {
                type: "string",
                description:
                  "The replacement block's short description (shown in the manifest). Used by " +
                  "compact, merge, fold (the new summary/canonical block), payload_offload (the " +
                  "offloaded block), and replace (the rewritten block).",
              },
              content: {
                type: "string",
                description:
                  "The new text this operation writes. compact: the dense summary that replaces the " +
                  "targets. fold: the scope summary for the folded subtask. merge: the consolidated " +
                  "canonical text. payload_offload: the SHORT inline summary left behind in context " +
                  "(must stand in for the payload until it is retrieved). replace: the new content. " +
                  "Unused by restore / set_visibility / redact.",
              },
              preserve: {
                type: "array",
                items: { type: "string" },
                description:
                  "compact: the facts/decisions the summary explicitly keeps (must be non-empty — " +
                  "forces a deliberate compaction). redact: JSON field names to keep.",
              },
              drop: {
                type: "array",
                items: { type: "string" },
                description:
                  "compact: what is intentionally discarded from the summary. " +
                  "redact: JSON field names to remove from the tool_result object.",
              },
              resolution: {
                type: "string",
                enum: ["update", "contradiction"],
                description:
                  "merge only. \"update\": the sources overlap and are combined. \"contradiction\": the " +
                  "newer information supersedes/invalidates the older — say so in `content`.",
              },
              scope_label: {
                type: "string",
                description:
                  "fold only. A short name for the subtask trajectory being folded (e.g. " +
                  "\"explored auth module\"); recorded on the folded summary block.",
              },
              visibility: {
                type: "string",
                enum: ["model", "archived", "hidden"],
                description:
                  "set_visibility only. model: rendered into context. archived: not rendered but " +
                  "listed in the manifest and recoverable (use this to park blocks, and to restore an " +
                  "archived block back to model). hidden: not rendered and not in the manifest.",
              },
              retrieval_hint: {
                type: "string",
                description:
                  "payload_offload only. How/when to retrieve the full payload later (e.g. \"call " +
                  "artifact_get if you need the exact stack trace\"). The only recovery breadcrumb " +
                  "left in context, so make it actionable.",
              },
            },
            required: ["op", "ids"],
            additionalProperties: false,
          },
        },
      },
      required: ["reason", "operations"],
      additionalProperties: false,
    },
  },
};

/** Recovery channel for offloaded payloads (artifact://<key> uris). */
export const artifactGetTool: ToolDefinition = {
  type: "function",
  function: {
    name: "artifact_get",
    description:
      "Retrieve the full payload of an offloaded block by its artifact:// uri. Use only when the " +
      "inline summary is not enough for the current step. To bring the payload back into the " +
      "rendered context permanently, use context_update op=restore instead.",
    parameters: {
      type: "object",
      properties: {
        uri: { type: "string", description: "artifact://<key> uri from an offloaded block." },
        max_chars: { type: "number", description: "Truncate the payload (default 6000)." },
      },
      required: ["uri"],
    },
  },
};

interface FlatOperation {
  op: string;
  ids?: string[];
  description?: string;
  content?: string;
  preserve?: string[];
  drop?: string[];
  resolution?: "update" | "contradiction";
  scope_label?: string;
  visibility?: "model" | "archived" | "hidden";
  retrieval_hint?: string;
}

/** Normalizes the flat tool-call payload into the typed operation union. */
export function parseContextUpdateArgs(argsJson: string): ContextUpdateRequest {
  const raw = JSON.parse(argsJson) as { reason?: string; operations?: FlatOperation[] };
  const operations: ContextOperation[] = (raw.operations ?? []).map((f) => {
    const ids = f.ids ?? [];
    switch (f.op) {
      case "compact":
        return {
          op: "compact",
          ids,
          output: { description: f.description ?? "", content: f.content ?? "" },
          preserve: f.preserve ?? [],
          drop: f.drop ?? [],
        };
      case "payload_offload":
        return {
          op: "payload_offload",
          ids,
          store: "file",
          replace_with: {
            description: f.description ?? "",
            summary: f.content ?? "",
            retrieval_hint: f.retrieval_hint ?? "",
          },
        };
      case "restore":
        return { op: "restore", ids };
      case "merge":
        return {
          op: "merge",
          ids,
          output: { description: f.description ?? "", content: f.content ?? "" },
          resolution: f.resolution ?? "update",
        };
      case "fold":
        return {
          op: "fold",
          ids,
          output: { description: f.description ?? "", content: f.content ?? "" },
          scope_label: f.scope_label ?? "",
        };
      case "redact":
        return { op: "redact", ids, drop_fields: f.drop ?? [], preserve_fields: f.preserve };
      case "set_visibility":
        return { op: "set_visibility", ids, visibility: f.visibility ?? "archived" };
      case "replace":
        return { op: "replace", id: ids[0] ?? "", content: f.content ?? "", description: f.description };
      default:
        throw new Error(`unknown op "${f.op}"`);
    }
  });
  return { reason: raw.reason ?? "", operations };
}
