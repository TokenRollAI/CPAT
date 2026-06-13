# 0005：CPAT 价值验证必须在「超工作窗口规模」场景下进行

- **状态**：已采纳（实验方法论结论，由四组 CPAT vs ReAct 对照实验得出）
- **日期**：2026-06-13
- **缘起**：建立 ReAct 对照臂后,前三组小预算/可跳过/无回访的实验都测不出 CPAT 价值;用户指出根因 + 实验佐证
- **约束范围**：约束**所有后续 CPAT 有效性实验**的场景设计

## 背景

为衡量「CPAT 主动治理相对无治理 agent 的净增量」,新增了 ReAct 对照臂(`src/agent/loop.ts` `AgentMode`)与连环多问(`followups`),以及 `bench/` runner(见 `llmdoc/architecture/benchmark-harness.md`)。随后跑了四组实验。**前三组(单文档 QA、多文档检索等)都没能展示出 CPAT 的价值**——不是机制失效,而是**场景选错了**。

## 决策(方法论)

**CPAT 的有效性验证必须在满足三条件的场景下进行,否则测不出 CPAT 价值:**

1. **语料规模超工作窗口数倍**(50 万+ token)。对 100 万窗口的 V4 Pro,3 万~15 万预算毫无意义;只要语料未真正逼近窗口,agent 总有「全留着不治理」的选项,治理就无用武之地。
2. **信息必须全部流经 context、无法 grep 选择性跳过**。聪明的 ReAct agent 用 grep 选择性读取,不需要累积全部信息,治理便无可治。
3. **存在「先放下后取回」的回访模式**。CPAT 区别于 ReAct 的核心可测能力是 **offload→restore 可逆吞吐**(ReAct 要么背着全部 context 撑爆、要么永久丢弃)。读一次就用、无回访的任务,restore 调用全程为 0,这条独有路径根本不被触发。

**衡量指标应是能力性,而非 F1 平均分**:任务能否完成 / 需要的信息是否被成功 restore / ReAct 是否因撑爆(API 400)或被干扰稀释而失败。

## 反例证据(前三组实验,均为反面教材)

| 场景 | 预算 | 为何测不出 |
|------|------|-----------|
| 单文档 QA(narrativeqa) | 2万/15万 | 预算远不及窗口;单篇文档,无回访,restore=0 |
| 多文档检索(1 gold + 4 干扰 ~14.6万) | 30k/60k | 聪明 ReAct 用 grep 选择性读取反而克制;无回访,restore=0 |
| 长程连环多问中等规模 smoke | — | 语料未真正逼近窗口,agent 干脆 0 patch 硬扛,prompt 飙到 16 万,offload/restore=0 |

三组的 avg F1 方向随预算翻转、全在样本噪声内(5 样本、F1 方差 2~14),未见 CPAT 一致优势;CPAT 的 prompt token 反而经常更高(治理固定开销 > 省下的)。

**关键实证(硬约束,非措辞问题)**:longloop 中等规模 smoke 表明,**仅靠改任务措辞无法逼出可逆链**——只要语料不逼近窗口,agent 就选择「全留着硬扛」,offload/restore 恒为 0。规模是硬约束。

## 决定性证据:longloop 25 万语料实验(2026-06-14)

收官实验拉满了规模,**坐实了本决策的更强版本——在 V4 Pro 的百万窗口下,我们根本无法构造出 CPAT 必胜的场景**。设置:10 本去重 narrativeqa ~30.7 万 token 语料(实测约 6 万预算的 5.1×)、6 个连环问(gold slots 1,2,3,4,5,1,末问回访首篇)。证据见 `runs/abtest/longloop_25w.txt`。

| 指标 | CPAT(6 万) | ReAct(无预算) |
|---|---|---|
| 6 问全答完 | 6/6 | 6/6 |
| total prompt tokens | 559,078 | 856,093 |
| offload / restore | **1 / 0** | 0 / 0 |
| api_error / runtime fallbacks | 0 / 0 | 0 / 0 |

两个结论钉死了「超窗口规模」前提本身的可达性:

1. **即便 5.1 倍语料,restore 仍为 0、offload 仅 1 次**——本决策要求的「先放下后取回」可逆链在如此大的规模下仍几乎不被触发。这不是任务措辞问题,而是**只要 ReAct 不崩,agent 就没有非治理不可的理由**。
2. **ReAct 用 856k tokens 答完全部 6 问、零报错(api_error=0)**——证明 V4 Pro 的真实窗口根本没被 30 万语料撑爆。本决策原本设想的「ReAct 因撑爆(API 400)而失败」这个能力性指标**在 V4 Pro 上根本触发不了**。

**强化后的结论**:验证 restore / 可逆吞吐的价值,需要**模型物理窗口被真正超过、ReAct 必然失败**的场景。在 V4 Pro(100 万窗口)+ 我们可及的 benchmark 上,这种场景无法构造——语料够不到窗口,ReAct 永远有「全留着不治理」的退路。因此 restore 的价值在当前条件下**既未证伪也未证实**,是一个明确的开放问题。CPAT 的整体定位据此重定位为成本优化策略,见 decision `0006-reposition-cpat-as-cost-optimization.md`。

## 后果与引用

- 本决策约束 `bench/longloop.ts` 的默认参数(~500k 语料、含回访 schedule)与一切后续有效性实验设计。
- 对照的诚实负面结果与三个根因详见 reflection `memory/reflections/2026-06-13-cpat-vs-react-inconclusive.md`。
- 已确立的正面事实(机制正确性、cache 命中 CPAT 占优)不受此决策动摇;受动摇的是「在小预算/可跳过/无回访任务上比 F1」这个验证方式本身。
