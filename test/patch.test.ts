import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextRuntime } from "../src/runtime/runtime.ts";
import { resetIdCounter } from "../src/util/misc.ts";
import type { CpatConfig, ToolCall } from "../src/types.ts";

function makeRuntime(overrides: Partial<CpatConfig> = {}): ContextRuntime {
  resetIdCounter();
  const config: CpatConfig = {
    model: "test",
    maxContextTokens: 10_000,
    softLimitRatio: 0.7,
    mustActRatio: 0.8,
    criticalRatio: 0.95,
    allowReplace: false,
    allowRedact: false,
    strictTools: true,
    maxTurns: 10,
    runDir: mkdtempSync(join(tmpdir(), "cpat-test-")),
    verbose: false,
    ...overrides,
  };
  return new ContextRuntime(config);
}

function toolCall(id: string, name = "grep_search"): ToolCall {
  return { id, type: "function", function: { name, arguments: "{}" } };
}

/** system + user + one assistant tool-call turn with one big tool result. */
function seedChain(rt: ContextRuntime, payload: string): { assistantId: string; toolId: string } {
  rt.ingestSystem("system prompt");
  rt.ingestUser("the task");
  rt.ingestAssistant({
    role: "assistant",
    content: "",
    tool_calls: [toolCall("call_1")],
  });
  rt.ingestToolResult(toolCall("call_1"), payload);
  const blocks = rt.blocks.all();
  return {
    assistantId: blocks.find((b) => b.kind === "assistant_message")!.id,
    toolId: blocks.find((b) => b.kind === "tool_result")!.id,
  };
}

test("payload_offload is zero-copy and recoverable", () => {
  const rt = makeRuntime();
  const payload = "RAW ".repeat(5000);
  const { toolId } = seedChain(rt, payload);

  const before = rt.blocks.get(toolId)!.token_count;
  const result = rt.applyUpdate(
    {
      reason: "too big",
      operations: [
        {
          op: "payload_offload",
          ids: [toolId],
          store: "file",
          replace_with: {
            description: "grep result (offloaded)",
            summary: "Matches in 3 files.",
            retrieval_hint: "artifact_get if exact lines needed",
          },
        },
      ],
    },
    "agent",
  );

  assert.equal(result.ok, true);
  assert.ok(result.freed_tokens > before * 0.9);
  const block = rt.blocks.get(toolId)!;
  assert.equal(block.kind, "tool_result"); // kind unchanged; offload is a storage state
  assert.equal(typeof block.content, "object");
  // recovery via the single content store
  const uri = (block.content as { uri: string }).uri;
  assert.equal(rt.artifactGet(uri), payload);
  // the rendered tool message keeps its tool_call_id (API protocol intact)
  assert.equal(block.api?.tool_call_id, "call_1");
});

test("compact requires preserve/drop and archives sources", () => {
  const rt = makeRuntime();
  const { assistantId, toolId } = seedChain(rt, "small result");

  const missingPolicy = rt.applyUpdate(
    {
      reason: "merge",
      operations: [
        {
          op: "compact",
          ids: [assistantId, toolId],
          output: { description: "summary", content: "Decision: X." },
          preserve: [],
          drop: [],
        },
      ],
    },
    "agent",
  );
  assert.equal(missingPolicy.ok, false);
  assert.equal(missingPolicy.rejections[0].rule, "compact_policy");

  const ok = rt.applyUpdate(
    {
      reason: "merge",
      operations: [
        {
          op: "compact",
          ids: [assistantId, toolId],
          output: { description: "exploration summary", content: "Decision: X. Pending: Y." },
          preserve: ["decisions"],
          drop: ["raw output"],
        },
      ],
    },
    "agent",
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.created_block_ids?.length ?? 1, 1);
  assert.equal(rt.blocks.get(assistantId)!.visibility, "archived");
  assert.equal(rt.blocks.get(toolId)!.visibility, "archived");
  const summary = rt.blocks.all().find((b) => b.kind === "summary")!;
  assert.deepEqual(summary.source_ids, [assistantId, toolId]);
  // summary takes the chain's place in the view order
  const view = rt.blocks.visible().map((b) => b.kind);
  assert.deepEqual(view, ["system_prompt", "user_message", "summary"]);
});

