# 上下文运行时（Context Runtime）

CPAT 运行时核心：数据模型、单份存储、patch 事务引擎、预算监控、视图构建。代码位于 `src/runtime/` + `src/types.ts`。所有不变量由 `test/patch.test.ts`（13 个离线测试，全部通过）守护。

## 1. 数据模型（src/types.ts）

**`ContextBlock`** —— 可寻址、可修补的工作态单元：

- `kind: BlockKind`：`system_prompt` / `user_message` / `assistant_message` / `reasoning_trace` / `tool_result` / `summary` / `artifact_ref` / `task_state` / `budget_report`。
  - `artifact_ref` 是保留/遗留 kind：patch.ts 刻意不再产生它（offload 不改 kind，见 §4），`src/runtime/view.ts` (`renderBlock`) 保留其渲染分支仅作防御性兜底。当前无任何生产路径。
- `content: string | ArtifactRef`：inline 文本或引用。offload 后仍是同一个 block，只是 content 翻成 `ArtifactRef`。
- `visibility: Visibility`：
  - `model`：渲染进下一次 view。
  - `archived`：不渲染，但列入 manifest，可经 `set_visibility=model` 恢复。
  - `hidden`：不渲染、不列 manifest。
  - `api_required`：runtime 内部态——DeepSeek thinking 模式要求在 tool-call 链开启期间回放 `reasoning_content`；agent 不可修补（`set_visibility` 的类型也不含它），链闭合后 runtime 降为 `hidden`。
- `protected?: boolean`：保护原件（system / user）不被改写或 hidden。
- `version: number`：配合 ContentStore 的 `<id>@v<version>` 键；redact/replace 成功后 `version += 1` 并写新键。
- `api?`：**runtime 内部 API 回放字段，agent 永远不可修补**——`tool_call_id`/`name`（role:"tool" 消息）、`tool_calls`（assistant 原始 tool_calls）、`reasoning_content`（链开启期间回放的 thinking trace）。这是「语义视图」与「API 协议」解耦的载体：agent 修补语义层，runtime 保证协议层完整。

**`ContextOperation`** 八种 op（默认启用 6 个 + gated 2 个）：

- `compact`（ids + output{description,content} + preserve[] + drop[]，output.id? 为保留字段、当前未使用）。
- `payload_offload`（ids + store + replace_with{description,summary,retrieval_hint}）。
- `set_visibility`（ids + visibility，类型只允许 model/archived/hidden）。
- `restore`（ids）—— `payload_offload` 的**零拷贝逆操作**：把已 offload 的 block 从 ContentStore 回填为 inline string。payload 仍在 `<id>@v<version>` 键下（offload 从不改 version），故 **version 不变**；只改 content（ArtifactRef→string）+ 重生成 description/token_count，不碰 visibility/kind，**永不破链**。
- `merge`（ids + output{description,content} + resolution:"update"|"contradiction"）—— 把 **≥2 个**语义重叠/重复块归并为一个 canonical 块，源块 archived 可恢复。`update`=合并，`contradiction`=新信息推翻旧的。
- `fold`（ids + output{description,content} + scope_label）—— 把 **store.order 中连续**的一段（已完成子任务轨迹）折叠成带 scope 的 summary 块，区间整体 archived（unfold 入口 = `set_visibility=model`）。与 compact 的唯一区别就是「ids 连续」+ scope_label。
- `redact`（ids + drop_fields[]，gated）。
- `replace`（单 id + content，唯一单目标 op，gated）。

`restore`/`merge`/`fold` **均不改 ContextBlock 数据模型**，与单份存储/链原子性自洽。

**`JournalEvent`** 三类，均带 `seq` + `ts`：`ingest`（元数据 + `content_key`，不存全文）、`patch`（actor: agent|runtime / reason / operations / result）、`llm_call`（model / usage / visible_blocks / est_view_tokens）。

**`BudgetReportContent`**：`used/max/soft_limit` + `pressure` + `largest_blocks[]`（含 suggested_ops）+ `required_preserve[]`。

## 2. 单份存储：ContentStore + Journal（src/runtime/stores.ts）

**设计决策**（详见 `llmdoc/memory/decisions/0001-single-copy-content-store.md`）：设计文稿的 append-only raw log 会让同一 payload 存三份（raw log 全文、block、offload 后的 artifact）。讨论后改为**单份内容存储 + 事件日志**：

