# ARCHITECTURE — `context_update` 工具的设计与实现

> 本文说明 CPAT 的核心：`context_update` 这个工具**应该怎么设计**、目前**提供哪些能力**、
> 以及**具体怎么实现**。读者对象是想理解或扩展 CPAT 的工程师。
> 配套：运行时细节见 [`llmdoc/architecture/context-runtime.md`](llmdoc/architecture/context-runtime.md)，
> 研究动机与验证见 [`research/`](research/)。

---

## 1. 设计哲学：上下文是 agent 治理的一等公民

传统 agent 把上下文当成只增不改的 append-only 日志，压缩交给框架在阈值处被动触发。
CPAT 的命题相反：**把"编辑未来上下文"做成一个 agent 可调用的、受校验的工具**，让 agent 在
推理过程中主动决定保留/卸载/恢复/合并哪些信息。

这个设计要同时满足四个约束，它们决定了下面所有实现细节：

| 约束 | 为什么 | 实现后果 |
|---|---|---|
| **可校验** | agent 会犯错（破坏 API 协议、压掉关键信息） | 事务式 patch 引擎，任一 op 被拒整体回滚 |
| **可逆** | "先放下、后又需要"是长程任务常态 | `payload_offload` ↔ `restore` 零拷贝对；archive 可恢复 |
| **审计可重放** | 研究需要知道每个决策的后果 | append-only Journal 记录每次 patch |
| **缓存友好** | 频繁改写上下文会摧毁 KV-cache | 稳定前缀 + 易变尾部；操作偏好 tail-local |

> 设计张力先讨论再实现：参见 [`llmdoc/memory/decisions/`](llmdoc/memory/decisions/)（如 0001 单份存储、0002 offload 不改 kind）。

---

## 2. 数据模型：工具操作的对象

`context_update` 操作的不是消息，而是 **block**。每条进入系统的消息成为一个 `ContextBlock`
（`src/types.ts`）：

```ts
interface ContextBlock {
  id: string;                       // 寻址键，patch 用它指定目标
  kind: BlockKind;                  // 这个块"是什么"
  content: string | ArtifactRef;    // inline 文本，或 offload 后的引用
  visibility: Visibility;           // 决定是否渲染进下一轮 view
  version: number;                  // 配合 ContentStore 的 <id>@v<version> 键
  source_ids: string[];             // summary 块指向它压缩了哪些源
  protected?: boolean;              // system / user 原件
  api?: { tool_call_id?, tool_calls?, reasoning_content? };  // API 协议回放字段，agent 永不可碰
}
```

**9 个 `BlockKind`**：`system_prompt` / `user_message` / `assistant_message` / `reasoning_trace` /
`tool_result` / `summary` / `artifact_ref`（遗留）/ `task_state` / `budget_report`。

**4 个 `Visibility`**：
- `model` — 渲染进下一轮 view。
- `archived` — 不渲染，但列入 manifest，可经 `set_visibility=model` 恢复。
- `hidden` — 不渲染、不列 manifest（彻底移出，但内容仍在 ContentStore）。
- `api_required` — runtime 内部态（thinking 链开启期间的 reasoning_trace），agent 不可 patch。

### 单份存储 + 零拷贝（关键设计）

```
ContentStore  每个 payload 在 ingestion 时只写一次，键 <blockId>@v<version>，
              落盘 runs/<ts>/content/。artifact://<key> 是唯一恢复通道。
Journal       append-only：ingest / patch / llm_call，只记元数据与内容键，从不复制全文。
```

推论：**`payload_offload` 退化为零拷贝视图翻转**——payload 已在 ContentStore 当前版本键下，
offload 只把 block 的 `content` 从 inline string 换成指向该键的 `ArtifactRef`，瞬时完成；
`restore` 是逆操作，把全文从该键读回填为 inline。两者都不改 version、不改 kind、不破链。

---

## 3. 工具契约：agent 看到的 schema

`context_update`（`src/agent/contextTool.ts`）。顶层 `{reason, operations[]}`，`operations` 每项是
**扁平的 per-op item**（OpenAI strict-mode 友好），由唯一翻译层 `parseContextUpdateArgs` 归一化成
typed `ContextOperation` 联合类型，再交给 patch 引擎。

