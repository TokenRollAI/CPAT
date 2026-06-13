# Agent 在 must_act 压力下不主动治理上下文

## Task

用 DeepSeek V4 Pro（100 万上下文）对同一个重任务（通读整个 CPAT 仓库 src+test+llmdoc 共 25 文件 ~147K 字符并产出逐文件审计报告，workdir=CPAT 自身、model=deepseek-v4-pro、turns=40）做三预算对照 run，只改 `--max-context`，观察 CPAT 治理机制（agent 主动 patch vs runtime 兜底 offload）的触发情况。

- Run A：`--max-context 120000`，runs/2026-06-13T10-49-19-047Z
- Run B：`--max-context 50000`，runs/2026-06-13T12-28-20-488Z
- Run C：`--max-context 1000000`，runs/2026-06-13T12-32-02-804Z

## Expected vs Actual

- **预期**：在紧预算（Run B）触发 must_act 压力时，agent 会被 SYSTEM_PROMPT 引导，主动调用 `context_update`（archive/offload/compact）来治理上下文，体现 H1 设想的「agent 自选 patch」。
- **实际**：三个 run 的 `agent_patches_applied` 全部为 0。Run B 在 turn 6 token 达 43236 越过 4 万 must_act 线后，治理动作全部由 runtime 兜底完成（turn 7 自动 offload 4 个大 tool_result，freed_tokens 15919，token 从 43236 降到 35952，`ops_by_type` 仅 `{payload_offload: 4}`）。agent 一次主动 patch 都没做，整个流程退化成被动阈值压缩。

## What Went Wrong

H1 的「agent 自选 patch」路径在真实 run 中没有被走通。当前仅靠 SYSTEM_PROMPT 的文字提示，不足以让 agent 在压力下主动治理；它倾向于继续推进任务本体（读文件、出报告），把上下文治理这件事「让给」了 runtime 阈值兜底。这是 H1 的一个失效模式：机制存在、但 agent 不主动使用。

## Root Cause

- **激励缺位**：SYSTEM_PROMPT 只是「提示」agent 可以治理上下文，没有强约束（如强制先 patch 再继续、或在压力下拒绝普通工具调用直到 agent 提交一次 patch）。对一个目标导向的 agent，治理上下文是「与任务无关的额外动作」，自然被忽略。
- **兜底太顺手**：runtime fallback offload 在越线后无声地把压力降下去，agent 感知不到「不治理的后果」，缺少促使其主动治理的反馈信号。
- **must_act 线相对温和**：在本任务稳态约 5.8 万 token 的背景下，4 万 must_act 线只在 Run B 的紧预算下被越过一次，且兜底立刻消化，agent 没有持续承压。

## Missing Docs or Signals

- SYSTEM_PROMPT 缺少「压力下必须先治理」的硬性引导；prompt 层没有把 agent 主动 patch 与任务推进的优先级讲清。
- 缺少一个把「agent 不主动治理」显式暴露给观察者的信号——目前只能靠事后比对 `agent_patches_applied` / `runtime_fallback_offloads` 比例（project-overview 已提示关注此比例，但 run 中无实时告警）。

## Promotion Candidates

- 「agent 压力下被动、全靠 runtime 兜底」是 CPAT 要研究的核心现象，是 H1 失效模式的实证，应在 `overview/project-overview.md` 的实验记录中留痕（本次已并入）。
- 「下一步如何让 agent 主动治理」属于设计方向，待方案确定后可升级为一条 decision；当前仅作为反思与改进线索保留。

## Follow-up

下一步改进方向（按可尝试性排序）：

1. **强化 prompt**：在 SYSTEM_PROMPT 中明确「检测到压力（must_act）时，必须先提交一次 `context_update` 再继续任务」，把治理提到任务推进之前。
2. **调激进 must_act**：把 must_act 阶梯前移或加大力度，让 agent 更早、更持续地承压，观察是否触发主动 patch。
3. **强制先 patch**：runtime 在越线后不立即兜底，而是先回灌一个「请先治理上下文」的提示给 agent，给它一轮主动机会，兜底仅作为最后保险。

验证手段：复跑紧预算 run（预算需低于任务稳态 ~5.8 万，见 `memory/decisions/0004-budget-below-steady-state.md`），观察 `agent_patches_applied` 是否从 0 抬升。
