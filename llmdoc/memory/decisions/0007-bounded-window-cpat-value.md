# 0007：受限窗口下 CPAT 的决定性价值（范式修正，部分推翻 0006）

- **状态**：已采纳（由全量双扫对照实验得出，2026-06-25）
- **日期**：2026-06-25
- **缘起**：按 CAT 论文（arXiv:2512.22087）的「受限窗口」范式重做实验——硬窗口 32K/200K × 三臂（react/threshold/cpat）× 超窗口语料。结果**推翻了 0006「CPAT 仅成本优化、非质量提升」结论中针对受限窗口的那一半**。
- **影响范围**：修正项目叙事（overview / README 级价值主张）；约束如何描述 CPAT 的能力边界；让 0006 限定在「非受限窗口」语境下成立。
- **数据来源**：真实 run 的 `results.json`，完整对照见 `research/experiments/04-full-double-sweep.md`；研究主叙事见 `research/00-research-log.md`（阶段 2-6）。

## 为什么 0006 是范式错误

前五组实验全部用 DeepSeek V4 Pro 的**百万真实窗口** → ReAct 永远不会因窗口耗尽而崩 → 测不出治理价值 → 据此把 CPAT 重定位为「仅成本优化、非质量提升」（0006）。**这是范式错误**：CPAT 是为**受限窗口的超长程 agent** 设计的，价值只在「ReAct 会因窗口耗尽而崩」的场景才显现——这也是 CAT 论文的核心设定（窗口硬卡 32K-65K）。把窗口开到百万，等于提前拿走了 ReAct 的死穴。

## 决定性实验（全量双扫，自建深度研究任务，12 问）

硬窗口机制（`src/agent/loop.ts` `hardWindowTokens`）：渲染 view 超过窗口时 react 臂被强制终止（复现论文「dialogue terminates early」）；threshold/cpat 有 runtime 安全网不终止。三臂见本仓库 `llmdoc/architecture/agent-protocol.md` §0 与 `benchmark-harness.md`。

| 窗口 | 臂 | terminated_early | accuracy | total prompt tokens | peak view tokens |
|---|---|---|---|---|---|
| 32K | react | true | **0%** | 31,740 | 75,089 |
| 32K | threshold | false | 100% | 305,434 | 27,077 |
| 32K | cpat | false | 100% | 464,041 | 19,233 |
| 200K | react | true | **8.3%** | 714,175 | 202,624 |
| 200K | threshold | false | 100% | **2,819,420** | 172,106 |
| 200K | **cpat** | false | **100%** | **488,333** | 25,542 |

## 决策：分窗口语境的双重结论

**结论 1（事实，铁证）：治理 > 不治理，两窗口都成立。** react 在 32K/200K 都因 context 超窗口提前终止（peak 75K/202K），准确率 0% / 8.3%；任何治理（threshold 或 cpat）→ 100%。受限窗口下 ReAct 因上下文耗尽彻底失败，这是「能否完成」而非成本问题。

**结论 2（事实 + 机制推断，突破）：200K 窗口下主动 CPAT 在效率上碾压被动 threshold。** 同样 100% 准确率，**cpat 488K token vs threshold 2,819K token，省 83%（5.8×）**；peak 25K vs 172K。
- 机制推断：threshold 被动等 context 涨满才压 → 每轮 LLM 调用都背近满窗口 context → 窗口越大越贵（200K 时总 token 飙到 281 万）；cpat 主动读完即 offload → context 始终压在低位（peak 25K）→ 每轮都轻。
- **关键规律**：窗口越大，被动 threshold 浪费越严重，主动 CPAT 压低 context 的优势越明显。这正是 CPAT 为「有限但较大窗口（如 200K）」设计的原因。

## 与 0006 的关系（范式修正，保留历史）

| 语境 | 相对 ReAct | 相对 threshold |
|---|---|---|
| **非受限窗口**（百万，0006 前五组观察成立） | 仅省 token（35-57%），质量无一致优势 | （前五组未设 threshold 臂） |
| **受限窗口**（32K/200K，本决策） | **质量决定性提升**（0%→100%，能否完成） | 大窗口（200K）下**巨大成本优化**（省 83%），质量打平 |

唯一变量是「窗口是否受限」。0006 的结论在受限窗口语境下被推翻；在非受限窗口语境下保留。0006 顶部已加修正指针指向本决策。

## 诚实标注（开放问题与负面事实）

- **restore 价值仍未验证**：restore 调用在所有 run 中仍为 0——信息源是静态文件、可重读，agent 永远选 re-read 而非 restore。restore 的独立价值需「信息源不可重得」的任务才能验证，这是明确的**开放问题**，不要写成已验证（见 `memory/doc-gaps.md` #4）。
- **32K 下 cpat 比 threshold 贵**（464K vs 305K）：主动治理的额外 LLM 往返开销在小窗口下不划算，大窗口才回本。机制根因（治理作为独立 tool call 每次都有往返开销，prompt 再好也省不掉）见 `research/00-research-log.md` 阶段 5。
- **prompt-only 主动 CPAT 的质量不天然优于被动 threshold**：v3 smoke 中未加护栏的主动 compact 会引发语义漂移（把当前问题压没）；加护栏（见下）后两者质量打平（都 100%）。这复现 CAT 论文为何用 SFT 训练。

## 配套实现（已落地，26 测试全过）

- **语义漂移护栏**（`src/runtime/patch.ts`）：compact/fold/merge 不能吞 `task_state`（规则 `protected_state`）与当前问题（最近 user_message，规则 `protected_current_question`）。详见 `llmdoc/architecture/context-runtime.md` §4。
- **三臂 + 硬窗口 + taskToolNames 过滤 + deepresearch runner**：见 `llmdoc/architecture/agent-protocol.md` 与 `benchmark-harness.md`。
