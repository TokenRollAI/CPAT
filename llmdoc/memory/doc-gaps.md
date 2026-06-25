# 文档缺口（doc-gaps）

记录可执行的已知缺口。每条带闭合标准；解决后移除或标记关闭。

## 开放缺口

1. **H1 三臂对照能力已具备（缺口收窄）**
   ~~仓库仍无 threshold-compression runner~~ → **已实现 threshold 臂**（`src/agent/loop.ts` `AgentMode="threshold"`：有 runtime 安全网被动 offload、不给 agent `context_update`），与 `react`（零治理）+ `cpat`（主动治理）构成**完整三臂对照**，见 `architecture/benchmark-harness.md` §1。受限窗口双扫已用三臂跑出决定性结果（治理>不治理、200K 下主动 CPAT 省 83% token，见 `memory/decisions/0007-bounded-window-cpat-value.md`）。
   剩余缺口：尚无一篇 `guides/` 文档沉淀「三臂受限窗口对照实验」的可重复流程（如何选窗口/语料倍数/无 grep/回访 schedule）。
   闭合标准：补一篇 guides/ 对比实验流程文档。

2. **token 估算启发式未对真实 tokenizer 验证**
   `src/util/misc.ts` (`estimateTokens`) 的 0.3/0.6 系数仅靠 `prompt_tokens` 在线校准（钳制 [0.5, 2]），未与 DeepSeek 真实 tokenizer 离线比对。
   闭合标准：对一组样本测量估算误差分布，必要时调系数；结论落入 reference 文档。

3. **redact / replace 路径无真实运行证据**
   两者默认关闭，行为仅由 patch.ts 代码与 test 4/5 覆盖；redact 的 `version+=1` 写新 content key 路径无正向测试。
   闭合标准：开 `--allow-redact`/`--allow-replace` 跑一次真实任务并补正向测试。

4. **可逆吞吐（offload→restore）的价值未被验证（仍开放）**
   CPAT 区别于 ReAct 的核心独门能力是 offload→restore 可逆吞吐。前五组（百万窗口，restore=0、ReAct 从未撑爆）与受限窗口双扫（32K/200K，已构造出 ReAct 因窗口耗尽提前终止的场景，治理价值已强证明）**都仍未触发 restore**——信息源是静态文件、可重读，agent 永远选 re-read 而非 restore。该能力的独立价值既未证伪也未证实（双扫已证明的是「治理 > 不治理」与「主动 CPAT 效率 > 被动 threshold」，不依赖 restore；见 `memory/decisions/0007-bounded-window-cpat-value.md`、`0005`、`0006`）。
   闭合标准：构造一个「信息源不可重得」（非静态文件、无法 re-read）的任务，观测 CPAT 是否凭 restore 完成而 re-read 路径不可用；或明确论证在可及条件下无法构造并据此定论。

## 已关闭

- **H3 cache 命中需要更大预算的 run**（原 #4，2026-06-13 关闭）：用 V4 Pro 做三预算对照 run（同一通读任务，只改 `--max-context`），cache 命中率随预算/轮次稳步上升——Run B 5 万预算 0.285（runs/2026-06-13T12-28-20-488Z）→ Run A 12 万 0.534（runs/2026-06-13T10-49-19-047Z）→ Run C 100 万 0.578（runs/2026-06-13T12-32-02-804Z），且 Run C 尾部单轮（turn 11-12）命中率爬到 84%。长稳定 prefix 随轮次增长持续命中，正面印证 H3。方法论提示与同组 run 详见 `memory/decisions/0004-budget-below-steady-state.md`。
  - **2026-06-14 修正**：H3 的稳定前缀利于 cache 仍成立,但「CPAT cache 一致优于 ReAct」不成立。longloop 25 万纯累积长任务上 ReAct 的 append-only 反而 cache 更高（74% vs 62%）——CPAT 一治理就改写 prefix、打断 cache。cache 优劣取决于任务形态,见 `memory/decisions/0006-reposition-cpat-as-cost-optimization.md`。

- **候选新原子 op 调研**（原 #5，2026-06 关闭）：调研已产出，采纳 restore/merge/fold、否决/暂缓其余，记入 `memory/decisions/0003-restore-merge-fold-ops.md`，并更新 `architecture/context-runtime.md` §1/§4 与 `architecture/agent-protocol.md` §2/§7。
