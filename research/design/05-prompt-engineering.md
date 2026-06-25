# 实验设计 05：CPAT 提示工程重写（三层）

> 用户洞察：CPAT 的 tool description / system prompt / harness 提示没做好，
> 尤其"下一轮压缩后，老的那部分应该删掉"的策略缺失。这是让**主动 CPAT** 治理质量上不去的根因之一
> （护栏只防自伤，好提示才教会正确治理）。

## 诊断的四个问题（基于 v3 失败 + 通读三层提示）

1. **压缩后旧块处置缺失**：提示从不引导 agent 在 compact/offload 后清掉被取代的旧块
   → 摘要与陈旧原始块并存，占窗口、诱导反复 restore/re-read。
2. **"只在边界治理"拖累深度研究**：旧提示主张 maintenance 集中在问题边界，
   但深度研究单个问题内就要读 20 篇文档 → 等不到边界就溢出。
3. **缺"读完即处置"里程碑策略**：CAT 论文核心做法（milestone 压缩）在提示里完全没有。
4. **preserve/drop 启发太弱**：没教"保精确事实（数值/ID/实体）、丢 filler 散文"。

## 三层重写内容

### Layer 1 — SYSTEM_PROMPT（loop.ts）
- 新增**里程碑策略**："读完一篇用不上的文档立刻 offload 原文，只留一行关键事实笔记（精确名/数/ID/code）"。
- 新增**处置陈旧块**："compact/offload 后，若关键事实已进摘要，对冗余的原始/已 offload 块 set_visibility=hidden，
  不要让摘要和陈旧源并存"。
- 新增 **restore vs re-read**："需要精确文本时 restore（比重读大文件便宜）"。
- 强化 **preserve/drop 启发**："preserve 列精确事实（逐字 名/数/ID/source ref），drop 列 filler 散文"。
- 明确 **护栏**："不能 compact 当前问题/task_state"。
- 改写 Task policy："read, digest, offload, repeat —— 不让原始读堆积"。

### Layer 2 — context_update tool description（contextTool.ts）
- 从"boundary 工具、别每轮用"改为"**bounded 窗口，边读边 offload**"——明确支持单问题内增量治理。
- 加"**处置陈旧块**"段、"preserve 精确事实 verbatim"段、护栏段。
- 每个 op 的 cost/risk 说明补全（hidden 用于"事实已captured在别处"）。

### Layer 3 — boundaryMaintenancePrompt（loop.ts，harness 层）
- 加"**处置陈旧块**：摘要已含关键事实就 hidden 掉冗余源，别留摘要+陈旧源并存"。
- offload 强调"保精确事实在摘要里"；护栏（不碰当前问题/task_state）。

## 假设

重写后，cpat 应：
- **更便宜**：里程碑 offload + 处置陈旧块 → 更少 re-read、更低 peak、更低 total prompt。
- **保持 100% 准确**：精确事实保留启发 + 护栏防漂移。
- **理想**：total prompt 降到接近或低于 threshold（142K），证明"主动选择保什么"比"被动盲压"更高效。

## 验证

v3c：cpat 同 v3 配置（32K，20 docs，埋深事实）重跑，对比 v3b（护栏但旧提示，319K token / 100%）
与 threshold（142K / 100%）。
