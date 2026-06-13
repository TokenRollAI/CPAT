# CPAT vs ReAct:四组实验后仍未证明 CPAT 优于 ReAct(诚实负面结果)

## Task

建立 ReAct 对照臂(`src/agent/loop.ts` `AgentMode`)+ 连环多问(`followups`)+ `bench/` runner(longbench/multidoc/longloop + f1)后,用 CPAT vs ReAct 对照跑实验,验证「CPAT 主动治理是否真的改善任务结果」。本反思记录截至 2026-06-13 已完成的四组实验的诚实结论。机制部分见 `llmdoc/architecture/benchmark-harness.md`,场景方法论修正见 `llmdoc/memory/decisions/0005-cpat-value-requires-superwindow-scale.md`。

> 注:本反思原写于四组实验完成时,当时 25 万~30 万 token 语料的超窗口 longloop 大规模对照实验仍在后台运行、结论未知。该实验已于 2026-06-14 跑完,最终结论收敛见文末「最终结论(2026-06-14,longloop 25 万跑完后)」小节,该小节为本反思的最终认知,优先于前文「未定论」语气。

## Expected vs Actual

- **预期**:在 LongBench 类长文 QA / 多文档检索任务上,CPAT 的主动治理会带来更高任务质量(F1)或更低 token 成本。
- **实际**:
  1. **通读仓库审计任务**(早先):react 臂 prompt 累积到 ~6.4 万 token,cpat 臂压到 ~3.3 万——大量工具输出累积时 CPAT 确能显著降 token(机制有效)。
  2. **LongBench narrativeqa 单文档 QA**(cpat vs react,2万/15万预算,各 5 样本):avg F1 方向不一致(紧预算 react 7.80 > cpat 6.28;宽预算 cpat 9.64 > react 6.54),全在噪声级。cpat 的 prompt token 反而更高;cache 命中 cpat 一致更高(~55% vs ~12-16%)。
  3. **多文档检索**(1 gold + 4 干扰 ~14.6万,30k/60k 预算,各 5 target):avg F1 仍方向不一致(紧 cpat 12.11 > react 9.27;中 react 8.21 ≈ cpat 8.01),仍噪声级。cpat prompt token 仍更高(39.6k/34k vs 19.8k/20.7k);cache 命中 cpat 一致更高(51-53% vs 27-29%)。

## What Went Wrong

CPAT 在已测的 LongBench 类任务上**未见相对 ReAct 的一致质量优势**:F1 方向随预算翻转,全部落在 5 样本的噪声方差内。更尖锐的是,CPAT 的 prompt token 经常**更高**——聪明的 react agent 用 grep 选择性读取、反而克制,而 cpat 被长 system prompt + budget_report + manifest + 治理 tool 往返这些**固定开销**加重,省下的量不抵开销。这是一个需要如实记录的负面结果。

## Root Cause

三组实验**测错了 CPAT 的价值场景**,三个根因:

1. **预算量级太小**:对 100 万窗口的 V4 Pro,3 万~15 万预算毫无意义。CPAT 价值只在 context 累积逼近/超过窗口时才显现。
2. **任务允许 grep 选择性跳过**:聪明 ReAct agent 不需要累积全部信息,治理就无用武之地。
3. **CPAT 核心价值「可逆吞吐」未被触发**:`payload_offload → 后续 restore` 是 CPAT 区别于 ReAct 的关键能力,但前三组任务「读一次就用、无回访」,restore 调用全程为 0。

与 **The Complexity Trap**(arXiv:2508.21433)的发现一致:复杂治理在简单任务上不值开销——固定治理成本只有在任务规模逼出真正的上下文压力时才被摊薄回来。

## 已确立的事实(不受场景修正动摇)

- **机制正确性**:充分验证——8 个 op、链原子性、ReAct 对照臂、followups 连环多问都按设计工作。
- **cache 命中**:在前三组(单文档 QA、多文档检索)上 CPAT 一致高于 ReAct(当时印证 H3 稳定前缀利于 cache)。**注:此说法已被 longloop 25 万实验部分修正——在纯累积型长任务上 ReAct 的 append-only 反而 cache 更优,见文末最终结论。**
- 受动摇的不是机制,而是「在小预算/可跳过/无回访任务上比 F1」这个验证方式本身。

## Missing Docs or Signals

