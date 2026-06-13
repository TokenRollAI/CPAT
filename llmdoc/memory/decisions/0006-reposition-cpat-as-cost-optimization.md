# 0006：把 CPAT 重新定位为上下文成本优化策略,而非任务质量提升策略

- **状态**：已采纳（项目叙事级重定位,由五组 CPAT vs ReAct 对照实验累积证据得出）
- **日期**：2026-06-14
- **缘起**：收官的 longloop 25 万语料实验跑完后,五组实验证据一致——CPAT 稳定省 token 但从未证明任务质量优于 ReAct。需要把项目命题落定为诚实的最终定位。
- **影响范围**：改变项目叙事(overview / README 级的价值主张表述);约束后续如何描述 CPAT 的能力边界。

## 背景

CPAT 的原始命题是「agent 主动治理上下文(`context_update`)优于 runtime 被动阈值压缩」,其中隐含一个更强的主张:**主动治理会让任务做得更好**(H1)。为检验这个主张,建立了 ReAct 对照臂 + 连环多问 + `bench/` runner(见 `llmdoc/architecture/benchmark-harness.md`),并跑了五组对照实验。结果迫使我们区分两件事:CPAT **机制是否正确**(是),与 CPAT **是否提升任务质量**(未证明)。

## 决策

**在当前证据下,CPAT 应被定位为「上下文成本优化策略」——在给定质量下用更少 prompt token、在受限预算约束下仍能维持任务可完成性——而非「任务质量提升策略」。**

价值主张的前后对比:

| | 原主张 | 修正后(本决策) |
|---|---|---|
| 核心卖点 | 主动治理 > 被动压缩,**任务做得更好** | 在给定质量下**用更少 token**;硬预算约束下**仍能完成** |
| F1 / 任务质量 | 期望 CPAT 更优 | 五组实验均未见一致优势(噪声级,常略低) |
| token 成本 | 次要收益 | **首要且唯一被稳定证实的收益**(省 35-57%) |
| 可逆吞吐(restore) | CPAT 的决定性独门能力 | **价值仍是开放问题**,未证伪也未证实 |

## 五组实验证据摘要

| 实验 | 任务质量(F1 等) | token 成本 | restore 是否触发 |
|---|---|---|---|
| 通读仓库审计(早期连通性) | — | CPAT ~3.3 万 vs ReAct ~6.4 万,显著省 | 0 |
| 单文档 QA(narrativeqa) | 方向随预算翻转,噪声级;CPAT prompt 反更高 | 见反思 | 0 |
| 多文档检索(1 gold + 4 干扰) | 方向随预算翻转,噪声级;CPAT prompt 反更高 | 见反思 | 0 |
| longloop 中等规模 smoke | — | agent 0 patch 硬扛,prompt 飙到 16 万 | 0 |
| **longloop 25 万(~30.7 万 token,收官)** | F1 3.44(CPAT) vs 4.01(ReAct),无统计意义 | **559k vs 856k,省 ~35%** | **1 offload / 0 restore** |

详见 reflection `memory/reflections/2026-06-13-cpat-vs-react-inconclusive.md` 与 decision `0005-cpat-value-requires-superwindow-scale.md`;25 万实验原始产物 `runs/abtest/longloop_25w.txt`。

## 根本原因

**V4 Pro 的百万窗口让 CPAT 最该赢的「撑爆」场景消失了。** 窗口太大,ReAct 即使纯累积 30 万 token 语料也不崩(`api_error`=0),所以 CPAT 的独门能力「可逆吞吐(offload→restore)」找不到「必须用它才能完成」的任务——只要 ReAct 有「全留着不治理」的退路,治理就只是可选优化而非必需能力。

## 后果与边界

- **诚实记录,不替 CPAT 圆话,也不过度否定**:机制是正确的(8 个 op、链原子性、对照臂、连环多问按设计工作),省 token 是真实且可复现的。被否定的只是「治理让任务做得更好」这个更强主张。
- **restore 的价值是明确的开放问题**:验证它需要「信息真正超过模型物理窗口、ReAct 必然失败」的场景,而这在 V4 Pro + 我们可及的 benchmark 上无法构造(见 0005 决定性证据)。不要把 restore 描述为已验证的优势。
- **cache 不是 CPAT 的恒定优势**:在纯累积型长任务上 ReAct 的 append-only 反而 cache 更优(longloop 25 万:74% vs 62%)。cache 优劣取决于任务形态。
- **对项目叙事的约束**:`overview/project-overview.md` 顶部命题与实验记录、以及 README 的价值表述,都应按本决策软化——把「主动治理让任务做得更好」改为「在更少 token / 受限预算下维持任务完成」,并标注这是五组实验后的修正认知。
