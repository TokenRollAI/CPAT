# 实验设计 03：受限窗口 × 三臂 × 深度研究任务

> 对应 task #7-#10。目标：复现 CAT 论文范式，在**受限窗口**下检验 H-bounded / H-reversible / H-degradation。

## 1. 硬窗口机制（核心改造）

前五组实验的根本缺陷：ReAct 臂用 V4 Pro 百万真窗口，永不"撑爆"。本轮引入**硬窗口 W**：

- 配置项 `hardWindowTokens`（独立于 CPAT 的 `maxContextTokens` 压力阶梯）。
- 每轮 `buildView` 后，估算渲染 context 的 token。若 **超过 W**：
  - **ReAct 臂**：模拟"窗口耗尽"。不再允许继续读取——注入终止信号，强制 agent 用现有信息**立即作答**（`toolChoice: "none"`），并标记 `terminated_early = true`。这复现论文的"dialogue terminates early"。
  - **CPAT / Threshold 臂**：不终止（它们有治理手段把 context 压回 W 以下）。CPAT 靠主动 op，Threshold 靠被动 compact。
- W 取值：**32K**（对齐论文）和 **200K**（贴近 V4 Pro 部署），双扫。

> 设计理由：真正卡 API 窗口需要换小窗口模型或改 client 截断，不稳定且会污染 usage 统计。
> 用"逻辑硬窗口 + 强制终止"更可控、可复现，且语义上等价于论文的"窗口耗尽即终止"。

## 2. 三对照臂（对齐论文 Table 2）

| 臂 | 治理能力 | 超窗口行为 |
|---|---|---|
| `react` | 无 | **提前终止**（死穴） |
| `threshold` | 被动：超 W 才自动 compact 最旧的块 | 压回 W 以下，继续 |
| `cpat` | 主动：agent 自选 op（含可逆 offload/restore） | 压回 W 以下，继续 |

`threshold` 臂是新增的——前五组只有 react/cpat。它隔离出"主动 vs 被动治理"的净差异
（这正是论文 53.8 vs 57.6 的对照）。

## 3. 自建深度研究任务

**不用现成 benchmark**（用户要求 + LongBench F1 判分失真已证明不合适）。

任务形态：让 agent **从头到尾深度研究一个语料**，跨数十轮，回答需要回访早期内容的连环问题。

候选构造（见 `bench/deepresearch.ts`）：
- 语料：多篇长文档（narrativeqa 去重，或自合成事实库）。
- 强制累积：问题需综合**多篇**文档的信息（不能单次 grep 命中）。
- 回访：后续问题指向早期已读、已被治理的文档 → 触发 restore（CPAT）/ 暴露 ReAct 丢信息。
- 判分：程序化。优先用**可精确匹配的合成事实**（如"文档 X 第 N 节的数值/实体"），避免 narrativeqa 短答案 F1 失真。

> 判分口径修正：前五组用 token-F1 判 narrativeqa，对长篇作答严重失真。本轮优先设计
> **有唯一可匹配答案**的问题（实体名/数值/精确引用），用 normalized exact-match 或 F1，区分力更强。

## 4. 指标（因变量）

| 指标 | 测什么 | 对应假设 |
|---|---|---|
| `terminated_early` | ReAct 是否因窗口耗尽提前终止 | H-bounded（死穴） |
| accuracy（EM/F1） | 任务质量 | H-bounded |
| `questions_answered` | 长程能走多少问 | H-degradation |
| total prompt tokens | 成本 | — |
| ops_by_type（offload/restore/compact） | 治理行为 | H-reversible |
| restore 命中 | 可逆链是否被用且有效 | H-reversible |
| accuracy vs 轮数曲线 | 长程退化 | H-degradation |

## 5. 跑法

- `bench/deepresearch.ts --mode {react|threshold|cpat} --hard-window {32000|200000} ...`
- 双扫：2 窗口 × 3 臂 = 6 组，每组 N 个研究任务。
- 先 smoke（小语料、1 任务）验证三臂行为差异正确（尤其 react 在小窗口下确实 terminated_early），再跑全量。

## 6. 风险与对策

- **风险**：prompt-only CPAT 的 agent 不主动治理（前五组观察到）。
  **对策**：保留软强制 nudge；threshold 臂作为"被动治理下限"参照——即使 agent 不主动，threshold 也能继续，证明"继续 > 终止"。
- **风险**：判分仍失真。**对策**：优先合成可精确匹配的事实型问题。
- **风险**：与并行会话改 loop.ts 冲突。**对策**：硬窗口逻辑尽量加在独立分支路径，不动 boundary-maintenance。
