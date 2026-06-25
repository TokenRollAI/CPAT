# 实验 03-smoke-v2：3 臂 × 32K 窗口（修复后，研究转折点）

**日期**：2026-06-25
**配置**：20 dossier ~81K 语料（2.5× 窗口），10 问（3 aggregate + 3 cross + 2 direct + 2 revisit），
hard-window 32K，**无 grep**（只 list_dir + read_file），aggregate 问题强制读遍全部。

## 结果

| 臂 | terminated_early | answered | accuracy | revisit | peak tokens | total prompt | offload/restore/compact | fallbacks |
|---|---|---|---|---|---|---|---|---|
| **react** | **true** | **1/10** | **0%** | 0% | 60,380 | 24,932 | 0/0/0 | 0 |
| **threshold** | false | 10/10 | **100%** | 100% | 22,497 | 215,583 | 14/0/0 | 14 |
| **cpat** | false | 10/10 | **100%** | 100% | 28,889 | 304,744 | 20/0/0 | 10 |

## 这是整个研究的转折点

**第一次让受限窗口真正咬住 ReAct。** 修复奏效——通过 (a) 去掉 grep 强制整篇读、
(b) 加聚合类问题（"哪个项目 accuracy 最高"必须读遍 20 篇），ReAct 在回答聚合问题时
把全部语料堆进 context，peak 冲到 **60,380**（远超 32K 窗口）→ **提前终止，只答了 1/10，0% 准确率**。
这正是 CAT 论文描述的 "dialogue terminates early" 死穴，第一次在我们的实验里复现。

**Threshold（被动 runtime 压缩）存活**：14 次自动 offload 压回窗口内，答完全部 10 问、100% 准确率。

## 关键观察

1. **H-bounded 部分验证**：受限窗口下 react 崩（0%），有治理的臂（至少 threshold）存活（100%）。
   "治理 > 不治理"在受限窗口下**第一次成立**。
2. **react 的 total prompt 反而低（24,932）**：因为它提前终止了，没继续烧。这说明
   **单看 token 成本会误导**——react"省 token"是因为它**失败得早**。必须看 accuracy。
3. **threshold 的 total prompt 很高（215,583）**：被动压缩需要反复 offload + 重读，开销大。
   这给 cpat 留了空间：若 cpat 能用更少 token 达到同样 100%，则"主动 > 被动"（论文 53.8 vs 57.6 的对应）。
4. cpat 臂较慢（主动治理的 tool 往返多），待补。

## 下一步

- 等 cpat 跑完，对比三臂（尤其 cpat vs threshold 的 token 效率与 revisit 准确率）。
- 若三臂分化清晰，扩到 200K 窗口 + 更多 docs 跑全量双扫。

## 三臂完整分析（cpat 跑完后）

**核心结论 1（H-bounded 成立）**：受限窗口下，**治理是任务完成的前提**。
react（无治理）→ 0%（提前终止）；threshold 与 cpat（有治理）→ 都 100%。
这是整个研究第一次得到"**有治理 > 无治理**"的、统计上无歧义的结果（0% vs 100%，不是噪声）。

**核心结论 2（cpat vs threshold，对 CPAT 不利的诚实发现）**：
在这个任务上，**主动 CPAT 并未优于被动 threshold**：
- 两者准确率都是 100%（含 revisit 100%）——没有质量差异。
- **cpat 反而更贵**：total prompt 304,744 vs threshold 215,583（多 41%），turns 也更多（16 vs 13）。
- cpat 做了更多治理动作（20 offload vs 14）但**没换来更好结果**。

原因推断：prompt-only CPAT 的 agent 主动调 context_update 增加了 tool 往返开销，
而这个任务的"被动按需 offload"（threshold）已经足够——agent 的主动判断没带来增量价值。
这再次呼应 The Complexity Trap：主动治理的复杂度未必值得，**除非任务复杂到被动压缩会丢关键信息**。

**核心结论 3（restore 仍为 0）**：即使有 revisit 问题且 100% 答对，**restore 调用仍是 0**。
原因：threshold/cpat 都靠 offload 把旧文档移出，但 revisit 时 agent **直接重新 read_file 原文档**
（文件还在 workdir），而不是 restore 已 offload 的 context 块。
**这说明：当原始信息源（文件）始终可重新获取时，restore 没有用武之地**——
restore 的价值场景是"原始源不可再得、只有 context 里那一份"（如工具输出、推理中间态）。
当前任务用静态文件，天然让 re-read 比 restore 更自然。这是一个重要的边界发现。

## 对全量实验的指导

1. **必须报告 accuracy 而非 token**：react 的低 token 是失败的副产品，不是优点。
2. **cpat 要赢 threshold，需要更难的任务**：被动压缩会丢信息、而主动选择能保住关键信息的场景。
   或者：信息源不可重得（迫使 restore 有价值）。
3. **当前已足够支撑一个真实结论**：CPAT（及任何治理）在受限窗口下让 ReAct 从 0% → 100%。
   这就是用户要的"对 CPAT 有实际价值的 case"——**虽然主动 vs 被动的增量仍未证明**。

