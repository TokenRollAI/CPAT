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
      "Edit the blocks that will be rendered into FUTURE context views — your working context is " +
      "bounded, so use this to keep only what you need and offload the rest as you go. Use it (1) " +
      "incrementally during a task: right after you finish reading a large document/tool_result, " +
      "offload that raw block so context does not pile up; (2) at boundaries: when a new question " +
      "changes what is relevant; and (3) whenever overflow is imminent. Batch operations into one " +
      "transaction when you can, to limit prefix churn.\n\n" +
      "Target blocks by ids from <context_manifest>. The tool never changes the message you are " +
      "currently reading; it changes the block store used for later LLM calls. Transactional: every " +
      "operation is validated against a staged copy. If ANY operation is rejected, nothing is applied " +
      "and the returned rule/message tells you how to retry. An empty operations list is an accepted " +
      "no-op when no update is worthwhile.\n\n" +
      "Dispose of superseded blocks: once a block's key facts live in a summary or an offload note, " +
      "do not leave the original ALSO competing in context — archive it, or set_visibility=hidden if " +
      "you will not need it again. Avoid a summary and its stale source both staying visible.\n\n" +
      "Call discipline: always preserve user requirements, the current question, task state, open " +
      "questions, and the EXACT facts you have gathered (names, numbers, IDs, codes, source refs) — " +
      "verbatim, never blurred into a vague summary. You may NOT compact/fold/merge the current " +
      "question or task_state.\n\n" +
      "Operation choice by cost/risk: (1) set_visibility=archived parks irrelevant-but-recoverable " +
      "blocks; =hidden removes a block whose facts are captured elsewhere. (2) payload_offload keeps a " +
      "short fact-bearing summary while moving bulky raw payload text behind an artifact reference. (3) " +
      "restore re-inlines an offloaded payload when you need its exact text again (cheaper than " +
      "re-reading the source). (4) compact/fold/merge rewrite several blocks into a summary/canonical " +
      "block; sources are archived, so the view becomes lossy even though recovery is possible. " +
      "redact/replace are gated rewrite operations and may be disabled.\n\n" +
      "Tool-call chains are atomic: an assistant message with tool_calls and ALL matching tool_result " +
      "blocks must be patched together, including already-offloaded tool results, or the transaction " +
      "is rejected with chain_atomicity.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            "Explain why this transaction is worth doing at this boundary. Include the trigger " +
            "(new user message, finished subtask, budget pressure, duplicate context, exact restore need) " +
            "and the intended outcome. Recorded in the audit journal.",
        },
        operations: {
          type: "array",
          description:
            "Operations applied as one atomic transaction, in order. Use [] for an explicit no-op " +
            "when a boundary pass decides that rewriting context would cost more than it saves. " +
            "Each item uses only fields relevant to its `op`; unused fields are ignored by the normalizer.",
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
                  "set_visibility: reason=park or restore whole blocks without rewriting content; side effect=visibility changes only. " +
                  "visibility=archived removes tokens from the view but keeps the block in the manifest; visibility=model restores it; hidden removes it from both view and manifest and is inappropriate for protected/user facts. Result: cheap and reversible, but chain members must move together. " +
                  "payload_offload: reason=a bulky tool_result/assistant payload has been read and only a short reminder is needed; side effect=the same block keeps its kind/api identity but renders as summary + artifact:// uri. Result: large token savings with exact recovery via artifact_get or restore; bad summaries can lose working signal. " +
                  "restore: reason=the new user request needs exact text from an offloaded block; side effect=re-inlines the full payload and increases prompt tokens. Result: exact recovery, possible renewed budget pressure. " +
                  "compact: reason=finished non-contiguous exploration can be replaced by a deliberate summary; side effect=sources archived and a new summary block inserted near the earliest source. Result: fewer visible tokens but lossy view; preserve/drop must be explicit. " +
                  "fold: reason=a contiguous completed subtask trajectory should become one scoped checkpoint; side effect=the whole range is archived and replaced by a scoped summary. Result: cleaner long-loop memory; rejected if ids are not contiguous or scope_label is empty. " +
                  "merge: reason=two or more blocks duplicate, overlap, or contradict each other; side effect=sources archived and one canonical summary is created. Result: less duplicate context; resolution must say update or contradiction. " +
                  "redact: reason=remove fields from inline JSON tool_result; side effect=rewrites payload version; gated and often disabled. " +
                  "replace: reason=overwrite a non-protected block; side effect=rewrites history-visible content; gated and often disabled.",
              },
              ids: {
                type: "array",
                items: { type: "string" },
                description:
                  "Target block ids, taken verbatim from <context_manifest>; never invent ids and never " +
                  "include budget_report/context_manifest pseudo-content. compact/merge/set_visibility/redact: " +
                  "one or more ids. merge: at least 2 ids. fold: a contiguous run in block order. " +
                  "payload_offload: bulky inline payload ids. restore: already-offloaded ids. replace: " +
                  "exactly one id (the first is used). If any id belongs to a tool-call chain, include " +
                  "the assistant tool-call block and every tool_result in that chain.",
              },
              description: {
                type: "string",
                description:
                  "Short manifest description for the resulting block/state. For compact/fold/merge, " +
                  "this names the new summary/canonical block so future you can decide whether to " +
                  "restore archived sources. For payload_offload, it replaces the block description " +
                  "and must say what the artifact contains. For replace, it describes the rewritten block.",
              },
              content: {
                type: "string",
                description:
                  "Text written into the future context. compact: dense summary that must preserve " +
                  "requirements, decisions, open questions, source refs, and next-step state. fold: " +
                  "scoped checkpoint for a contiguous subtask. merge: canonical combined text, including " +
                  "which facts supersede which when resolution=contradiction. payload_offload: SHORT " +
                  "inline summary left behind in place of the raw payload; it must be enough to decide " +
                  "whether retrieval is needed. replace: new content. Unused by restore/set_visibility/redact.",
              },
              preserve: {
                type: "array",
                items: { type: "string" },
                description:
                  "compact: concrete facts/constraints/refs intentionally kept in `content`; must be " +
                  "non-empty so compaction is deliberate and auditable. redact: JSON field names to keep.",
              },
              drop: {
                type: "array",
                items: { type: "string" },
                description:
                  "compact: details intentionally omitted because they are obsolete, duplicated, raw " +
                  "payload noise, or recoverable from archived/offloaded sources. redact: JSON field " +
                  "names to remove from the tool_result object.",
              },
              resolution: {
                type: "string",
                enum: ["update", "contradiction"],
                description:
                  "merge only. \"update\" means sources overlap and should be combined. \"contradiction\" " +
                  "means newer/better evidence supersedes older text; the `content` must state the " +
                  "winning fact and what was invalidated.",
              },
              scope_label: {
                type: "string",
                description:
                  "fold only. Short name for the contiguous subtask trajectory being folded, e.g. " +
                  "\"explored auth module\" or \"answered question 2\". Required so future retrieval " +
                  "can identify what archived range the folded summary represents.",
              },
              visibility: {
                type: "string",
                enum: ["model", "archived", "hidden"],
                description:
                  "set_visibility only. model: render the block again. archived: remove from prompt " +
                  "tokens but list in the manifest for recovery; best default for user/decision/source " +
                  "context you might need later. hidden: remove from both prompt and manifest; use only " +
                  "for truly dead non-protected blocks because future you will not see it as recoverable.",
              },
              retrieval_hint: {
                type: "string",
                description:
                  "payload_offload only. Actionable recovery rule for the raw payload, e.g. \"call " +
                  "artifact_get if exact grep lines are needed for file X\". This is the breadcrumb " +
                  "future turns see next to the artifact uri, so mention when retrieval/restore is justified.",
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
      "Retrieve the full payload of an offloaded block by artifact:// uri for the CURRENT step only. " +
      "Use this when the inline summary is insufficient but you do not want to permanently expand " +
      "future context. If the new user request needs the exact payload to remain visible across " +
      "turns, use context_update op=restore instead. Large retrievals add prompt cost, so prefer " +
      "the summary unless exact text matters.",
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