- `ContentStore`：每个 payload 在 ingestion 时只写一次，键 `<blockId>@v<version>`，落盘 `runs/<ts>/content/<key>.txt`，内存 cache 幂等。`artifact://<key>` 是**唯一恢复通道**（`ContextRuntime.artifactGet` → `content.get`）。`ContentStore.isRef` 用 `typeof content !== "string"` 判定 block 是否已 offload。
- `Journal`：append-only，落盘 `journal.jsonl`，只携带元数据与 content key，从不复制全文。**agent 没有任何 op 能触碰 journal**——它承担原设计 raw log 的溯源/审计职责，所有 patch（agent 与 runtime 兜底）均可重放。
- 推论：`payload_offload` 退化为**零拷贝视图翻转**——payload 已在 ContentStore 当前 version 键下，offload 只把 `content` 换成指向该键的 ArtifactRef，瞬时完成。

## 3. BlockStore 与 chainOf（src/runtime/blocks.ts）

- 顺序：`order: string[]` 按插入维护；`visible()` = order 中 `visibility==="model"` 的子序列。**view 的消息顺序 = block 顺序**（缓存友好的根基，见 §7）。
- `BlockStore.create` 是所有写入汇聚点：分配 id、estimateTokens、写 ContentStore、记 journal ingest 事件。`insertAfter` 让 compact 生成的 summary 占据被压缩链的原位置。
- `createAssistantMessage`：thinking 模式同时返回 reasoning + tool_calls 时，额外建一个 `reasoning_trace` block（`visibility: "api_required"`、`retention: "ephemeral"`），并把 `reasoning_content` 同步写进 assistant block 的 `api` 以便渲染回放。无 tool_calls 时不建。

**`chainOf` 核心不变量：链归属由 `api.tool_call_id` / `api.tool_calls` 决定，不是 kind。**

- 找链头：block 自身有 `api.tool_calls` 即是头；否则按其 `api.tool_call_id` 向前扫描找到含该 id 的 assistant 头。再由头的 tool_calls id 集合收集全部成员。
- **API-400 回归故事**：早期版本 offload 后改 kind，导致按 kind 判链时漏掉已 offload 的 tool result → patch 把链拆散 → 下一轮 API 收到孤立的 role:"tool" 消息 → DeepSeek 真实返回 400。修复后 offload 保持 kind 与 `api.tool_call_id` 不变，offloaded tool result 仍渲染为 role:"tool"、仍是链成员。由 test 9（"offloaded tool results remain chain members"）回归守护。详见 `llmdoc/memory/decisions/0002-offload-keeps-kind.md`。

## 4. Patch 引擎（src/runtime/patch.ts，`applyContextUpdate`）

**事务语义**：对 block store 的克隆副本（`staged` map）逐 op 校验；**任一 op 被拒则整体不提交**（applied=0），全部 rejection 作为 tool result 返回 agent 以便修正重试。test 3 守护事务性（被拒后什么都没变）。

**通用前置门 `unpatchable`**（统一以 `protected_kind` 拒绝）：

| 目标 | 理由 |
| --- | --- |
| `system_prompt` | 永不可修补 |
| `budget_report` | runtime-owned，每轮自动轮转（提示 agent 从 op 中移除该 id 重试） |
| `api_required` 块 | 开启中的 tool-call 链，runtime 会自行释放 |

**逐规则与理由**：

| 规则 | 触发 | 理由 |
| --- | --- | --- |
| `empty_ids` | op 无目标 id | 拒绝无目标操作 |
| `unknown_id` | block 不存在 | 禁止编造 id |
| `compact_output` | output 缺 description 或 content | summary 必须可独立替代原文 |
| `compact_policy` | preserve 为空或 drop 非数组 | 强制 agent 显式声明保留/丢弃策略，防止无脑压缩 |
| `hidden_target` | compact/merge/fold 目标为 hidden | hidden 块需先恢复可见再处理（由共享 `collapseIntoBlock` 统一拒绝） |
| `protected_state` | compact/merge/fold 目标是 `task_state` 块 | 把任务状态压成有损 summary 会让 agent 丢失进度——必须 archive 或 restore，不可折叠 |
| `protected_current_question` | compact/merge/fold 目标是当前问题（最近 `user_message`） | 当前问题须逐字保留，否则 agent「忘了在答什么」（v3 smoke 实测的语义漂移失效模式） |
| `offload_replacement` | 缺 description/summary/retrieval_hint | 恢复线索不能丢——offload 后唯一找回入口是这些字段 + uri |
| `offload_kind` | 目标非 tool_result / assistant_message | 只有大 payload 块值得 offload；原件与摘要不适用 |
| `already_offloaded` | content 已是 ArtifactRef | 幂等保护 |
| `not_offloaded` | restore 目标不是 ArtifactRef | restore 只回填已 offload 块；幂等保护 |
| `artifact_missing` | restore 时内容键查不到全文 | payload 不可恢复（理论不应发生，offload 不改 version） |
| `merge_output` | merge 缺 output.description/content | 归并产物必须可独立替代源块 |
| `merge_arity` | merge 的 id < 2 个 | merge 是去重/归并，单块无意义 |
| `merge_resolution` | resolution 非 update/contradiction | 强制 agent 声明是合并还是矛盾消解 |
| `fold_output` | fold 缺 output.description/content | scope 摘要必须可独立替代区间 |
| `fold_scope` | scope_label 为空 | fold 必须命名被折叠的子任务 |
| `fold_range` | ids 在 store.order 不是连续 run | fold 只折叠连续子任务轨迹；非连续集用 compact |
| `op_disabled` | replace/redact 未经 `--allow-*` 开启 | MVP 阶段「历史不可重写」默认策略 |
| `redact_fields` / `redact_kind` / `redact_not_json` | redact 参数/目标不合法 | redact 仅对 inline JSON tool_result 删字段，否则建议 compact/offload |
| `visibility_missing` | set_visibility 缺 visibility | — |
| `protected_hidden` | protected 块设 hidden | archive 在 manifest 中可恢复，hidden 不可见——protected 原件只许 archive |
| `replace_protected` | user_message 或任何 protected 块被 replace | 原件只能被 summarize/archive，不可改写 |
| `replace_content` | replace content 为空 | — |