设计要点：

- **schema 即契约**：每个字段的 description 明确说明"哪个 op 用、效果是什么"。tool description 顶部给出
  **操作选择指南**（按可逆性/代价升序：`set_visibility=archived` < `payload_offload` < `restore` <
  `compact`/`fold`/`merge`），以及"处置陈旧块"（摘要已含事实就 hidden 掉冗余源）和"读完即 offload"的里程碑策略。
- **空 `operations: []` = 显式 no-op**：用于边界 pass 决定"不值得改写上下文"。
- 辅助工具 `artifact_get`：按 `artifact://<key>` 取回 offload 全文（恢复通道）。

---

## 4. 8 个原子操作（目前提供的能力）

默认启用 6 个；`replace` / `redact` 默认 gated。

### 4.1 `set_visibility` — 最便宜、最可逆
park 或恢复整块，不改内容。`archived` 留 manifest 可恢复；`hidden` 彻底移出；`model` 恢复。
**首选**——处置不再需要但可能回访的块。

### 4.2 `payload_offload` — 大载荷外置（零拷贝）
把大 `tool_result` / `assistant_message` 的原文换成"短摘要 + artifact 引用"。摘要里要放**精确事实**
（名/数/ID/code 逐字）和 `retrieval_hint`。token 大幅下降，全文经 `restore` / `artifact_get` 可恢复。

### 4.3 `restore` — offload 的逆操作（零拷贝）
把已 offload 块的全文从 ContentStore 回填为 inline。version 不变、kind 不变、不破链。
比"重读源文件"便宜——但前提是信息源在 context 里那一份是唯一的（见 §7 局限）。

### 4.4 `compact` / `fold` / `merge` — 把多块收敛成一块（有损但可恢复）
三者共享实现路径 `collapseIntoBlock`：归档源块 + 在最早源块位置插入一个 summary 块。区别在语义与校验：

| op | 适用 | 额外约束 |
|---|---|---|
| `compact` | 任意一组完成的探索 | 必须声明 `preserve`（保精确事实）/ `drop`（弃 filler） |
| `fold` | 一段**连续**子任务轨迹 | ids 必须在 block order 连续；需 `scope_label` |
| `merge` | 2+ 重叠/重复块（如同文件读两次） | ≥2 个 id；`resolution` = update / contradiction |

源块被 archive（可恢复），所以视图有损但信息可找回。summary 块是一等块（可被再压缩，形成层级摘要）。

### 4.5 `replace` / `redact` — gated 改写
`replace` 改写非 protected 块内容；`redact` 删 inline JSON tool_result 的字段。默认关闭
（`--allow-replace` / `--allow-redact`），MVP 阶段"历史不可重写"策略。

---

## 5. 事务引擎：怎么实现校验与应用

`applyContextUpdate`（`src/runtime/patch.ts`）。**事务语义**：对 block store 的克隆副本（`staged`）逐 op 校验，
**任一 op 被拒则整体不提交**，全部 rejection 返回 agent 重试。

### 5.1 通用前置门
`unpatchable`：`system_prompt` / `budget_report` / `api_required` 块一律拒（`protected_kind`）——
runtime-owned，agent 不可碰。

### 5.2 全部 27 条校验规则
| 类别 | 规则 |
|---|---|
| 通用 | `empty_ids` · `unknown_id` · `protected_kind` |
| compact | `compact_output` · `compact_policy` · `hidden_target` |
| offload | `offload_replacement` · `offload_kind` · `already_offloaded` |
| restore | `not_offloaded` · `artifact_missing` |
| merge | `merge_output` · `merge_arity` · `merge_resolution` |
| fold | `fold_output` · `fold_scope` · `fold_range` |
| set_visibility | `visibility_missing` · `protected_hidden` |
| replace | `op_disabled` · `replace_protected` · `replace_content` |
| redact | `op_disabled` · `redact_fields` · `redact_kind` · `redact_not_json` |
| **护栏** | `protected_state` · `protected_current_question` · `chain_atomicity` |

### 5.3 两个关键护栏（实现正确性的命门）

