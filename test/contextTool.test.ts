import { test } from "node:test";
import assert from "node:assert/strict";
import { parseContextUpdateArgs } from "../src/agent/contextTool.ts";

test("parseContextUpdateArgs maps flat payload fields to typed operations", () => {
  const req = parseContextUpdateArgs(
    JSON.stringify({
      reason: "boundary cleanup",
      operations: [
        {
          op: "payload_offload",
          ids: ["tool_1"],
          description: "grep result",
          content: "Matches in auth files.",
          retrieval_hint: "artifact_get if exact grep lines are needed",
        },
        { op: "restore", ids: ["tool_2"] },
        {
          op: "merge",
          ids: ["assistant_1", "assistant_2"],
          description: "auth findings",
          content: "auth.ts exports guard()",
        },
        {
          op: "fold",
          ids: ["assistant_3", "tool_3"],
          description: "question 1 work",
          content: "Question 1 answered from doc A.",
          scope_label: "answered question 1",
        },
        { op: "set_visibility", ids: ["assistant_4"] },
        { op: "replace", ids: ["assistant_5"], description: "rewritten", content: "new" },
      ],
    }),
  );

  assert.equal(req.reason, "boundary cleanup");
  assert.deepEqual(req.operations[0], {
    op: "payload_offload",
    ids: ["tool_1"],
    store: "file",
    replace_with: {
      description: "grep result",
      summary: "Matches in auth files.",
      retrieval_hint: "artifact_get if exact grep lines are needed",
    },
  });
  assert.deepEqual(req.operations[1], { op: "restore", ids: ["tool_2"] });
  assert.deepEqual(req.operations[2], {
    op: "merge",
    ids: ["assistant_1", "assistant_2"],
    output: { description: "auth findings", content: "auth.ts exports guard()" },
    resolution: "update",
  });
  assert.deepEqual(req.operations[3], {
    op: "fold",
    ids: ["assistant_3", "tool_3"],
    output: { description: "question 1 work", content: "Question 1 answered from doc A." },
    scope_label: "answered question 1",
  });
  assert.deepEqual(req.operations[4], {
    op: "set_visibility",
    ids: ["assistant_4"],
    visibility: "archived",
  });
  assert.deepEqual(req.operations[5], {
    op: "replace",
    id: "assistant_5",
    content: "new",
    description: "rewritten",
  });
});

test("parseContextUpdateArgs preserves explicit no-op and rejects unknown op", () => {
  assert.deepEqual(parseContextUpdateArgs(JSON.stringify({ reason: "no change", operations: [] })), {
    reason: "no change",
    operations: [],
  });

  assert.throws(
    () =>
      parseContextUpdateArgs(
        JSON.stringify({ reason: "bad", operations: [{ op: "clear", ids: ["x"] }] }),
      ),
    /unknown op "clear"/,
  );
});