**`chain_atomicity` 事务级后置检查**（op_index: -1，仅在无其它拒绝时跑）：遍历仍可见的 block，对每个取 `chainOf`；若链中任一成员在 staged 视图中不再可见则整体拒绝。理由：破链 → 下一轮 API 出现孤立 tool 消息或无 result 的 tool_calls 头 → 400。这是真实 run 中 agent 最常踩的规则（一次 run 中 13 次 rejection），被拒后 agent 可学会「整链一起 compact」并成功重试（journal 有完整证据链）。

**`payload_offload` 零拷贝路径**：校验通过后只把 `b.content` 换成指向现有 content key 的 ArtifactRef、更新 description、按 renderedText 重算 token_count。**kind 故意不变**（test 1 断言 `block.kind === "tool_result"`）。

**`restore` 零拷贝逆操作**：offload 的镜像。校验目标 content 是 ArtifactRef（否则 `not_offloaded`）、从 `content.get(contentKey(b))` 取回全文（缺失则 `artifact_missing`），把 content 翻回 inline string、用 `describeText("Restored payload", …)` 重生成 description、重算 token_count。payload 始终在 block 的 `<id>@v<version>` 当前键下（offload 从不改 version），故 version 不变、不写新键；不碰 visibility/kind/api，**永不破链**（test 10 守护往返一致 + `not_offloaded` 拒绝）。

**`collapseIntoBlock(i, ids, targets, description, contentText)` 共享 helper**：`compact` / `merge` / `fold` 三者的公共主体——把 targets 全部置 archived（命中 hidden 则拒 `hidden_target`），并在**最早目标的位置**（`store.order` 中最小索引的前一个块之后）stage 一个替换 summary 块。**语义漂移护栏**（共享前置检查）：targets 含 `task_state` 块拒 `protected_state`、含当前问题（最近 `user_message`）拒 `protected_current_question`——这两类活动对话状态不能被折叠成有损 summary（v3 smoke 实测：未护栏时主动 compact 把当前问题压没，agent「忘了在答什么」，质量反输被动 threshold；加护栏后两者打平 100%，见 decision `0007-bounded-window-cpat-value.md`）。三者只在前置校验与 description 前缀上不同：
- `compact`：直接用 `output.description`。
- `merge`：description 前缀 `[merged]` 或 `[merged (contradiction resolved)]`（按 resolution）。
- `fold`：description 前缀 `[folded scope: <label>]`。
`compact` 已重构为复用该 helper，行为不变（test 2 仍通过）。

**`freed_tokens` 记账**：提交前后各算一次 `visible()` token 总和之差（`max(0, before - after)`）——是**可见 token 差**，不是被处理 block 的 token。

**提交**：staged 克隆中 version 增长且 content 为 string 的写新 version 键到 ContentStore，再 `Object.assign` 落回真实 block；暂存的 summary 经 `store.create` + `insertAfter` 正常 ingestion。

## 5. 预算监控（src/runtime/runtime.ts）

**压力阶梯**（`pressureOf`，阈值 = `maxContextTokens` × config 比例，CLI 硬编码 0.7/0.8/0.95，不可 flag 覆盖）：

| 估算用量 | 压力 | 行为 |
| --- | --- | --- |
| ≥ 95% | `critical` | 先跑 `criticalFallback` 兜底，再重估，仍生成报告 |
| ≥ 80% | `must_act` | 普通任务回合应收窄探索；边界维护 pass 或临近溢出时提交最小 patch / 显式 no-op |
| ≥ 70% | `soft` | 注入 budget_report，agent 自行决定 |
| 其下 | `ok` | 不动作 |