- 缺一个能在小规模实验中就显式提示「这个场景测不出 CPAT 价值」的前置判据——现已固化为 decision 0005 的三条件清单。
- ReAct 对照臂虽已就位,但**阈值压缩基线**仍缺(H1 的严格对照,见 doc-gaps #1)。

## Promotion Candidates

- 「CPAT 价值验证需超窗口规模 + 不可 grep 跳过 + 有回访」的场景约束已升级为 decision `memory/decisions/0005-cpat-value-requires-superwindow-scale.md`。
- 「四组实验后 CPAT 在 LongBench 类任务未证明优于 ReAct」的负面结果已并入 `overview/project-overview.md` 实验记录。

## Follow-up

正确的验证方向(待超窗口大规模实验给出结论):语料达 50 万+ token(超工作预算数倍)、信息全部流经 context 无法 grep 跳过、存在回访模式;指标用能力性(任务能否完成 / 信息是否被成功 restore / ReAct 是否因撑爆或稀释而失败)而非 F1 平均分。验证手段:`bench/longloop.ts` 的超窗口配置 + cpat/react 双臂对照。

---

## 最终结论(2026-06-14,longloop 25 万跑完后)

第五组(也是收官)实验已跑完:10 本去重 narrativeqa 拼成 ~30.7 万 token 语料(实测比预期 25 万更大,~5.1× 的 6 万预算)、6 个连环问(gold slots 1,2,3,4,5,1,末问回访首篇文档)、`bench/longloop.ts` 的 `followups` 在同一 runtime 上吞吐。证据见 `runs/abtest/longloop_25w.txt`。

| 指标 | CPAT(6 万预算) | ReAct(无预算) |
|---|---|---|
| 6 问全答完 | 6/6 | 6/6 |
| avg F1 | 3.44 | 4.01 |
| total prompt tokens | 559,078 | 856,093 |
| cache 命中 | 61.9% | 74.0% |
| offload / restore | **1 / 0** | 0 / 0 |
| agent patches | 2 | 0 |
| runtime fallbacks | 0 | 0 |

**收敛后的最终认知(把"未定论"落定为结论):**

1. **可逆链几乎没被触发**:即便语料达预算的 5.1 倍,restore 仍为 0、offload 仅 1 次。设计上最想验证的 offload→restore 可逆吞吐在此场景下基本未上场。
2. **ReAct 不治理也能完成**:ReAct 用 856k tokens 答完全部 6 问且零报错(`api_error`=0、runtime fallbacks=0),证明 V4 Pro 的真实窗口根本没被 30 万语料撑爆。**既然 ReAct 不治理也能完成,CPAT 的治理在此不是"必需能力",只是"可选优化"。**
3. **延续"省成本、不提质量"的一致模式**:CPAT 省了 ~35% prompt token(559k vs 856k)但 F1 没赢(3.44 vs 4.01,还略低)。F1 绝对值全部 < 7——narrativeqa 短答案 + V4 Pro 长篇作答让 token-F1 对两臂都严重失真,该 benchmark 在此设置下无区分力,3.44 vs 4.01 无统计意义。
4. **反直觉的新发现(修正旧 cache 说法)**:ReAct 的 cache 命中反而更高(74% vs 62%)。原因合理:ReAct 的 context 纯 append、只增不改、prefix 极稳;CPAT 一治理就改写 prefix、打断 cache。**这修正了前三组得出的"CPAT cache 一致更高"——在纯累积型长任务上,ReAct 的 append-only 反而 cache 更优。** cache 优劣取决于任务形态,不是 CPAT 的恒定优势。

**总结论(五组实验累积一致)**:在所有可程序化判分、不需 Docker 的任务上,**CPAT 都未能证明任务质量优于 ReAct**;它稳定做到的只是省 token(35-57%)。根本原因是 V4 Pro 的百万窗口让 CPAT 最该赢的"撑爆"场景消失了——窗口太大,ReAct 不治理也不崩,CPAT 的独门能力"可逆吞吐(offload→restore)"在 V4 Pro + 我们可及的 benchmark 上找不到"必须用它才能完成"的任务。

**诚实的开放问题**:可逆吞吐(restore)的价值**既未被证伪也未被证实**——它需要"信息真正超过模型物理窗口、ReAct 必然失败"的场景才能体现,而这在 V4 Pro(100 万窗口)+ 我们可及的 benchmark 上无法构造。这是一个明确、诚实的开放问题,而非已验证的优势。

基于以上,CPAT 的定位已正式修正为**上下文成本优化策略**而非任务质量提升策略,固化为 decision `memory/decisions/0006-reposition-cpat-as-cost-optimization.md`(并见 0005 的决定性证据补充)。
