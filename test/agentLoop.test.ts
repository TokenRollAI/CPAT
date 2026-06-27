import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/agent/loop.ts";
import { resetIdCounter } from "../src/util/misc.ts";
import type {
  ChatMessage,
  ChatResponse,
  ChatUsage,
  CpatConfig,
  ToolDefinition,
} from "../src/types.ts";

function makeConfig(overrides: Partial<CpatConfig> = {}): CpatConfig {
  resetIdCounter();
  return {
    model: "test",
    maxContextTokens: 10_000,
    softLimitRatio: 0.7,
    mustActRatio: 0.8,
    criticalRatio: 0.95,
    generational: false,
    allowReplace: false,
    allowRedact: false,
    strictTools: true,
    maxTurns: 6,
    runDir: mkdtempSync(join(tmpdir(), "cpat-agent-test-")),
    verbose: false,
    ...overrides,
  };
}

const usage = (promptTokens = 100): ChatUsage => ({
  prompt_tokens: promptTokens,
  completion_tokens: 5,
  total_tokens: promptTokens + 5,
  prompt_cache_hit_tokens: Math.floor(promptTokens / 2),
  prompt_cache_miss_tokens: Math.ceil(promptTokens / 2),
});

class FakeClient {
  calls: Array<{
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    toolChoice?: string;
  }> = [];
  private readonly responses: ChatResponse[];

  constructor(responses: ChatResponse[]) {
    this.responses = responses;
  }

  async chat(opts: {
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    toolChoice?: "auto" | "required" | "none";
  }): Promise<ChatResponse> {
    this.calls.push(opts);
    const next = this.responses.shift();
    if (!next) throw new Error("unexpected chat call");
    return next;
  }
}

test("runAgent performs an ephemeral context_update pass before each followup", async () => {
  const client = new FakeClient([
    {
      message: { role: "assistant", content: "answer one" },
      finish_reason: "stop",
      usage: usage(100),
    },
    {
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "maint_1",
            type: "function",
            function: {
              name: "context_update",
              arguments: JSON.stringify({
                reason: "boundary maintenance: no update needed",
                operations: [],
              }),
            },
          },
        ],
      },
      finish_reason: "tool_calls",
      usage: usage(120),
    },
    {
      message: { role: "assistant", content: "answer two" },
      finish_reason: "stop",
      usage: usage(140),
    },
  ]);

  const result = await runAgent({
    task: "question one",
    followups: ["question two"],
    config: makeConfig(),
    client: client as never,
    workdir: process.cwd(),
    mode: "cpat",
  });

  assert.deepEqual(result.answers, ["answer one", "answer two"]);
  assert.equal(result.metrics.boundary_maintenance_calls, 1);
  assert.equal(result.metrics.agent_patches_applied, 0);
  assert.equal(result.metrics.agent_patches_noop, 1);
  assert.equal(result.metrics.llm_calls, 3);
  assert.equal(client.calls[1].toolChoice, undefined);
  assert.deepEqual(
    client.calls[1].tools?.map((t) => t.function.name),
    ["context_update"],
  );
  assert.match(
    client.calls[1].messages.at(-2)?.content ?? "",
    /context_maintenance_boundary/,
  );
  assert.match(client.calls[1].messages.at(-1)?.content ?? "", /<context_manifest>/);
  assert.equal(
    result.runtime.blocks.all().some((b) => String(b.content).includes("context_maintenance_boundary")),
    false,
  );
});

test("react mode skips boundary maintenance pass", async () => {
  const client = new FakeClient([
    {
      message: { role: "assistant", content: "answer one" },
      finish_reason: "stop",
      usage: usage(100),
    },
    {
      message: { role: "assistant", content: "answer two" },
      finish_reason: "stop",
      usage: usage(120),
    },
  ]);

  const result = await runAgent({
    task: "question one",
    followups: ["question two"],
    config: makeConfig(),
    client: client as never,
    workdir: process.cwd(),
    mode: "react",
  });

  assert.deepEqual(result.answers, ["answer one", "answer two"]);
  assert.equal(result.metrics.boundary_maintenance_calls, 0);
  assert.equal(client.calls.length, 2);
});

test("threshold arm gets the runtime safety net but no context_update tool", async () => {
  const client = new FakeClient([
    {
      message: { role: "assistant", content: "done" },
      finish_reason: "stop",
      usage: usage(100),
    },
  ]);

  const result = await runAgent({
    task: "a task",
    config: makeConfig(),
    client: client as never,
    workdir: process.cwd(),
    mode: "threshold",
  });

  assert.deepEqual(result.answers, ["done"]);
  // threshold is passive: the agent is never handed context_update.
  const toolNames = client.calls[0].tools?.map((t) => t.function.name) ?? [];
  assert.equal(toolNames.includes("context_update"), false);
  assert.equal(toolNames.includes("artifact_get"), false);
});

test("react terminates early when the hard context window is exceeded", async () => {
  // The first turn's rendered view already exceeds a tiny hard window, so the
  // react arm cannot continue: it is forced to answer (paper's early
  // termination) via the tool-disabled flush.
  const client = new FakeClient([
    {
      message: { role: "assistant", content: "forced answer under overflow" },
      finish_reason: "stop",
      usage: usage(100),
    },
  ]);

  const result = await runAgent({
    task: "investigate a large corpus",
    config: makeConfig({ maxTurns: 6 }),
    client: client as never,
    workdir: process.cwd(),
    mode: "react",
    hardWindowTokens: 50, // far below even the system prompt + task
  });

  assert.equal(result.metrics.terminated_early, true);
  assert.ok(result.metrics.peak_view_tokens > 50);
  // exactly one (forced, tool-disabled) LLM call happened
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].toolChoice, "none");
  assert.equal(result.answer, "forced answer under overflow");
});

test("cpat is not force-terminated by the hard window (it can govern)", async () => {
  // Same tiny window, but cpat is NOT terminated — it keeps its turn and can
  // patch. Here it simply answers; the point is terminated_early stays false.
  const client = new FakeClient([
    {
      message: { role: "assistant", content: "governed answer" },
      finish_reason: "stop",
      usage: usage(100),
    },
  ]);

  const result = await runAgent({
    task: "investigate a large corpus",
    config: makeConfig(),
    client: client as never,
    workdir: process.cwd(),
    mode: "cpat",
    hardWindowTokens: 50,
  });

  assert.equal(result.metrics.terminated_early, false);
  assert.equal(result.answer, "governed answer");
});