**标定 token 估算**（`estimatedUsed`）：基础是 `src/util/misc.ts` (`estimateTokens`) 的字符级启发式（ASCII 0.3 token/字符、CJK 等宽字符 0.6）；有真实 `prompt_tokens` 后用 `ratio = clamp(lastActualPrompt / lastEstimate, 0.5, 2)` 在线校正。闭环：`buildView` 记 `lastEstimate`，`recordLlmCall` 回填 `lastActualPrompt`。注意 loop 每轮 `checkBudget` 在 `recordLlmCall` 之前，用的是上一轮校准比率。

**`criticalFallback`（95% 安全网）**：候选 = 可见 + `kind==="tool_result"` + content 为 string + **`token_count >= 300`**（只 offload 大块；小块碎成 ref 收益微薄），按 token 降序逐个 offload，估算降到 soft 以下即停。每次走正常 `applyUpdate(..., "runtime")` 路径（同一校验 + journal），`runtimeFallbacks += 1`。比 agent 可用的 `offload_kind` 更保守：**只碰 tool_result，不碰 assistant_message**。

**budget_report 生命周期（runtime-owned）**：每轮 `checkBudget` 把旧报告设 **hidden 而非 archived**——archived 会出现在 manifest 中，实际运行中 agent 曾反复试图 patch 预算报告；hidden + `protected_kind` 拦截 + manifest 标 `runtime_owned` 三重防护解决该问题。test 6 守护「model 可见的 budget_report ≤ 1，不累积」。

**reasoning_trace 生命周期**（`releaseReasoning`）：新 assistant 消息到达即表示上一轮 tool-call 链闭合，`ingestAssistant` **先**调 `releaseReasoning`——所有 `api_required` 的 reasoning_trace 降为 `hidden`，并从父 assistant block 的 `api` 删除 `reasoning_content`（停止回放）。test 7 守护完整生命周期。

## 6. 视图构建（src/runtime/view.ts）

**`buildMessages`**：遍历 `store.all()`，只渲染 `visibility==="model"` 的 block；消息顺序 = block 顺序；估算 = 各内容估算 + 每消息固定 4 token 开销。可选 `ephemeralTailMessages` 会插在 manifest 前，供边界维护等**单次调用提示**使用，不创建 block、不写 ContentStore、不污染后续 stable prefix。

**缓存友好原则（stable-prefix / volatile-tail）**：消息列表是只在 patch 处变动的**稳定前缀**；每轮易变内容（ephemeral tail、manifest、budget_report）集中在**尾部**，使前缀持续命中 DeepSeek context cache（实验假设 H3 的实现基础）。manifest **每轮重建、从不落为 block**（否则累积会破坏稳定前缀），作为最后一条 role:"user" 消息追加。经验修正：CPAT 治理不是 cache 恒优，频繁改写早期 prefix 会降低命中；因此边界维护提示要求优先 tail-local、可逆、收益明确的 patch。

**`renderBlock` 渲染规则**（除 system_prompt 外均带 `[block:<id>]` 前缀标签，供 agent 在 manifest 与消息间对应 id）：

| kind | role | 备注 |
| --- | --- | --- |
| `system_prompt` | system | 无 tag |
| `user_message` | user | — |
| `budget_report` | user | `<budget_report>...</budget_report>` 包裹 |
| `tool_result` / `artifact_ref` | tool（有 `api.tool_call_id` 时）否则 user | API 协议字段决定 role |
| `assistant_message` | assistant | 带 `api.tool_calls`；链开启期间回放 `api.reasoning_content` |
| `summary` / `task_state` | assistant | 标注 `[compacted context — summary of <source_ids>]` |
| `reasoning_trace` | assistant | 仅当 agent 主动设为 model 才渲染 |

offload 后的渲染（`BlockStore.renderedText`）：`[offloaded payload] <summary>`＋`(full payload recoverable at <uri> — <retrieval_hint>)`。

**`buildManifest`**：列出所有 model 块（id/kind/tokens/protected?/offloaded?/runtime_owned?/description）与 archived 块（可恢复），但**排除 budget_report 与 reasoning_trace**——不诱导 agent 恢复 runtime 内部块。

**`buildBudgetReport`**：候选 = 可见 + kind∈{tool_result, assistant_message, summary} + 非 ref，token 降序取前 5；suggested_ops：tool_result → `[payload_offload, compact]`，其他 → `[compact, set_visibility:archived]`；固定 `required_preserve` 四项（用户需求/当前计划/开放问题/下一步引用）。

## 相关文档

- agent 侧协议与循环：`llmdoc/architecture/agent-protocol.md`
- 决策记录：`llmdoc/memory/decisions/0001-single-copy-content-store.md`、`0002-offload-keeps-kind.md`
