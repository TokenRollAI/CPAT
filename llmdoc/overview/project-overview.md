# 项目总览：CPAT

基于 DeepSeek 的最小原型，验证「Context Patch as Tool」协议：agent 用受控的 `context_update` 工具主动治理自己的上下文，而非由 runtime 做被动阈值压缩。核心概念见 `llmdoc/must/core-concepts.md`。

> **价值主张（受限窗口范式修正后，2026-06-25）**：CPAT 是为**受限窗口的超长程 agent** 设计的——价值只在「ReAct 会因窗口耗尽而崩」的场景显现（CAT 论文 arXiv:2512.22087 的核心设定，窗口硬卡 32K-65K）。全量双扫（硬窗口 32K/200K × 三臂）给出两个决定性结论：(1) **治理 > 不治理**——ReAct 在两窗口都因 context 超窗口提前终止（准确率 0% / 8.3%），任何治理（threshold 或 cpat）→ 100%，这是「能否完成」而非成本问题；(2) **200K 下主动 CPAT 在效率上碾压被动 threshold**——同 100% 准确率下 cpat 488K token vs threshold 2,819K token（省 83%），窗口越大优势越明显。**诚实标注**：32K 下 cpat 反比 threshold 贵（主动治理往返开销小窗口不回本）；restore 价值仍未验证（信息源静态可重读，restore 全程为 0）。早前「仅成本优化、非质量提升」（decision 0006）只在**非受限窗口**（百万）语境成立，受限窗口下已被推翻——详见 `llmdoc/memory/decisions/0007-bounded-window-cpat-value.md`。

## 实验假设

- **H1**：agent 自选 patch 比阈值压缩更能保留任务相关信息。
- **H2**：block 级 payload offload 比 append-only raw tool results 的 token 成本与干扰更低。
- **H3**：stable prefix + patchable tail 更好利用 DeepSeek context caching。
- **H4**：收益不只是避免超窗，而是减少 semantic drift / duplicate context / obsolete reasoning。

对比基线时关注 `agent_patches_applied` 与 `runtime_fallback_offloads` 的比例——兜底占比高说明 agent 治理不及时，退化成被动压缩。

## 仓库布局

```
src/types.ts               全部协议类型（block / operation / journal / config）
src/util/env.ts            零依赖 .env 解析（OPENAI_BASE_URL + API_KEY）
src/util/misc.ts           token 估算（ASCII 0.3 / CJK 0.6）、id 生成
src/deepseek/client.ts     OpenAI 兼容客户端（strict 降级、5xx 重试）
src/runtime/               stores / blocks / patch / view / runtime（CPAT 核心）
src/agent/                 contextTool / taskTools / loop（协议面 + 主循环）
src/cli.ts                 CLI 入口与 demo 任务
test/                      patch 引擎、context tool 归一化、agent loop 边界维护的离线测试
bench/                      有效性验证 harness（f1 + exact-match 评分 + longbench/multidoc/longloop/deepresearch runner），独立模块不改核心
```

## 开发工作流

- `npm test`：离线测试 patch 引擎（Node 内置 test runner 直接跑 `.ts`，不调 API）。
- `npm run demo`：内置仓库分析任务，小预算强制触发 budget 压力。
- 自定义任务：`node src/cli.ts run "<task>" [flags]`。
- CLI flags 与默认值：`--model deepseek-v4-flash`、`--max-context 16000`（故意压小以触发压力）、`--turns 40`、`--workdir cwd`、`--allow-replace` / `--allow-redact`（默认关）、`--verbose`、`--demo`。压力比例 0.7/0.8/0.95 与 `strictTools: true` 硬编码，无 flag 覆盖。
- `.env`：CPAT 只消费 `OPENAI_BASE_URL`（多重回退，默认 `https://api.deepseek.com`）与 `API_KEY`（回退 `DEEPSEEK_API_KEY` 等），见 `src/util/env.ts` (`loadDeepSeekEnv`)。`.env.example` 中的 `ANTHROPIC_BASE_URL` **不被 CPAT 代码消费**，仅供其他工具使用。
- 环境要求：Node ≥ 23.6（原生 type-stripping 跑 TS），零运行时依赖（仅 dev 依赖 typescript / @types/node）。

## 运行产物

每次 run 落盘 `runs/<ISO时间戳>/`（已 gitignore）：

- `journal.jsonl`：append-only 事件日志（ingest / patch / llm_call），runtime 写入。
- `content/`：单份内容存储，文件名 `<blockId>@v<version>.txt`，runtime 写入。
- `metrics.json` + `answer.md`：cli 在 run 结束时写入。

## 当前状态

- 原型已端到端验证：真实 DeepSeek API run 跑通（含一次 API-400 回归的发现与修复，见 `llmdoc/memory/decisions/0002-offload-keeps-kind.md`）；26 个离线测试全部通过（含硬窗口终止、threshold 无 context_update、语义漂移护栏）。
- 仓库 git 初始态：`main` 零 commit，全部文件 untracked。
- 语言约定：项目文档简体中文，技术名词/代码英文。

## 实验记录

