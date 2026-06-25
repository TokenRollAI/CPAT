# Context Update 应在用户消息边界做维护

## Task

根据用户反馈重做 `context_update` 的 agent-facing contract 和调用时机：每个 op 的 description 要写清适用原因、副作用、可能结果；工具整体要强调 context 组织和成本优势；同时修正原先「must_act 压力下本轮先 patch」的设计，使 Context Update 更适合在一次 agent loop 结束后、或下一条 user message 进入后执行。用户还指出过去实验 cache 命中率不高，需要把 cache 张力写进协议。

## What Changed

- `src/agent/contextTool.ts`：把 tool description 改成 future context / boundary maintenance 契约；每个 op 描述都覆盖 reason / side effect / result / rejection 风险；明确无收益 patch 会破坏 stable prefix 和 cache。
- `src/agent/loop.ts`：followup user message 进入后，CPAT 模式先跑一次 ephemeral `runBoundaryMaintenance`，只注册 `context_update`；维护提示通过 `buildView(ephemeralTailMessages)` 插在 manifest 前，不落为 block。真实 smoke benchmark 暴露 DeepSeek thinking mode 不支持 `tool_choice:"required"`，因此维护 pass 不能强制 required，模型未调用工具时按 no-op 处理。
- metrics：新增 `boundary_maintenance_calls`；把空 `operations: []` 从 `agent_patches_applied` 拆出为 `agent_patches_noop`，避免 no-op 让实验误以为 agent 做了真实治理。
- docs/tests：补 `test/contextTool.test.ts`、`test/agentLoop.test.ts`，并同步 README / llmdoc 架构文档。

## Lesson

之前反思里自然想到的修复方向是「must_act 时强制先 patch 再继续任务」。用户这次纠正了这个假设：对 agent 来说，正在执行的一次 tool/reasoning loop 中插入整理动作，会打断任务推进，也更容易频繁改写 context prefix，伤害 cache。更合理的工程切点是**边界维护**：

- 新 user message 提供了新的相关性判断依据，最适合决定哪些旧 context 仍有价值。
- 任务 loop 结束后，agent 已经消化了上一段探索，能写出更可靠的 summary / retrieval_hint。
- 维护 pass 本身应是 ephemeral tail，不应变成长期 block，否则 Context Update 会反过来污染 context。
- no-op 是有意义的决策，应单独计数；不能把它混进真实 patch 数。

## Promotion Candidates

- 稳定规则已提升到 `llmdoc/architecture/agent-protocol.md` 与 `llmdoc/architecture/context-runtime.md`：`context_update` 优先作为边界维护工具，真实 patch 应 tail-local、可逆、收益明确。
- 后续实验解读必须同时看 `agent_patches_applied`、`agent_patches_noop`、`boundary_maintenance_calls`、`runtime_fallback_offloads`；只看 patch 事件数会误读治理效果。