test("breaking a tool-call chain is rejected", () => {
  const rt = makeRuntime();
  const { toolId } = seedChain(rt, "result");

  const result = rt.applyUpdate(
    {
      reason: "drop tool result only",
      operations: [{ op: "set_visibility", ids: [toolId], visibility: "archived" }],
    },
    "agent",
  );
  assert.equal(result.ok, false);
  assert.ok(result.rejections.some((r) => r.rule === "chain_atomicity"));
  // transactional: nothing applied
  assert.equal(rt.blocks.get(toolId)!.visibility, "model");
});

test("system prompt and user originals are protected", () => {
  const rt = makeRuntime({ allowReplace: true });
  seedChain(rt, "result");
  const system = rt.blocks.all().find((b) => b.kind === "system_prompt")!;
  const user = rt.blocks.all().find((b) => b.kind === "user_message")!;

  const sysPatch = rt.applyUpdate(
    {
      reason: "x",
      operations: [{ op: "set_visibility", ids: [system.id], visibility: "archived" }],
    },
    "agent",
  );
  assert.equal(sysPatch.ok, false);
  assert.equal(sysPatch.rejections[0].rule, "protected_kind");

  const userReplace = rt.applyUpdate(
    { reason: "x", operations: [{ op: "replace", id: user.id, content: "rewritten" }] },
    "agent",
  );
  assert.equal(userReplace.ok, false);
  assert.equal(userReplace.rejections[0].rule, "replace_protected");

  const userHide = rt.applyUpdate(
    { reason: "x", operations: [{ op: "set_visibility", ids: [user.id], visibility: "hidden" }] },
    "agent",
  );
  assert.equal(userHide.ok, false);
  assert.equal(userHide.rejections[0].rule, "protected_hidden");

  // archive (recoverable) is allowed for user messages
  const userArchive = rt.applyUpdate(
    { reason: "x", operations: [{ op: "set_visibility", ids: [user.id], visibility: "archived" }] },
    "agent",
  );
  assert.equal(userArchive.ok, true);
});

test("replace is gated off by default", () => {
  const rt = makeRuntime();
  const { assistantId } = seedChain(rt, "r");
  const res = rt.applyUpdate(
    { reason: "x", operations: [{ op: "replace", id: assistantId, content: "new" }] },
    "agent",
  );
  assert.equal(res.ok, false);
  assert.equal(res.rejections[0].rule, "op_disabled");
});

test("budget monitor injects report and critical pressure force-offloads", () => {
  const rt = makeRuntime({ maxContextTokens: 2000 });
  // ~4000 estimated tokens of payload >> critical threshold (1900)
  seedChain(rt, "PAYLOAD ".repeat(5000));

  const { pressure } = rt.checkBudget();
  assert.notEqual(pressure, "ok");
  assert.equal(rt.runtimeFallbacks > 0, true);

  const report = rt.blocks.all().find((b) => b.kind === "budget_report");
  assert.ok(report);
  // the huge tool result was auto-offloaded by the runtime
  const tool = rt.blocks.all().find((b) => b.api?.tool_call_id === "call_1")!;
  assert.equal(typeof tool.content, "object");

  // a second check replaces the old report instead of accumulating
  rt.checkBudget();
  const reports = rt.blocks.all().filter((b) => b.kind === "budget_report" && b.visibility === "model");
  assert.equal(reports.length <= 1, true);
});

test("reasoning_trace is api_required during open chain, released after", () => {
  const rt = makeRuntime();
  rt.ingestSystem("sys");
  rt.ingestUser("task");
  rt.ingestAssistant({
    role: "assistant",
    content: "",
    reasoning_content: "thinking...",
    tool_calls: [toolCall("call_9")],
  });
  rt.ingestToolResult(toolCall("call_9"), "result");

  const reasoning = rt.blocks.all().find((b) => b.kind === "reasoning_trace")!;
  assert.equal(reasoning.visibility, "api_required");

  // agent cannot patch api_required blocks
  const res = rt.applyUpdate(
    { reason: "x", operations: [{ op: "set_visibility", ids: [reasoning.id], visibility: "hidden" }] },
    "agent",
  );
  assert.equal(res.ok, false);

  // while open, the rendered assistant message replays reasoning_content
  const { messages } = rt.buildView();
  const assistantMsg = messages.find((m) => m.role === "assistant")!;
  assert.equal(assistantMsg.reasoning_content, "thinking...");

  // next assistant turn closes the chain
  rt.ingestAssistant({ role: "assistant", content: "done" });
  assert.equal(rt.blocks.get(reasoning.id)!.visibility, "hidden");
  const { messages: after } = rt.buildView();
  assert.equal(after.find((m) => m.role === "assistant")!.reasoning_content, undefined);
});

