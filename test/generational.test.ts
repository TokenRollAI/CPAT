import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextRuntime } from "../src/runtime/runtime.ts";
import { resetIdCounter } from "../src/util/misc.ts";
import type { ChatMessage, CpatConfig, ToolCall } from "../src/types.ts";

function makeRuntime(overrides: Partial<CpatConfig> = {}): ContextRuntime {
  resetIdCounter();
  const config: CpatConfig = {
    model: "test",
    maxContextTokens: 10_000,
    softLimitRatio: 0.7,
    mustActRatio: 0.8,
    criticalRatio: 0.95,
    generational: true,
    allowReplace: false,
    allowRedact: false,
    strictTools: true,
    maxTurns: 10,
    runDir: mkdtempSync(join(tmpdir(), "cpat-gen-test-")),
    verbose: false,
    ...overrides,
  };
  return new ContextRuntime(config);
}

function toolCall(id: string, name = "read_file"): ToolCall {
  return { id, type: "function", function: { name, arguments: "{}" } };
}

/** Append one assistant tool-call turn + its tool result with the given payload. */
function addReadTurn(rt: ContextRuntime, callId: string, payload: string): void {
  rt.ingestAssistant({
    role: "assistant",
    content: "",
    tool_calls: [toolCall(callId)],
  });
  rt.ingestToolResult(toolCall(callId), payload);
}

/** Serialize a message for byte-exact prefix comparison. */
function ser(m: ChatMessage): string {
  return JSON.stringify({
    role: m.role,
    content: m.content ?? "",
    tool_call_id: m.tool_call_id ?? null,
    tool_calls: m.tool_calls ?? null,
  });
}

/**
 * Every assistant message carrying tool_calls must be immediately followed by a
 * role:"tool" message for each call id, with no other message interleaved —
 * DeepSeek rejects a split chain with a 400. This holds the line after reorder.
 */
function assertChainPairing(messages: ChatMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    const ids = m.tool_calls.map((t) => t.id);
    const got = messages
      .slice(i + 1, i + 1 + ids.length)
      .map((x) => x.tool_call_id);
    assert.deepEqual(
      got,
      ids,
      `tool-call chain for ${ids.join(",")} is split or out of order`,
    );
  }
}

test("generational: stable prefix is byte-identical after a tail offload (I2)", () => {
  const rt = makeRuntime();
  rt.ingestSystem("system prompt");
  rt.ingestUser("work through the corpus");
  // Two bulky read turns. By predicted-lifespan order the OLDER turn (A) renders
  // LAST in the tail (most likely offloaded next); the newer turn (B) renders
  // ahead of it. So A is the cache-safe thing to retire.
  addReadTurn(rt, "call_a", "AAA ".repeat(2000)); // older → tail end
  addReadTurn(rt, "call_b", "BBB ".repeat(2000)); // newer → ahead of A

  const before = rt.buildView().messages;
  // Sanity: A is physically after B in the rendered tail.
  assert.ok(
    before.findIndex((m) => m.tool_call_id === "call_a") >
      before.findIndex((m) => m.tool_call_id === "call_b"),
    "older bulky turn A should render after newer turn B",
  );

  // Retire A exactly as the generational fallback does: offload + promote.
  const toolA = rt.blocks.all().find((b) => b.api?.tool_call_id === "call_a")!;
  const text = toolA.content as string;
  rt.applyUpdate(
    {
      reason: "retire oldest generation",
      operations: [
        {
          op: "payload_offload",
          ids: [toolA.id],
          store: "file",
          replace_with: {
            description: "offloaded A",
            summary: "head: " + text.slice(0, 40),
            retrieval_hint: "artifact_get",
          },
        },
      ],
    },
    "runtime",
  );
  rt.blocks.setGeneration(toolA.id, rt.blocks.allocGeneration());

  const after = rt.buildView().messages;

  // Everything up to and including B's tool result — the whole stable prefix —
  // must be byte-identical: retiring A (which rendered AFTER B) touched nothing
  // before it.
  const idxB_before = before.findIndex((m) => m.tool_call_id === "call_b");
  const idxB_after = after.findIndex((m) => m.tool_call_id === "call_b");
  assert.ok(idxB_before >= 0 && idxB_after >= 0, "B turn present in both views");

  const prefixBefore = before.slice(0, idxB_before + 1).map(ser);
  const prefixAfter = after.slice(0, idxB_after + 1).map(ser);
  assert.deepEqual(
    prefixAfter,
    prefixBefore,
    "retiring A rippled into the stable prefix (B's turn changed)",
  );

  // A is still at the tail end (now a small ref), so the hole is a clean
  // truncation, not a hole punched mid-prefix.
  assert.ok(
    after.findIndex((m) => m.tool_call_id === "call_a") >
      after.findIndex((m) => m.tool_call_id === "call_b"),
  );
});

test("generational: tool-call chains stay paired after reorder", () => {
  const rt = makeRuntime();
  rt.ingestSystem("system prompt");
  rt.ingestUser("task");
  addReadTurn(rt, "call_a", "AAA ".repeat(2000));
  addReadTurn(rt, "call_b", "BBB ".repeat(2000));

  // Promote A so its group is reordered to the tail end.
  const toolA = rt.blocks.all().find((b) => b.api?.tool_call_id === "call_a")!;
  rt.blocks.setGeneration(toolA.id, rt.blocks.allocGeneration());

  assertChainPairing(rt.buildView().messages);
});

test("generational: small tool results stay in the stable prefix", () => {
  const rt = makeRuntime();
  rt.ingestSystem("system prompt");
  rt.ingestUser("task");
  addReadTurn(rt, "call_small", "tiny result"); // below TAIL_PAYLOAD_TOKENS
  addReadTurn(rt, "call_big", "BIG ".repeat(2000)); // bulky → tail

  const messages = rt.buildView().messages;
  const idxSmall = messages.findIndex((m) => m.tool_call_id === "call_small");
  const idxBig = messages.findIndex((m) => m.tool_call_id === "call_big");

  // Small group rendered before the bulky tail group, preserving insertion order
  // for everything that isn't a volatile payload.
  assert.ok(idxSmall < idxBig, "small result should precede the bulky tail");
});
