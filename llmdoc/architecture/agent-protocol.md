# Agent 协议层（agent-protocol）

agent 侧的全部契约：系统提示词、工具 schema、DeepSeek 客户端行为、主循环、指标语义、测试清单。代码位于 `src/agent/` + `src/deepseek/client.ts` + `test/patch.test.ts`。运行时核心见 `llmdoc/architecture/context-runtime.md`。

## 1. SYSTEM_PROMPT 契约（src/agent/loop.ts `SYSTEM_PROMPT`）

注入为不可修补的 `system_prompt` block，对 agent 的约束：

- **block 标签**：runtime 给消息打 `[block:<id>]`；agent 禁止在自己的回复里写 `[block:...]`。
- **manifest**：每轮最后一条 user 消息是 `<context_manifest>`（可见块 + 可恢复 archived 块），每轮重建，agent 不应直接回答它。
- **维护时机**：提示词把 `context_update` 定位为**边界维护工具**——任务 loop 结束后、下一条 user message 进入后、或临近溢出时使用；常规任务回合不要为整理而整理，避免频繁改写 stable prefix。
- **压力策略**：`pressure=soft` 时收窄新探索、等边界 pass 整理已消化内容；`pressure=must_act` 时避免 broad task tools，必要时做最小 `context_update` 或基于已知证据收尾，也可显式 `no_context_update_needed`；`critical` 由 runtime 兜底。
- **操作优先级**：提示词列出全部可用 op，并固化「优先便宜、可逆、tail-local」：`set_visibility=archived` < `payload_offload` < `restore` < `compact/fold/merge`；restore 标注为 offload 的逆操作，merge/fold 各带其触发场景说明。
- **id 纪律**：禁止编造 id；protected 块可 compact/archive 但约束必须存活在某个可见块；**NEVER include budget_\* ids in a patch**（runtime-owned）。
- **task policy**：少量多次读文件；压力下不开 broad 新战线；任务完成时回复纯文本最终答案、无 tool calls。followup 进入后由 runtime 触发一次维护 pass。

## 2. 工具面（src/agent/contextTool.ts）

**`context_update`（strict JSON schema）**：顶层 `{reason, operations[]}`；`operations` 每项是**扁平 per-op item**（strict-mode 友好）：`op`（enum 八种）+ `ids[]` 必填，`description/content/preserve/drop/resolution/scope_label/visibility/retrieval_hint` 选填，`additionalProperties: false`。顶层 tool description 明确这是**future context / boundary maintenance** 工具，并写入 cache 注意事项：优先便宜、可逆、tail-local；避免无收益地 compact 早期高复用 prefix。每个 op 的 description 都说明适用原因、副作用、可能结果与失败约束；chain_atomicity 仍是显式提醒。

**扁平 → 联合类型归一化**（`parseContextUpdateArgs`，唯一翻译层）：

| op | 映射 |
| --- | --- |
| compact | `{ids, output:{description, content}, preserve, drop}` |
| payload_offload | `{ids, store:"file", replace_with:{description, summary(=content), retrieval_hint}}` —— schema 的 `content` 映射到 `replace_with.summary` |
| restore | `{ids}` |
| merge | `{ids, output:{description, content}, resolution ?? "update"}` |
| fold | `{ids, output:{description, content}, scope_label ?? ""}` |
| redact | `{ids, drop_fields(=drop), preserve_fields(=preserve)}` |
| set_visibility | `{ids, visibility ?? "archived"}` |
| replace | `{id: ids[0], content, description}`（单 id） |

新字段：`resolution`（merge 用，enum update/contradiction，默认 "update"）、`scope_label`（fold 用，默认 ""）。未知 op 抛 `unknown op "..."`。

**空 operations = 显式 no-op**：schema description 明确说明；用于边界 pass 判断「不值得改写 context」或压力下确认无可释放内容。`ok=true, applied=0`，由 patch test 8 与 `test/contextTool.test.ts` 守护。