test("empty operations list is an explicit accepted no-op", () => {
  const rt = makeRuntime();
  seedChain(rt, "r");
  const res = rt.applyUpdate({ reason: "no_context_update_needed", operations: [] }, "agent");
  assert.equal(res.ok, true);
  assert.equal(res.applied, 0);
});

test("offloaded tool results remain chain members (regression: API 400)", () => {
  const rt = makeRuntime();
  rt.ingestSystem("sys");
  rt.ingestUser("task");
  // one assistant turn with two parallel tool calls
  rt.ingestAssistant({
    role: "assistant",
    content: "",
    tool_calls: [toolCall("call_a"), toolCall("call_b")],
  });
  rt.ingestToolResult(toolCall("call_a"), "BIG ".repeat(3000));
  rt.ingestToolResult(toolCall("call_b"), "small");
  const blocks = rt.blocks.all();
  const head = blocks.find((b) => b.kind === "assistant_message")!;
  const [toolA, toolB] = blocks.filter((b) => b.kind === "tool_result");

  // offload one member (as the runtime critical fallback would)
  const off = rt.applyUpdate(
    {
      reason: "offload big one",
      operations: [
        {
          op: "payload_offload",
          ids: [toolA.id],
          store: "file",
          replace_with: { description: "big (offloaded)", summary: "big", retrieval_hint: "artifact_get" },
        },
      ],
    },
    "runtime",
  );
  assert.equal(off.ok, true);

  // compacting the chain WITHOUT the offloaded member must be rejected —
  // it still renders as a role:"tool" message tied to the head.
  const broken = rt.applyUpdate(
    {
      reason: "compact chain, forgot offloaded member",
      operations: [
        {
          op: "compact",
          ids: [head.id, toolB.id],
          output: { description: "s", content: "summary." },
          preserve: ["x"],
          drop: ["y"],
        },
      ],
    },
    "agent",
  );
  assert.equal(broken.ok, false);
  assert.ok(broken.rejections.some((r) => r.rule === "chain_atomicity"));

  // including the offloaded member succeeds
  const full = rt.applyUpdate(
    {
      reason: "compact whole chain",
      operations: [
        {
          op: "compact",
          ids: [head.id, toolA.id, toolB.id],
          output: { description: "s", content: "summary." },
          preserve: ["x"],
          drop: ["y"],
        },
      ],
    },
    "agent",
  );
  assert.equal(full.ok, true);
  // rendered view must contain no orphan tool messages
  const { messages } = rt.buildView();
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool") {
      let j = i - 1;
      while (j >= 0 && messages[j].role === "tool") j--;
      assert.ok(messages[j].tool_calls?.length, "tool message must follow tool_calls");
    }
  }
});

test("restore re-inlines an offloaded payload (inverse of payload_offload)", () => {
  const rt = makeRuntime();
  const payload = "RAW ".repeat(5000);
  const { toolId } = seedChain(rt, payload);

  rt.applyUpdate(
    {
      reason: "offload",
      operations: [
        {
          op: "payload_offload",
          ids: [toolId],
          store: "file",
          replace_with: { description: "grep (offloaded)", summary: "matches", retrieval_hint: "artifact_get" },
        },
      ],
    },
    "agent",
  );
  assert.equal(typeof rt.blocks.get(toolId)!.content, "object"); // now a ref

  const restore = rt.applyUpdate(
    { reason: "need the raw text again", operations: [{ op: "restore", ids: [toolId] }] },
    "agent",
  );
  assert.equal(restore.ok, true);
  const block = rt.blocks.get(toolId)!;
  assert.equal(typeof block.content, "string");
  assert.equal(block.content, payload); // zero-copy round trip from the content store
  assert.equal(block.kind, "tool_result");
  assert.equal(block.api?.tool_call_id, "call_1"); // chain membership intact

  // restoring a block that is not offloaded is rejected
  const again = rt.applyUpdate(
    { reason: "x", operations: [{ op: "restore", ids: [toolId] }] },
    "agent",
  );
  assert.equal(again.ok, false);
  assert.equal(again.rejections[0].rule, "not_offloaded");
});

