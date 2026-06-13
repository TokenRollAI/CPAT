# 0002：payload_offload 不改变 block 的 kind

- **状态**：已采纳（真实 API 400 回归修复）
- **日期**：2026-06（demo run 期间发现）

## 背景

早期实现中 offload 会把 block 的 kind 改掉（如改为 artifact_ref 类形态）。在真实 DeepSeek demo run 中触发 API 400：offload 后的 tool result 不再被识别为 tool-call 链成员，后续 patch 把链拆散，下一轮 API 收到孤立的 `role:"tool"` 消息（没有对应带 `tool_calls` 的 assistant 头）。

## 决策

- **kind 表示块「是什么」（tool_result 等）；是否 offload 是存储/渲染形态**（content 是否为 ArtifactRef），二者正交。`src/runtime/patch.ts` 的 offload 路径刻意保持 kind 不变。
- **链归属由 API 字段判定，不由 kind 判定**：`src/runtime/blocks.ts` (`chainOf`) 基于 `api.tool_call_id` / `api.tool_calls` 收集链成员。offload 后 `api.tool_call_id` 保留，block 仍渲染为 `role:"tool"`、仍是链成员，`chain_atomicity` 检查继续覆盖它。
- 预算启发式（criticalFallback 只挑 tool_result）也因此继续基于真实 kind 工作。

## 后果

- `artifact_ref` 成为保留/遗留 BlockKind：无生产路径；`src/runtime/view.ts` 保留其渲染分支仅作防御性兜底。
- 由 test 9（"offloaded tool results remain chain members (regression: API 400)"）回归守护：漏掉 offloaded 成员的 compact 被拒 `chain_atomicity`；渲染后的消息列表无孤儿 tool 消息。
