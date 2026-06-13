# 0004：预算必须设在任务稳态 token 之下才能测到治理机制

- **状态**：已采纳（实验方法论结论，由 V4 Pro 三预算对照 run 得出）
- **日期**：2026-06-13
- **缘起**：V4 Pro（100 万上下文）三预算对照 run，发现中/大预算压不出任何压力

## 背景

为对照 CPAT 治理机制（agent 主动 patch vs runtime 兜底 offload）随预算的变化，用同一重任务（通读 CPAT 仓库 25 文件 ~147K 字符并产出逐文件审计报告，model=deepseek-v4-pro、turns=40、workdir=CPAT 自身）只改 `--max-context` 跑三个 run：

| Run | `--max-context` | 目录 | 压力 | llm_calls | offloads | cache_hit_ratio | final_visible_tokens |
|-----|-----------------|------|------|-----------|----------|-----------------|----------------------|
| A | 120000（中） | runs/2026-06-13T10-49-19-047Z | 全程 ok | 9 | 0 | 0.534 | 57665 |
| B | 50000（紧） | runs/2026-06-13T12-28-20-488Z | must_act ⚠ | 8 | 4 | 0.285 | 47307 |
| C | 1000000（百万） | runs/2026-06-13T12-32-02-804Z | 全程 ok | 12 | 0 | 0.578 | 55786 |

## 观察

- **这个通读任务的稳态约 5.8 万 token**（Run A 稳态 ~5.8 万 < soft 线 8.4 万；Run C token 一路爬到 ~5.2 万出答案）。
- Run A（12 万）与 Run C（100 万）全程 ok 压力，**零 offload、`agent_patches_applied`=0、`freed_tokens`=0**——预算远高于稳态，根本没有任何阶梯被触发，治理机制全程旁观。
- 只有 Run B（5 万 < 稳态 5.8 万）在 turn 6 token 达 43236 越过 4 万 must_act 线，才触发治理（runtime 兜底 offload 4 个块，freed 15919）。

## 决策（方法论）

**后续治理对照实验，`--max-context` 预算必须设在任务稳态 token 之下，否则测不到任何治理机制。**

预算高于稳态时，token 永远不越阈值，压力阶梯（soft/must_act/hard）全程 ok，agent patch 与 runtime offload 都不会发生——这类 run 只能用于观察 cache / token 走势，不能用于评估治理。设计治理实验时，应先用一个宽预算 run 摸出该任务的稳态 token，再把对照 run 的预算压到稳态之下。

## 后果与引用

- 本结论指导 reflection `memory/reflections/2026-06-13-agent-passive-under-pressure.md` 的复跑验证：要观察 agent 是否主动 patch，必须用低于稳态的紧预算 run。
- 同组 run 还顺带印证 H3、关闭 doc-gap #4（cache 命中率随预算/轮次上升），见 `memory/doc-gaps.md` 与 `overview/project-overview.md` 实验记录。
- 三个 run 的 `metrics.json` 即本决策的原始证据，路径见上表。