test("merge consolidates overlapping blocks and archives the sources", () => {
  const rt = makeRuntime();
  rt.ingestSystem("sys");
  rt.ingestUser("task");
  rt.ingestAssistant({ role: "assistant", content: "finding: auth lives in src/auth.ts" });
  rt.ingestAssistant({ role: "assistant", content: "finding: auth.ts also exports a guard()" });
  const [a, b] = rt.blocks.all().filter((x) => x.kind === "assistant_message");

  // arity: merge needs >= 2 ids
  const arity = rt.applyUpdate(
    {
      reason: "x",
      operations: [
        { op: "merge", ids: [a.id], output: { description: "d", content: "c" }, resolution: "update" },
      ],
    },
    "agent",
  );
  assert.equal(arity.ok, false);
  assert.equal(arity.rejections[0].rule, "merge_arity");

  const ok = rt.applyUpdate(
    {
      reason: "dedupe two findings about auth.ts",
      operations: [
        {
          op: "merge",
          ids: [a.id, b.id],
          output: { description: "auth findings", content: "auth lives in src/auth.ts and exports guard()." },
          resolution: "update",
        },
      ],
    },
    "agent",
  );
  assert.equal(ok.ok, true);
  assert.equal(rt.blocks.get(a.id)!.visibility, "archived");
  assert.equal(rt.blocks.get(b.id)!.visibility, "archived");
  const merged = rt.blocks.all().find((x) => x.kind === "summary")!;
  assert.deepEqual(merged.source_ids, [a.id, b.id]);
  assert.match(merged.description, /merged/);
});

test("fold collapses a contiguous range and rejects a non-contiguous set", () => {
  const rt = makeRuntime();
  rt.ingestSystem("sys");
  rt.ingestUser("task");
  rt.ingestAssistant({ role: "assistant", content: "step A" });
  rt.ingestAssistant({ role: "assistant", content: "step B" });
  rt.ingestAssistant({ role: "assistant", content: "step C" });
  const [a, b, c] = rt.blocks.all().filter((x) => x.kind === "assistant_message");

  // scope_label is required
  const noScope = rt.applyUpdate(
    {
      reason: "x",
      operations: [
        { op: "fold", ids: [a.id, b.id, c.id], output: { description: "d", content: "summary" }, scope_label: "" },
      ],
    },
    "agent",
  );
  assert.equal(noScope.ok, false);
  assert.equal(noScope.rejections[0].rule, "fold_scope");

  // non-contiguous range (skips b) is rejected
  const gap = rt.applyUpdate(
    {
      reason: "x",
      operations: [
        { op: "fold", ids: [a.id, c.id], output: { description: "d", content: "summary" }, scope_label: "subtask" },
      ],
    },
    "agent",
  );
  assert.equal(gap.ok, false);
  assert.equal(gap.rejections[0].rule, "fold_range");

  // contiguous range folds into one scoped summary
  const ok = rt.applyUpdate(
    {
      reason: "subtask done, fold it",
      operations: [
        {
          op: "fold",
          ids: [a.id, b.id, c.id],
          output: { description: "the three steps", content: "Did A then B then C; result R." },
          scope_label: "warm-up steps",
        },
      ],
    },
    "agent",
  );
  assert.equal(ok.ok, true);
  for (const id of [a.id, b.id, c.id]) assert.equal(rt.blocks.get(id)!.visibility, "archived");
  const folded = rt.blocks.all().find((x) => x.kind === "summary")!;
  assert.deepEqual(folded.source_ids, [a.id, b.id, c.id]);
  assert.match(folded.description, /folded scope: warm-up steps/);
});

