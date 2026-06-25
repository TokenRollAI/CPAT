# Agent 协议层（agent-protocol）

agent 侧的全部契约：系统提示词、工具 schema、DeepSeek 客户端行为、主循环、指标语义、测试清单。代码位于 `src/agent/` + `src/deepseek/client.ts` + `test/patch.test.ts`。运行时核心见 `llmdoc/architecture/context-runtime.md`。

## 0. 三对照臂与硬窗口（`src/agent/loop.ts`）

`AgentMode = "cpat" | "react" | "threshold"`（`runAgent` 的可选 `mode`，默认 `"cpat"`）——隔离「主动治理 vs 被动治理 vs 零治理」：

| mode | 注册工具 | system prompt | budget 监控 / runtime 兜底 | 角色 |
| --- | --- | --- | --- | --- |
| `cpat` | task tools + `artifact_get` + `context_update` | `SYSTEM_PROMPT`（含治理指引） | `checkBudget()` 全程，critical 兜底 | 主动治理 |
| `threshold` | task tools（**无 context_update / artifact_get**） | `REACT_SYSTEM_PROMPT`（无治理指引） | `checkBudget()` 全程，critical 被动 offload | 被动治理基线 |
| `react` | task tools | `REACT_SYSTEM_PROMPT` | **全旁路**：`pressure` 恒 `"ok"`、不调 `checkBudget` | 零治理（会撑爆） |

`threshold` 是 H1 缺失已久的「阈值压缩基线」：有 runtime 安全网（critical 时被动 force-offload）但不给 agent `context_update` 工具，从而把「主动 vs 被动治理」与「治理 vs 不治理」两个变量分开。

**硬窗口机制**（`hardWindowTokens`，默认 0=无）：渲染 view 超过该 token 数时，**react 臂被强制终止**（复现 CAT 论文 arXiv:2512.22087「dialogue terminates early」——窗口耗尽后无法纳入新信息）；threshold/cpat 不终止（它们靠 runtime 安全网把 context 压回窗口内）。指标 `terminated_early`（是否提前终止）与 `peak_view_tokens`（全程峰值渲染 token）随之上报。

**`taskToolNames` 过滤**（可选）：只注册指定的 task 工具，例如只给 `list_dir`+`read_file`（去 `grep_search`），强制 agent 整篇读、无法 grep 选择性跳过——制造真正的累积压力。

这三个旋钮支撑受限窗口双扫的决定性结果（见 `llmdoc/architecture/benchmark-harness.md` 与 decision `0007-bounded-window-cpat-value.md`）。

## 1. SYSTEM_PROMPT 契约（src/agent/loop.ts `SYSTEM_PROMPT`）

注入为不可修补的 `system_prompt` block，对 agent 的约束：

- **block 标签**：runtime 给消息打 `[block:<id>]`；agent 禁止在自己的回复里写 `[block:...]`。
- **manifest**：每轮最后一条 user 消息是 `<context_manifest>`（可见块 + 可恢复 archived 块），每轮重建，agent 不应直接回答它。
- **里程碑策略（DURING-task，提示重写后的核心）**：提示词明确「working context 是 BOUNDED 且小于待读材料，放任 raw read 累积会溢出被截断」，要求**读完一篇 tool_result 立刻 `payload_offload` 该 raw 块**、只在一行里留下精确事实（exact names/numbers/IDs/codes），只保留正在用的少数 raw 块——这是「读得远超窗口」的方式。不再只在边界整理。
- **处置陈旧块**：compact/fold/merge 后源块自动 archived；若某 raw 块**还另外被 offload 过**且其关键事实已进 summary，用 `set_visibility=hidden` 让它离开 manifest，避免「summary 与陈旧 raw/offloaded 块同时争用 context」并诱导重读。
- **re-read vs restore**：offload 过的块若后续需要精确原文，用 `restore`（或 `artifact_get`）而非重读整篇大文件——restore 比重读数千 token 文档便宜。
- **压力策略**：`soft` 时立刻开始 offload 已消化内容、不等；`must_act` 时本轮先 offload/hide 笨重已消化块再读新内容、或基于已知证据收尾，确实无可释放则回 `no_context_update_needed` + 一行理由；`critical` 由 runtime 兜底（语义盲、largest-first，靠它说明治理不及时）。
- **操作优先级**：固化「优先便宜、可逆」：`set_visibility`（archive/hide）< `payload_offload` < `restore` < `compact/fold/merge`；每个 op 都说明 preserve 精确事实、compact 整链一起、fold 连续区间、merge 用 resolution。
- **preserve 精确事实硬约束**：每个 patch 必须保住 user 需求、**当前问题**、task state、open questions、以及已收集的 EXACT 事实——summary 绝不能把精确事实糊成模糊表述。compact/fold/merge **不可吞当前问题（最近 user_message）与 task_state**（runtime 护栏强制，见 context-runtime.md §4）。
- **id 纪律**：禁止编造 id；protected 块可 compact/archive 但约束必须存活在某个可见块；**NEVER include budget_\* ids in a patch**（runtime-owned）。
- **task policy**：read → digest → offload → repeat，不让 raw read 累积；任务完成时回复纯文本最终答案、无 tool calls。

> 三层提示协同：上面的 `SYSTEM_PROMPT`（harness 层）+ `context_update` 的 tool description（工具层，见 §2）+ runtime 边界提示（boundary 层，见 §5）共同贯彻「里程碑式读完即 offload、处置陈旧块、preserve 精确事实」策略。重写动机与「prompt-only 主动治理的瓶颈在架构（治理 tool call 每次有 LLM 往返开销）」的发现见 `research/00-research-log.md` 阶段 5。`react`/`threshold` 臂用极简 `REACT_SYSTEM_PROMPT`（仅 block-tag/manifest 纪律 + task policy，无任何治理指引）。

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
- **受限窗口指标**：`terminated_early`（bool）= react 臂渲染 view 超过 `hardWindowTokens` 被强制终止（复现 CAT 论文「dialogue terminates early」）；`peak_view_tokens` = 全程峰值渲染 token（衡量 context 是否贴着窗口跑）。双扫中 react 两窗口 `terminated_early=true`、peak 75K/202K 爆窗口 → 0% / 8.3%；cpat peak 仅 19K/25K（主动压低），见 `benchmark-harness.md`。
- 实验解读（README H1-H4）：关注 `agent_patches_applied` 与 `runtime_fallback_offloads` 的**比例**——兜底占比高 = agent 治理不及时，退化成被动压缩。

一次失败事务可含多条 rejection（rule 计数 > 失败事务数是正常现象）。

## 7. 测试清单（离线不调 API）

**agent/tool 协议测试**：

- `test/contextTool.test.ts`：覆盖 `parseContextUpdateArgs` 扁平 schema → 内部 union 的映射、默认值、显式 no-op、未知 op 抛错。
- `test/agentLoop.test.ts`：覆盖 CPAT followup 前会跑一次 ephemeral `context_update` 边界维护 pass、该 pass 只暴露 `context_update` 且不落为 block；不强制 `tool_choice:"required"` 以兼容 DeepSeek thinking mode；ReAct 模式跳过。

**patch 引擎测试（test/patch.test.ts，13 个用例）**：

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
| 13 | compact cannot swallow the current question (semantic-drift guardrail) | `protected_current_question`：含当前问题（最近 user_message）的 compact 被拒、事务零变更；只压已答旧轮允许 |