**`chain_atomicity`（事务级后置检查）**：tool-call chain = assistant 头 + 它全部的 tool_result
（含已 offload 的）。链归属看 `api.tool_call_id`/`api.tool_calls`，**不看 kind**。若 patch 后链中任一成员
不再可见，整体拒绝——否则下一轮 API 会收到孤立的 `role:"tool"` 消息而返回 400（这是真实回归，由 test 守护）。

**`protected_state` / `protected_current_question`（语义漂移护栏）**：`compact`/`fold`/`merge` **不能吞掉**
`task_state` 块和**当前问题**（block order 里最后一个 `user_message`）。没有这个护栏时，实测 agent 会把当前问题
压进摘要、然后回复"没收到问题"（语义漂移）。这是研究中诊断出的真实失败，加护栏后准确率从 90% → 100%
（见 [`research/experiments/03-smoke-v3-active-vs-passive.md`](research/experiments/03-smoke-v3-active-vs-passive.md)）。

### 5.4 提交
校验通过后：version 增长的写新 content 键，`Object.assign` 落回真实 block；暂存的 summary 经
`store.create` + `insertAfter` 正常 ingestion。`freed_tokens` = 提交前后可见 token 之差。

---

## 6. 与 runtime 的协作

`context_update` 不是孤立工具，它嵌在一个预算监控循环里（`src/runtime/runtime.ts`、`src/agent/loop.ts`）：

- **压力阶梯**（按下一轮 view 的校准估算）：70% soft → 80% must_act → 95% critical。
- **critical 兜底**：runtime 强制 offload 最大的 inline tool_result（≥300 token）——语义上"笨"
  （最大优先、不懂哪些重要），所以好的治理应更早发生。`runtime_fallback_offloads` 占比高 = agent 治理不及时。
- **边界维护 pass**：一个 followup 问题进入后，runtime 给 cpat 一次只允许 `context_update` 的 ephemeral pass。
- **缓存友好**：消息列表 = block 顺序（稳定前缀），manifest/budget_report 集中在易变尾部、不落为长期 block。

---

## 7. 已验证的价值与已知局限

**验证**（受限窗口、自建深度研究任务、三臂双扫，详见 [`research/experiments/04-full-double-sweep.md`](research/experiments/04-full-double-sweep.md)）：
- 受限窗口下，治理（CPAT 或 threshold）让 ReAct 从 0-8%（提前终止）→ 100%。
- 200K 窗口下，主动 CPAT 用 1/5.8 的 token 达到与被动 threshold 相同的 100%（省 83%）。

**局限（诚实记录）**：
- 32K 小窗口下，CPAT 主动治理的 LLM 往返开销 > 节省，比 threshold 更贵——大窗口才回本。
- `restore` 的独立价值未验证：静态文件可重读时，agent 永远选 re-read 而非 restore。restore 的价值场景是
  **信息源不可重得**（一次性工具输出、推理中间态）。
- prompt-only 主动治理有架构开销瓶颈（每次治理一次 LLM 往返），印证 CAT 论文用 SFT 训练让治理零往返融入推理的必要性。

---

## 8. 扩展指南：怎么加一个新 op

1. **`src/types.ts`**：在 `ContextOperation` 联合类型加新 op 的形状。
2. **`src/agent/contextTool.ts`**：在 schema 的 `op` enum 加名字 + 相关字段的 description；在 `parseContextUpdateArgs`
   加扁平→typed 的归一化分支。
3. **`src/runtime/patch.ts`**：在 `applyContextUpdate` 的 switch 加 case；复用 `collapseIntoBlock`（若是收敛类）
   或写新逻辑；加校验规则（用 `reject(i, "rule_name", msg)`）。
4. **守护不变量**：若触及 tool-call chain 或对话状态，确认 `chain_atomicity` / `protected_*` 护栏覆盖。
5. **测试**：在 `test/patch.test.ts` 加正反向用例（参考 restore/merge/fold 的测试）。`npm test` 必须全过。
6. **文档**：更新本文 §4 + [`llmdoc/architecture/context-runtime.md`](llmdoc/architecture/context-runtime.md) §4 规则表。

> 设计原则：新 op 应尽量复用"归档源块 + 建 summary"或"零拷贝翻转"路径，**不碰 `ContextBlock` 数据模型**。
> 触及数据模型的扩展（如 supersede 需 resource_key、set_retention 需 TTL）应先讨论再实现。