**`artifact_get`（非 strict）**：`{uri, max_chars?}`；`runtime.artifactGet(uri)` 取回 offload 全文，未命中返回 `error: no artifact at "..."`，超过 max_chars（默认 6000）截断并标注完整长度。它是**当前步骤临时读取**；若需要让全文长期回到 rendered context，用 `context_update op=restore`。

## 3. 任务工具沙箱（src/agent/taskTools.ts）

三个只读工具 `list_dir / read_file / grep_search`，故意简单、会产生大 payload 以驱动 agent 学会 payload_offload。

- **workdir 沙箱**（`safePath`）：`resolve(root, p)` 后必须等于 root 或以 `root + sep` 开头，否则抛 `path escapes the workdir`。
- 输出截断：`MAX_OUTPUT_CHARS = 120_000`，超长追加 `…[truncated N chars]`。
- grep：大小写不敏感；NUL 检测跳过二进制；跳过 ≥2MB 文件。
- 跳过 `SKIP_DIRS`（node_modules/.git/runs/.llmdoc-tmp/dist/build）与所有 `.` 开头条目。
- read_file 带行号渲染。

## 4. DeepSeek 客户端（src/deepseek/client.ts `DeepSeekClient.chat`）

OpenAI 兼容 `POST {baseUrl}/chat/completions`，全局 fetch、零依赖、Bearer 鉴权。

- **strict 降级**：400 且响应体匹配 `/strict/i` 且未降级 → 置 `strictRejected=true` 重试；此后所有调用经 `stripStrict` 去掉 tools 的 `strict` 字段。安全性依据：patch 校验在我们自己的 patch 引擎里，不依赖 API 端 strict。
- **5xx 重试**：`status >= 500 && attempt < 3` → 线性退避（1s/2s）后重试；其它非 2xx 抛 `DeepSeek API <status>: <body>`。
- **usage / cache token 提取**：直接取 `data.usage`，缺失回退全 0；`ChatUsage` 含可选 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（DeepSeek context caching 字段，metrics 据此算命中率；API 不返回时 miss 统计会偏低）。
- **thinking 模式回放要求**：tool-call 链未闭合时，assistant 消息必须随消息回放 `reasoning_content`（API 协议要求）——由 runtime 的 `api_required` reasoning_trace 生命周期实现（见 context-runtime.md §5）。

## 5. 主循环（src/agent/loop.ts `runAgent`）

1. 入口 `ingestSystem(SYSTEM_PROMPT)` + `ingestUser(task)`。
2. 每轮：`checkBudget()`（可能触发 critical 兜底 + 注入 budget_report；**在 recordLlmCall 之前**，用上一轮校准比率）→ `buildView()` → `client.chat()` → `recordLlmCall(usage)` → `ingestAssistant(resp.message)`。
3. 有 `tool_calls`：逐个 `dispatchTool` + `ingestToolResult`；否则把 content 作为最终答案提前返回。
4. followup 场景：当前问题产出最终答案后，`runtime.ingestUser(nextQuestion)`，CPAT 模式先跑一次 `runBoundaryMaintenance`，只注册 `context_update`（不强制 `tool_choice:"required"`，DeepSeek thinking mode 不支持该设置）；维护提示以 ephemeral tail message 传入 `buildView`，不落为 block。agent 可以提交真实 patch，也可以用 `operations: []` 显式 no-op；若模型未调用工具则按 no-op 处理。ReAct 模式跳过此 pass。
5. **final-answer flush**：跑满 `maxTurns` 仍无答案时，ingest 一条 "Turn limit reached... Do not request tools." 的 user 消息，`toolChoice: "none"` 强制再调一次 chat 产出文字答案——run 永不无结果结束。

工具注册顺序：`[...taskToolDefs, artifactGetTool, contextUpdateTool]`。

## 6. 指标语义（`collectMetrics`，从 journal 聚合）

**关键区分（易误读）**：

