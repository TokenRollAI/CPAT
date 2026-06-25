# 实验 03-smoke-v3：主动 vs 被动（埋深事实回访）

**日期**：2026-06-25
**配置**：20 dossier ~98K 语料（3.1× 窗口），10 问，hard-window 32K，无 grep，
**revisit 问题改问埋在 Section 5 的 incident code**（非 header，逼重读全文或精准保留）。

## 结果

| 臂 | terminated_early | accuracy | revisit acc | total prompt | turns | offload/restore/compact | fallbacks |
|---|---|---|---|---|---|---|---|
| **threshold** | false | **100%** | **100%** | 142,474 | 12 | 18/0/0 | 18 |
| **cpat** | false | **90%** | **50%** | **445,786** | 29 | 14/0/**9** | 12 |
| **react** | **true** | 10% | 0% | 58,755 | 60 | 0/0/0 | 0 |

## 核心发现：prompt-only 主动 CPAT 输给被动 threshold

**1. "治理 > 不治理" 再次稳固**：react 10%（提前终止，peak 147K 爆窗口）vs 两个治理臂 90-100%。

**2. CPAT 反而不如 threshold，且贵 3 倍**：
- accuracy 90% < threshold 100%；revisit 50% < 100%。
- total prompt 445,786 ≈ threshold 的 3.1 倍；turns 29 vs 12。
- **CPAT 做了 9 次 compact，threshold 做了 0 次。**

**3. 失败根因 = semantic drift（语义漂移）**：cpat 的 Q9 预测是
**"No new question received — standing by for Question..."** ——agent **以为没收到问题**。
结合 9 次 compact，诊断明确：**主动 compact 太激进，把对话状态/当前问题也压掉了**，
agent 迷失了"我在答哪个问题"。这正是 CAT 论文警告的 semantic drift。

**4. restore 仍为 0**：埋深事实也没逼出 restore——只要文件可重读，agent 永远选择 re-read。

## 解读：这恰好复现了 CAT 论文的核心动机

- CAT 论文里 CAT（57.6）赢 threshold（53.8）赢 ReAct（49.8），关键是 **CAT 经过 SFT 训练**
  学会了"何时压、压什么、保住什么"。
- 我们的 CPAT 是**纯 prompt、无训练**：agent 不知道怎么聪明地压，于是
  **压坏了自己的工作记忆**（语义漂移）→ 比"被动按需 offload 原始 tool_result"的 threshold 更差。
- **这是一个有价值的负面结果**：它定量地说明
  **"主动治理"的价值依赖于 agent 压缩决策的质量，而 prompt-only 不足以保证这个质量。**
  threshold 之所以稳，是因为它压的是"最旧最大的 tool_result"且**保留摘要+可重读**，
  从不碰对话状态；CPAT 的 compact 会重写语义块，风险更高。

## 对 CPAT 设计的直接启示

1. **compact 不应触及对话状态/当前问题块**——这是 semantic drift 的直接来源。
   可在 patch 引擎加保护：task_state / 最近 user_message 不可被 compact 进摘要。
2. **prompt-only 不够**：要让主动治理赢，要么 (a) 训练（论文路线，超出当前范围），
   要么 (b) 给 agent 更强的护栏（只允许 offload 原始 payload、禁止 compact 语义状态）。
3. **threshold 是强基线**：被动"offload 最旧大 tool_result + 保留摘要 + 文件可重读"已经很稳。
   CPAT 要赢它，必须在**threshold 会丢信息**的场景——即**信息源不可重得**（工具一次性输出、
   推理中间态），这样 restore 才有价值，主动选择保什么才有意义。

## 下一步候选

- **A**：加护栏（compact 不碰对话状态/当前问题），重跑，看 cpat 是否追平/超过 threshold。
  这是最小改动，直接针对已诊断的 semantic drift。
- **B**：设计"信息源不可重得"的任务（工具输出一次性），逼出 restore 的价值。
- **C**：接受结论——prompt-only CPAT 不优于被动压缩，需要训练（论文已证），把这写成主结论。

---

## v3b：加语义漂移护栏后重跑 cpat（2026-06-25）

给 patch 引擎加硬护栏（compact/fold/merge 不能吞 `task_state` 和当前问题块，新规则
`protected_state`/`protected_current_question`）后，重跑 cpat 臂：

| cpat 版本 | accuracy | revisit | total prompt | compact 次数 | 诊断 |
|---|---|---|---|---|---|
| v3（无护栏） | 90% | 50% | 445,786 | **9** | 语义漂移，Q9 "没收到问题" |
| **v3b（+护栏）** | **100%** | **100%** | 318,987 | **0** | 漂移消失 |

**护栏完全奏效**：
- accuracy 90% → **100%**，revisit 50% → **100%**（两个埋深事实都答对）。
- **compact 从 9 → 0**：护栏让 agent 不再用 compact 压对话状态，转而用 offload（21 次）+ runtime fallback。
- total prompt 445K → 319K（降 28%），turns 29 → 20。

### v3 系列最终对照（32K 窗口）

| 臂 | accuracy | revisit | total prompt | 提前终止 |
|---|---|---|---|---|
| react | 10% | 0% | 58,755 | **是** |
| threshold | 100% | 100% | 142,474 | 否 |
| **cpat（+护栏）** | **100%** | **100%** | 318,987 | 否 |

### 结论（重要，对 CPAT 的诚实评价）

1. **加护栏后 cpat 追平 threshold 的准确率（都 100%）** —— 语义漂移是真 bug，修了就好。
   这说明 **CPAT 的主动治理理念没问题，但实现需要护栏防止 agent 自伤**。
2. **但 cpat 仍比 threshold 贵 2.2 倍（319K vs 142K token）** —— 主动治理的 tool 往返开销
   在"文件可重读"的任务上没换来优势。**CPAT 还是没赢 threshold，只是不再输。**
3. **restore 仍为 0** —— 文件可重读，restore 无用武之地的结论不变。

**所以：要让主动 CPAT 真正赢被动 threshold（不只是追平），必须换到"信息源不可重得"的任务
（候选 B）。** 这是 restore 唯一能体现价值的场景，也是 CPAT 区别于"被动 offload 原始 tool_result"的地方。