- **V4 Pro 三预算对照 run（2026-06-13）**：用 DeepSeek V4 Pro（100 万上下文）对同一通读任务（CPAT 仓库 25 文件 ~147K 字符 → 逐文件审计，turns=40）只改 `--max-context` 跑三个 run。结论：
  - **印证 H3**：cache 命中率随预算/轮次稳步上升（5 万 0.285 → 12 万 0.534 → 100 万 0.578，100 万 run 尾部单轮达 84%），长稳定 prefix 持续命中。关闭 doc-gap #4。
  - **暴露 H1 失效模式**：三个 run 的 `agent_patches_applied` 全为 0；即便在 5 万紧预算触发 must_act 压力时，治理也全靠 runtime 兜底 offload，agent 不主动 patch，退化成被动阈值压缩。详见 `llmdoc/memory/reflections/2026-06-13-agent-passive-under-pressure.md`。
  - **方法论**：预算必须设在任务稳态 token（本任务约 5.8 万）之下，否则压不出任何治理动作。见 `llmdoc/memory/decisions/0004-budget-below-steady-state.md`。

- **CPAT vs ReAct 对照框架与五组实验（2026-06,已收官）**：建立 ReAct 对照臂（`src/agent/loop.ts` `AgentMode`）+ 连环多问（`followups`）+ `bench/` runner（longbench / multidoc / longloop + f1），见 `llmdoc/architecture/benchmark-harness.md`。五组实验(通读仓库、单文档 QA、多文档检索、longloop 中等 smoke、longloop 25 万收官)累积得出的**最终结论**：
  - **机制有效**：工具输出大量累积时 CPAT 显著降 token；8 个 op、链原子性、对照臂、连环多问都按设计工作。
  - **省 token 是唯一被稳定证实的收益**：CPAT 一致省 prompt token（35-57%）。longloop 25 万收官:559k vs ReAct 856k（省 ~35%）。
  - **任务质量未见一致优势(最终结论)**：所有可程序化判分任务上,CPAT 相对 ReAct 的 avg F1 方向随预算翻转、全在样本噪声内,且常略低（longloop 25 万:CPAT 3.44 vs ReAct 4.01,无统计意义）。这是一个诚实的负面结果,详见 `llmdoc/memory/reflections/2026-06-13-cpat-vs-react-inconclusive.md`。
  - **cache 非恒定优势(修正旧说法)**：前三组 CPAT cache 占优,但 longloop 25 万纯累积长任务上 ReAct 的 append-only 反而更高（74% vs 62%）——CPAT 一治理就改写 prefix、打断 cache。cache 优劣取决于任务形态。
  - **重定位**：V4 Pro 的百万窗口让 CPAT 最该赢的「撑爆」场景消失——即便 5.1 倍语料(~30.7 万 token),ReAct 仍不崩(api_error=0)、restore 仍为 0、offload 仅 1 次。CPAT 据此重定位为**成本优化策略而非质量提升策略**;restore 的价值是明确的开放问题。见 decision `llmdoc/memory/decisions/0006-reposition-cpat-as-cost-optimization.md` 与 `0005-cpat-value-requires-superwindow-scale.md`。**注意：此条结论已在受限窗口下被下方双扫推翻（见 0007）。**

- **受限窗口全量双扫（2026-06-25，决定性突破）**：诊断出前五组是**范式错误**（百万窗口让 ReAct 永不溢出，提前拿走 ReAct 死穴）后，按 CAT 论文范式重做：硬窗口 32K + 200K × 三臂（react / threshold / cpat）× 自建深度研究任务（合成 dossier、精确匹配、聚合/跨文档/回访问题、无 grep）、12 问。数据来自真实 run 的 `results.json`，完整对照 `research/experiments/04-full-double-sweep.md`，研究主叙事 `research/00-research-log.md`。

  | 窗口 | 臂 | terminated_early | accuracy | total prompt tokens | peak view tokens |
  |---|---|---|---|---|---|
  | 32K | react | true | **0%** | 31,740 | 75,089 |
  | 32K | threshold | false | 100% | 305,434 | 27,077 |
  | 32K | cpat | false | 100% | 464,041 | 19,233 |
  | 200K | react | true | **8.3%** | 714,175 | 202,624 |
  | 200K | threshold | false | 100% | **2,819,420** | 172,106 |
  | 200K | **cpat** | false | **100%** | **488,333** | 25,542 |

  - **结论 1（铁证）治理 > 不治理，两窗口都成立**：react 在 32K/200K 都因 context 超窗口提前终止（peak 75K/202K）、准确率 0% / 8.3%；任何治理 → 100%。这是「能否完成」而非成本。
  - **结论 2（突破）200K 下主动 CPAT 效率碾压被动 threshold**：同 100% 准确率，cpat 488K vs threshold 2,819K token（省 83%）；peak 25K vs 172K。机制推断：threshold 被动等 context 涨满才压（每轮背近满窗口，窗口越大越贵），cpat 主动读完即 offload（context 始终压低）。窗口越大 CPAT 优势越明显。
  - **诚实标注**：32K 下 cpat 反比 threshold 贵（464K vs 305K，主动治理往返开销小窗口不回本）；restore 全程仍为 0（信息源静态可重读），restore 独立价值仍未验证。修正详见 `llmdoc/memory/decisions/0007-bounded-window-cpat-value.md`。