- `agent_patches_applied` = agent 成功且 `applied>0` 的**真实变更事务数**（非 op 数）；空 `operations: []` 不计入。
- `agent_patches_noop` = agent 成功提交的 no-op 事务数，主要来自边界维护 pass 判断“不值得改写 context”。
- `ops_by_type` = **agent + runtime 全部成功事务的逐 op 计数**。
- 真实 demo run 的证据：`ops_by_type.payload_offload = 62` **全部来自 runtime critical 兜底**；agent 的 9 个成功 patch 贡献的是 21 compact + 6 set_visibility。读 metrics 时不可把 ops_by_type 归功于 agent。
- `runtime_fallback_offloads` 直接取 `runtime.runtimeFallbacks` 计数器。
- `governance_nudges` = 普通任务回合在 `must_act` 压力下仍继续开 task tools 的软提醒次数；不再代表“本轮必须 patch”硬门。
- `boundary_maintenance_calls` = followup user message 进入后触发的 ephemeral 维护 pass 次数（包括空 operations no-op）。
- `cache_hit_ratio = cache_hit / prompt`（3 位小数）；`final_visible_*` 取末态 `blocks.visible()`。
- 实验解读（README H1-H4）：关注 `agent_patches_applied` 与 `runtime_fallback_offloads` 的**比例**——兜底占比高 = agent 治理不及时，退化成被动压缩。

一次失败事务可含多条 rejection（rule 计数 > 失败事务数是正常现象）。

## 7. 测试清单（离线不调 API）

**agent/tool 协议测试**：

- `test/contextTool.test.ts`：覆盖 `parseContextUpdateArgs` 扁平 schema → 内部 union 的映射、默认值、显式 no-op、未知 op 抛错。
- `test/agentLoop.test.ts`：覆盖 CPAT followup 前会跑一次 ephemeral `context_update` 边界维护 pass、该 pass 只暴露 `context_update` 且不落为 block；不强制 `tool_choice:"required"` 以兼容 DeepSeek thinking mode；ReAct 模式跳过。

**patch 引擎测试（test/patch.test.ts，12 个用例）**：

| # | 测试 | 守护的不变量 |
| --- | --- | --- |
| 1 | payload_offload is zero-copy and recoverable | offload 零拷贝；kind 不变；content 变 ArtifactRef；`artifactGet` 可恢复原文；`api.tool_call_id` 保留 |
| 2 | compact requires preserve/drop and archives sources | `compact_policy`；源块 archived；summary 接替链位置 |
| 3 | breaking a tool-call chain is rejected | `chain_atomicity` + 事务性（被拒后零变更） |
| 4 | system prompt and user originals are protected | `protected_kind` / `replace_protected` / `protected_hidden`；archive user 允许 |
| 5 | replace is gated off by default | `op_disabled` |
| 6 | budget monitor injects report and critical pressure force-offloads | 压力阶梯 + critical 兜底 + budget_report 轮转不累积 |
| 7 | reasoning_trace is api_required during open chain, released after | thinking 回放生命周期：链开启 api_required 不可 patch，链闭合降 hidden |
| 8 | empty operations list is an explicit accepted no-op | 空 ops = 显式 no-op（ok=true, applied=0） |
| 9 | offloaded tool results remain chain members (regression: API 400) | chainOf 按 api 字段判链；漏掉 offloaded 成员的 compact 被拒；渲染后无孤儿 tool 消息 |
| 10 | restore re-inlines an offloaded payload (inverse of payload_offload) | offload→restore 往返 content 等于原 payload；kind/tool_call_id 不变；未 offload 块 restore 拒 `not_offloaded` |
| 11 | merge consolidates overlapping blocks and archives the sources | `merge_arity`（1 id 拒）；2 块 archived、生成含 `merged` 的 summary、source_ids 正确 |
| 12 | fold collapses a contiguous range and rejects a non-contiguous set | `fold_scope`（空 label 拒）+ `fold_range`（跳块拒）；连续 3 块 archived、生成 scoped summary |
